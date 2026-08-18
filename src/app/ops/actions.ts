"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";
import { todayLakeDate, dayStatus, effectiveSeason, validateSeasonDates } from "@/lib/booking";
import { runRouteBuild } from "@/lib/automation";
import { getPlatformSettings } from "@/lib/settings";
import { assertOps } from "./data";
import { readFailedMessage } from "@/lib/must-read";

export interface OpsResult {
  ok: boolean;
  error?: string;
  /** Saved, but something about the save is worth saying out loud (e.g. a
   *  lake left closed for water work because ice-out is still unknown). */
  warning?: string;
}

const SLOTS = new Set(["8a", "10a", "1p", "3p"]);

function isISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Assign a job to a vendor and schedule it (the core ops move). Sets the
 * vendor cost, derives margin = customer_price − vendor_cost, moves the job to
 * `scheduled`, and texts both crew and owner. Enforced server-side:
 *  - ops only,
 *  - vendor must be active with a valid (unexpired) COI — no COI, no jobs,
 *  - vendor_cost is bounded to [0, customer_price] so margin can't go negative
 *    or exceed the price,
 *  - the job must already carry a customer_price (priced at booking).
 */
export async function assignAndSchedule(
  jobId: string,
  input: { vendorId: string; vendorCost: number; date: string; slot: string },
): Promise<OpsResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const admin = createServiceClient();
  const jobRes = await admin
    .from("jobs")
    .select("id, status, customer_price, property_id, service_id, group_id, services(name, is_water_work)")
    .eq("id", jobId)
    .maybeSingle();
  // "Job not found." asserts the row is gone — and every check below it (the
  // season gate, the price, the status) is decided from this row. A failed read
  // hands back the same `data: null` as a deleted job, so ops is told a job they
  // are looking at on the board does not exist.
  if (jobRes.error) return { ok: false, error: readFailedMessage("that job", jobRes.error) };
  const job = jobRes.data;
  if (!job) return { ok: false, error: "Job not found." };
  if (job.group_id) {
    return { ok: false, error: "Storage packages route automatically — this visit needs a crew that covers every leg (rates, insurance, barn space). Fix the crew's docs or capacity and the machine will place it." };
  }
  if (!["requested", "scheduled"].includes(job.status as string)) {
    return { ok: false, error: `Can't reschedule a job that's ${job.status}.` };
  }
  if (job.customer_price == null) {
    return { ok: false, error: "This job has no customer price yet — it can't be costed." };
  }

  // Validate the schedule inputs.
  if (!isISODate(input.date)) return { ok: false, error: "Pick a valid date." };
  if (input.date < todayLakeDate()) return { ok: false, error: "That date is in the past." };
  if (!SLOTS.has(input.slot)) return { ok: false, error: "Pick a valid time slot." };

  // SEASON GATE (sim-report defense-in-depth, rule 7): the customer booking
  // flow refuses water work outside the lake's ice-out → pull-deadline window
  // (dayStatus, src/lib/booking.ts) — that gate was booking-time-only by
  // design, so a manual ops override could still schedule water work outside
  // the season. Re-check the same rule here. Rush-window fields are forced
  // open: ops can place a same-day job any hour, this gate only cares whether
  // the DATE itself falls inside the season.
  const svcRow = (Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string; is_water_work?: boolean } | null;
  if (svcRow?.is_water_work) {
    const propRes = await admin
      .from("properties")
      .select("lakes(ice_out_actual, pull_deadline)")
      .eq("id", job.property_id as string)
      .maybeSingle();
    // dayStatus fails closed on half a window, so a failed read here refuses the
    // assignment AND blames the lake — "ice-out not set" about a lake whose
    // dates are on file. Ops would go and re-enter season dates that are fine.
    if (propRes.error) {
      return { ok: false, error: readFailedMessage("this lake's season dates", propRes.error) };
    }
    const propRow = propRes.data;
    const lake = (Array.isArray(propRow?.lakes) ? propRow?.lakes[0] : propRow?.lakes) as
      | { ice_out_actual?: string; pull_deadline?: string } | undefined;
    const today = todayLakeDate();
    const status = dayStatus(input.date, {
      today,
      isWaterWork: true,
      seasonStart: lake?.ice_out_actual ?? null,
      seasonEnd: lake?.pull_deadline ?? null,
      fullDates: new Set<string>(),
      rushNowHour: 12,
      rushCutoffHour: 24,
    });
    if (status === "off-season") {
      // Report the window dayStatus actually used, and say when it's a rolled
      // guess rather than a confirmed ice-out (audit finding 1) — otherwise
      // the refusal quotes dates ops can't find on the lake card.
      const eff = effectiveSeason(
        { iceOut: lake?.ice_out_actual ?? null, pullDeadline: lake?.pull_deadline ?? null },
        today,
      );
      const note = eff.wasRolled ? " — provisional dates, rolled from last season; confirm them on Lake conditions" : "";
      return {
        ok: false,
        error: `Outside the water-work window for this lake (ice-out ${eff.seasonStart ?? "not set"}, pull by ${eff.seasonEnd ?? "not set"}${note}).`,
      };
    }
  }

  // Validate the vendor: must be active with a valid COI (spec: no COI, no jobs).
  const vendorRes = await admin
    .from("vendors")
    .select("id, company, status, coi_expiry, user_id")
    .eq("id", input.vendorId)
    .maybeSingle();
  // "That vendor isn't active" and "That vendor's insurance is expired" are both
  // claims about the crew's file. On a failed read we have no file to claim
  // anything about, and ops would chase a crew for paperwork they already sent.
  if (vendorRes.error) return { ok: false, error: readFailedMessage("that crew", vendorRes.error) };
  const vendor = vendorRes.data;
  if (!vendor || vendor.status !== "active") return { ok: false, error: "That vendor isn't active." };
  if (vendor.coi_expiry == null || String(vendor.coi_expiry) < todayLakeDate()) {
    return { ok: false, error: "That vendor's insurance (COI) is missing or expired — can't route them." };
  }

  // Validate the cost / margin. Quantize the cost to whole cents BEFORE the
  // bound check and before deriving margin, so vendor_cost + margin always
  // reconciles exactly to customer_price (no fractional-cent drift).
  const price = Number(job.customer_price);
  const cost = Math.round(Number(input.vendorCost) * 100) / 100;
  if (!Number.isFinite(cost) || cost < 0 || cost > price) {
    return { ok: false, error: `Vendor cost must be between $0 and the $${price.toFixed(0)} customer price.` };
  }
  // Same margin floor the auto-dispatch engine enforces (now a DB dial) — a
  // manual assignment must never break it either. Cap the vendor cost.
  const { marginFloor } = await getPlatformSettings();
  const maxCost = Math.floor(price * (1 - marginFloor) * 100) / 100;
  if (cost > maxCost) {
    return { ok: false, error: `That cost leaves less than ${Math.round(marginFloor * 100)}% margin. Keep vendor cost at or below $${maxCost.toFixed(0)}.` };
  }
  const margin = Math.round((price - cost) * 100) / 100;

  const { data: changed, error } = await admin
    .from("jobs")
    .update({
      vendor_id: vendor.id,
      vendor_cost: cost,
      margin,
      date: input.date,
      slot: input.slot,
      status: "scheduled",
    })
    .eq("id", jobId)
    .in("status", ["requested", "scheduled"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!changed || changed.length === 0) return { ok: false, error: "Job changed underneath you — reload." };

  // Best-effort notifications. Vendor crew + homeowner (no prices to the crew).
  const svcName = ((Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string } | null)?.name ?? "a service";
  const prettyDate = new Date(input.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  // The two reads below stay best-effort: the job is already scheduled, and
  // unwinding that over a missing phone number would be worse than a text that
  // did not go. But a swallow has to leave a trace, or "the crew never got told"
  // has no explanation anywhere.
  const vUserRes = await admin.from("users").select("phone").eq("id", vendor.user_id).maybeSingle();
  if (vUserRes.error) console.error("[read failed] the crew's phone number (job scheduled, text not sent):", vUserRes.error);
  const vUser = vUserRes.data;
  if (vUser?.phone) {
    void sendSms(vUser.phone as string, `LakeLife: new job on your route — ${svcName}, ${prettyDate} (${input.slot}). Opens in your Today list. 🌊`);
  }
  const propNotifyRes = await admin
    .from("properties")
    .select("address, users(phone)")
    .eq("id", job.property_id)
    .maybeSingle();
  if (propNotifyRes.error) console.error("[read failed] the owner's phone number (job scheduled, text not sent):", propNotifyRes.error);
  const prop = propNotifyRes.data;
  const ownerPhone = ((Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as { phone?: string } | null)?.phone;
  if (ownerPhone) {
    void sendSms(ownerPhone, `LakeLife: your ${svcName} is booked for ${prettyDate}. We'll text you when the crew is done, with photos. 🌊`);
  }

  return { ok: true };
}

export interface BuildRoutesResult extends OpsResult {
  routes?: number;
  stops?: number;
  overflow?: number;
  texted?: number;
}

/**
 * Router v1 (ops only): take a day's scheduled jobs, cluster each vendor's
 * stops by lake, order them in drive direction, cap at daily capacity, write
 * `routes` + per-job sequence, and text each crew their map link. Deterministic
 * rebuild: running it again replaces that day's routes. The nightly 8pm cron
 * calls exactly this; the button just runs it early.
 */
export async function buildRoutesForDate(dateISO?: string): Promise<BuildRoutesResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  // Same engine the nightly cron runs — authorized here by assertOps.
  const r = await runRouteBuild(dateISO);
  return { ok: r.ok, error: r.error, routes: r.routes, stops: r.stops, overflow: r.overflow, texted: r.texted };
}

/**
 * Update a lake's season dates (ops only). The pull deadline is derived, not
 * entered: hard freeze − 8 days (rule 7). Saving reflows the customer booking
 * calendar, which already reads ice_out_actual + pull_deadline.
 *
 * Validation lives in the pure `validateSeasonDates` (src/lib/booking.ts) —
 * format was the whole gate before, and the two-season audit (finding 8)
 * showed what got through: the two dates swapped into each other's boxes
 * saved fine and closed the lake's entire water calendar with no error, and a
 * blank ice-out saved fine and left the lower half of the gate open. Marking
 * the season confirmed is what turns off the provisional year-roll.
 */
export async function updateLakeConditions(
  lakeId: string,
  input: { iceOut: string | null; hardFreeze: string | null },
): Promise<OpsResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const iceOut = input.iceOut === "" ? null : input.iceOut;
  const hardFreeze = input.hardFreeze === "" ? null : input.hardFreeze;
  const check = validateSeasonDates({ iceOut, hardFreeze });
  if (!check.ok) return { ok: false, error: check.error };

  const admin = createServiceClient();
  const { error } = await admin
    .from("lakes")
    .update({
      ice_out_actual: iceOut,
      hard_freeze_est: hardFreeze,
      pull_deadline: check.pullDeadline,
      // A human just typed these: they are this season's real dates, not a
      // rolled guess, so the lake stops being provisional.
      season_confirmed: iceOut != null && hardFreeze != null,
    })
    .eq("id", lakeId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, warning: check.warning };
}
