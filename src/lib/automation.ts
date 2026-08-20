import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { notify } from "@/lib/notify";
import { allowsNotification } from "@/lib/notif-gate";
import { sendEmail } from "@/lib/email";
import { LakeLifePayments } from "@/lib/payments";
import { statementDescriptor } from "@/lib/descriptor";
import { revalidateJob } from "@/app/book/dispatch";
import { todayLakeDate } from "@/lib/booking";
import { planVendorDay, routeMapUrl } from "@/lib/router";
import { planFleetDay, jobMinutesOf, type TruckIn, type FleetStop } from "@/lib/fleet";
import { coiRevalidationDue } from "@/app/vendor/onboarding-helpers";
import { proposeAutopilotDate } from "@/lib/autopilot";
import { shouldDemote, healBase, isCoolingDown } from "@/lib/lake-standing";
import { warningDue, isExpired, WAITLIST_WARNING_KIND, expiryActionFor, PROTECTIVE_ESCALATION_KIND } from "@/lib/waitlist";
import { remindDecision, extendedRange, extensionPrice } from "@/lib/extend-stay";
import { parseDaterange, type Term } from "@/lib/parks";
import { rushWindowOpen } from "@/lib/rush";
import { isLastDayOfMonth, nudgeCooling, nearMilestone } from "@/lib/growth";
import { withinSunset, customerReferralAccrual, crewShareAccrual, creditToApply } from "@/lib/referrals";
import { getPlatformSettings } from "@/lib/settings";
import { autoAssignJob, loadPricingProfileById } from "@/app/book/dispatch";
import { computeScarcityOffer } from "@/app/requests/offer-data";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { computeMenuSuggestions } from "@/app/ops/data";
import { executeMenuUpdate } from "@/lib/menu-core";
import { composeNightlyDigest, type DigestSections } from "@/lib/digest-render";
import { proposedFee, deadlinePassed, tripFeeFor } from "./recovery";
import { withParkRate } from "@/lib/park-rates";
import { groundsFor, loadParkRates } from "@/app/park/rate-data";
import { mustRead, ReadFailed } from "@/lib/must-read";

/**
 * Scheduled/automation runners. NO auth of their own — the CALLER authorizes
 * (ops action via assertOps, or a cron route via the CRON_SECRET). All use the
 * service role. Keep these idempotent enough to run on a schedule.
 */

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function prettyDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
const one = <T>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

export interface RouteBuildOutcome {
  ok: boolean;
  error?: string;
  date?: string;
  routes?: number;
  stops?: number;
  overflow?: number;
  texted?: number;
  trucks?: number; // count of per-truck route rows written (fleet vendors only)
  hoursBust?: number; // count of truck days that busted the truck's work window
  /**
   * WHAT DIDN'T GET BUILT OR DELIVERED, in human words.
   *
   * `ok:false` and a crew who silently never received tomorrow's route both
   * ended in an HTTP response nobody reads. The nightly carries this into the
   * digest, so a morning where a crew has no route is something ops learns the
   * night before rather than from the crew.
   */
  skipped?: string[];
}

/**
 * Build routes for a day (default: tomorrow, lake time). Clusters each vendor's
 * scheduled jobs by lake, orders them in drive direction, writes routes +
 * per-job sequence, texts each crew their map link. Skips crews whose COI
 * lapsed. Deterministic rebuild — clears that day's routes first.
 *
 * Fleet-aware (docs/fleet-routing-design.md): a vendor with crew_units gets
 * ONE routes row PER TRUCK (planFleetDay, time-budget aware); a vendor with
 * ZERO crew_units rows gets the EXACT legacy path (planVendorDay, one route,
 * one SMS to the vendor phone) — the backward-compat invariant.
 */
export async function runRouteBuild(dateISO?: string, onlyVendorId?: string): Promise<RouteBuildOutcome> {
  const date = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : addDays(todayLakeDate(), 1);
  const admin = createServiceClient();

  // onlyVendorId scopes a mid-day self-heal (truck down) to ONE vendor —
  // a platform-wide rebuild would re-text every crew's route on every
  // toggle (review finding, 2026-07-23). Nightly passes no vendor.
  let jobsQuery = admin
    .from("jobs")
    .select(
      "id, vendor_id, group_id, est_minutes, properties(lat, lng, lakes(name)), vendors(daily_capacity, company, user_id, status, coi_expiry, base_lat, base_lng), services(est_minutes), job_items(services(est_minutes))",
    )
    .eq("date", date)
    .eq("status", "scheduled")
    .not("vendor_id", "is", null);
  if (onlyVendorId) jobsQuery = jobsQuery.eq("vendor_id", onlyVendorId);
  // Route-build skips, collected for the digest (see RouteBuildOutcome.skipped).
  const skipped: string[] = [];
  const { data: jobs, error: loadErr } = await jobsQuery;
  if (loadErr) return { ok: false, error: loadErr.message, skipped: [`Couldn't read the jobs scheduled for ${date} — NO routes were built and no crew was texted a route.`] };

  const byVendor = new Map<
    string,
    { capacity: number; user_id: string | null; baseLat: number | null; baseLng: number | null; stops: FleetStop[] }
  >();
  for (const j of jobs ?? []) {
    const v = one(j.vendors) as
      | { daily_capacity?: number; user_id?: string; status?: string; coi_expiry?: string; base_lat?: number; base_lng?: number }
      | null;
    if (!v || v.status !== "active" || !v.coi_expiry || String(v.coi_expiry) < todayLakeDate()) continue;
    const p = one(j.properties) as { lat?: number; lng?: number; lakes?: unknown } | null;
    const lake = one(p?.lakes) as { name?: string } | null;
    const svc = one(j.services) as { est_minutes?: number } | null;
    const key = j.vendor_id as string;
    if (!byVendor.has(key)) {
      byVendor.set(key, {
        capacity: Number(v.daily_capacity ?? 0),
        user_id: v.user_id ?? null,
        baseLat: v.base_lat ?? null,
        baseLng: v.base_lng ?? null,
        stops: [],
      });
    }
    // Packages cost their legs' sum (jobMinutesOf) — the same number their
    // admission was charged, so fitsHours sees the real day.
    const legs = (j as { group_id?: string | null }).group_id
      ? ((j as { job_items?: Array<{ services?: unknown }> }).job_items ?? []).map((it) => (one(it.services) as { est_minutes?: number } | null)?.est_minutes ?? null)
      : null;
    byVendor.get(key)!.stops.push({
      id: j.id as string,
      lat: p?.lat ?? null,
      lng: p?.lng ?? null,
      lake_name: lake?.name ?? null,
      // 0083 stamps the REAL figure on the job at booking; dispatch already
      // prefers it. The router did not, so a 12-section pier was 255 minutes
      // to the gate that admitted it and 180 to the builder that laid out the
      // day. That does not oversell a day — dispatch used the larger number —
      // but it costs truck-to-truck balance and suppresses the crew's "this
      // day runs past your hours" text on a day that genuinely does.
      estMinutes: Number((j as { est_minutes?: number | null }).est_minutes ?? 0) > 0
        ? Number((j as { est_minutes?: number | null }).est_minutes)
        : jobMinutesOf(svc?.est_minutes, legs),
    });
  }

  // ALL active crew_units for the involved vendors, ONE query. Created-order
  // keeps the fleet split deterministic across rebuilds (design doc).
  const vendorIds = [...byVendor.keys()];
  const unitsByVendor = new Map<string, TruckIn[]>();
  if (vendorIds.length > 0) {
    const { data: units, error: uErr } = await admin
      .from("crew_units")
      .select("id, vendor_id, name, phone, capacity, work_start, work_end, base_lat, base_lng")
      .in("vendor_id", vendorIds)
      .eq("active", true)
      .order("created_at", { ascending: true });
    if (uErr) return { ok: false, error: uErr.message, skipped: [`Couldn't read the crews' trucks for ${date} — NO routes were built and no crew was texted a route.`] };
    for (const u of units ?? []) {
      const vid = u.vendor_id as string;
      if (!unitsByVendor.has(vid)) unitsByVendor.set(vid, []);
      unitsByVendor.get(vid)!.push({
        id: u.id as string,
        name: (u.name as string) ?? "Truck 1",
        phone: (u.phone as string) ?? null,
        capacity: Number(u.capacity ?? 0),
        workStart: Number(u.work_start ?? 0),
        workEnd: Number(u.work_end ?? 24),
        baseLat: u.base_lat == null ? null : Number(u.base_lat),
        baseLng: u.base_lng == null ? null : Number(u.base_lng),
      });
    }
  }

  if (onlyVendorId) {
    await admin.from("routes").delete().eq("date", date).eq("vendor_id", onlyVendorId);
    await admin.from("jobs").update({ route_id: null, sequence: null }).eq("date", date).eq("status", "scheduled").eq("vendor_id", onlyVendorId);
  } else {
    await admin.from("routes").delete().eq("date", date);
    await admin.from("jobs").update({ route_id: null, sequence: null }).eq("date", date).eq("status", "scheduled");
  }

  const vendorContactFor = async (userId: string | null): Promise<{ phone: string | null; email: string | null }> => {
    if (!userId) return { phone: null, email: null };
    const { data: u, error: uPhoneErr } = await admin.from("users").select("phone, email").eq("id", userId).maybeSingle();
    // A failed read is not "no phone on file". Say so, or a crew silently
    // never gets tomorrow's route and nothing anywhere records why.
    if (uPhoneErr) {
      console.error("[read failed] the crew's phone number:", uPhoneErr);
      skipped.push(`A crew's route for ${date} was built but their phone number couldn't be read — no route text went out; they will arrive with nothing but their Today list.`);
      return { phone: null, email: null };
    }
    return { phone: (u?.phone as string) ?? null, email: (u?.email as string) ?? null };
  };

  let routes = 0, stops = 0, overflow = 0, texted = 0, trucks = 0, hoursBust = 0;
  for (const [vendorId, v] of byVendor) {
    const units = unitsByVendor.get(vendorId) ?? [];

    if (units.length === 0) {
      // ZERO crew units — EXACT legacy path (behavior byte-identical to today).
      const plan = planVendorDay(v.stops, v.capacity);
      if (!plan.ordered.length) continue;
      const mapUrl = routeMapUrl(plan.ordered);
      const { data: routeRow, error: rErr } = await admin
        .from("routes")
        .insert({ vendor_id: vendorId, date, stops_order: plan.ordered.map((s) => s.id), drive_minutes: plan.driveMinutes, map_url: mapUrl })
        .select("id")
        .single();
      // SKIP THE VENDOR, NEVER THE REBUILD. Every routes row for this date was
      // deleted above and every scheduled job had its route_id nulled, so
      // returning here left EVERY REMAINING CREW with no route for tomorrow —
      // a wiped calendar, not a stale one. Cron rule 1: one crew's failed
      // insert costs that crew their route and nothing more.
      if (rErr) {
        console.error("[route build] couldn't write a route row:", rErr);
        skipped.push(`One crew (${vendorId}) has no route for ${date} — we couldn't write it. Every other crew's route was built.`);
        continue;
      }
      for (let i = 0; i < plan.ordered.length; i++) {
        await admin.from("jobs").update({ sequence: i + 1, route_id: routeRow.id }).eq("id", plan.ordered[i].id);
      }
      routes++; stops += plan.ordered.length; overflow += plan.overflow.length;
      const crew = await vendorContactFor(v.user_id);
      if (crew.phone || crew.email) {
        // EVERY DOOR. This IS tomorrow's work — where to go and in what order.
        // On text alone it has reached nobody since July, and a crew with no
        // route arrives with nothing but their Today list.
        const told = await notify(
          `a crew their route for ${prettyDate(date)}`,
          crew,
          {
            sms: `LakeLife route for ${prettyDate(date)}: ${plan.ordered.length} stops, ~${plan.driveMinutes} min drive.${mapUrl ? " Map: " + mapUrl : ""} Details in your Today list. 🌊`,
            subject: `Your route for ${prettyDate(date)}: ${plan.ordered.length} stops`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
        texted++;
      }
      continue;
    }

    // Fleet path: N trucks, one routes row (and one SMS) each.
    const vendorBase = v.baseLat != null && v.baseLng != null ? { lat: v.baseLat, lng: v.baseLng } : null;
    const plan = planFleetDay(v.stops, units, vendorBase);
    overflow += plan.overflow.length;
    const vendorContact = await vendorContactFor(v.user_id);
    // sequence runs CONTINUOUSLY across trucks (Truck 1: 1..n, Truck 2:
    // n+1..m) — the vendor Today list orders by sequence and would
    // interleave the trucks if each restarted at 1. Each truck's own
    // stop order still lives in routes.stops_order and its map link.
    let seq = 0;
    let truckWriteFailed = false;
    for (const tp of plan.trucks) {
      if (!tp.ordered.length) continue;
      const mapUrl = routeMapUrl(tp.ordered);
      const { data: routeRow, error: rErr } = await admin
        .from("routes")
        .insert({
          vendor_id: vendorId,
          date,
          stops_order: tp.ordered.map((s) => s.id),
          drive_minutes: tp.driveMinutes,
          map_url: mapUrl,
          crew_unit_id: tp.truck.id,
          unit_name: tp.truck.name,
          drive_km: tp.driveKm,
        })
        .select("id")
        .single();
      if (rErr) {
        console.error("[route build] couldn't write a truck's route row:", rErr);
        skipped.push(`One crew (${vendorId}) has an incomplete route for ${date} — a truck's route wouldn't write. Every other crew's route was built.`);
        truckWriteFailed = true;
        break;
      }
      for (let i = 0; i < tp.ordered.length; i++) {
        seq++;
        await admin.from("jobs").update({ sequence: seq, route_id: routeRow.id }).eq("id", tp.ordered[i].id);
      }
      routes++; stops += tp.ordered.length; trucks++;
      if (!tp.fitsHours) hoursBust++;
      const phone = tp.truck.phone ?? vendorContact.phone;
      // A truck with its OWN number is its own crew, and crew_units holds no
      // email address — so the second door exists only where this falls back
      // to the vendor's own number. Where it doesn't, the route still rides
      // the dead channel alone and `notify` is what says so out loud.
      const email = tp.truck.phone ? null : vendorContact.email;
      if (phone || email) {
        let msg = `LakeLife route for ${prettyDate(date)} — ${tp.truck.name}: ${tp.ordered.length} stops, ~${tp.driveMinutes} min drive.${mapUrl ? " Map: " + mapUrl : ""} 🌊`;
        if (!tp.fitsHours) msg += " Heads up: this day runs past your hours — tap Availability to adjust.";
        const told = await notify(
          `a crew their ${tp.truck.name} route for ${prettyDate(date)}`,
          { phone, email },
          {
            sms: msg,
            subject: `${tp.truck.name} — your route for ${prettyDate(date)}: ${tp.ordered.length} stops`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
        texted++;
      }
    }
    // This crew's route is incomplete; don't also tell them what overflowed
    // from a plan we failed to write. The next crew still gets theirs.
    if (truckWriteFailed) continue;
    if (plan.overflow.length > 0 && (vendorContact.phone || vendorContact.email)) {
      const told = await notify(
        "a crew that some jobs didn't fit tomorrow's trucks",
        vendorContact,
        {
          sms: `LakeLife: ${plan.overflow.length} job${plan.overflow.length === 1 ? "" : "s"} didn't fit tomorrow's trucks — ops has them. 🌊`,
          subject: `${plan.overflow.length} job${plan.overflow.length === 1 ? "" : "s"} didn't fit tomorrow's trucks`,
        },
      );
      if (!told.reached && told.note) skipped.push(told.note);
    }
  }
  return { ok: true, date, routes, stops, overflow, texted, trucks, hoursBust, skipped };
}

export interface SettleOutcome {
  ok: boolean;
  invoiced?: boolean;
  charged?: boolean;
  error?: string;
  /**
   * THINGS THAT WENT WRONG WITHOUT STOPPING THE SETTLE, in human words.
   *
   * A settle can return ok:true having quietly failed to pay a crew or failed
   * to raise the alarm on a charge the ledger refused. Those used to exist
   * only as a console line on a server nobody reads. Absent when nothing went
   * wrong — the reconcile rail carries whatever is here into the digest.
   */
  notes?: string[];
}

/**
 * MONEY LEFT THE CUSTOMER AND THE LEDGER REFUSED TO RECORD IT.
 *
 * `payments_one_capture_per_invoice` (0024) permits exactly one captured row
 * per invoice. Charge paths used to hit the processor first and then discard
 * the insert's error, so a race meant a real charge with no record — and only
 * a person can hand that back. It is the one failure that has to reach a human
 * the same night.
 */
export async function alertOpsDoubleCharge(
  admin: ReturnType<typeof createServiceClient>,
  subjectId: string,
  amount: number,
  ref: string | null,
  // A tip has no invoice at all (0097) — it hangs off the job — so the email
  // has to name the right thing or ops goes looking for an invoice that was
  // never raised.
  against: "invoice" | "tip" = "invoice",
  // WHETHER A HUMAN WAS ACTUALLY REACHED. This used to return nothing, which
  // made "the alert went out" and "the alert reached nobody" the same value at
  // every call site. The caller can now say so where somebody reads it.
): Promise<{ notified: number }> {
  let notified = 0;
  try {
    const amt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
    const what = against === "tip"
      ? `as a tip on visit <code>${subjectId}</code> and the ledger refused the ` +
        `payment row — a captured tip already exists for that visit`
      : `against invoice <code>${subjectId}</code> and the ledger refused the ` +
        `payment row — an earlier capture already exists for that invoice`;
    const { data: opsUsers, error: opsErr } = await admin
      .from("users").select("email").eq("role", "ops").not("email", "is", null);
    // Nothing retries this, so the log is the last line of defence: a real
    // charge, no ledger row, and now nobody told either.
    if (opsErr) console.error("[read failed] the ops emails for a CHARGED-BUT-NOT-RECORDED alert:", opsErr);
    for (const u of opsUsers ?? []) {
      const to = u.email as string | null;
      if (!to) continue;
      const res = await sendEmail({
        to,
        subject: `⚠️ CHARGED BUT NOT RECORDED — ${amt}`,
        html:
          `<p>A card was charged <b>${amt}</b> ${what}.</p>` +
          `<p>The money left the customer. Processor reference: ` +
          `<code>${ref ?? "none returned"}</code>.</p>` +
          `<p><b>This needs a refund today.</b> Nothing automatic will fix it.</p>`,
      });
      if (res.ok) notified++;
    }
  } catch {
    /* nothing here may throw into a payment path */
  }
  // THE ALERT ITSELF FAILED. A failed ops read, an ops table with nobody in
  // it, an unconfigured mailer — all three end the same way: a real charge,
  // no ledger row, and now no alert either. Nothing retries this and nothing
  // else in the system knows it happened, so the log line has to carry the
  // whole fact (amount and processor reference) rather than point at a row
  // that was never written. The caller carries it to the digest.
  //
  // INSIDE ITS OWN TRY, for the same reason as the block above. This runs on a
  // path where the card HAS ALREADY BEEN CHARGED, and `amount.toFixed(2)`
  // throws if a caller ever hands it something that is not a number — which
  // would propagate out of the alert and into the payment path that the catch
  // above exists to protect. A log line must never be the thing that breaks a
  // settle.
  if (notified === 0) {
    try {
      console.error(
        `[alert unsent] a card was charged $${Number(amount).toFixed(2)} against ${against} ${subjectId} ` +
        `and the ledger refused the payment row — and NOBODY WAS EMAILED. ` +
        `Processor reference: ${ref ?? "none returned"}. This needs a refund today.`,
      );
    } catch {
      console.error("[alert unsent] a card was charged and the ledger refused it; nobody was emailed.", subjectId, ref);
    }
  }
  return { notified };
}

/**
 * A SETTLE THAT DIDN'T COLLECT, SAID OUT LOUD — to the customer and to ops.
 *
 * Both failure paths (no card on file, card declined) used to end in silence:
 * the invoice sat 'due', the receipt email lived inside the success branch,
 * and the crew's payout had already been released. The first anyone noticed
 * was a customer seeing repeated attempts on a statement.
 *
 * Deliberately does NOT hold or claw back the crew's payout. The crew did the
 * work; whether the customer's card cleared is not their problem, and taking
 * a crew's money back for it is how you lose crews. The exposure sits with
 * LakeLife, which is where it belongs — but it must be VISIBLE, not silent.
 *
 * Nothing here throws. A settle must not fail because a notification did.
 */
async function noteSettleFailure(
  admin: ReturnType<typeof createServiceClient>,
  f: {
    jobId: string;
    ownerId: string | null | undefined;
    svcName: string;
    address: string | null;
    amount: number;
    reason: "no_card" | "declined";
  },
): Promise<void> {
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const amt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(f.amount);
    const where = f.address ?? "your property";

    if (f.ownerId) {
      const { data: owner, error: ownerErr } = await admin
        .from("users").select("email, name").eq("id", f.ownerId).maybeSingle();
      if (ownerErr) console.error("[read failed] the owner's email for an uncollected job:", ownerErr);
      const email = owner?.email as string | null;
      if (email) {
        const why = f.reason === "no_card"
          ? "We don't have a card on file for you yet"
          : "Your card on file was declined";
        await sendEmail({
          to: email,
          subject: `Action needed — ${amt} for your ${f.svcName}`,
          html:
            `<p>Hi ${(owner?.name as string) ?? "there"},</p>` +
            `<p>Your ${f.svcName} at ${where} is done — thank you.</p>` +
            `<p><b>${why}</b>, so the ${amt} hasn't been paid yet.</p>` +
            `<p><a href="${site}/billing">Add or update your card</a> and we'll take care of it. ` +
            `Nothing else is needed from you.</p>` +
            `<p>🌊</p>`,
        });
      }
    }

    // Ops needs to know a completed job is unpaid, because the crew has
    // already been paid for it and nothing else in the system will say so.
    const { data: opsUsers, error: opsErr } = await admin
      .from("users").select("email").eq("role", "ops").not("email", "is", null);
    if (opsErr) console.error("[read failed] the ops emails for an unpaid completed job:", opsErr);
    for (const u of opsUsers ?? []) {
      const to = u.email as string | null;
      if (!to) continue;
      await sendEmail({
        to,
        subject: `Unpaid completed job — ${amt}`,
        html:
          `<p>${f.svcName} at ${where} completed and did not collect.</p>` +
          `<p>Reason: <b>${f.reason === "no_card" ? "no card on file" : "card declined"}</b>. ` +
          `Amount: <b>${amt}</b>.</p>` +
          `<p>The crew's payout was released as normal — they did the work. ` +
          `<a href="${site}/ops/jobs/${f.jobId}">Open the job</a>.</p>`,
      });
    }
  } catch {
    /* A settle must never fail because an email did. */
  }
}

/**
 * Ensure a COMPLETED job is fully settled: a payout exists, an invoice exists,
 * and (if the owner has a saved card) the customer is charged once with a
 * receipt. IDEMPOTENT and reconcilable — it checks-then-writes each row, so
 * running it twice never double-bills, and a reconcile sweep can safely re-run
 * it for any job that was completed but left partially settled (e.g. a crash
 * between writes). Auth is the caller's job (service-role only). rule 4: only
 * the vault token is ever charged.
 */
export async function settleJob(jobId: string): Promise<SettleOutcome> {
  const admin = createServiceClient();
  // Things that did not stop the settle but that nothing else will ever
  // mention. Stays empty on a clean run; see SettleOutcome.notes.
  const notes: string[] = [];
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, status, customer_price, vendor_cost, vendor_id, property_id, margin, group_id, phase, price_finalized, correction_of, services(name)")
    .eq("id", jobId)
    .maybeSingle();
  // "job not found" is a FACT about the database. A failed read knows no such
  // fact, and everything below it moves money — so it stops instead of guessing.
  if (jobErr) {
    console.error(`[read failed] the job being settled (${jobId}):`, jobErr);
    return { ok: false, error: "couldn't read the job" };
  }
  if (!job) return { ok: false, error: "job not found" };
  if (!["complete", "paid"].includes(job.status as string)) return { ok: false, error: "job not complete" };
  // Make-It-Right correction visits are FREE by design: no invoice, no
  // charge, no payout — the photo-gated completion is the point, and the
  // dispute resolution (lib/disputes.ts) owns what happens next.
  if ((job as { correction_of?: string | null }).correction_of) return { ok: true, invoiced: false, charged: false };
  const svcName = (one(job.services) as { name?: string } | null)?.name ?? "service";

  // SPRING SPLASH FINALIZE (S4, review-hardened): EVERY settle path —
  // completeJob's inline call AND the nightly reconcile — finalizes the
  // spring price BEFORE any invoice exists: quoted total + the overstay
  // meter (days past season end × the daily dial), the meter as its own
  // line item so items always sum to the bill. Guarded exactly-once; a
  // failed finalize ABORTS the settle (the reconcile rail retries), so
  // the card can never be charged the unfinalized number.
  if (job.phase === "spring" && job.group_id && job.price_finalized === false) {
    const { data: stay, error: stayErr } = await admin
      .from("storage_stays").select("id, intake_at, status").eq("group_id", job.group_id as string)
      .eq("status", "in_storage").maybeSingle();
    // No stay reads as no overstay meter, and the price finalizes exactly ONCE:
    // a failed read here would bill the bare quote and close that number
    // forever. Abort, exactly as a failed finalize does — the rail retries.
    if (stayErr) {
      console.error(`[read failed] the boat's storage stay (${jobId}):`, stayErr);
      return { ok: false, error: "couldn't read the storage stay" };
    }
    let addOn = 0;
    if (stay?.intake_at) {
      const { seasonEndFor, overstayDays, perdiemCharge } = await import("@/lib/storage");
      const dials = await getPlatformSettings();
      const end = seasonEndFor((stay.intake_at as string).slice(0, 10), dials.storageSeasonEndMonth, dials.storageSeasonEndDay);
      addOn = perdiemCharge(overstayDays(todayLakeDate(), end), dials.storagePerdiemDaily);
    }
    const finalPrice = Math.round((Number(job.customer_price ?? 0) + addOn) * 100) / 100;
    const { data: finalized, error: finErr } = await admin
      .from("jobs")
      .update({
        customer_price: finalPrice,
        margin: job.vendor_cost != null ? Math.round((finalPrice - Number(job.vendor_cost)) * 100) / 100 : null,
        price_finalized: true,
      })
      .eq("id", jobId)
      .eq("price_finalized", false)
      .select("id");
    if (finErr) return { ok: false, error: `spring finalize failed: ${finErr.message}` };
    if (finalized && finalized.length > 0) {
      job.customer_price = finalPrice; // the number every step below bills
      if (addOn > 0) {
        // The meter as its own honest line (items must sum to the bill).
        const { data: meterSvc, error: meterErr } = await admin
          .from("services").select("id").eq("name", "Storage overstay (per-diem)").maybeSingle();
        // The bill is already right; a failed read costs only the line that
        // explains it — but items that don't sum is exactly what gets queried.
        if (meterErr) console.error(`[read failed] the overstay line item (${jobId}):`, meterErr);
        if (meterSvc) {
          await admin.from("job_items").insert({
            job_id: jobId, service_id: meterSvc.id, customer_price: addOn, vendor_cost: 0,
          });
        }
      }
    }
    // Custody closes with the splash — release the stay, complete the season.
    if (stay) {
      await admin.from("storage_stays")
        .update({ status: "released", out_at: new Date().toISOString() })
        .eq("id", stay.id as string).eq("status", "in_storage");
    }
    await admin.from("job_groups").update({ status: "completed" }).eq("id", job.group_id as string).eq("status", "active");
  }

  // A 👎 can land before settle runs (reconcile path especially). An open
  // dispute means TWO things here: a payout born onto this job is born
  // HELD, and the CHARGE step stays quiet — charging a card mid-dispute
  // days after completion, possibly right before an auto-refund, is
  // processor fees both ways and reads terribly (review finding). The
  // reconcile rail retries the charge after resolution.
  const { data: openDispute, error: disputeErr } = await admin
    .from("disputes").select("id").eq("job_id", jobId)
    .in("status", ["crew_review", "fixing", "verifying", "talk", "escalated"]).maybeSingle();
  // FAILS OPEN IF IGNORED: a failed read reads as "no dispute", which releases
  // the payout and charges the card mid-dispute — the two things this read
  // exists to prevent. Stop; the reconcile rail retries after resolution.
  if (disputeErr) {
    console.error(`[read failed] any open dispute on this job (${jobId}):`, disputeErr);
    return { ok: false, error: "couldn't check for an open dispute" };
  }

  // 1) Payout — release once (photo-verified completion already happened).
  const { data: existingPayout, error: payoutReadErr } = await admin.from("payouts").select("id").eq("job_id", jobId).eq("kind", "earning").maybeSingle();
  // FAILS OPEN IF IGNORED: null reads as "no payout yet" and pays the crew a
  // second time for the same job.
  if (payoutReadErr) {
    console.error(`[read failed] the crew's existing payout (${jobId}):`, payoutReadErr);
    return { ok: false, error: "couldn't check the crew's payout" };
  }
  if (!existingPayout) {
    const { error: pErr } = await admin.from("payouts").insert({
      vendor_id: job.vendor_id,
      job_id: jobId,
      amount: job.vendor_cost,
      original_amount: job.vendor_cost, // immutable "ever owed" anchor — refund clawback conservation
      status: openDispute ? "held" : job.vendor_cost != null ? "released" : "pending",
    });
    // THE CREW'S MONEY, AND NOTHING COMES BACK FOR IT. Deliberately does not
    // abort the settle — the customer's charge is not the crew's problem — but
    // the reconcile sweep only revisits jobs whose INVOICE is unpaid, so a
    // payout that failed to insert on a job that then charged cleanly is never
    // retried and, until now, never mentioned anywhere a person looks.
    if (pErr) {
      console.error(`[settleJob ${jobId}] payout insert failed:`, pErr.message);
      notes.push(`the crew's payout row was refused (${pErr.message}) — they have not been paid for this job and nothing retries it`);
    }
  }

  // 2) Invoice — one per job. Reuse an existing row rather than creating a second.
  const { data: invoiceRow, error: invoiceReadErr } = await admin.from("invoices").select("id, status").eq("job_id", jobId).maybeSingle();
  // FAILS OPEN IF IGNORED: null reads as "no invoice yet" and raises a second
  // bill for the same job.
  if (invoiceReadErr) {
    console.error(`[read failed] this job's invoice (${jobId}):`, invoiceReadErr);
    return { ok: false, error: "couldn't read the invoice" };
  }
  let invoice = invoiceRow;
  if (!invoice) {
    const { data: created, error: iErr } = await admin
      .from("invoices")
      .insert({ job_id: jobId, property_id: job.property_id, amount: job.customer_price, status: "due" })
      .select("id, status")
      .single();
    if (iErr || !created) {
      console.error(`[settleJob ${jobId}] invoice insert failed:`, iErr?.message);
      return { ok: false, error: iErr?.message ?? "invoice insert failed" };
    }
    invoice = created;
  }

  // 3) Charge — only if not already paid, there's a positive price, the owner
  //    has a saved card, and no captured payment already exists for this invoice.
  let charged = false;
  const price = job.customer_price == null ? 0 : Number(job.customer_price);
  if (invoice.status !== "paid" && price > 0 && job.property_id && !openDispute) {
    const { data: prop, error: propErr } = await admin
      .from("properties")
      .select("address, owner_id, users(email, name)")
      .eq("id", job.property_id)
      .maybeSingle();
    // A failed read looks exactly like a property with no owner, which skips
    // the charge in silence and still returns "settled".
    if (propErr) {
      console.error(`[read failed] the property and its owner (${jobId}):`, propErr);
      return { ok: false, error: "couldn't read the property" };
    }
    const ownerId = (prop?.owner_id as string) ?? null;
    const { data: paid, error: paidErr } = await admin
      .from("payments")
      .select("id")
      .eq("invoice_id", invoice.id)
      .eq("status", "captured")
      .maybeSingle();
    // FAILS OPEN IF IGNORED: null reads as "not paid yet" and charges a card
    // that has already been charged for this invoice.
    if (paidErr) {
      console.error(`[read failed] whether this invoice was already paid (${jobId}):`, paidErr);
      return { ok: false, error: "couldn't check whether this was already paid" };
    }
    if (!paid && ownerId) {
      // SERVICE CREDITS first (§8b: homeowner referral rewards are credits, not
      // cash — no 1099s, and the money comes home as bookings). Idempotent:
      // exactly one application row per invoice (partial unique index); a
      // re-run reuses the existing application instead of double-spending.
      let creditApplied = 0;
      // A failed credits read is NOT a zero balance: it charges the full price
      // to a card that should have been reduced, or not charged at all. The
      // grant staying a bonus is unchanged — what moves is the CHARGE, by one
      // night, because the reconcile rail comes back for it.
      let creditReadFailed = false;
      try {
        const { data: existingApp, error: appErr } = await admin
          .from("user_credits").select("amount").eq("invoice_id", invoice.id).maybeSingle();
        // A READ. This one blocks the settle — see the catch below.
        if (appErr) { creditReadFailed = true; throw appErr; }
        if (existingApp) {
          creditApplied = Math.abs(Number(existingApp.amount ?? 0));
        } else {
          const { data: creditRows, error: creditErr } = await admin.from("user_credits").select("amount").eq("user_id", ownerId);
          // Also a READ — the balance that decides what the card is charged.
          if (creditErr) { creditReadFailed = true; throw creditErr; }
          const balance = (creditRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
          const apply = creditToApply(balance, price);
          if (apply > 0) {
            const { error: capErr } = await admin.from("user_credits").insert({
              user_id: ownerId, amount: -apply, reason: `Applied to ${svcName}`, invoice_id: invoice.id,
            });
            if (!capErr) creditApplied = apply;
          }
        }
      } catch (e) {
        // A failed GRANT is still just a bonus lost — credits never block a
        // settle. Not knowing the BALANCE is a different thing: it decides what
        // the card is charged, so the charge waits a night rather than billing
        // the full price to somebody whose credits covered it.
        //
        // NARROWED: the flag is now set at the two READS above, not here. This
        // catch also receives a rejected promise from the credit APPLICATION
        // insert, and setting the flag for that blocked the settle — which the
        // paragraph above says never happens.
        console.error(`[read failed] this customer's service credits (${jobId}):`, e);
      }
      if (creditReadFailed) return { ok: false, error: "couldn't read the customer's credits" };
      const cashDue = Math.round((price - creditApplied) * 100) / 100;

      const { data: pm, error: pmErr } = await admin
        .from("payment_methods")
        .select("token, last4, brand")
        .eq("user_id", ownerId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      // THE LIE THIS PREVENTS: a failed read is indistinguishable from an empty
      // wallet, and the final `else` below emails the customer "We don't have a
      // card on file for you yet" — to somebody whose card is on file.
      if (pmErr) {
        console.error(`[read failed] the customer's saved card (${jobId}):`, pmErr);
        return { ok: false, error: "couldn't read the customer's saved card" };
      }
      if (cashDue <= 0 && creditApplied > 0) {
        // Fully covered by credits — no card involved, invoice settles clean.
        await admin.from("invoices").update({ status: "paid", processor_ref: "credits" }).eq("id", invoice.id);
        charged = true;
        const owner = one((prop as { users?: unknown } | null)?.users) as { email?: string; name?: string } | null;
        if (owner?.email) {
          void sendEmail({
            to: owner.email,
            subject: `Your LakeLife receipt — ${svcName}`,
            html: `<p>Hi ${owner.name ?? "there"},</p><p>Your ${svcName} at ${prop?.address ?? "your property"} is complete.</p><p><b>Covered entirely by your referral credits</b> ($${creditApplied.toFixed(2)}) — nothing charged to your card. Thanks for spreading the word. 🌊</p>`,
          });
        }
      } else if (pm?.token) {
        const charge = await LakeLifePayments.charge({ token: pm.token as string, amountCents: Math.round(cashDue * 100), description: statementDescriptor("service") });
        const { error: payErr } = await admin.from("payments").insert({
          invoice_id: invoice.id,
          amount: cashDue,
          status: charge.ok ? "captured" : "failed",
          processor_ref: charge.ref ?? null,
        });
        // Charged, and the ledger wouldn't take it. See alertOpsDoubleCharge.
        if (payErr?.code === "23505" && charge.ok) {
          const alerted = await alertOpsDoubleCharge(admin, invoice.id as string, cashDue, charge.ref ?? null);
          // The alert IS the safety net here, and it hangs off a read of its
          // own (the ops mailboxes). If that read failed — or there was nobody
          // to email — the one failure that has to reach a human the same
          // night reached nobody, and only the digest can still say so.
          if (alerted.notified === 0) {
            notes.push(`a card was charged $${cashDue.toFixed(2)} and the ledger refused the payment row — and the CHARGED-BUT-NOT-RECORDED alert reached nobody. Needs a refund today.`);
          }
        }
        await admin.from("invoices").update({ status: charge.ok ? "paid" : "due", processor_ref: charge.ref ?? null }).eq("id", invoice.id);
        charged = charge.ok;
        const owner = one((prop as { users?: unknown } | null)?.users) as { email?: string; name?: string } | null;
        if (charge.ok && owner?.email) {
          const amt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cashDue);
          const creditLine = creditApplied > 0 ? ` (after $${creditApplied.toFixed(2)} in referral credits)` : "";
          void sendEmail({
            to: owner.email,
            subject: `Your LakeLife receipt — ${svcName}`,
            html: `<p>Hi ${owner.name ?? "there"},</p><p>Your ${svcName} at ${prop?.address ?? "your property"} is complete.</p><p><b>Charged: ${amt}</b>${creditLine}${pm.brand ? ` to your ${pm.brand} ending ${pm.last4}` : ""}.</p><p>Thank you. 🌊</p>`,
          });
        }
        // THE CARD SAID NO. The receipt above is inside `charge.ok`, so this
        // used to be the end of it: a failed payments row, an invoice quietly
        // left 'due', and not one word to anybody. The customer's next signal
        // was their card being retried every night.
        if (!charge.ok) {
          await noteSettleFailure(admin, {
            jobId, ownerId, svcName,
            address: (prop?.address as string) ?? null,
            amount: cashDue,
            reason: "declined",
          });
        }
      } else {
        // NO CARD ON FILE AT ALL — and there was no `else` here, so this path
        // did nothing whatsoever. The job completed, the crew's payout was
        // already released, the invoice sat 'due' forever, and the job page
        // cheerfully printed "We'll run this on your card on file" when there
        // was no card on file. Nobody found out until somebody read a ledger.
        await noteSettleFailure(admin, {
          jobId, ownerId, svcName,
          address: (prop?.address as string) ?? null,
          amount: cashDue,
          reason: "no_card",
        });
      }

      // REFERRAL ACCRUALS — only after money actually COLLECTED this run, and
      // only on the CASH portion (never commission on our own credits — that
      // would let credits recycle into more credits). Idempotent: one accrual
      // per (beneficiary, job, kind) via unique index.
      if (charged && cashDue > 0) {
        try {
          await accrueReferralEarnings(admin, {
            jobId, ownerId, vendorId: (job.vendor_id as string) ?? null,
            cashCollected: cashDue, price, margin: Number((job as { margin?: number }).margin ?? 0),
          });
        } catch { /* accrual is a bonus — never block a settle */ }
      }
    }
  }

  // The spread keeps a clean settle byte-identical to what it always returned.
  return { ok: true, invoiced: true, charged, ...(notes.length > 0 ? { notes } : {}) };
}

/** §8b accrual hooks — called by settleJob strictly AFTER cash collection. */
async function accrueReferralEarnings(
  admin: ReturnType<typeof createServiceClient>,
  p: { jobId: string; ownerId: string; vendorId: string | null; cashCollected: number; price: number; margin: number },
): Promise<void> {
  const settings = await getPlatformSettings();
  const cashRatio = p.price > 0 ? p.cashCollected / p.price : 0;

  // Arm 1+2: the customer was referred — by a neighbor (customer_referral)
  // or by the crew who imported them (cross_sell, only when someone ELSE did
  // this job; the importer is already paid their rate when they do the work).
  const { data: refUser, error: refUserErr } = await admin.from("users").select("id, referred_by, created_at").eq("id", p.ownerId).maybeSingle();
  // Reads as "nobody referred them" and quietly loses a reward that only ever
  // accrues once, at settle. Nothing can retry it, so at least it is on record.
  if (refUserErr) console.error(`[read failed] who referred this customer (${p.jobId}):`, refUserErr);
  const referrerId = (refUser?.referred_by as string) ?? null;
  if (referrerId && withinSunset((refUser?.created_at as string) ?? null, Date.now(), settings.referralSunsetDays)) {
    const { data: refVendor, error: refVendorErr } = await admin.from("vendors").select("id").eq("user_id", referrerId).maybeSingle();
    let kind: "customer_referral" | "cross_sell" | null = null;
    let pct = 0;
    // FAILS OPEN IF IGNORED: null reads as "the referrer is not a crew", which
    // pays a CREW at the customer rate, or pays them for their own job. Leaving
    // `kind` null skips this arm only — the crew-referral arm below still runs.
    if (refVendorErr) {
      console.error(`[read failed] whether the referrer is a crew (${p.jobId}):`, refVendorErr);
    } else if (!refVendor) {
      kind = "customer_referral";
      pct = settings.referralCustomerPct;
    } else if (p.vendorId && refVendor.id !== p.vendorId) {
      kind = "cross_sell";
      pct = settings.referralCrossSellPct;
    }
    if (kind && pct > 0) {
      const amount = customerReferralAccrual(p.cashCollected, pct);
      if (amount > 0) {
        const { error: aErr } = await admin.from("referral_earnings").insert({
          beneficiary: referrerId, kind, source_job: p.jobId, source_vendor: p.vendorId, amount,
        }); // unique (beneficiary, job, kind) — re-runs no-op on the index
        if (aErr && !/duplicate|unique/i.test(aErr.message)) console.error(`[referral ${p.jobId}] ${kind} accrual failed:`, aErr.message);
      }
    }
  }

  // Arm 3: this job's crew was BROUGHT by someone — share of collected margin
  // until the lifetime cap for that (bringer, crew) pair. Self-financing.
  if (p.vendorId && p.margin > 0) {
    const { data: crew, error: crewErr } = await admin.from("vendors").select("invited_by").eq("id", p.vendorId).maybeSingle();
    if (crewErr) console.error(`[read failed] who brought this crew aboard (${p.jobId}):`, crewErr);
    const bringer = (crew?.invited_by as string) ?? null;
    if (bringer && bringer !== p.ownerId) { // no earning on your own bills
      const { data: prior, error: priorErr } = await admin
        .from("referral_earnings")
        .select("amount")
        .eq("beneficiary", bringer)
        .eq("source_vendor", p.vendorId)
        .eq("kind", "crew_referral")
        .neq("status", "void");
      // FAILS OPEN IF IGNORED: a failed read reads as "nothing accrued yet",
      // which restarts the lifetime cap at zero and overpays the bringer.
      if (priorErr) {
        console.error(`[read failed] this bringer's prior earnings (${p.jobId}):`, priorErr);
        return;
      }
      const already = (prior ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
      const amount = crewShareAccrual(p.margin * cashRatio, settings.referralCrewSharePct, settings.referralCrewCap, already);
      if (amount > 0) {
        const { error: aErr } = await admin.from("referral_earnings").insert({
          beneficiary: bringer, kind: "crew_referral", source_job: p.jobId, source_vendor: p.vendorId, amount,
        });
        if (aErr && !/duplicate|unique/i.test(aErr.message)) console.error(`[referral ${p.jobId}] crew_referral accrual failed:`, aErr.message);
      }
    }
  }
}

/** Reconcile sweep: settle any job that's complete but wasn't fully billed
 *  (invoice missing, or invoice still 'due' with no captured payment). Safe to
 *  run on a schedule — settleJob is idempotent. Bounded scan of recent jobs. */
export async function reconcileUnsettledJobs(): Promise<{ ok: boolean; settled: number; capped: number; skipped: number; failures: string[] }> {
  const admin = createServiceClient();
  // A failed read here reports "0 settled" for a night the reconcile never
  // looked. The nightly route catches this and names the step in the digest,
  // which is the only place anybody would ever find out.
  const jobs = mustRead("completed jobs that may still be unsettled", await admin
    .from("jobs")
    .select("id, invoices(id, status)")
    .eq("status", "complete")
    .is("correction_of", null) // $0 correction visits never invoice — don't rescan them nightly
    .limit(500));
  let settled = 0;
  let capped = 0;
  // A JOB THIS SWEEP COULD NOT FINISH IS NOT A JOB IT FINISHED. `settled` and
  // `capped` between them described a night where every single job was skipped
  // exactly as they described a clean one, and this step's result goes nowhere
  // but an HTTP response. Skips are counted, and the first twenty are worded
  // for the digest — a bad night can touch every job in the scan and the email
  // still has to be readable.
  let skipped = 0;
  let hidden = 0;
  const failures: string[] = [];
  const note = (line: string): void => {
    if (failures.length < 20) failures.push(line);
    else hidden++;
  };
  const noteSkip = (line: string): void => { skipped++; note(line); };
  for (const j of jobs ?? []) {
    const inv = j.invoices as { id?: string; status?: string }[] | { id?: string; status?: string } | null;
    const rows = Array.isArray(inv) ? inv : inv ? [inv] : [];
    const fullyPaid = rows.length > 0 && rows.every((r) => r.status === "paid" || r.status === "refunded");
    if (fullyPaid) continue; // already settled + charged

    // RETRY CAP — the same five-night rule `retryCancellationFees` already
    // applies, for the same reason. Without it this re-ran settleJob on every
    // unpaid complete job EVERY NIGHT, forever, so a customer whose card was
    // declined once got that card re-attempted nightly until they closed it.
    // On a statement that reads as fraud, and card networks penalise it. The
    // invoice stays visibly 'due' on their Billing page either way — the money
    // is not forgotten, we just stop hammering the card and ask them instead.
    const invoiceIds = rows.map((r) => r.id).filter(Boolean) as string[];
    if (invoiceIds.length > 0) {
      const { count: failCount, error: failErr } = await admin
        .from("payments").select("id", { count: "exact", head: true })
        .in("invoice_id", invoiceIds).eq("status", "failed");
      // FAILS OPEN IF IGNORED: an errored count is null, `(null ?? 0) >= 5` is
      // false, and the cap the comment above describes simply does not apply —
      // the card gets hammered a sixth night. A night not retried costs nothing.
      if (failErr) {
        console.error(`[read failed] this invoice's failed attempts (job ${j.id}):`, failErr);
        noteSkip(`Job ${j.id}: couldn't read how many times this card has already been declined, so the settle was skipped rather than risk a sixth retry.`);
        continue;
      }
      if ((failCount ?? 0) >= 5) { capped++; continue; }
    }

    // ONE JOB MUST NEVER TAKE DOWN THE SWEEP. settleJob can throw — the
    // processor call, a dynamic import, a mustRead deeper down — and an
    // uncaught throw here left every REMAINING unsettled job unlooked-at,
    // with the step recorded by name and no hint that the list was truncated.
    let r: SettleOutcome;
    try {
      r = await settleJob(j.id as string);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[settle threw] job ${j.id}:`, e);
      noteSkip(`Job ${j.id}: the settle threw (${why}) — skipped tonight; the rest of the sweep still ran.`);
      continue;
    }
    if (r.ok) settled++;
    // A settle that REFUSED (a failed read on the money path stops rather than
    // guesses) reports its reason and then had nowhere to put it.
    else noteSkip(`Job ${j.id}: not settled — ${r.error ?? "no reason given"}.`);
    // ...and the things it did anyway that nothing else will mention.
    for (const n of r.notes ?? []) note(`Job ${j.id}: ${n}`);
  }
  if (hidden > 0) failures.push(`…and ${hidden} more, in tonight's server log.`);
  return { ok: true, settled, capped, skipped, failures };
}

/**
 * Nightly self-heal: re-validate every assignment for `date` (default tomorrow)
 * before routes build. Jobs whose crew went ineligible (suspended, COI lapsed,
 * blocked, dropped service) waterfall to the next eligible crew; still-unassigned
 * 'requested' jobs get a fresh assignment attempt. Returns counts; anything left
 * unfilled is the ops "needs attention" signal.
 */
/**
 * No-show sweep: a job whose scheduled day has PASSED while still 'scheduled'
 * with ZERO photos was ghosted by its crew. We record the no-show (feeds the
 * crew's reliability score → demotes dispatch rank / Priority), then release the
 * job for a PENALTY-FREE reschedule: crew unassigned, status back to 'requested'
 * (needs a crew), no charge to the customer. Both sides are notified. Idempotent
 * via the unique(job_id) on vendor_no_shows. A job WITH photos is a "forgot to
 * tap complete", not a ghost — left alone for ops.
 */
export async function recordNoShows(): Promise<{ ok: boolean; flagged: number; skipped: string[] }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  // JOBS THIS SWEEP COULD NOT JUDGE TONIGHT. Both guards below skip rather
  // than strike — right, because a strike never clears — but a skipped job is
  // one nobody has looked at, and `{ok:true, flagged:0}` is also what a night
  // with no ghosts looks like. The nightly carries this into the digest.
  const skipped: string[] = [];
  const stale = mustRead("yesterday's still-scheduled jobs", await admin
    .from("jobs")
    .select("id, vendor_id, property_id, date, group_id, phase, held_at, no_show_at, stood_down_at, services(name), properties(address, owner_id, lake_id), vendors(user_id)")
    .lt("date", today)
    .in("status", ["scheduled", "in_progress"])
    .not("vendor_id", "is", null));

  const one = <T>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);
  let flagged = 0;

  for (const j of stale ?? []) {
    // THE CREW DID TURN UP. THIS IS THE ONE THING THIS SWEEP MUST NOT GET
    // WRONG, and until 0084/0088 existed there was no way for it to know.
    //
    // A past scheduled job with a crew and no photos looks identical whether
    // the crew never went, or went and was locked out, or went and was stood
    // down by the owner, or is sitting held while the owner decides. In three
    // of those four the crew was in the driveway — and this writes a
    // `vendor_no_shows` strike, which `demoteLakeStrikes` counts until the
    // crew loses that lake entirely.
    //
    // So it would strike a crew FOR HONESTLY REPORTING that the customer
    // wasn't there. That is the exact behaviour the whole arrival flow
    // depends on, punished. Same shape as the custody guard below, and the
    // same fix: check before recording, not after.
    const arrival = j as { held_at?: string | null; no_show_at?: string | null; stood_down_at?: string | null };
    if (arrival.no_show_at || arrival.stood_down_at || arrival.held_at) continue;

    const { count, error: photoErr } = await admin.from("job_photos").select("id", { count: "exact", head: true }).eq("job_id", j.id as string);
    // FAILS OPEN IF IGNORED: an errored count is null, `(null ?? 0) > 0` is
    // false, and a crew who DID the work and photographed it takes a permanent
    // no-show strike (unique(job_id) — it never clears) while their finished
    // job is unassigned and repriced. Skip it; tomorrow's sweep looks again.
    if (photoErr) {
      console.error(`[read failed] the job's photos (${j.id}):`, photoErr);
      skipped.push(`Job ${j.id} (${j.date}): couldn't count its photos, so we did NOT record a no-show — no strike, no release; tomorrow's sweep looks again.`);
      continue;
    }
    if ((count ?? 0) > 0) continue; // photos on file → not a ghost, leave for ops

    // CUSTODY GUARD, BEFORE ANYTHING IS RECORDED. A sticky spring splash whose
    // boat is physically in the assigned crew's barn is never released to the
    // lottery and never strikes the barn holding it — only that vendor CAN do
    // the work. This used to sit BELOW the insert, so the strike it exists to
    // prevent was written first: `unique(job_id)` meant it never cleared, and
    // `demoteLakeStrikes` counted it forever, eventually dropping the crew's
    // whole lake — over a boat still in their building. The overstay meter and
    // the ops Storage ledger carry the pressure instead.
    if ((j as { phase?: string }).phase === "spring" && (j as { group_id?: string }).group_id) {
      const { data: custody, error: custodyErr } = await admin
        .from("storage_stays").select("id").eq("group_id", (j as { group_id?: string }).group_id as string)
        .eq("status", "in_storage").limit(1);
      // FAILS OPEN IF IGNORED: null reads as "no boat in the barn" — precisely
      // the strike this guard was written to prevent, and it never clears.
      if (custodyErr) {
        console.error(`[read failed] whether the boat is still in the barn (${j.id}):`, custodyErr);
        skipped.push(`Job ${j.id} (${j.date}): couldn't tell whether the boat is still in the crew's barn, so we did NOT record a no-show — no strike; tomorrow's sweep looks again.`);
        continue;
      }
      if (custody && custody.length > 0) continue;
    }

    // Record the no-show (idempotent), stamped with the LAKE it happened on —
    // that's what drives the per-lake auto-demotion (Phase E). If the lake_id
    // column doesn't exist yet (migration 0021 pending), fall back to the
    // legacy shape — the sweep itself must never silently stop.
    const missLake = (one(j.properties) as { lake_id?: string } | null)?.lake_id ?? null;
    let insErr = (
      await admin.from("vendor_no_shows").insert({
        vendor_id: j.vendor_id, job_id: j.id, property_id: j.property_id, scheduled_date: j.date, lake_id: missLake,
      })
    ).error;
    if (insErr && /lake_id/i.test(insErr.message)) {
      insErr = (
        await admin.from("vendor_no_shows").insert({
          vendor_id: j.vendor_id, job_id: j.id, property_id: j.property_id, scheduled_date: j.date,
        })
      ).error;
    }
    if (insErr) continue; // unique(job_id) violation = already handled

    // Penalty-free release: unassign, wipe the priced amounts, back to needs-a-crew.
    await admin.from("jobs").update({ vendor_id: null, vendor_cost: null, margin: null, status: "requested" }).eq("id", j.id);
    flagged++;

    const svc = (one(j.services) as { name?: string } | null)?.name ?? "your service";
    const prop = one(j.properties) as { address?: string; owner_id?: string } | null;
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

    // Owner: no charge, easy reschedule.
    if (prop?.owner_id) {
      const { data: owner, error: ownerErr } = await admin.from("users").select("phone, email").eq("id", prop.owner_id).maybeSingle();
      // POST-WRITE: the strike is recorded and the job already unassigned, so
      // refusing here would undo nothing — but the customer's crew has
      // vanished off their calendar and nobody has told them.
      if (ownerErr) {
        console.error(`[read failed] the owner's phone number (job ${j.id}):`, ownerErr);
        skipped.push(`Job ${j.id} (${j.date}): released for a free rebook, but we couldn't read the owner's phone number — they were not told their crew missed it.`);
      }
      // EVERY DOOR: their crew has just come off the calendar. On text alone
      // the first they hear of it is an empty driveway.
      if (owner?.phone || owner?.email) {
        const told = await notify(
          `the owner that their crew missed ${svc} (job ${j.id})`,
          { phone: owner?.phone as string | null, email: owner?.email as string | null },
          {
            sms: `LakeLife: your crew couldn't make ${svc} at ${prop?.address ?? "your place"} — no charge. Pick any open day to rebook: ${site}/book 🌊`,
            subject: `Your crew couldn't make ${svc} at ${prop?.address ?? "your place"}`,
            body:
              `Your crew couldn't make ${svc} at ${prop?.address ?? "your place"}, and you were not charged.\n\n` +
              `Pick any open day to rebook:\n  ${site}/book`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
      }
    }
    // Crew: reliability warning (standing-based, no fine).
    const crewUser = (one(j.vendors) as { user_id?: string } | null)?.user_id;
    if (crewUser) {
      const { data: cu, error: cuErr } = await admin.from("users").select("phone, email").eq("id", crewUser).maybeSingle();
      // POST-WRITE, and the one that matters most to the crew: the strike is
      // already on their record and counts toward losing the lake.
      if (cuErr) {
        console.error(`[read failed] the crew's phone number (job ${j.id}):`, cuErr);
        skipped.push(`Job ${j.id} (${j.date}): a no-show strike was recorded but we couldn't read the crew's phone number — they were never told their standing moved.`);
      }
      // EVERY DOOR: this strike counts toward losing a lake, and a crew that
      // is never told has no way to change what causes it.
      if (cu?.phone || cu?.email) {
        const told = await notify(
          `the crew that a missed job is on their record (job ${j.id})`,
          { phone: cu?.phone as string | null, email: cu?.email as string | null },
          {
            sms: `LakeLife: a scheduled job was marked missed and affects your standing. If something came up, block the day ahead next time — no penalty for advance notice.`,
            subject: "A missed job was recorded against your standing",
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
      }
    }
  }
  return { ok: true, flagged, skipped };
}

export async function revalidateAssignments(
  dateISO?: string,
  opts: { broadcast?: boolean } = {},
): Promise<{ ok: boolean; checked: number; rehomed: number; unfilled: number; crewsTexted?: number; skipped: string[] }> {
  const broadcast = opts.broadcast ?? true; // intraday heartbeat passes false — no SMS every 30 min
  const admin = createServiceClient();
  // What this pass could not do, in words. The per-job reads live inside
  // revalidateJob and already skip rather than unassign; what has never had
  // anywhere to go is the dead-end alert failing to reach a person.
  const skipped: string[] = [];
  // SIM-FOUND (Wave 2): healing only "tomorrow" left a COI-lapsed crew
  // holding every job further out until the night before each one. When no
  // explicit date is given, sweep the WHOLE forward book (bounded 60 days)
  // so ineligibility strips a crew's future the night it happens.
  let query = admin.from("jobs").select("id").in("status", ["scheduled", "requested"]);
  if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    query = query.eq("date", dateISO);
  } else {
    const from = addDays(todayLakeDate(), 1);
    query = query.gte("date", from).lte("date", addDays(from, 60));
  }
  const jobs = mustRead("the jobs to re-validate", await query);
  let rehomed = 0;
  const unfilledIds: string[] = [];
  for (const j of jobs ?? []) {
    // PER ITEM, NEVER THE SWEEP. revalidateJob reaches reads that throw now, and
    // an escape here abandoned every remaining job in the forward book — the
    // one thing this step exists to walk. A job we could not re-validate keeps
    // whatever crew it has, which is the safe direction, and is named.
    let r;
    try {
      r = await revalidateJob(j.id as string);
    } catch (e) {
      console.error("[revalidate] skipped a job:", j.id, e);
      skipped.push(`Couldn't re-check the crew on one job (${j.id}) — it keeps the crew it has. The rest of the book was checked.`);
      continue;
    }
    if (r.rehomed) rehomed++;
    if (!r.nowAssigned) unfilledIds.push(j.id as string);
  }

  // Phase D: unfilled jobs go to the CREWS, not ops — broadcast "up for grabs"
  // to every active, insured crew that does one of the open services (any lake:
  // claiming a new lake opts them into it). One text per crew per night. Ops
  // only hears about jobs NO crew could even be asked about (true dead end).
  let crewsTexted = 0;
  const unfilled = unfilledIds.length;
  if (broadcast && unfilled > 0) {
    const today = todayLakeDate();
    const [openJobsRes, crewsRes] = await Promise.all([
      admin.from("jobs").select("id, services(name)").in("id", unfilledIds),
      admin.from("vendors").select("id, user_id, service_types, coi_expiry").eq("status", "active").not("user_id", "is", null),
    ]);
    // Either read failing empties `notifiable`, and the dead-end branch at the
    // bottom then texts ops "no crew on the platform can claim open jobs" — a
    // statement about the whole marketplace, made from a dropped connection.
    const openJobs = mustRead("the open jobs to broadcast", openJobsRes);
    const crews = mustRead("the crews who could claim them", crewsRes);
    const openServices = new Set(
      (openJobs ?? []).map((j) => (one(j.services) as { name?: string } | null)?.name).filter((n): n is string => !!n),
    );
    const claimersByService = new Map<string, number>(); // service -> how many crews were told
    const notifiable = (crews ?? []).filter((v) => {
      if (!v.coi_expiry || String(v.coi_expiry) < today) return false;
      const mine = ((v.service_types as string[]) ?? []).filter((s) => openServices.has(s));
      for (const s of mine) claimersByService.set(s, (claimersByService.get(s) ?? 0) + 1);
      return mine.length > 0;
    });
    if (notifiable.length > 0) {
      // The `phone` filter still decides WHO is asked — same crews as before,
      // now reachable at both of their doors rather than one dead one.
      const users = mustRead("the crews' phone numbers", await admin
        .from("users")
        .select("id, phone, email")
        .in("id", notifiable.map((v) => v.user_id as string))
        .not("phone", "is", null));
      const contactByUser = new Map((users ?? []).map((u) => [u.id as string, { phone: (u.phone as string) ?? null, email: (u.email as string) ?? null }]));
      const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
      for (const v of notifiable) {
        const contact = contactByUser.get(v.user_id as string);
        if (!contact) continue;
        const told = await notify(
          "a crew that there is open work up for grabs near them",
          contact,
          {
            sms: `LakeLife: ${unfilled} open job${unfilled === 1 ? "" : "s"} up for grabs near you — first crew to claim gets it: ${site}/vendor/open 🌊`,
            subject: `${unfilled} open job${unfilled === 1 ? "" : "s"} up for grabs near you`,
            body:
              `${unfilled} open job${unfilled === 1 ? "" : "s"} up for grabs near you — first crew to claim gets it.\n\n` +
              `  ${site}/vendor/open`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
        crewsTexted++;
      }
    }
    // True dead end: a service nobody on the platform offers ⇒ recruit signal.
    const deadEnd = [...openServices].filter((s) => !claimersByService.has(s));
    if (deadEnd.length > 0 || crewsTexted === 0) {
      const { data: ops, error: opsErr } = await admin.from("users").select("phone, email").eq("role", "ops").not("phone", "is", null);
      if (opsErr) {
        console.error("[read failed] the ops phone numbers for a dead-end alert:", opsErr);
        skipped.push(`${unfilled} job${unfilled === 1 ? "" : "s"} nobody on the platform can claim, and we couldn't read the ops phone numbers to raise it — no dead-end text went out.`);
      }
      const pretty = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)
        ? new Date(dateISO + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
        : "the coming days";
      const what = deadEnd.length > 0 ? deadEnd.join(", ") : "open jobs";
      for (const o of ops ?? []) {
        const told = await notify(
          "ops that nobody on the platform can claim this work",
          { phone: o.phone as string | null, email: o.email as string | null },
          {
            sms: `LakeLife: no crew on the platform can claim ${what} for ${pretty} — recruiting signal, nothing to dispatch. 🌊`,
            subject: `No crew on the platform can claim ${what} for ${pretty}`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
      }
    }
  }
  return { ok: true, checked: (jobs ?? []).length, rehomed, unfilled, crewsTexted, skipped };
}

/** Night-before reminder text to each owner who has a scheduled job on `date`
 *  (default tomorrow). One text per property/day. */
export async function sendNightBeforeReminders(dateISO?: string): Promise<{ ok: boolean; sent: number }> {
  const date = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : addDays(todayLakeDate(), 1);
  const admin = createServiceClient();
  const jobs = mustRead("tomorrow's scheduled jobs", await admin
    .from("jobs")
    .select("id, slot, services(name), properties(address, users(id, phone, email))")
    .eq("date", date)
    .eq("status", "scheduled"));

  // De-dupe by phone so an owner with two jobs tomorrow gets one text.
  const seen = new Set<string>();
  let sent = 0;
  for (const j of jobs ?? []) {
    const p = one(j.properties) as { address?: string; users?: unknown } | null;
    const ownerUser = one(p?.users) as { id?: string; phone?: string; email?: string } | null;
    const phone = ownerUser?.phone;
    const svc = (one(j.services) as { name?: string } | null)?.name ?? "your service";
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    // The 'day' switch on the settings screen finally means something. EACH
    // CHANNEL IS ASKED SEPARATELY, the same way the completion notice asks:
    // "Crew on the way / service-day reminder" is a TEXT-ONLY type on the
    // settings screen, so today the email half is always denied and this stays
    // a text — the day that type is offered on email too, this already sends it.
    const [dayBySms, dayByEmail] = await Promise.all([
      allowsNotification(ownerUser?.id, "day", "sms"),
      allowsNotification(ownerUser?.id, "day", "email"),
    ]);
    if (!dayBySms && !dayByEmail) continue;
    await notify(
      "the owner that their crew comes tomorrow",
      { phone: dayBySms ? phone : null, email: dayByEmail ? ownerUser?.email : null },
      {
        sms: `LakeLife reminder: ${svc} is scheduled tomorrow (${prettyDate(date)}) at ${p?.address ?? "your place"}. We'll text you when it's done, with photos. 🌊`,
        subject: `${svc} is scheduled tomorrow at ${p?.address ?? "your place"}`,
      },
    );
    sent++;
  }
  return { ok: true, sent };
}

/**
 * Retry UNCOLLECTED late-cancellation fees (closes the adversarial-review gap:
 * the completed-job reconciler never touched cancelled jobs, so a failed fee
 * charge sat 'due' forever). Nightly: find cancelled jobs whose fee invoice
 * isn't paid, retry the saved card, and — only once the money is actually in —
 * release the crew's proportional share (roadmap §2: paid from fees COLLECTED).
 */
export async function reconcileCancelledFees(): Promise<{ ok: boolean; retried: number; collected: number; collectedAmount: number; skipped: string[] }> {
  const admin = createServiceClient();
  // Inner-join on UNPAID invoices so paid/free-cancelled rows never occupy the
  // scan window (expired-waitlist cancels accumulate forever — an unfiltered
  // limit could starve real fee invoices out of the batch permanently).
  const jobs = mustRead("cancelled jobs with an unpaid fee", await admin
    .from("jobs")
    .select("id, customer_price, vendor_cost, vendor_id, property_id, created_at, services(name), invoices!inner(id, status, amount, created_at), properties(owner_id)")
    .eq("status", "cancelled")
    .neq("invoices.status", "paid")
    .order("created_at", { ascending: false })
    .limit(200));

  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  // collectedAmount: the DOLLARS, not just the count — the nightly digest
  // has to be able to say what money moved tonight (audit bug 10a).
  let retried = 0, collected = 0, collectedAmount = 0;
  // FEES WE COULD NOT DECIDE ABOUT TONIGHT, in words a person can read.
  // Every guard below skips ONE job and carries on (cron rule 1) — right, but
  // a night where every read failed returned exactly the same {collected: 0}
  // as a night with nothing to collect, and the only trace was a console line
  // on a server nobody opens. The nightly carries this into the digest.
  const skipped: string[] = [];
  for (const j of jobs ?? []) {
    const invRaw = j.invoices as { id?: string; status?: string; amount?: number; created_at?: string }[] | { id?: string; status?: string; amount?: number; created_at?: string } | null;
    const inv = (Array.isArray(invRaw) ? invRaw[0] : invRaw) ?? null;
    if (!inv?.id || inv.status === "paid") continue;
    // Age guard: a cancelRequest may be mid-flight (it flips the job, creates
    // the invoice, THEN charges) — never race it. Fresh invoices wait a cycle.
    if (inv.created_at && String(inv.created_at) > tenMinAgo) continue;
    const fee = Number(inv.amount ?? 0);
    const priceSanity = Number(j.customer_price ?? 0);
    if (!(fee > 0)) continue;
    // Sanity: a cancellation fee is a FRACTION of the price. An invoice at or
    // near full price on a cancelled job is not ours to charge — leave for ops.
    if (priceSanity > 0 && fee > priceSanity * 0.5) continue;
    // Retry cap: card networks limit reattempts — after 5 failed nights, stop
    // (the invoice stays visibly 'due' on the customer's Billing page).
    const { count: failCount, error: failErr } = await admin
      .from("payments").select("id", { count: "exact", head: true })
      .eq("invoice_id", inv.id).eq("status", "failed");
    // FAILS OPEN IF IGNORED: an errored count is null, so `(null ?? 0) >= 5` is
    // false and the retry cap above is not applied — a sixth attempt on a card
    // that has declined five nights running.
    if (failErr) {
      console.error(`[read failed] this fee invoice's failed attempts (job ${j.id}):`, failErr);
      skipped.push(`cancellation fee on job ${j.id}: couldn't read how many nights this card has already declined, so nothing was charged — it retries tomorrow`);
      continue;
    }
    if ((failCount ?? 0) >= 5) continue;

    // Never double-charge: skip if a captured payment already exists.
    const { data: paid, error: paidErr } = await admin.from("payments").select("id").eq("invoice_id", inv.id).eq("status", "captured").maybeSingle();
    // FAILS OPEN IF IGNORED: null reads as "never captured" and takes the
    // charge branch below — a second charge for a fee already collected.
    if (paidErr) {
      console.error(`[read failed] whether this fee was already collected (job ${j.id}):`, paidErr);
      skipped.push(`cancellation fee on job ${j.id}: couldn't tell whether it was already collected, so no card was charged — it retries tomorrow`);
      continue;
    }
    if (paid) {
      await admin.from("invoices").update({ status: "paid" }).eq("id", inv.id);
    } else {
      const ownerId = (one(j.properties) as { owner_id?: string } | null)?.owner_id;
      if (!ownerId) continue;
      const { data: pm, error: pmErr } = await admin
        .from("payment_methods")
        .select("token")
        .eq("user_id", ownerId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      // Not "still no card" — we couldn't look. Same skip, honestly logged.
      if (pmErr) {
        console.error(`[read failed] the customer's saved card (job ${j.id}):`, pmErr);
        skipped.push(`cancellation fee on job ${j.id}: couldn't read the customer's saved card, so nothing was charged — it retries tomorrow`);
        continue;
      }
      if (!pm?.token) continue; // still no card — try again tomorrow
      retried++;
      const charge = await LakeLifePayments.charge({ token: pm.token as string, amountCents: Math.round(fee * 100), description: statementDescriptor("cancel_fee") });
      await admin.from("payments").insert({ invoice_id: inv.id, amount: fee, status: charge.ok ? "captured" : "failed", processor_ref: charge.ref ?? null });
      if (!charge.ok) continue;
      await admin.from("invoices").update({ status: "paid", processor_ref: charge.ref ?? null }).eq("id", inv.id);
    }
    collected++;
    collectedAmount = Math.round((collectedAmount + fee) * 100) / 100;

    // Fee is in — release the crew's proportional share (same pct of THEIR
    // rate as the fee is of the customer price), once.
    const price = Number(j.customer_price ?? 0);
    const cost = Number(j.vendor_cost ?? 0);
    if (j.vendor_id && price > 0 && cost > 0) {
      const crewShare = Math.round((fee / price) * cost * 100) / 100;
      if (crewShare > 0) {
        const { data: existing, error: existingErr } = await admin.from("payouts").select("id").eq("job_id", j.id as string).eq("kind", "earning").maybeSingle();
        // FAILS OPEN IF IGNORED: null reads as "no payout yet" and releases the
        // crew's share twice. The fee is collected either way; a missed release
        // can be raised by hand, a duplicate payment has to be clawed back.
        if (existingErr) {
          console.error(`[read failed] the crew's existing payout (job ${j.id}):`, existingErr);
          // POST-CHARGE, and the only one in this step: the customer's fee is
          // already collected by the time we get here. Refusing releases
          // nothing, so this is the crew's share NOT going out tonight and
          // nothing coming back to retry it — it needs a person.
          skipped.push(`job ${j.id}: the cancellation fee was collected, but we couldn't tell whether the crew's share had already been released — it was NOT released, and nothing retries it`);
        } else if (!existing) {
          await admin.from("payouts").insert({ vendor_id: j.vendor_id, job_id: j.id, amount: crewShare, original_amount: crewShare, status: "released" });
        }
      }
    }
  }
  return { ok: true, retried, collected, collectedAmount, skipped };
}

/**
 * The ledger state an earning lands on once it has been SETTLED AS CREDITS.
 * There is no 'credited' status in the schema (0028: accrued|matured|paid|
 * void), and 'paid' is what the batch already stamped on credit-settled rows
 * — so 'paid' means "closed out, nothing further owed", by either rail.
 */
const CREDIT_SETTLED_STATUS = "paid";

/** Referral maturation (§8b): accruals become SPENDABLE after the clawback
 *  window. Homeowner/HOA beneficiaries get service credits; crew beneficiaries
 *  flip to 'matured' and ride the payout batch when it runs. Idempotent —
 *  guarded status flips, one credit grant per earning row. */
export async function matureReferralEarnings(): Promise<{ ok: boolean; matured: number; credited: number; creditedAmount: number; skipped: string[] }> {
  const admin = createServiceClient();
  const { referralMaturationDays } = await getPlatformSettings();
  const cutoff = new Date(Date.now() - referralMaturationDays * 86_400_000).toISOString();
  const due = mustRead("the referral earnings due to mature", await admin
    .from("referral_earnings")
    .select("id, beneficiary, amount, kind")
    .eq("status", "accrued")
    .lt("accrued_at", cutoff)
    .order("accrued_at", { ascending: true })
    .limit(200));

  let matured = 0, credited = 0, creditedAmount = 0;
  // EARNINGS WE COULDN'T PLACE TONIGHT. A beneficiary we can't identify, or a
  // backfill that couldn't read, leaves real money parked at 'matured' — and
  // the backfill's heal only looks back seven days, so a read that keeps
  // failing orphans that money for good. {credited: 0} alone can't say that.
  const skipped: string[] = [];
  /**
   * AUDIT BUG 4: a credit grant is a SETTLEMENT — the beneficiary has been
   * paid, in credits. Leaving the earning at 'matured' parked it in the
   * payout batch's 500-row window forever, crowding out crews and HOAs who
   * are owed actual cash. Close it out the moment the credit lands (guarded
   * flip, so a concurrent void still wins), and the window only ever holds
   * rows representing real money to move.
   */
  const closeOutAsCredited = async (earningId: string): Promise<void> => {
    const { error } = await admin
      .from("referral_earnings")
      .update({ status: CREDIT_SETTLED_STATUS })
      .eq("id", earningId)
      .eq("status", "matured");
    if (error) console.error(`[referral mature ${earningId}] credit close-out failed:`, error.message);
  };
  const grantFor = async (earningId: string, beneficiary: string, amount: number, kind: string): Promise<boolean> => {
    const { data: isVendor, error: isVendorErr } = await admin.from("vendors").select("id").eq("user_id", beneficiary).maybeSingle();
    // SIM-FOUND (Wave 2): a lake association is a users row like any owner —
    // but its money is a month-end DONATION, never spendable credits.
    const { data: isHoa, error: isHoaErr } = await admin.from("lakes").select("id").eq("hoa_user_id", beneficiary).limit(1);
    // FAILS OPEN IF IGNORED: both null read as "an ordinary homeowner", which
    // settles a CREW's or an HOA's cash as spendable credits — the one thing
    // these two reads exist to stop. No grant: the row stays matured and rides
    // the month-end batch, which is where their money belongs anyway.
    if (isVendorErr || isHoaErr) {
      console.error(`[read failed] who this referral beneficiary is (${earningId}):`, isVendorErr ?? isHoaErr);
      skipped.push(`referral earning ${earningId}: couldn't tell whether the beneficiary is a crew, a lake association or a homeowner — no credits were granted; it sits at 'matured' waiting on the month-end batch`);
      return false;
    }
    if (isVendor || (isHoa && isHoa.length > 0) || !(amount > 0)) return false;
    const { error: gErr } = await admin.from("user_credits").insert({
      user_id: beneficiary, amount, earning_id: earningId,
      reason: kind === "crew_referral" ? "Referral reward — you brought a crew aboard" : "Referral reward — thanks for spreading the word",
    });
    if (gErr && !/duplicate|unique/i.test(gErr.message)) {
      console.error(`[referral mature ${earningId}] credit grant failed:`, gErr.message);
      return false;
    }
    return true;
  };

  for (const e of due ?? []) {
    // FLIP FIRST (guarded accrued→matured), grant only on a won flip — a
    // refund VOIDING this accrual mid-loop then loses cleanly: the flip
    // misses and no credit is ever minted for voided money (review finding,
    // 2026-07-23). The crash direction (flipped, then died before granting)
    // is healed by the backfill sweep below — money can't vanish either way.
    const { data: won } = await admin
      .from("referral_earnings")
      .update({ status: "matured", matured_at: new Date().toISOString() })
      .eq("id", e.id)
      .eq("status", "accrued")
      .select("id");
    if (!won || won.length === 0) continue;
    matured++;
    if (await grantFor(e.id as string, e.beneficiary as string, Number(e.amount), e.kind as string)) {
      credited++;
      creditedAmount = Math.round((creditedAmount + Number(e.amount ?? 0)) * 100) / 100;
      await closeOutAsCredited(e.id as string);
    }
  }

  // BACKFILL: recently-matured earnings whose credit never landed (crash
  // between flip and grant). earning_id-unique keeps this idempotent.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: recent, error: recentErr } = await admin
    .from("referral_earnings")
    .select("id, beneficiary, amount, kind")
    .eq("status", "matured")
    .gte("matured_at", weekAgo)
    .limit(200);
  if (recentErr) {
    console.error("[read failed] recently-matured referral earnings:", recentErr);
    skipped.push("the referral credit backfill didn't run tonight: the recently-matured earnings couldn't be read, so any earning whose credit never landed is still uncredited");
  }
  if (recent && recent.length > 0) {
    const { data: creditRows, error: creditRowsErr } = await admin
      .from("user_credits").select("earning_id").in("earning_id", recent.map((r) => r.id));
    // An empty `granted` set would re-grant credits already granted and count
    // them again. The backfill is a heal, not a deadline — skip it tonight.
    if (creditRowsErr) {
      console.error("[read failed] which matured earnings were already credited:", creditRowsErr);
      skipped.push("the referral credit backfill stopped: we couldn't read which matured earnings were already credited, so nothing was re-granted tonight");
      return { ok: true, matured, credited, creditedAmount, skipped };
    }
    const granted = new Set((creditRows ?? []).map((c) => c.earning_id as string));
    for (const e of recent) {
      // Already credited but still sitting at 'matured' (a pre-fix row, or a
      // crash between the grant and the close-out): close it, don't re-grant.
      if (granted.has(e.id as string)) {
        await closeOutAsCredited(e.id as string);
        continue;
      }
      if (await grantFor(e.id as string, e.beneficiary as string, Number(e.amount), e.kind as string)) {
        credited++;
        creditedAmount = Math.round((creditedAmount + Number(e.amount ?? 0)) * 100) / 100;
        await closeOutAsCredited(e.id as string);
      }
    }
  }
  return { ok: true, matured, credited, creditedAmount, skipped };
}

/**
 * MONTH-END REFERRAL PAYOUT BATCH (owner cadence, 2026-07-23): crews and
 * HOAs get their matured referral money once a month — one guarded
 * matured→paid flip per row, one statement email per beneficiary (their
 * digest: paid now + still maturing). Runs only on the last lake-day of the
 * month; customers' credits never wait for this (they apply continuously).
 * Real money movement rides the crew remittance rails when the processor
 * lands — until then the flip + statement IS the batch, idempotently.
 */
export async function runReferralPayoutBatch(force = false): Promise<{ ok: boolean; ran: boolean; beneficiaries: number; total: number; creditSettledClosed: number; skipped: string[] }> {
  const today = todayLakeDate();
  if (!force && !isLastDayOfMonth(today)) return { ok: true, ran: false, beneficiaries: 0, total: 0, creditSettledClosed: 0, skipped: [] };
  const admin = createServiceClient();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  // AUDIT BUG 4 — DRAIN THE SILT FIRST. Earnings already settled as credits
  // (user_credits.earning_id is the linkage) used to sit at 'matured'
  // forever; as the credit ledger grew they filled the 500-row window below
  // and crews and HOAs owed actual CASH stopped getting paid. Maturation now
  // closes these out at the source, so this is the one-time backlog sweep —
  // and the permanent belt-and-braces for any row that slips through.
  //
  // Paging note: closing a row REMOVES it from the matured set, so the offset
  // only advances by the rows this page could NOT close. Otherwise the shift
  // would skip un-closeable rows and the sweep would never terminate cleanly.
  const PAGE = 500;
  const MAX_PAGES = 40; // 20k rows a night — far past any real backlog
  // WHO DIDN'T GET PAID TONIGHT, AND WHY. This runs once a month, on the night
  // the largest sum of the month leaves the account; a payee skipped here waits
  // a FULL MONTH for the next attempt. {beneficiaries: 0} read as a quiet
  // month-end whether nobody was owed or every read failed. Carried to the
  // digest so a skipped crew is a sentence somebody sees tomorrow morning.
  const skipped: string[] = [];
  let creditSettledClosed = 0;
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: scan, error: scanErr } = await admin
      .from("referral_earnings")
      .select("id")
      .eq("status", "matured")
      // TOTAL ordering (id breaks matured_at ties): equal timestamps under a
      // partial sort can shuffle between pages, which would let a row slip
      // the scan. Seeing one twice is harmless — the flip is guarded.
      .order("matured_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    // A failed page is not an empty one — stop draining rather than treat the
    // silt as gone. The per-row guard further down is the real protection.
    if (scanErr) {
      console.error("[read failed] the matured-earnings drain page:", scanErr);
      skipped.push("the credit-settled drain stopped early: a page of matured earnings couldn't be read, so some already-credited rows still sit in the payout window");
      break;
    }
    if (!scan || scan.length === 0) break;
    const { data: creditRows, error: creditRowsErr } = await admin
      .from("user_credits").select("earning_id").in("earning_id", scan.map((r) => r.id));
    // Without this we cannot tell a credit-settled row from one owed cash.
    if (creditRowsErr) {
      console.error("[read failed] which drain-page rows were credit-settled:", creditRowsErr);
      skipped.push("the credit-settled drain stopped early: we couldn't tell which of this page's earnings were already settled as credits");
      break;
    }
    const settled = new Set((creditRows ?? []).map((c) => c.earning_id as string));
    let closedThisPage = 0;
    for (const id of scan.map((r) => r.id as string)) {
      if (!settled.has(id)) continue;
      const { data: done } = await admin
        .from("referral_earnings")
        .update({ status: CREDIT_SETTLED_STATUS })
        .eq("id", id)
        .eq("status", "matured")
        .select("id");
      if (done && done.length > 0) closedThisPage++;
    }
    creditSettledClosed += closedThisPage;
    offset += scan.length - closedThisPage;
    if (scan.length < PAGE) break;
  }

  // THE MONTH'S MONEY. Empty reads as "nobody is owed anything", on the one
  // night of the month the largest sum leaves the account, and the digest
  // prints it as a quiet night.
  const matured = mustRead("the matured referral earnings to pay out", await admin
    .from("referral_earnings")
    .select("id, beneficiary, amount")
    .eq("status", "matured")
    .limit(500));

  // Only vendor/HOA-type beneficiaries batch out; customers settled as
  // credits at maturation are CLOSED OUT above, so the window they used to
  // silt up now holds only rows that still represent real money to move.
  const byUser = new Map<string, { ids: string[]; total: number }>();
  for (const e of matured ?? []) {
    const u = byUser.get(e.beneficiary as string) ?? { ids: [], total: 0 };
    u.ids.push(e.id as string);
    u.total += Number(e.amount ?? 0);
    byUser.set(e.beneficiary as string, u);
  }

  let beneficiaries = 0, total = 0;
  for (const [userId, u] of byUser) {
    const { data: vendorRow, error: vendorRowErr } = await admin.from("vendors").select("id, company").eq("user_id", userId).maybeSingle();
    const { data: hoaLake, error: hoaLakeErr } = await admin.from("lakes").select("id").eq("hoa_user_id", userId).limit(1);
    // Both null reads as "a customer", which skips a crew's or an HOA's whole
    // month on the next line. Skip out loud instead; next run pays them.
    if (vendorRowErr || hoaLakeErr) {
      console.error(`[read failed] who this payee is (${userId}):`, vendorRowErr ?? hoaLakeErr);
      skipped.push(`referral payout for ${userId}: couldn't tell whether they're a crew, a lake association or a customer — $${(Math.round(u.total * 100) / 100).toFixed(2)} was NOT paid out and waits for next month's batch`);
      continue;
    }
    const isHoa = !!hoaLake && hoaLake.length > 0;
    if (!vendorRow && !isHoa) continue; // customer rows were credited at maturation

    // SIM-FOUND (Wave 2): money never flips to "paid" without a destination
    // AND a batch artifact the banking layer can execute. No bank on file →
    // the earnings stay matured and next month retries (the statement nags).
    const { data: acct, error: acctErr } = await admin
      .from("payout_accounts").select("account_last4").eq("user_id", userId).maybeSingle();
    // Not "no bank on file" — we couldn't look. Same skip, said out loud.
    if (acctErr) {
      console.error(`[read failed] this payee's bank details (${userId}):`, acctErr);
      skipped.push(`referral payout for ${userId}: couldn't read their bank details, so $${(Math.round(u.total * 100) / 100).toFixed(2)} was NOT paid out and waits for next month's batch`);
      continue;
    }
    if (!acct) continue;
    const { data: batch, error: batchErr } = await admin
      .from("payout_batches")
      .insert({ user_id: userId, vendor_id: vendorRow?.id ?? null, kind: "referral", status: "building" })
      .select("id").single();
    // No batch artifact, no payout — the earnings stay matured, which is the
    // safe direction, but it is a payee going a whole month unpaid with nothing
    // but a null local to show for it.
    if (batchErr) {
      console.error(`[write failed] this payee's referral batch (${userId}):`, batchErr);
      skipped.push(`referral payout for ${userId}: the payout batch couldn't be created, so $${(Math.round(u.total * 100) / 100).toFixed(2)} was NOT paid out and waits for next month's batch`);
    }
    if (!batch) continue;

    let paidThis = 0;
    const flippedIds: string[] = [];
    for (const id of u.ids) {
      // Double-pay guard (sim final audit): an earning already granted as
      // credits (user_credits.earning_id linkage) never ALSO rides a bank
      // batch — close it out with no money and move on. The drain above
      // normally catches these; this stays as the per-row last word.
      const { data: credited, error: creditedErr } = await admin
        .from("user_credits").select("id").eq("earning_id", id).limit(1);
      // FAILS OPEN IF IGNORED: null reads as "never credited", so an earning
      // already settled as credits ALSO rides a bank batch — paid twice, in two
      // currencies. Leave it matured; next month's batch tries again.
      if (creditedErr) {
        console.error(`[read failed] whether this earning was already credited (${id}):`, creditedErr);
        skipped.push(`referral earning ${id} (payee ${userId}): couldn't tell whether it was already settled as credits, so it was left out of tonight's batch rather than risk paying it twice`);
        continue;
      }
      if (credited && credited.length > 0) {
        const { data: closed } = await admin
          .from("referral_earnings").update({ status: CREDIT_SETTLED_STATUS }).eq("id", id).eq("status", "matured").select("id");
        if (closed && closed.length > 0) creditSettledClosed++;
        continue;
      }
      const { data: won } = await admin
        .from("referral_earnings")
        .update({ status: "paid" })
        .eq("id", id)
        .eq("status", "matured")
        .select("amount");
      if (won && won.length > 0) { paidThis += Number(won[0].amount ?? 0); flippedIds.push(id); }
    }
    paidThis = Math.round(paidThis * 100) / 100;
    if (paidThis <= 0) {
      await admin.from("payout_batches").delete().eq("id", batch.id);
      continue;
    }
    const { data: fin, error: finErr } = await admin
      .from("payout_batches")
      .update({ gross: paidThis, fee: 0, net: paidThis, status: "queued" })
      .eq("id", batch.id).eq("status", "building")
      .select("id");
    if (finErr || !fin || fin.length === 0) {
      // Whole-batch unwind: earnings back to matured, batch gone — retried next run.
      for (const id of flippedIds) {
        await admin.from("referral_earnings").update({ status: "matured" }).eq("id", id).eq("status", "paid");
      }
      await admin.from("payout_batches").delete().eq("id", batch.id);
      continue;
    }
    beneficiaries++;
    total += paidThis;
    // Still-maturing remainder for the digest line.
    const { data: pending, error: pendingErr } = await admin
      .from("referral_earnings").select("amount").eq("beneficiary", userId).eq("status", "accrued");
    // A failed read drops the "still maturing" sentence rather than printing a
    // wrong figure — silence, not a lie, but worth knowing it happened.
    // POST-WRITE: the money is already flipped to 'paid' and the batch queued.
    // Refusing here would undo none of that — it would only drop the statement.
    if (pendingErr) {
      console.error(`[read failed] this payee's still-maturing earnings (${userId}):`, pendingErr);
      skipped.push(`referral statement for ${userId}: paid as normal, but the "still maturing" figure couldn't be read, so their email doesn't mention it`);
    }
    const maturing = (pending ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const { data: u2, error: u2Err } = await admin.from("users").select("email, name").eq("id", userId).maybeSingle();
    // POST-WRITE as above: their money moved. This is the notification only —
    // no address, no email, and nothing else tells them the payout happened.
    if (u2Err) {
      console.error(`[read failed] this payee's email (${userId}):`, u2Err);
      skipped.push(`referral payout for ${userId}: $${paidThis.toFixed(2)} was approved, but their email address couldn't be read so NO statement was sent`);
    }
    if (u2?.email) {
      void sendEmail({
        to: u2.email,
        subject: `Referral payout approved — $${paidThis.toFixed(2)} 🌊`,
        html: `<p>Hi ${vendorRow?.company ?? u2.name ?? "there"},</p><p>Your referral earnings for the month are in: <b>$${paidThis.toFixed(2)}</b> approved and riding your next remittance.${maturing > 0 ? ` Another $${maturing.toFixed(2)} is maturing and lands next batch.` : ""}</p><p>Keep sharing — it stacks. 🌊</p><p style="font-size:12px;color:#5D7681">Manage notifications: ${site}/settings/notifications</p>`,
      });
    }
  }
  return { ok: true, ran: true, beneficiaries, total: Math.round(total * 100) / 100, creditSettledClosed, skipped };
}

/**
 * NUDGE ENGINE (owner direction: keep the game alive, never spammy).
 * Email-only (SMS stays operational), per-kind per-user cooldown via
 * nudge_log, and a notification_prefs opt-out (type 'growth', channel
 * 'email' — absence means opted in).
 *  A) credit_covers_visit — a customer's balance crossed the threshold:
 *     their credits now cover a real visit. One email, then quiet.
 *  B) territory — a crew's neighboring lake has WAITING demand for work
 *     they do; estimate the season at THEIR OWN rates (rule-1 safe) and
 *     hand them the one-tap lakes editor.
 */
export async function runNudges(): Promise<{ ok: boolean; creditNudges: number; nearMilestoneNudges: number; territoryNudges: number; skipped: string[] }> {
  const admin = createServiceClient();
  const { nudgeCreditThreshold, nudgeCooldownDays, lakeDemotionCooldownDays } = await getPlatformSettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const now = Date.now();
  // WHAT TONIGHT'S NUDGES SILENTLY DIDN'T DO. Every guard below fails CLOSED,
  // which is right — an unreadable preference must not become an email. But a
  // closed guard and a quiet night look identical from the outside, and three
  // zeroes in a return value is exactly how the COI check reported success for
  // months. The nightly route feeds these to the digest (noteSkips).
  const skipped: string[] = [];

  const optedOut = async (userId: string): Promise<boolean> => {
    const { data, error } = await admin
      .from("notification_prefs").select("enabled")
      .eq("user_id", userId).eq("type", "growth").eq("channel", "email").maybeSingle();
    // FAILS OPEN IF IGNORED: `null?.enabled === false` is false, i.e. "they
    // never opted out" — emailing somebody who did. A failed read counts as an
    // opt-out; the cost is one unsent nudge.
    if (error) {
      console.error(`[read failed] this person's growth-email preference (${userId}):`, error);
      skipped.push(`no nudge for ${userId}: couldn't read whether they'd opted out of growth email (${error.message ?? "read failed"})`);
      return true;
    }
    return data?.enabled === false;
  };
  const cooling = async (userId: string, kind: string): Promise<boolean> => {
    const { data, error } = await admin
      .from("nudge_log").select("sent_at")
      .eq("user_id", userId).eq("kind", kind)
      .order("sent_at", { ascending: false }).limit(1).maybeSingle();
    // FAILS OPEN IF IGNORED: no row reads as "never nudged", so the cooldown is
    // skipped and the same person hears from us again tonight.
    if (error) {
      console.error(`[read failed] when we last nudged this person (${userId}, ${kind}):`, error);
      skipped.push(`no ${kind} nudge for ${userId}: couldn't read when we last nudged them (${error.message ?? "read failed"})`);
      return true;
    }
    return nudgeCooling((data?.sent_at as string) ?? null, nudgeCooldownDays, now);
  };
  const send = async (userId: string, kind: string, subject: string, html: string): Promise<boolean> => {
    if (await optedOut(userId)) return false;
    if (await cooling(userId, kind)) return false;
    const { data: u, error: uErr } = await admin.from("users").select("email").eq("id", userId).maybeSingle();
    if (uErr) {
      console.error(`[read failed] this person's email (${userId}):`, uErr);
      skipped.push(`no ${kind} nudge for ${userId}: couldn't read their email address (${uErr.message ?? "read failed"})`);
      return false;
    }
    if (!u?.email) return false;
    void sendEmail({ to: u.email, subject, html: html + `<p style="font-size:12px;color:#5D7681">Manage notifications: ${site}/settings/notifications</p>` });
    const logged = await admin.from("nudge_log").insert({ user_id: userId, kind });
    // POST-SEND: the email has gone. Refusing here would un-send nothing — but
    // this row IS the frequency cap, so a failure means the same person can
    // hear the same pitch again tomorrow night, and the night after.
    if (logged.error) {
      console.error(`[write failed] the nudge cooldown row (${userId}, ${kind}):`, logged.error);
      skipped.push(`${kind} nudge sent to ${userId} but its cooldown row did not save (${logged.error.message ?? "write failed"}) — nothing stops them being nudged again tomorrow`);
    }
    return true;
  };

  // A) Credits now cover a visit.
  let creditNudges = 0;
  // Every number below is a dollar figure printed in somebody's email ("You've
  // got $X in credits", "you're $Y away"). A failed read would print zeroes.
  const creditRows = mustRead("everyone's credit balances", await admin.from("user_credits").select("user_id, amount"));
  const balances = new Map<string, number>();
  for (const c of creditRows ?? []) balances.set(c.user_id as string, (balances.get(c.user_id as string) ?? 0) + Number(c.amount ?? 0));
  for (const [userId, bal] of balances) {
    if (bal < nudgeCreditThreshold) continue;
    const ok = await send(
      userId, "credit_covers_visit",
      `You've got $${bal.toFixed(2)} in LakeLife credits 🌊`,
      `<p>Your referral credits just crossed <b>$${bal.toFixed(2)}</b> — enough to cover a visit on us.</p><p>Book anything at <a href="${site}/book">${site}/book</a> and it applies automatically at billing. Keep sharing your link and the next one's on us too.</p><p style="font-size:12px;color:#5D7681">How credits work: ${site}/referral-terms</p>`,
    );
    if (ok) creditNudges++;
  }

  // A2) Near-milestone tease — spendable + maturing has crossed 60% of the
  // threshold but the balance hasn't: "couple more referrals and it's a free
  // visit." Homeowners only — a crew's milestone is the month-end batch, not
  // credits. nearMilestone() itself refuses anyone covers-visit already owns.
  let nearMilestoneNudges = 0;
  const accruedRows = mustRead("everyone's maturing referral earnings", await admin
    .from("referral_earnings").select("beneficiary, amount").eq("status", "accrued"));
  const accruedBy = new Map<string, number>();
  for (const a of accruedRows ?? []) accruedBy.set(a.beneficiary as string, (accruedBy.get(a.beneficiary as string) ?? 0) + Number(a.amount ?? 0));
  const candidates = new Set([...balances.keys(), ...accruedBy.keys()]);
  if (candidates.size > 0) {
    // An empty crew set sends a HOMEOWNER credit tease to crews — the exact
    // audience this read exists to exclude.
    const vendorUsers = mustRead("which of these people are crews", await admin
      .from("vendors").select("user_id").in("user_id", [...candidates]).not("user_id", "is", null));
    const crewUserIds = new Set((vendorUsers ?? []).map((v) => v.user_id as string));
    for (const userId of candidates) {
      if (crewUserIds.has(userId)) continue;
      const near = nearMilestone(balances.get(userId) ?? 0, accruedBy.get(userId) ?? 0, nudgeCreditThreshold);
      if (!near) continue;
      const body =
        near.gap > 0
          ? `<p>You're <b>$${near.gap.toFixed(2)} away</b> from your credits covering a whole visit — one more neighbor usually does it.</p><p>Your link is waiting at <a href="${site}/book">${site}/book</a>. 🌊</p>`
          : `<p>You've got <b>$${(accruedBy.get(userId) ?? 0).toFixed(2)} maturing</b> — when it clears, your credits cross <b>$${nudgeCreditThreshold.toFixed(0)}</b> and your next visit is on us.</p><p>Nothing to do — it applies automatically at billing. Want to stack the next one? Your link's at <a href="${site}/book">${site}/book</a>. 🌊</p>`;
      const subject =
        near.gap > 0
          ? `You're $${near.gap.toFixed(2)} from a visit on us 🌊`
          : `Your free visit is about to unlock 🌊`;
      const ok = await send(
        userId, "near_milestone", subject,
        body + `<p style="font-size:12px;color:#5D7681">How credits work: ${site}/referral-terms</p>`,
      );
      if (ok) nearMilestoneNudges++;
    }
  }

  // B) Territory expansion — waiting demand next door, priced at THEIR rates.
  let territoryNudges = 0;
  const today = todayLakeDate();
  const waiting = mustRead("the jobs waiting on a crew", await admin
    .from("jobs")
    .select("id, service_id, property_id, services(name, pricing_model), properties(lake_id, lakes(name))")
    .eq("status", "requested").is("vendor_id", null).gte("date", today).limit(50));
  if (waiting && waiting.length > 0) {
    const crews = mustRead("the active crews", await admin
      .from("vendors")
      .select("id, user_id, company, service_types, service_lakes, coi_expiry")
      .eq("status", "active").not("user_id", "is", null));
    // The pitch quotes a dollar figure built from these rates; without them
    // every crew silently looks like it has no rate for anything.
    const rates = mustRead("the crews' rate cards", await admin.from("vendor_rates").select("vendor_id, service_id, base, unit_rate, band_pricing"));
    const rateBy = new Map((rates ?? []).map((r) => [`${r.vendor_id}|${r.service_id}`, r]));

    for (const v of crews ?? []) {
      if (!v.coi_expiry || String(v.coi_expiry) < today) continue;
      const myLakes = new Set((v.service_lakes as string[]) ?? []);
      // Group this crew's claimable-if-they-expanded demand by lake.
      const byLake = new Map<string, { name: string; jobs: typeof waiting; est: number }>();
      let tallyFailed = false;
      for (const j of waiting) {
        const svc = one(j.services) as { name?: string; pricing_model?: string } | null;
        const prop = one(j.properties) as { lake_id?: string; lakes?: unknown } | null;
        const lakeId = prop?.lake_id as string | undefined;
        if (!svc?.name || !lakeId || myLakes.has(lakeId)) continue;
        if (!((v.service_types as string[]) ?? []).includes(svc.name)) continue;
        const vr = rateBy.get(`${v.id}|${j.service_id}`);
        if (!vr) continue; // no rate = no honest estimate
        const lakeName = (one(prop?.lakes) as { name?: string } | null)?.name ?? "a nearby lake";
        const entry = byLake.get(lakeId) ?? { name: lakeName, jobs: [] as typeof waiting, est: 0 };
        // SEAM: loadPricingProfileById THROWS on a failed read now. Uncaught it
        // leaves runNudges entirely — the credit and near-milestone nudges
        // already sent stand, but every REMAINING crew loses tonight's pitch and
        // the step reports only the throw. So catch it here and skip the item.
        let profile: Awaited<ReturnType<typeof loadPricingProfileById>>;
        try {
          profile = await loadPricingProfileById(admin, j.property_id as string);
        } catch (e) {
          if (!(e instanceof ReadFailed)) throw e;
          console.error(`[read failed] pricing a waiting job for the territory pitch (crew ${v.id}, job ${j.id}):`, e);
          skipped.push(`no territory pitch for crew ${v.id}: couldn't price waiting job ${j.id} (${e.message})`);
          tallyFailed = true;
          break;
        }
        if (profile) {
          const rule: ServiceRule = {
            name: svc.name, pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
            base: Number(vr.base ?? 0), unit_rate: Number(vr.unit_rate ?? 0),
            band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
          };
          entry.est += priceService(rule, profile);
        }
        entry.jobs.push(j);
        byLake.set(lakeId, entry);
      }
      // A TALLY WE COULDN'T FINISH IS NOT A SMALLER TALLY. The pitch states
      // "$X sitting there right now" as fact, so a crew whose tally hit a
      // failed read hears nothing tonight rather than a number that is short.
      // (Same rule the fill-in digest follows: the item skipped is the CREW.)
      if (tallyFailed) continue;
      // Best single lake pitch; skip lakes the crew is paused on (Phase E).
      let best: { lakeId: string; name: string; count: number; est: number } | null = null;
      for (const [lakeId, e] of byLake) {
        if (e.jobs.length === 0 || e.est <= 0) continue;
        const { data: pause, error: pauseErr } = await admin
          .from("vendor_lake_demotions").select("demoted_at")
          .eq("vendor_id", v.id as string).eq("lake_id", lakeId).maybeSingle();
        // FAILS OPEN IF IGNORED: null reads as "not paused here", so we pitch a
        // crew the very lake we just paused them on.
        if (pauseErr) {
          console.error(`[read failed] whether this crew is paused on the lake (${v.id}, ${lakeId}):`, pauseErr);
          skipped.push(`${lakeId} left out of crew ${v.id}'s territory pitch: couldn't read whether they're paused on it (${pauseErr.message ?? "read failed"})`);
          continue;
        }
        if (pause && isCoolingDown(pause.demoted_at as string, lakeDemotionCooldownDays, now)) continue;
        if (!best || e.est > best.est) best = { lakeId, name: e.name, count: e.jobs.length, est: e.est };
      }
      if (best) {
        const ok = await send(
          v.user_id as string, "territory",
          `${best.count} homeowner${best.count === 1 ? "" : "s"} waiting on ${best.name} 🌊`,
          `<p>Hi ${v.company ?? "there"},</p><p><b>${best.count} homeowner${best.count === 1 ? " is" : "s are"} waiting</b> for work you do on ${best.name} — at your rates that's about <b>$${best.est.toFixed(0)}</b> sitting there right now.</p><p>Add the lake in one tap and the machine starts routing you: <a href="${site}/vendor/availability">${site}/vendor/availability</a></p>`,
        );
        if (ok) territoryNudges++;
      }
    }
  }

  return { ok: true, creditNudges, nearMilestoneNudges, territoryNudges, skipped };
}

/** Annual COI re-validation nudge (the owner's yearly re-attest). Emails an
 *  active crew when the certificate on file is exactly `leadDays` (default 30)
 *  from expiring, OR on the yearly anniversary of their last verification — one
 *  send per crew per cycle, no tracking column (same idiom as the seasonal
 *  reminder). An already-expired COI drops the crew from routing regardless
 *  (no COI, no jobs), so this is the courtesy heads-up before that bites. */
export async function sendCoiRevalidations(leadDays = 30): Promise<{ ok: boolean; due: number; emailed: number }> {
  const today = todayLakeDate();
  const admin = createServiceClient();
  const crews = mustRead("the active crews and their insurance dates", await admin
    .from("vendors")
    // NAME THE RELATIONSHIP. There are TWO foreign keys from vendors to users —
    // vendors_user_id_fkey (the crew's own account) and vendors_invited_by_fkey
    // (whoever at ops invited them, added in 0028). A bare users(...) is
    // ambiguous and PostgREST answers PGRST201, which arrives as
    // {error, data:null} — so before this read was guarded, every night this
    // step reported {ok:true, due:0, emailed:0} and NO crew was ever warned
    // that their insurance was about to lapse. An expired COI drops a crew from
    // routing, so the first they'd have known is the work stopping.
    // Had it resolved the other way it would have emailed the ops person who
    // invited them instead of the crew.
    .select("id, company, coi_expiry, verified_at, users!vendors_user_id_fkey(email, name)")
    .eq("status", "active"));

  let due = 0, emailed = 0;
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  for (const c of crews ?? []) {
    const isDue = coiRevalidationDue(
      { coi_expiry: (c.coi_expiry as string | null) ?? null, verified_at: (c.verified_at as string | null) ?? null },
      today,
      leadDays,
    );
    if (!isDue) continue;
    due++;
    const u = one((c as { users?: unknown }).users) as { email?: string; name?: string } | null;
    if (!u?.email) continue;
    void sendEmail({
      to: u.email,
      subject: "Keep your LakeLife crew active — refresh your insurance on file",
      html: `<p>Hi ${c.company ?? u?.name ?? "there"},</p><p>Time for your yearly insurance check-in. Upload a current Certificate of Insurance so jobs keep routing to you without a gap — it takes a minute from your crew portal.</p><p><a href="${site}/vendor">Update my COI</a> 🌊</p>`,
    });
    emailed++;
  }
  return { ok: true, due, emailed };
}

/**
 * WAITLIST SWEEP (ladder rungs 6–7): try to fill EVERY future unassigned job,
 * not just tomorrow's. Runs nightly, and immediately when supply arrives (a
 * crew self-activates or claims into a new lake) — the waiting customer hears
 * "crew locked in" the moment it's true. Optionally scoped to one lake (the
 * lake a crew just joined). Bounded per run; the nightly catches the rest.
 */
/** Hour of day (0–23) in lake time — for SMS quiet hours. */
function lakeHour(): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Indiana/Indianapolis", hour12: false, hour: "2-digit" }).format(new Date());
  return Number(h) % 24;
}

export async function sweepWaitlist(lakeId?: string, limit = 60): Promise<{ ok: boolean; checked: number; filled: number; skipped: string[] }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  // The good news that didn't get delivered. A fill nobody hears about looks
  // to the customer exactly like still waiting.
  const skipped: string[] = [];
  // FUTURE-only (strictly after today). Same-day fills are deliberately out:
  // today's capacity math counts completed jobs as freed slots and there's no
  // time-of-day cutoff, so a late beat could pile guaranteed no-shows onto a
  // crew — and then strike them for it (adversarial review, 2026-07-22).
  let q = admin
    .from("jobs")
    .select("id, date, services(name), properties!inner(lake_id, owner_id)")
    .eq("status", "requested")
    .is("vendor_id", null)
    .gt("date", today)
    .order("date", { ascending: true })
    .limit(limit);
  if (lakeId) q = q.eq("properties.lake_id", lakeId);
  const waiting = mustRead("the future jobs still waiting on a crew", await q);

  // Good-news texts respect quiet hours (8a–9p lake). A night fill still
  // happens — the portal shows Scheduled and the night-before reminder is
  // guaranteed — we just don't buzz a phone at 2am about it.
  const canText = lakeHour() >= 8 && lakeHour() < 21;
  let filled = 0;
  for (const j of waiting ?? []) {
    try {
      const r = await autoAssignJob(j.id as string);
      if (!r.assigned) continue;
      filled++;
      // Recovery notify — the whole point of the waitlist: instant good news.
      const prop = one(j.properties) as { owner_id?: string } | null;
      const svc = (one(j.services) as { name?: string } | null)?.name ?? "your service";
      if (canText && prop?.owner_id) {
        const { data: owner, error: ownerErr } = await admin.from("users").select("phone, email").eq("id", prop.owner_id).maybeSingle();
        // POST-WRITE: the crew is already assigned. Nothing to undo — but the
        // whole point of the waitlist is the instant good news, and it didn't
        // go. The night-before reminder is still the backstop.
        if (ownerErr) {
          console.error(`[read failed] the owner's phone number (job ${j.id}):`, ownerErr);
          skipped.push(`Job ${j.id}: a crew was locked in for ${prettyDate(j.date as string)} but we couldn't read the owner's phone number — the good-news text didn't go.`);
        }
        if (owner?.phone || owner?.email) {
          const told = await notify(
            `the owner that a crew is locked in for their ${svc} (job ${j.id})`,
            { phone: owner?.phone as string | null, email: owner?.email as string | null },
            {
              sms: `LakeLife: good news — a crew is locked in for your ${svc} on ${prettyDate(j.date as string)}. You'll get a reminder before we arrive. 🌊`,
              subject: `A crew is locked in for your ${svc} on ${prettyDate(j.date as string)}`,
            },
          );
          if (!told.reached && told.note) skipped.push(told.note);
        }
      }
    } catch (e) {
      /* keep sweeping */
      // ...but say which job the sweep gave up on. This catch is deliberate
      // (one job must never end the sweep); silence was the accident.
      console.error(`[waitlist sweep] job ${j.id} threw:`, e);
      skipped.push(`Job ${j.id}: the fill attempt threw (${e instanceof Error ? e.message : String(e)}) — still waiting on a crew; the next sweep tries again.`);
    }
  }
  return { ok: true, checked: (waiting ?? []).length, filled, skipped };
}

/**
 * WAITLIST TERMINAL (ladder rung 8): the honest floor. At `waitlist_warning_days`
 * out, a still-unfilled job's customer gets the self-serve fork (exact-boundary,
 * one send). If the date passes with nobody to send, the machine cancels,
 * says so plainly, and reminds them they were never charged — no silent rot,
 * no ops queue. The demand history stays on the books as the recruit signal.
 */
export async function expireUnfilledJobs(): Promise<{ ok: boolean; warned: number; expired: number; escalated: number; skipped: string[] }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  // JOBS THIS RUNG COULD NOT REACH TONIGHT. Each skip below is correct — none
  // of these branches may fire on a read it could not make — but a job left in
  // limbo is not the same as a quiet night, and only this array can tell them
  // apart from outside.
  const skipped: string[] = [];
  const { waitlistWarningDays } = await getPlatformSettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const unfilled = mustRead("the jobs still waiting on a crew", await admin
    .from("jobs")
    .select("id, date, group_id, services(name, criticality), properties(owner_id, address, nickname)")
    .eq("status", "requested")
    .is("vendor_id", null)
    .eq("is_rush", false) // rush stragglers get their own, kinder fallback rung
    .not("date", "is", null));

  let warned = 0, expired = 0, escalated = 0;
  for (const j of unfilled ?? []) {
    const svcRow = one(j.services) as { name?: string; criticality?: string | null } | null;
    const svc = svcRow?.name ?? "your service";
    const prop = one(j.properties) as { owner_id?: string; address?: string; nickname?: string } | null;
    const where = prop?.nickname || prop?.address || "your place";
    // A failed read here is not "no phone". Both branches below either CANCEL
    // the job or burn its one lifetime warning, and neither may happen without
    // being able to tell the owner — so a job we cannot reach them about waits.
    const phoneRes = prop?.owner_id
      ? await admin.from("users").select("phone, email").eq("id", prop.owner_id).maybeSingle()
      : null;
    if (phoneRes?.error) {
      console.error(`[read failed] the owner's phone number (job ${j.id}):`, phoneRes.error);
      skipped.push(`Job ${j.id} (${svc} on ${j.date}): couldn't read the owner's phone number, so it was neither warned nor cancelled — it is still open and waiting.`);
      continue;
    }
    const owner = {
      phone: (phoneRes?.data?.phone as string | undefined) ?? null,
      email: (phoneRes?.data?.email as string | undefined) ?? null,
    };
    const canTell = !!(owner.phone || owner.email);

    if (isExpired(j.date as string, today)) {
      // CUSTODY GUARD (S4 review): never expire a visit whose boat is IN
      // the barn — cancelling the envelope would silence the overstay
      // meter and strand the boat with no billing rail. The stay, the
      // meter and the ops ledger own this case; the job stays requested.
      const gid0 = (j as { group_id?: string | null }).group_id ?? null;
      if (gid0) {
        const { data: custody, error: custodyErr } = await admin
          .from("storage_stays").select("id").eq("group_id", gid0).eq("status", "in_storage").limit(1);
        // FAILS OPEN IF IGNORED: null reads as "no boat in the barn" and
        // cancels the envelope that is the boat's only billing rail.
        if (custodyErr) {
          console.error(`[read failed] whether the boat is still in the barn (job ${j.id}):`, custodyErr);
          skipped.push(`Job ${j.id} (${svc} on ${j.date}): couldn't tell whether the boat is still in a barn, so the past-due visit was NOT cancelled — it stays open and billable.`);
          continue;
        }
        if (custody && custody.length > 0) continue;
      }

      // PROTECTIVE WORK NEVER GETS CANCELLED BY A MACHINE (migration 0053).
      // Same shape as the custody guard above, higher stakes: telling someone
      // we cancelled their winterization and they were never charged is a
      // burst pipe, not a refund. The job stays `requested` and becomes LOUD
      // instead — it stays on the ops board (getNeedsAttention now reaches
      // back past today for exactly these) and the customer gets one honest
      // message saying we have NOT given up.
      //
      // The database refuses the cancel too, so a future edit here cannot
      // reintroduce this.
      if (expiryActionFor(svcRow?.criticality) === "escalate") {
        // Exactly-once, via the same sent-ledger the waitlist warning uses:
        // the INSERT is the claim, so a nightly that runs twice, or a manual
        // re-run, does not text the same person every night about a job we
        // are already chasing.
        const { error: escLogErr } = await admin
          .from("waitlist_notice_log")
          .insert({ job_id: j.id as string, kind: PROTECTIVE_ESCALATION_KIND });
        if (escLogErr) {
          // A DUPLICATE IS THE DESIGN (we already chased this one); anything
          // else is the ledger refusing, and the behaviour is identical —
          // silence — on protective work nobody has been staffed for. Say
          // which it was, since only one of the two is fine.
          if (!/duplicate|unique/i.test(escLogErr.message)) {
            console.error(`[protective escalation ${j.id}] ledger write failed:`, escLogErr.message);
            skipped.push(`Job ${j.id} (${svc} on ${j.date}): protective work with no crew, and the escalation ledger refused the claim — nobody was texted. It stays open on the ops board.`);
          }
          continue; // already escalated — stay quiet, stay open
        }
        escalated++;
        if (canTell) {
          const told = await notify(
            `the owner that we have NOT cancelled their ${svc} (job ${j.id})`,
            owner,
            {
              sms: `LakeLife: we still don't have a crew for ${svc} at ${where}, and we are NOT cancelling it — this is the kind of work that can't wait. We're on it and will text as soon as it's set. If it's urgent, reply here. 🌊`,
              subject: `We still don't have a crew for ${svc} at ${where} — and we are not cancelling it`,
            },
          );
          if (!told.reached && told.note) skipped.push(told.note);
        }
        continue;
      }
      // Guarded flip — never race a same-moment claim/assign.
      const { data: gone } = await admin
        .from("jobs")
        .update({ status: "cancelled", cancel_reason: "expired_unfilled" })
        .eq("id", j.id as string)
        .eq("status", "requested")
        .is("vendor_id", null)
        .select("id");
      if (!gone || gone.length === 0) continue; // lost the race → the winner owns the envelope too
      // Package visit: expiring the job closes the season envelope and
      // frees the barn's reserved feet (no phantom spring work in S4).
      if (gid0) {
        await admin.from("storage_stays").update({ status: "cancelled" }).eq("group_id", gid0).eq("status", "reserved");
        await admin.from("job_groups").update({ status: "cancelled", storing_vendor: null }).eq("id", gid0);
      }
      expired++;
      // EVERY DOOR. This is the machine cancelling somebody's booked work in
      // the night. On text alone — 0 of 81 delivered since July — they find
      // out by nobody arriving.
      if (canTell) {
        const told = await notify(
          `the owner that their ${svc} was cancelled for want of a crew (job ${j.id})`,
          owner,
          {
            sms: `LakeLife: we couldn't line up a crew in time for ${svc} at ${where} — so we've cancelled it and you were never charged. Rebook any open day (${site}/book), or invite a crew you trust and they're always first on your jobs (${site}/book). We're recruiting on your lake. 🌊`,
            subject: `Your ${svc} at ${where} was cancelled — you were never charged`,
            body:
              `We couldn't line up a crew in time for ${svc} at ${where}, so we've cancelled it. You were never charged.\n\n` +
              `Rebook any open day:\n  ${site}/book\n\n` +
              `Or invite a crew you trust — they're always first on your jobs:\n  ${site}/book\n\n` +
              `We're recruiting on your lake.`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
      }
    } else if (warningDue(j.date as string, today, waitlistWarningDays)) {
      // AUDIT BUG 10d: the warning used to be a bare date equality — a missed
      // nightly lost it forever, a manual re-run re-texted everyone in the
      // window. warningDue now covers a short CATCH-UP window, and the
      // sent-ledger (0049, unique on (job_id, kind)) is what makes it
      // exactly-once: the INSERT is the claim, so two runs racing the same
      // job produce one text. A duplicate means "already warned" — stay quiet.
      const { error: logErr } = await admin
        .from("waitlist_notice_log")
        .insert({ job_id: j.id as string, kind: WAITLIST_WARNING_KIND });
      if (logErr) {
        if (!/duplicate|unique/i.test(logErr.message)) {
          console.error(`[waitlist warn ${j.id}] ledger write failed:`, logErr.message);
          skipped.push(`Job ${j.id} (${svc} on ${j.date}): the warning ledger refused the claim, so the customer's one options text didn't go — the job is still open.`);
        }
        continue; // never text without a durable record of having texted
      }
      warned++;
      if (canTell) {
        // If a price bump would unlock a crew RIGHT NOW (rung 3), say so in
        // the same text — the fix shouldn't hide on a page they may not visit.
        let boost = "";
        try {
          const offer = await computeScarcityOffer(j.id as string);
          if (offer) boost = ` Crews are tight that day — add $${offer.uplift.toFixed(2)} (new total $${offer.newPrice.toFixed(2)}) on your requests page and we'll lock one in now.`;
        } catch {
          /* offer is a bonus, never a blocker */
        }
        const told = await notify(
          `the owner their options while we look for a crew (job ${j.id})`,
          owner,
          {
            sms: `LakeLife: still lining up a crew for ${svc} at ${where} on ${prettyDate(j.date as string)}. You can hold tight (no charge unless it's done), pick a different day (${site}/requests), or invite a crew you know (${site}/book) — they'd be first on all your jobs.${boost} 🌊`,
            subject: `Still lining up a crew for ${svc} at ${where} on ${prettyDate(j.date as string)}`,
            body:
              `We're still lining up a crew for ${svc} at ${where} on ${prettyDate(j.date as string)}.\n\n` +
              `You can hold tight — there's no charge unless it's done.\n\n` +
              `Pick a different day:\n  ${site}/requests\n\n` +
              `Or invite a crew you know — they'd be first on all your jobs:\n  ${site}/book` +
              `${boost ? `\n\n${boost.trim()}` : ""}`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
      }
    }
  }
  return { ok: true, warned, expired, escalated, skipped };
}

/**
 * ⚡ SAME-DAY RUSH FALLBACK. When the rush window closes with a rush job still
 * unclaimed, execute the customer's PRE-CHOSEN fallback — no limbo, no ops:
 *  - 'roll'   → move to tomorrow at the STANDARD price (the premium bought a
 *               shot at today, not tomorrow) and run normal dispatch;
 *  - 'cancel' → delete it — nothing was ever charged.
 * Runs on the intraday heartbeat (first beat past the cutoff resolves) and
 * nightly as the backstop for anything stale.
 */
export async function resolveRushFallbacks(): Promise<{ ok: boolean; rolled: number; cancelled: number }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const { sameDayCutoffHour } = await getPlatformSettings();
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Indiana/Indianapolis", hour12: false, hour: "2-digit" }).format(new Date())) % 24;

  // Nothing to resolve while the window is still open (today's rush jobs are
  // legitimately waiting to be claimed); stale rows from prior days always resolve.
  const windowStillOpen = rushWindowOpen(hour, sameDayCutoffHour);
  let q = admin
    .from("jobs")
    .select("id, date, rush_fallback, service_id, property_id, customer_price, services(name, pricing_model, base, unit_rate, band_pricing), properties(owner_id, address, nickname)")
    .eq("is_rush", true)
    .eq("status", "requested")
    .is("vendor_id", null)
    .lte("date", today)
    .limit(50);
  if (windowStillOpen) q = q.lt("date", today); // only stale rows mid-window
  const stuck = mustRead("the unclaimed rush jobs", await q);

  const tomorrow = addDays(today, 1);
  let rolled = 0, cancelled = 0;
  for (const j of stuck ?? []) {
    const svcRow = one(j.services) as { name?: string; pricing_model?: string; base?: number; unit_rate?: number; band_pricing?: unknown } | null;
    const prop = one(j.properties) as { owner_id?: string; address?: string; nickname?: string } | null;
    const svcName = svcRow?.name ?? "your service";
    const where = prop?.nickname || prop?.address || "your place";
    // One branch below DELETES the job and the other moves the day and reprices
    // it. Neither is a thing to do to somebody we then cannot text, and a failed
    // read looks exactly like "no phone on file".
    const phoneRes = prop?.owner_id
      ? await admin.from("users").select("phone, email").eq("id", prop.owner_id).maybeSingle()
      : null;
    if (phoneRes?.error) {
      console.error(`[read failed] the owner's phone number (job ${j.id}):`, phoneRes.error);
      continue;
    }
    const owner = {
      phone: (phoneRes?.data?.phone as string | undefined) ?? null,
      email: (phoneRes?.data?.email as string | undefined) ?? null,
    };
    const canTell = !!(owner.phone || owner.email);

    if ((j.rush_fallback as string) === "cancel") {
      const { data: gone } = await admin
        .from("jobs").delete().eq("id", j.id as string).eq("status", "requested").is("vendor_id", null).select("id");
      if (!gone || gone.length === 0) continue; // claimed at the buzzer — leave it
      cancelled++;
      if (canTell) {
        await notify(
          `the owner that their same-day ${svcName} was cancelled as they asked (job ${j.id})`,
          owner,
          {
            sms: `LakeLife: no crew could free up today for ${svcName} at ${where} — cancelled as you asked, nothing charged. Book any other day at your standard price. 🌊`,
            subject: `Your ${svcName} at ${where} was cancelled — nothing charged`,
          },
        );
      }
      continue;
    }

    // Roll: tomorrow at the STANDARD menu price, recomputed server-side.
    let standard = Number(j.customer_price ?? 0); // fallback: keep rush price only if repricing fails
    let repriced = false;
    // SEAM: loadPricingProfileById and groundsFor THROW on a failed read now.
    // Uncaught, one park's dropped connection would abort the beat and leave
    // every REMAINING rush job unresolved. Cron rule: log and skip the item.
    // A skipped job leaves `repriced` false, which lands in the "could not work
    // out the standard price" branch below — the outcome already designed for
    // not knowing the price, and it says nothing false to anyone.
    try {
      const profile = await loadPricingProfileById(admin, j.property_id as string);
      if (svcRow?.name && profile) {
        const rule: ServiceRule = {
          name: svcRow.name,
          pricing_model: svcRow.pricing_model as ServiceRule["pricing_model"],
          base: Number(svcRow.base ?? 0),
          unit_rate: Number(svcRow.unit_rate ?? 0),
          band_pricing: (svcRow.band_pricing as ServiceRule["band_pricing"]) ?? null,
        };
        // A PARK PAYS ITS OWN RATE (0115). Without the overlay the global row is
        // base 0 / unit_rate 0, priceService returns 0, the `p > 0` guard below
        // declines to use it, and `standard` stays at the RUSH price — so the
        // rolled job keeps its 25% same-day premium and the text that follows
        // calls that number "the standard price". The guard that was meant to
        // fail safe is what makes it charge more.
        const grounds = await groundsFor(j.property_id as string);
        const p = priceService(
          grounds ? withParkRate({ ...rule, id: j.service_id as string }, await loadParkRates(grounds.parkId)) : rule,
          profile,
        );
        if (p > 0) { standard = p; repriced = true; }
      }
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.error(`[read failed] the standard price for this rush job (job ${j.id}):`, e);
    }

    // COULD NOT WORK OUT THE STANDARD PRICE. Rolling anyway would move the day
    // AND keep the premium, then tell him it is standard. Leave it for the
    // waitlist sweep and say nothing false.
    // Every job that reaches here is a rush job (rush_fallback 'roll'), so
    // `standard` is still carrying the same-day premium.
    if (!repriced) continue;
    const { data: moved } = await admin
      .from("jobs")
      .update({ date: tomorrow, customer_price: standard, is_rush: false, rush_fallback: null })
      .eq("id", j.id as string)
      .eq("status", "requested")
      .is("vendor_id", null)
      .select("id");
    if (!moved || moved.length === 0) continue; // claimed at the buzzer — leave it
    rolled++;
    let assignedNow = false;
    try {
      assignedNow = (await autoAssignJob(j.id as string)).assigned;
    } catch { /* waitlist sweeps take it from here */ }
    if (canTell) {
      await notify(
        `the owner that their same-day ${svcName} moved to tomorrow (job ${j.id})`,
        owner,
        {
          sms: `LakeLife: no crew could free up today for ${svcName} at ${where}, so it's moved to tomorrow at the standard price ($${standard.toFixed(2)})${assignedNow ? " — and a crew is already locked in" : " — we're lining up a crew now"}. 🌊`,
          subject: `Your ${svcName} at ${where} moved to tomorrow at the standard price`,
        },
      );
    }
  }
  return { ok: true, rolled, cancelled };
}

/** PHASE E: per-lake auto-demotion. A crew whose net strikes (no-shows minus
 *  completions) on ONE lake reach the dial gets paused there: the lake is
 *  removed from their service area and a cooldown row blocks claims/re-adds
 *  until the clock runs out. Nobody suspends anyone — the marketplace heals. */
export async function demoteLakeStrikes(): Promise<{ ok: boolean; demoted: number; skipped: string[] }> {
  const admin = createServiceClient();
  const { lakeStrikeLimit } = await getPlatformSettings();
  // A crew loses a lake here. If we could not tell them, that has to be said
  // out loud — they find out by their work drying up otherwise.
  const skipped: string[] = [];

  const [vendorsRes, missesRes, donesRes, lakesRes] = await Promise.all([
    admin.from("vendors").select("id, user_id, service_lakes").eq("status", "active"),
    admin.from("vendor_no_shows").select("vendor_id, lake_id").not("lake_id", "is", null),
    admin.from("jobs").select("vendor_id, properties(lake_id)").in("status", ["complete", "paid"]).not("vendor_id", "is", null),
    admin.from("lakes").select("id, name"),
  ]);
  // The COMPLETIONS read is the dangerous one: empty, every crew looks like
  // nothing but no-shows and shouldDemote strips lakes off crews who have been
  // working them all season. This takes a lake away from somebody — it runs on
  // facts or it does not run.
  const vendors = mustRead("the active crews", vendorsRes);
  const misses = mustRead("the recorded no-shows", missesRes);
  const dones = mustRead("the jobs those crews completed", donesRes);
  const lakes = mustRead("the lakes", lakesRes);
  const lakeName = new Map((lakes ?? []).map((l) => [l.id as string, l.name as string]));

  const key = (v: string, l: string) => `${v}|${l}`;
  const strikes = new Map<string, number>();
  for (const m of misses ?? []) strikes.set(key(m.vendor_id as string, m.lake_id as string), (strikes.get(key(m.vendor_id as string, m.lake_id as string)) ?? 0) + 1);
  const comps = new Map<string, number>();
  for (const d of dones ?? []) {
    const lk = (one(d.properties) as { lake_id?: string } | null)?.lake_id;
    if (!lk) continue;
    comps.set(key(d.vendor_id as string, lk), (comps.get(key(d.vendor_id as string, lk)) ?? 0) + 1);
  }

  let demoted = 0;
  for (const v of vendors ?? []) {
    const myLakes = (v.service_lakes as string[]) ?? [];
    for (const lk of myLakes) {
      const s = strikes.get(key(v.id as string, lk)) ?? 0;
      const c = comps.get(key(v.id as string, lk)) ?? 0;
      if (!shouldDemote(s, c, lakeStrikeLimit)) continue;

      // Pause: drop the lake from their service area + start the cooldown.
      await admin.from("vendors").update({ service_lakes: myLakes.filter((x) => x !== lk) }).eq("id", v.id as string);
      await admin.from("vendor_lake_demotions").upsert(
        { vendor_id: v.id, lake_id: lk, strikes: s, demoted_at: new Date().toISOString() },
        { onConflict: "vendor_id,lake_id" },
      );
      demoted++;

      if (v.user_id) {
        const { data: cu, error: cuErr } = await admin.from("users").select("phone, email").eq("id", v.user_id as string).maybeSingle();
        // POST-WRITE: the lake is already off their service area and the
        // cooldown has started. Nothing to undo, and nothing to tell them with.
        if (cuErr) {
          console.error(`[read failed] the crew's phone number (${v.id}):`, cuErr);
          skipped.push(`Crew ${v.id}: paused on ${lakeName.get(lk) ?? "a lake"}, but we couldn't read their phone number — they were never told, and their work there just stops.`);
        }
        // EVERY DOOR: a crew that is never told just watches the work on that
        // lake stop, with no idea why or how it comes back.
        if (cu?.phone || cu?.email) {
          const told = await notify(
            `the crew that they are paused on ${lakeName.get(lk) ?? "a lake"}`,
            { phone: cu?.phone as string | null, email: cu?.email as string | null },
            {
              sms: `LakeLife: after repeated missed jobs on ${lakeName.get(lk) ?? "a lake"}, we've paused routing you there for a while. Keep completing jobs on your other lakes and it reopens automatically. Advance-notice blocks never count against you. 🌊`,
              subject: `You're paused on ${lakeName.get(lk) ?? "a lake"} for a while`,
            },
          );
          if (!told.reached && told.note) skipped.push(told.note);
        }
      }
      break; // one demotion per crew per night — no pile-ons
    }
  }
  return { ok: true, demoted, skipped };
}

/** PHASE E: base-pin self-heal. The rolling median of where a crew actually
 *  COMPLETES jobs is ground truth for proximity ranking — set a missing pin
 *  from it, correct a wildly-wrong one (>25 mi), leave sane pins alone. */
export async function selfHealCrewBases(): Promise<{ ok: boolean; set: number; corrected: number; skipped: string[] }> {
  const admin = createServiceClient();
  // Crews whose pin could not be judged tonight. A missing pin costs them
  // proximity rank every day it stays missing, so "0 set, 0 corrected" must
  // not be able to mean "we never looked".
  const skipped: string[] = [];
  const vendors = mustRead("the active crews", await admin
    .from("vendors")
    .select("id, base_lat, base_lng")
    .eq("status", "active"));

  let setCount = 0, corrected = 0;
  for (const v of vendors ?? []) {
    const { data: recent, error: recentErr } = await admin
      .from("jobs")
      .select("date, properties(lat, lng)")
      .eq("vendor_id", v.id as string)
      .in("status", ["complete", "paid"])
      .order("date", { ascending: false })
      .limit(20);
    // No points is the input healBase judges a pin against; a failed read must
    // not be allowed to look like "this crew has completed nothing".
    if (recentErr) {
      console.error(`[read failed] where this crew has been completing jobs (${v.id}):`, recentErr);
      skipped.push(`Crew ${v.id}: couldn't read where they have been completing jobs, so their base pin was left exactly as it is.`);
      continue;
    }
    const points = (recent ?? []).map((r) => {
      const p = one(r.properties) as { lat?: number; lng?: number } | null;
      return { lat: p?.lat != null ? Number(p.lat) : null, lng: p?.lng != null ? Number(p.lng) : null };
    });
    const d = healBase(points, v.base_lat != null ? Number(v.base_lat) : null, v.base_lng != null ? Number(v.base_lng) : null);
    if (d.action === "keep") continue;
    await admin.from("vendors").update({ base_lat: d.lat, base_lng: d.lng }).eq("id", v.id as string);
    if (d.action === "set") setCount++;
    else corrected++;
  }
  return { ok: true, set: setCount, corrected, skipped };
}

/** AUTOPILOT (§8d): propose each enrolled service's next visit and text the
 *  owner a one-tap confirm/skip. One OPEN proposal per enrollment (DB-enforced);
 *  nothing is booked without the customer's tap; skip is free. Proposals older
 *  than 14 days quietly expire (no nagging). */
export async function generateAutopilotProposals(): Promise<{ ok: boolean; proposed: number; expired: number; texted: number; skipped: string[] }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  // Enrollments that got no proposal tonight. Autopilot's whole promise is
  // that the customer never has to remember; an enrollment silently skipped
  // every night is the promise quietly not being kept.
  const skipped: string[] = [];

  // Expire stale proposals (their token links die with them).
  const { data: stale, error: staleErr } = await admin
    .from("autopilot_events")
    .update({ status: "expired" })
    .eq("status", "proposed")
    .lt("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
    .select("id");
  if (staleErr) {
    console.error("[read failed] expiring stale autopilot proposals:", staleErr);
    skipped.push("Couldn't expire the stale proposals, so 14-day-old confirm links may still be live tonight.");
  }
  const expired = stale?.length ?? 0;

  const enrollments = mustRead("the autopilot enrollments", await admin
    .from("autopilot_enrollments")
    .select("id, property_id, service_id, locked_price, services(name, is_water_work), properties(owner_id, address, nickname, lake_id, lakes(ice_out_actual, pull_deadline))")
    .eq("active", true));

  let proposed = 0, texted = 0;
  for (const e of enrollments ?? []) {
    // One open proposal at a time (also DB-enforced by the partial unique index).
    const { data: open, error: openErr } = await admin
      .from("autopilot_events").select("id").eq("enrollment_id", e.id).eq("status", "proposed").maybeSingle();
    // FAILS OPEN IF IGNORED: null reads as "no open proposal" and texts the
    // owner a second one. (The partial unique index would refuse the insert,
    // but only after we had already decided to send.)
    if (openErr) {
      console.error(`[read failed] this enrollment's open proposal (${e.id}):`, openErr);
      skipped.push(`Enrollment ${e.id}: couldn't check for an open proposal, so nothing was proposed tonight — tomorrow's run looks again.`);
      continue;
    }
    if (open) continue;
    // Don't propose when a manual/confirmed booking is already ahead.
    const { data: upcoming, error: upcomingErr } = await admin
      .from("jobs").select("id")
      .eq("property_id", e.property_id).eq("service_id", e.service_id)
      .in("status", ["requested", "scheduled", "in_progress"])
      .gte("date", today)
      .limit(1);
    // FAILS OPEN IF IGNORED: null reads as "nothing booked", and we propose a
    // visit to somebody who already has one on the calendar.
    if (upcomingErr) {
      console.error(`[read failed] whether a visit is already booked (${e.id}):`, upcomingErr);
      skipped.push(`Enrollment ${e.id}: couldn't check whether a visit is already booked, so nothing was proposed tonight — tomorrow's run looks again.`);
      continue;
    }
    if (upcoming && upcoming.length > 0) continue;

    const svc = one(e.services) as { name?: string; is_water_work?: boolean } | null;
    const prop = one(e.properties) as { owner_id?: string; address?: string; nickname?: string; lakes?: unknown } | null;
    const lake = one(prop?.lakes) as { ice_out_actual?: string; pull_deadline?: string } | null;
    if (!svc?.name || !prop?.owner_id) continue;

    const { data: lastDone, error: lastDoneErr } = await admin
      .from("jobs").select("date")
      .eq("property_id", e.property_id).eq("service_id", e.service_id)
      .in("status", ["complete", "paid"])
      .order("date", { ascending: false })
      .limit(1);
    // The last visit is what the proposed date is measured from — a failed read
    // reads as "never done" and pencils the wrong day into a text.
    if (lastDoneErr) {
      console.error(`[read failed] when this service was last done (${e.id}):`, lastDoneErr);
      skipped.push(`Enrollment ${e.id}: couldn't read when the service was last done, so no date was penciled tonight — tomorrow's run looks again.`);
      continue;
    }
    const date = proposeAutopilotDate({
      serviceName: svc.name,
      isWaterWork: !!svc.is_water_work,
      iceOutISO: (lake?.ice_out_actual as string) ?? null,
      pullDeadlineISO: (lake?.pull_deadline as string) ?? null,
      lastCompletedISO: (lastDone?.[0]?.date as string) ?? null,
      todayISO: today,
    });
    if (!date) continue;

    const { data: ev } = await admin
      .from("autopilot_events")
      .insert({ enrollment_id: e.id, proposed_date: date })
      .select("confirm_token")
      .maybeSingle();
    if (!ev) continue;
    proposed++;

    const { data: owner, error: ownerErr } = await admin.from("users").select("phone, email").eq("id", prop.owner_id).maybeSingle();
    // POST-WRITE. The proposal row now exists with a confirm token nobody was
    // sent — and it holds the enrollment's one open slot until it expires in
    // 14 days, so this quietly costs them a whole cycle.
    if (ownerErr) {
      console.error(`[read failed] how to reach the owner (enrollment ${e.id}):`, ownerErr);
      skipped.push(`Enrollment ${e.id}: a visit was penciled for ${prettyDate(date)} but we couldn't read how to reach the owner — the confirm link was never sent, and it holds their slot for 14 days.`);
    }
    if (owner?.phone || owner?.email) {
      const where = prop.nickname || prop.address || "your place";
      // EVERY DOOR: the confirm token holds the enrollment's one open slot for
      // 14 days. A link that reaches nobody costs them the whole cycle.
      const told = await notify(
        `the owner that we penciled ${svc.name} for ${prettyDate(date)} (enrollment ${e.id})`,
        { phone: owner?.phone as string | null, email: owner?.email as string | null },
        {
          sms: `LakeLife Autopilot 🌊: time for ${svc.name} at ${where} — we've penciled ${prettyDate(date)} at your locked price. Book it: ${site}/a/${ev.confirm_token}/confirm  ·  Skip: ${site}/a/${ev.confirm_token}/skip`,
          subject: `We've penciled ${svc.name} at ${where} for ${prettyDate(date)}`,
          body:
            `It's time for ${svc.name} at ${where} — we've penciled ${prettyDate(date)} at your locked price.\n\n` +
            `Book it:\n  ${site}/a/${ev.confirm_token}/confirm\n\n` +
            `Skip it:\n  ${site}/a/${ev.confirm_token}/skip`,
        },
      );
      if (!told.reached && told.note) skipped.push(told.note);
      texted++;
    }
  }
  return { ok: true, proposed, expired, texted, skipped };
}

/** Seasonal "book your fall pull before freeze" email. Fires the day a lake's
 *  pull deadline is exactly `leadDays` out (default 14) — so it sends once per
 *  lake per season, no per-user tracking column needed. */
export async function sendSeasonalPullReminders(leadDays = 14): Promise<{ ok: boolean; lakes: number; emailed: number; skipped: string[] }> {
  const target = addDays(todayLakeDate(), leadDays);
  const admin = createServiceClient();
  // THIS FIRES ONCE PER LAKE PER SEASON, on an exact date match. A lake
  // skipped tonight is not retried tomorrow — the target date has moved on —
  // so a silent skip is the season's freeze warning simply never sent.
  const skipped: string[] = [];
  // 0124: fixtures excluded. This is a SEND — it fans out over every property
  // on the matched lake and emails each owner by name. A born fixture inherits
  // real-looking season dates from lake-birth, so its pull_deadline genuinely
  // lands on the target day; nothing about the date says "this lake is fake".
  const lakes = mustRead("the lakes whose pull deadline is coming up", await admin
    .from("lakes").select("id, name, pull_deadline")
    .eq("is_fixture", false).eq("pull_deadline", target));
  if (!lakes || lakes.length === 0) return { ok: true, lakes: 0, emailed: 0, skipped };

  let emailed = 0;
  for (const lake of lakes) {
    const { data: props, error: propsErr } = await admin
      .from("properties")
      .select("id, address, users(id, email, name)")
      .eq("lake_id", lake.id);
    // Empty reads as "nobody lives on this lake" and the season's one warning
    // is silently never sent — the claim ledger means it never sends again.
    if (propsErr) {
      console.error(`[read failed] the homes on this lake (${lake.id}):`, propsErr);
      skipped.push(`${lake.name}: couldn't read the homes on the lake, so NOBODY got this season's pull-deadline warning (deadline ${lake.pull_deadline}). This fires on one date a year — it will not retry itself.`);
      continue;
    }
    const seen = new Set<string>();
    // The YEAR of the deadline we are warning about. Keyed by season, not by
    // date, so a re-run with a different `?lead=` is still the same message.
    const seasonYear = Number(String(lake.pull_deadline).slice(0, 4));
    for (const p of props ?? []) {
      const u = one((p as { users?: unknown }).users) as
        { id?: string; email?: string; name?: string } | null;
      const email = u?.email;
      if (!email || seen.has(email)) continue;
      seen.add(email);
      // "Seasonal reminders" is one of the six switches. It now works.
      if (!(await allowsNotification(u?.id, "season", "email"))) continue;

      // THE CLAIM ROW IS THE LEDGER. This used to fire on a date match alone,
      // with a de-dupe set that lived for one invocation — and the route takes
      // GET, POST and a caller-supplied `?lead=`, so anyone checking that it
      // worked re-emailed every household on the lake. The INSERT is how a
      // second attempt finds out it has nothing to do.
      const { error: claimErr } = await admin
        .from("seasonal_notice_log")
        .insert({ property_id: (p as { id: string }).id, season_year: seasonYear });
      if (claimErr) continue; // 23505 = already told about this season
      const deadline = prettyDate(lake.pull_deadline as string);
      void sendEmail({
        to: email,
        subject: `Book your fall pull on ${lake.name} before the freeze`,
        html: `<p>Hi ${u?.name ?? "there"},</p><p>${lake.name}'s pull deadline is <b>${deadline}</b> — that's when piers, lifts and boats need to be out ahead of the hard freeze (we build in an 8-day safety buffer). Book your fall pull now so your crew has a slot before the rush.</p><p>Open LakeLife to schedule. 🌊</p>`,
      });
      emailed++;
    }
  }
  return { ok: true, lakes: lakes.length, emailed, skipped };
}

// ============================================================================
// S4 — spring two-phase: the season envelope births its spring visit at
// ice-out, custody stays sticky, and the overstay meter stays polite.
// ============================================================================

/**
 * Birth spring visits (nightly). For every ACTIVE envelope with a spring
 * recipe, a COMPLETED fall visit, and its lake's ice-out confirmed on/after
 * the fall visit (i.e. THIS coming spring, not last year's stale date):
 * create the spring job dated ice-out + 14 days (lift/pier breathing room)
 * at the QUOTED price (the booking-time promise; per-diem rides on top at
 * splash). Stored boats pre-assign to the storing vendor — the boat is
 * physically in their barn, there is no dispatch lottery. Home-storage
 * variants flow through the component-aware engine like any job.
 */
export async function birthSpringJobs(): Promise<{ ok: boolean; born: number; sticky: number; skipped: string[] }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  let born = 0, sticky = 0;
  // WHAT DIDN'T GET BORN, AND WHY, in words a person can act on. Every skip
  // below is a boat whose spring visit does not exist tonight — it existed
  // only as a console line before, and `{ok:true, born:0}` is exactly what a
  // clean night looks like. The nightly carries this into the digest.
  const skipped: string[] = [];

  const groups = mustRead("the active season envelopes", await admin
    .from("job_groups")
    .select("id, property_id, spring_service_ids, spring_quote, storing_vendor, fall_job_id, properties(lake_id, owner_id, lakes(name, ice_out_actual))")
    .eq("status", "active"));
  for (const g of groups ?? []) {
    const springIds = (g.spring_service_ids as string[]) ?? [];
    if (springIds.length === 0) continue;
    const prop = (Array.isArray(g.properties) ? g.properties[0] : g.properties) as
      | { lake_id?: string; owner_id?: string; lakes?: unknown } | null;
    const lake = (Array.isArray(prop?.lakes) ? prop?.lakes[0] : prop?.lakes) as
      | { name?: string; ice_out_actual?: string } | null;
    const iceOut = lake?.ice_out_actual as string | undefined;
    if (!iceOut || iceOut > today) continue;

    // Exactly-once: skip envelopes with a LIVE spring job (a cancelled
    // penciled date may re-birth); the partial unique index in 0037 is
    // the concurrent-nightly backstop.
    const { data: existing, error: existingErr } = await admin
      .from("jobs").select("id").eq("group_id", g.id as string).eq("phase", "spring").neq("status", "cancelled").limit(1);
    // FAILS OPEN IF IGNORED: null reads as "no spring job yet" and births a
    // second billable visit. The 0037 index is the backstop, not the check.
    if (existingErr) {
      console.error(`[read failed] this envelope's existing spring job (${g.id}):`, existingErr);
      skipped.push(`Envelope ${g.id}: couldn't check whether its spring visit already exists — no visit born tonight; tomorrow's run looks again.`);
      continue;
    }
    if (existing && existing.length > 0) continue;

    // The fall visit must be DONE, and the ice-out must belong to the spring
    // AFTER it — a stale last-spring date would otherwise birth in October.
    if (!g.fall_job_id) continue;
    const { data: fall, error: fallErr } = await admin
      .from("jobs").select("status, date").eq("id", g.fall_job_id as string).maybeSingle();
    if (fallErr) {
      console.error(`[read failed] the fall visit behind this envelope (${g.id}):`, fallErr);
      skipped.push(`Envelope ${g.id}: couldn't read the fall visit it hangs off — no spring visit born tonight; tomorrow's run looks again.`);
      continue;
    }
    if (!fall || !["complete", "paid"].includes(fall.status as string)) continue;
    if (iceOut < ((fall.date as string) ?? "")) continue;

    // SEAM: loadPricingProfileById THROWS on a failed read (mustRead inside).
    // Uncaught, ONE property's dropped connection aborts the whole birth run
    // and every REMAINING envelope's spring visit goes unborn — invisibly,
    // since the throw takes the counts with it. Cron rule 1: log, name it,
    // skip THIS envelope. The next nightly births it.
    let profile: Awaited<ReturnType<typeof loadPricingProfileById>>;
    try {
      profile = await loadPricingProfileById(admin, g.property_id as string);
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.error(`[read failed] the property to price the spring visit against (${g.id}):`, e);
      skipped.push(`Envelope ${g.id}: couldn't read the property to price the spring visit — no visit born tonight; tomorrow's run tries again.`);
      continue;
    }
    const { data: svcRows, error: svcErr } = await admin
      .from("services")
      .select("id, name, kind, pricing_model, base, unit_rate, band_pricing")
      .in("id", springIds);
    // These rows are what the spring visit is priced from.
    if (svcErr) {
      console.error(`[read failed] the spring services to price (${g.id}):`, svcErr);
      skipped.push(`Envelope ${g.id}: couldn't read the services the spring visit is priced from — no visit born tonight; tomorrow's run tries again.`);
      continue;
    }
    if (!profile || !svcRows?.length) continue;

    const { anchorFromServices } = await import("@/lib/packages");
    const anchor = anchorFromServices(svcRows.map((s) => ({ id: s.id as string, kind: (s.kind as string) ?? "component", pricing_model: s.pricing_model as string })));
    if (!anchor) continue;

    // Per-leg prices recomputed for the breakdown, then trued to the QUOTE:
    // the customer pays what they were promised, to the penny, even if the
    // owner turned menu dials mid-winter. Largest leg absorbs the rounding.
    const quote = Math.round(Number(g.spring_quote ?? 0));
    const legs = svcRows.map((s) => ({
      id: s.id as string,
      price: priceService({
        name: s.name as string, pricing_model: s.pricing_model as ServiceRule["pricing_model"],
        base: Number(s.base ?? 0), unit_rate: Number(s.unit_rate ?? 0),
        band_pricing: (s.band_pricing as ServiceRule["band_pricing"]) ?? null,
      }, profile),
    }));
    const sum = legs.reduce((t, l) => t + l.price, 0);
    const trued = quote > 0 ? (await import("@/lib/storage")).trueLegsToQuote(legs, quote) : legs;
    legs.length = 0; legs.push(...trued);
    const price = quote > 0 ? quote : sum;

    const springDate = (() => {
      const d = new Date(iceOut + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + 14);
      const proposed = d.toISOString().slice(0, 10);
      // A backfilled ice-out must never birth a job already in the past —
      // that would feed it straight into the no-show/expiry machinery.
      const t = new Date(today + "T12:00:00Z");
      t.setUTCDate(t.getUTCDate() + 2);
      const floor = t.toISOString().slice(0, 10);
      return proposed > floor ? proposed : floor;
    })();

    const { data: job, error: birthErr } = await admin
      .from("jobs")
      .insert({
        property_id: g.property_id, service_id: anchor, date: springDate,
        frequency: "One-time (spring)", status: "requested",
        customer_price: price, group_id: g.id, phase: "spring", price_finalized: false,
      })
      .select("id").single();
    if (birthErr || !job) continue; // unique-index loser (twin nightly) or transient — next night retries
    const { error: legsErr } = await admin
      .from("job_items").insert(legs.map((l) => ({ job_id: job.id, service_id: l.id, customer_price: l.price, vendor_cost: 0 })));
    if (legsErr) {
      // A spring job with no legs would dodge the summed photo gate and
      // confuse dispatch — unwind and let the next nightly re-birth it.
      await admin.from("jobs").delete().eq("id", job.id);
      continue;
    }
    born++;

    // Sticky custody: the storing vendor holds the boat — assign directly at
    // THEIR rates (legs without a rate price $0 and show up on Margin Health;
    // physics beats the rate card when the boat is already in the barn).
    const { data: stay, error: stayErr } = await admin
      .from("storage_stays").select("id, status").eq("group_id", g.id as string).eq("status", "in_storage").maybeSingle();
    // FAILS OPEN IF IGNORED: null reads as "no boat in anybody's barn" and the
    // else-branch below hands the splash to the dispatch lottery — a crew who
    // cannot do it, because the boat is physically in someone else's building.
    if (stayErr) {
      console.error(`[read failed] whether the boat is in a barn (${g.id}):`, stayErr);
      skipped.push(`Envelope ${g.id}: the spring visit was created but we couldn't tell whether the boat is in a barn — it has no crew yet and is sitting on the ops board.`);
      continue;
    }
    // Sticky custody needs a HEALTHY barn: suspended crew or lapsed COI is
    // a genuine exception (the boat is physically theirs) — leave the job
    // requested, alert ops, and let the docs get fixed rather than
    // assigning work to a crew the platform has benched.
    let stickyOk = false;
    if (stay && g.storing_vendor) {
      const { data: sv, error: svErr } = await admin
        .from("vendors").select("status, coi_expiry").eq("id", g.storing_vendor as string).maybeSingle();
      // A failed read would text ops that the storing crew "is not active" —
      // a statement about that crew, made from a dropped connection.
      if (svErr) {
        console.error(`[read failed] the storing crew's standing (${g.storing_vendor}):`, svErr);
        skipped.push(`Envelope ${g.id}: the spring visit was created but we couldn't read the storing crew's standing — it has no crew yet and is sitting on the ops board.`);
        continue;
      }
      stickyOk = sv?.status === "active" && !!sv?.coi_expiry && String(sv.coi_expiry) >= today;
      if (!stickyOk) {
        try {
          const { data: ops, error: opsErr } = await admin.from("users").select("phone, email").eq("role", "ops").not("phone", "is", null);
          if (opsErr) {
            console.error("[read failed] the ops phone numbers for a sticky-custody alert:", opsErr);
            skipped.push(`Envelope ${g.id}: a stored boat's splash can't auto-assign (the storing crew is benched) and we couldn't read the ops phone numbers to say so — nobody was texted.`);
          }
          for (const o of ops ?? []) {
            const told = await notify(
              `ops that a stored boat's spring splash can't auto-assign (group ${g.id})`,
              { phone: o.phone as string | null, email: o.email as string | null },
              {
                sms: `LakeLife OPS: spring splash for a stored boat can't auto-assign — the storing crew is ${sv?.status !== "active" ? "not active" : "COI-lapsed"}. Group ${g.id}. Fix their docs and the machine takes it from there.`,
                subject: `A stored boat's spring splash can't auto-assign — group ${g.id}`,
              },
            );
            if (!told.reached && told.note) skipped.push(told.note);
          }
        } catch { /* best effort */ }
      }
    }
    if (stay && g.storing_vendor && stickyOk) {
      const { data: rates, error: ratesErr } = await admin
        .from("vendor_rates").select("service_id, base, unit_rate, band_pricing")
        .eq("vendor_id", g.storing_vendor as string).in("service_id", springIds);
      // Empty reads as "this crew has no rates", and the job would be assigned
      // to them at a vendor_cost of $0 — they'd do the work for nothing.
      if (ratesErr) {
        console.error(`[read failed] the storing crew's rate card (${g.storing_vendor}):`, ratesErr);
        skipped.push(`Envelope ${g.id}: the spring visit was created but we couldn't read the storing crew's rates, so it was not assigned to them — it is sitting on the ops board.`);
        continue;
      }
      const rateBy = new Map((rates ?? []).map((r) => [r.service_id as string, r]));
      let cost = 0;
      for (const s of svcRows) {
        const vr = rateBy.get(s.id as string);
        if (!vr) continue;
        const c = priceService({
          name: s.name as string, pricing_model: s.pricing_model as ServiceRule["pricing_model"],
          base: Number(vr.base ?? 0), unit_rate: Number(vr.unit_rate ?? 0),
          band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
        }, profile);
        cost += c;
        await admin.from("job_items").update({ vendor_cost: c }).eq("job_id", job.id).eq("service_id", s.id as string);
      }
      await admin.from("jobs")
        .update({ vendor_id: g.storing_vendor, vendor_cost: cost, margin: price - cost, status: "scheduled" })
        .eq("id", job.id).eq("status", "requested");
      sticky++;
    } else {
      try { await autoAssignJob(job.id as string); } catch { /* sweeps keep hunting */ }
    }

    // The penciled-date text — reschedule rides the existing rails.
    try {
      if (prop?.owner_id) {
        const { data: u, error: uErr } = await admin.from("users").select("phone, email").eq("id", prop.owner_id as string).maybeSingle();
        // POST-WRITE: the visit is already on their calendar. Refusing here
        // would undo nothing and lose the text as well, so it is logged and
        // named — somebody has a penciled date they were never told about.
        if (uErr) {
          console.error(`[read failed] the owner's phone number (${g.id}):`, uErr);
          skipped.push(`Envelope ${g.id}: the spring visit is penciled in, but we couldn't read the owner's phone number — nobody told them the date.`);
        }
        const prettyDate = new Date(springDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
        if (u?.phone || u?.email) {
          const told = await notify(
            `the owner that their boat's spring visit is penciled in (envelope ${g.id})`,
            { phone: u?.phone as string | null, email: u?.email as string | null },
            {
              sms: `LakeLife: ice-out is here on ${lake?.name ?? "your lake"} 🌊 We've penciled your boat's spring visit for ${prettyDate} — $${price.toLocaleString()} as quoted at booking. Need a different day? Just cancel and rebook from your requests page, or text us.`,
              subject: `Ice-out on ${lake?.name ?? "your lake"} — your boat's spring visit is penciled for ${prettyDate}`,
            },
          );
          if (!told.reached && told.note) skipped.push(told.note);
        }
      }
    } catch { /* best effort */ }
  }
  return { ok: true, born, sticky, skipped };
}

/**
 * The polite overstay meter (nightly): boats still in storage past the
 * season end, with no scheduled splash on the calendar, get ONE weekly
 * operational text with the running number — never a surprise bill.
 */
export async function overstayNotices(): Promise<{ ok: boolean; sent: number; skipped: string[] }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();
  const today = todayLakeDate();
  const now = Date.now();
  let sent = 0;
  // A meter running on a boat whose owner has not been told is the surprise
  // bill this whole step exists to prevent. Every skip below is one of those.
  const skipped: string[] = [];

  const stays = mustRead("the boats still in storage", await admin
    .from("storage_stays")
    .select("id, group_id, intake_at, job_groups(property_id, status, properties(owner_id, address))")
    .eq("status", "in_storage"));
  for (const st of stays ?? []) {
    const grp = (Array.isArray(st.job_groups) ? st.job_groups[0] : st.job_groups) as
      | { property_id?: string; status?: string; properties?: unknown } | null;
    if (!grp || grp.status !== "active" || !st.intake_at) continue;
    const { seasonEndFor, overstayDays, perdiemCharge } = await import("@/lib/storage");
    const end = seasonEndFor((st.intake_at as string).slice(0, 10), settings.storageSeasonEndMonth, settings.storageSeasonEndDay);
    const days = overstayDays(today, end);
    if (days <= 0) continue;

    // A scheduled splash on the books = the meter is already understood.
    const { data: springJob, error: springJobErr } = await admin
      .from("jobs").select("id").eq("group_id", st.group_id as string).eq("phase", "spring")
      .in("status", ["scheduled", "in_progress"]).limit(1);
    // FAILS OPEN IF IGNORED: null reads as "no splash booked", and somebody
    // with a date on the calendar gets a meter text anyway.
    if (springJobErr) {
      console.error(`[read failed] whether a splash is already booked (${st.group_id}):`, springJobErr);
      skipped.push(`Stay ${st.group_id}: couldn't check whether a splash is booked, so no meter text went out — the per-diem is still accruing.`);
      continue;
    }
    if (springJob && springJob.length > 0) continue;

    const prop = (Array.isArray(grp.properties) ? grp.properties[0] : grp.properties) as
      | { owner_id?: string; address?: string } | null;
    if (!prop?.owner_id) continue;

    // Weekly, not daily — polite is the covenant.
    const { data: last, error: lastErr } = await admin
      .from("nudge_log").select("sent_at").eq("user_id", prop.owner_id as string).eq("kind", `overstay_meter:${st.group_id}`)
      .order("sent_at", { ascending: false }).limit(1).maybeSingle();
    // FAILS OPEN IF IGNORED: no row reads as "never texted", and weekly
    // becomes nightly. Polite is the covenant.
    if (lastErr) {
      console.error(`[read failed] when we last texted this meter (${st.group_id}):`, lastErr);
      skipped.push(`Stay ${st.group_id}: couldn't read when we last texted this meter, so no text went out tonight — the per-diem is still accruing.`);
      continue;
    }
    if (nudgeCooling((last?.sent_at as string) ?? null, 7, now)) continue;

    const charge = perdiemCharge(days, settings.storagePerdiemDaily);
    const { data: u, error: uErr } = await admin.from("users").select("phone, email").eq("id", prop.owner_id as string).maybeSingle();
    if (uErr) {
      console.error(`[read failed] the owner's phone number (${st.group_id}):`, uErr);
      skipped.push(`Stay ${st.group_id}: the meter is at $${charge.toFixed(2)} and we couldn't read the owner's phone number — they have not been told, and nothing was logged as sent.`);
    }
    // EVERY DOOR: this is the notice that stops a per-diem from arriving as a
    // surprise bill at splash. The weekly cooldown row is still written on the
    // attempt, so the cadence is exactly what it was — but a week where it
    // reached nobody now says so in the digest instead of counting as told.
    if (u?.phone || u?.email) {
      const told = await notify(
        `the owner that their boat's storage meter is running (stay ${st.group_id})`,
        { phone: u?.phone as string | null, email: u?.email as string | null },
        {
          sms: `LakeLife: your boat's storage season ended ${end} — the meter's at $${charge.toFixed(2).replace(/\.00$/, "")} ($${settings.storagePerdiemDaily.toFixed(2).replace(/\.00$/, "")}/day, billed at splash). Pick your splash day from your requests page and we'll get it back on the water. 🌊`,
          subject: `Your boat's storage meter is at $${charge.toFixed(2).replace(/\.00$/, "")}`,
        },
      );
      if (!told.reached && told.note) skipped.push(told.note);
      await admin.from("nudge_log").insert({ user_id: prop.owner_id, kind: `overstay_meter:${st.group_id}` });
      sent++;
    }
  }
  return { ok: true, sent, skipped };
}

/**
 * Month-end payout batches (owner: all automated, no human banking).
 * Last lake-day of the month: every crew with released, un-batched job
 * payouts AND a bank account on file gets ONE free batch (fee 0). The
 * queued batch is what the bank-API layer (or the auto-generated ACH
 * export until it lands) executes. Crews without bank details just keep
 * accumulating — nothing is ever lost, and the earnings page nags them.
 */
export async function runMonthlyPayoutBatches(force = false): Promise<{ ok: boolean; ran: boolean; batches: number; total: number; skipped: string[] }> {
  const today = todayLakeDate();
  if (!force && !isLastDayOfMonth(today)) return { ok: true, ran: false, batches: 0, total: 0, skipped: [] };
  const admin = createServiceClient();

  // Empty reads as "no crew is owed anything this month", on the night the
  // crews get paid, and the digest reports it as a quiet night.
  const unbatched = mustRead("the released payouts waiting on a batch", await admin
    .from("payouts").select("vendor_id, amount").eq("status", "released").is("batch_id", null).not("vendor_id", "is", null));
  const byVendor = new Map<string, number>();
  for (const p of unbatched ?? []) byVendor.set(p.vendor_id as string, (byVendor.get(p.vendor_id as string) ?? 0) + Number(p.amount ?? 0));

  // CREWS THIS RUN DIDN'T PAY, IN WORDS. Skipping is the safe direction —
  // the payouts stay released and un-batched, so nothing is lost — but this
  // runs once a month, so a crew skipped tonight waits until the end of the
  // NEXT month, and {batches: 0} looked identical to a month where nobody was
  // owed anything. The nightly carries this into the digest.
  const skipped: string[] = [];
  let batches = 0, total = 0;
  for (const [vendorId, sum] of byVendor) {
    if (sum <= 0) continue;
    const { data: v, error: vErr } = await admin.from("vendors").select("user_id").eq("id", vendorId).maybeSingle();
    // Neither of these failing means what its empty case means. Skipping is the
    // safe direction — the money keeps accumulating — but it must be visible.
    if (vErr) {
      console.error(`[read failed] the crew behind this payout (${vendorId}):`, vErr);
      skipped.push(`crew ${vendorId}: couldn't look up who they are, so $${(Math.round(sum * 100) / 100).toFixed(2)} of released pay was NOT batched — it waits for next month's run`);
      continue;
    }
    if (!v?.user_id) continue;
    const { data: acct, error: acctErr } = await admin
      .from("payout_accounts").select("account_last4").eq("user_id", v.user_id as string).maybeSingle();
    if (acctErr) {
      console.error(`[read failed] this crew's bank details (${vendorId}):`, acctErr);
      skipped.push(`crew ${vendorId}: couldn't read their bank details, so $${(Math.round(sum * 100) / 100).toFixed(2)} of released pay was NOT batched — it waits for next month's run`);
      continue;
    }
    if (!acct) continue; // no bank on file — keep accumulating, keep nudging

    const { data: batch, error: batchErr } = await admin
      .from("payout_batches")
      .insert({ user_id: v.user_id, vendor_id: vendorId, kind: "monthly", status: "building" })
      .select("id").single();
    // The batch IS the payout as far as the banking layer is concerned. No
    // batch, no money — the payouts stay released and un-batched (safe), but a
    // crew with a bank account on file goes another month unpaid.
    if (batchErr) {
      console.error(`[write failed] this crew's monthly payout batch (${vendorId}):`, batchErr);
      skipped.push(`crew ${vendorId}: the payout batch couldn't be created, so $${(Math.round(sum * 100) / 100).toFixed(2)} of released pay was NOT batched — it waits for next month's run`);
    }
    if (!batch) continue;
    const { data: claimed, error: claimErr } = await admin
      .from("payouts")
      .update({ batch_id: batch.id })
      .eq("vendor_id", vendorId).eq("status", "released").is("batch_id", null)
      .select("amount");
    // A failed claim leaves gross at 0, which unwinds the batch below — the
    // right outcome, but not one to reach silently.
    if (claimErr) {
      console.error(`[read failed] claiming this crew's payouts into a batch (${vendorId}):`, claimErr);
      skipped.push(`crew ${vendorId}: their released payouts couldn't be claimed into a batch, so $${(Math.round(sum * 100) / 100).toFixed(2)} was NOT paid out — it waits for next month's run`);
    }
    const gross = Math.round((claimed ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100;
    if (gross <= 0) {
      await admin.from("payouts").update({ batch_id: null }).eq("batch_id", batch.id);
      await admin.from("payout_batches").delete().eq("id", batch.id);
      continue;
    }
    const { data: fin, error: finErr } = await admin
      .from("payout_batches").update({ gross, net: gross, status: "queued" })
      .eq("id", batch.id).eq("status", "building").select("id");
    // An empty `fin` is the ordinary lost-race case (someone else moved the
    // batch out of 'building') and unwinds quietly. An ERRORED one is a crew's
    // whole month not going out, and looked exactly the same.
    if (finErr) {
      console.error(`[write failed] queueing this crew's payout batch (${vendorId}):`, finErr);
      skipped.push(`crew ${vendorId}: their payout batch couldn't be queued for the bank, so $${gross.toFixed(2)} was NOT paid out — it waits for next month's run`);
    }
    if (!fin || fin.length === 0) {
      await admin.from("payouts").update({ batch_id: null }).eq("batch_id", batch.id);
      await admin.from("payout_batches").delete().eq("id", batch.id);
      continue;
    }
    batches++;
    total += gross;
    try {
      const { data: u, error: uErr } = await admin.from("users").select("phone, email").eq("id", v.user_id as string).maybeSingle();
      // POST-WRITE: the batch is queued and the money is on its way. This read
      // only decides whether the crew is TOLD, so it can't refuse anything —
      // but "we queued $X and nobody told them" should be said out loud.
      if (uErr) {
        console.error(`[read failed] the crew's phone number (${vendorId}):`, uErr);
        skipped.push(`crew ${vendorId}: $${gross.toFixed(2)} was queued as normal, but their phone number couldn't be read so NO payout text was sent`);
      }
      if (u?.phone || u?.email) {
        const told = await notify(
          "the crew that their month-end payout is queued",
          { phone: u?.phone as string | null, email: u?.email as string | null },
          {
            sms: `LakeLife: month-end payout queued — $${gross.toFixed(2)} to your account ····${acct.account_last4}, no fee. 🌊`,
            subject: `Your month-end payout is queued — $${gross.toFixed(2)}`,
          },
        );
        if (!told.reached && told.note) skipped.push(told.note);
      }
    } catch { /* best effort */ }
  }
  return { ok: true, ran: true, batches, total: Math.round(total * 100) / 100, skipped };
}

/**
 * FILL-IN DIGEST (margin-gap design, weekly-ish on the growth rails):
 * "$X of fill-in work is open on your lakes right now" — aggregate, never
 * comparative, never a rate critique. A job counts for a crew ONLY when it
 * would actually render as a gap offer for them (their own card, priced
 * against the property, fails the floor — and they aren't paused on the
 * lake), and the dollars are THEIR anchored offers, not the raw ceiling.
 * Two-job minimum so the total can never identify a single job's number
 * (a one-job "aggregate" IS that job — rule 1 by arithmetic again).
 */
export async function runFillInDigest(): Promise<{ ok: boolean; sent: number; skipped: string[] }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();
  const today = todayLakeDate();
  const now = Date.now();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  let sent = 0;
  // THE CREWS WHO HEARD NOTHING, AND WHY. Every skip below is correct — none of
  // them may email a dollar figure we couldn't finish adding up — but `sent: 0`
  // on its own reads as "no fill-in work tonight". The route lifts these into
  // the digest's failures section (noteSkips).
  const skipped: string[] = [];

  // Open, aged, unassigned, non-package jobs = the gap-offer universe.
  // Age gate in LAKE time, failing closed on a missing created_at — the same
  // rule the board and the claim action enforce.
  const { lakeDateOf } = await import("@/lib/booking");
  const open = mustRead("the open fill-in jobs", await admin
    .from("jobs")
    .select("id, date, customer_price, service_id, property_id, created_at, services(name, pricing_model), properties(lake_id)")
    .eq("status", "requested").is("vendor_id", null).is("group_id", null)
    .gte("date", today).limit(200));
  const aged = (open ?? []).filter((j) => {
    const d = j.created_at != null ? lakeDateOf(String(j.created_at)) : null;
    return d != null && d < today;
  });
  if (aged.length === 0) return { ok: true, sent: 0, skipped };

  const [crewsRes, allRatesRes, allPausesRes] = await Promise.all([
    admin.from("vendors")
      .select("id, user_id, company, service_types, service_lakes, work_days, coi_expiry, status")
      .eq("status", "active").not("user_id", "is", null),
    admin.from("vendor_rates").select("vendor_id, service_id, base, unit_rate, band_pricing"),
    admin.from("vendor_lake_demotions").select("vendor_id, lake_id, demoted_at"),
  ]);
  // The PAUSES read is the one that fails open: empty, `pausedNow` is empty and
  // we advertise a lake to the crew we just paused on it. The rates read is the
  // subject line's dollar figure.
  const crews = mustRead("the active crews", crewsRes);
  const allRates = mustRead("the crews' rate cards", allRatesRes);
  const allPauses = mustRead("which crews are paused on which lakes", allPausesRes);
  const { gapTakeHome, gapOfferFor, gapJitter, marginPct } = await import("@/lib/dispatch");
  const { loadGapAnchor } = await import("@/app/vendor/open-data");
  const rateByCrewSvc = new Map((allRates ?? []).map((r) => [`${r.vendor_id}|${r.service_id}`, r]));
  const pausedNow = new Set(
    (allPauses ?? [])
      .filter((p) => isCoolingDown(p.demoted_at as string, settings.lakeDemotionCooldownDays, now))
      .map((p) => `${p.vendor_id}|${p.lake_id}`),
  );
  // Small caches: profiles per property, anchors per crew×service×property.
  const profileCache = new Map<string, Awaited<ReturnType<typeof loadPricingProfileById>>>();
  const anchorCache = new Map<string, number | null>();

  const DIGEST_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const v of crews ?? []) {
    if (!v.coi_expiry || String(v.coi_expiry) < today) continue;
    const myLakes = new Set((v.service_lakes as string[]) ?? []);
    const myDays = new Set((v.work_days as string[]) ?? []);
    let total = 0, count = 0, tallyFailed = false;
    for (const j of aged) {
      const svc = one(j.services) as { name?: string; pricing_model?: string } | null;
      const lakeId = (one(j.properties) as { lake_id?: string } | null)?.lake_id;
      if (!svc?.name || !lakeId || !myLakes.has(lakeId)) continue;
      if (!((v.service_types as string[]) ?? []).includes(svc.name)) continue;
      if (pausedNow.has(`${v.id}|${lakeId}`)) continue;
      // Standing day-off check: don't advertise Saturday work to a crew that
      // never works Saturdays. (Transient gates — a blocked date, a full
      // day — are left to the claim action; the digest is directional.)
      const wd = DIGEST_WEEKDAYS[new Date(String(j.date) + "T12:00:00").getDay()];
      if (myDays.size > 0 && !myDays.has(wd)) continue;
      const vr = rateByCrewSvc.get(`${v.id}|${j.service_id}`);
      if (!vr) continue; // no rate = no capability — this job never gaps for them
      let profile = profileCache.get(j.property_id as string);
      if (profile === undefined) {
        // SEAM: loadPricingProfileById throws on a failed read now. Uncaught it
        // would abort the digest for every REMAINING crew; skipping just the
        // job would quietly understate the dollar figure this crew's subject
        // line asserts. So the ITEM we skip is the crew, not the job.
        try {
          profile = await loadPricingProfileById(admin, j.property_id as string);
        } catch (e) {
          if (!(e instanceof ReadFailed)) throw e;
          console.error(`[read failed] pricing a fill-in job for the digest (crew ${v.id}, job ${j.id}):`, e);
          skipped.push(`no fill-in digest for crew ${v.id}: couldn't price job ${j.id} (${e.message})`);
          tallyFailed = true;
          break;
        }
        profileCache.set(j.property_id as string, profile);
      }
      if (!profile) continue;
      const cardPriced = priceService({
        name: svc.name, pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
        base: Number(vr.base ?? 0), unit_rate: Number(vr.unit_rate ?? 0),
        band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
      }, profile);
      if (!(cardPriced > 0)) continue;
      const menu = Number(j.customer_price ?? 0);
      if (marginPct(menu, cardPriced) >= settings.marginFloor) continue; // clears at card — not a gap for them
      const tStar = gapTakeHome(menu, settings.marginFloor, gapJitter(j.id as string), settings.gapMinOffer);
      if (tStar == null) continue;
      const anchorKey = `${v.id}|${j.service_id}|${j.property_id}`;
      let anchor = anchorCache.get(anchorKey);
      if (anchor === undefined) {
        // SEAM: loadGapAnchor throws on a failed rate-history read. Same rule
        // as the profile above — never abort the run, and never email a total
        // we could not finish adding up.
        try {
          anchor = await loadGapAnchor(
            admin, v.id as string, j.service_id as string, svc.name,
            svc.pricing_model as ServiceRule["pricing_model"], profile, cardPriced,
          );
        } catch (e) {
          if (!(e instanceof ReadFailed)) throw e;
          console.error(`[read failed] this crew's rate history for the digest (crew ${v.id}, job ${j.id}):`, e);
          skipped.push(`no fill-in digest for crew ${v.id}: couldn't read their rate history for job ${j.id} (${e.message})`);
          tallyFailed = true;
          break;
        }
        anchorCache.set(anchorKey, anchor);
      }
      const offer = gapOfferFor(tStar, anchor, settings.gapAnchorPct, settings.gapMinOffer);
      if (offer != null) { total += offer; count++; }
    }
    // A TALLY WE COULDN'T FINISH IS NOT A SMALLER TALLY. The subject line
    // states a dollar amount as fact, so a crew whose tally hit a failed read
    // gets no email this beat rather than a number that is short.
    if (tallyFailed) continue;

    // Two-job minimum + dollar threshold: a single-job "digest" would print
    // that job's exact offer in a subject line — aggregate or nothing.
    if (count < 2 || total < settings.fillinDigestMin) continue;

    const { data: last, error: lastErr } = await admin
      .from("nudge_log").select("sent_at").eq("user_id", v.user_id as string).eq("kind", "fillin_digest")
      .order("sent_at", { ascending: false }).limit(1).maybeSingle();
    // FAILS OPEN IF IGNORED: no row reads as "never sent", and the cooldown
    // this crew is inside of is skipped.
    if (lastErr) {
      console.error(`[read failed] when this crew last got the digest (${v.id}):`, lastErr);
      skipped.push(`no fill-in digest for crew ${v.id} ($${total.toFixed(0)} of work): couldn't read when they last got one (${lastErr.message ?? "read failed"})`);
      continue;
    }
    if (nudgeCooling((last?.sent_at as string) ?? null, settings.fillinDigestCooldownDays, now)) continue;
    const { data: pref, error: prefErr } = await admin
      .from("notification_prefs").select("enabled")
      .eq("user_id", v.user_id as string).eq("type", "growth").eq("channel", "email").maybeSingle();
    // FAILS OPEN IF IGNORED: `null?.enabled === false` is false, i.e. "never
    // opted out" — emailing a crew who turned this off.
    if (prefErr) {
      console.error(`[read failed] this crew's growth-email preference (${v.id}):`, prefErr);
      skipped.push(`no fill-in digest for crew ${v.id} ($${total.toFixed(0)} of work): couldn't read whether they'd opted out (${prefErr.message ?? "read failed"})`);
      continue;
    }
    if (pref?.enabled === false) continue;
    const { data: u, error: uErr } = await admin.from("users").select("email").eq("id", v.user_id as string).maybeSingle();
    if (uErr) {
      console.error(`[read failed] this crew's email (${v.id}):`, uErr);
      skipped.push(`no fill-in digest for crew ${v.id} ($${total.toFixed(0)} of work): couldn't read their email address (${uErr.message ?? "read failed"})`);
      continue;
    }
    if (!u?.email) continue;
    // The cooldown row is only written when the email actually went out — a
    // Resend hiccup must not buy 30 days of silence (same standard as the
    // SLA valve's SMS).
    const sentRes = await sendEmail({
      to: u.email,
      subject: `$${total.toFixed(0)} of fill-in work is open on your lakes 🌊`,
      html: `<p>Hi ${v.company ?? "there"},</p><p><b>${count} jobs</b> on your lakes are offering posted fill-in rates right now — <b>$${total.toFixed(0)}</b> of take-home, first tap takes each one: <a href="${site}/vendor/open">${site}/vendor/open</a></p><p>Your regular rates stay yours — fill-ins are extra work at a posted price, nothing more.</p><p style="font-size:12px;color:#5D7681">Manage notifications: ${site}/settings/notifications</p>`,
    });
    if (!sentRes.ok) {
      // The cooldown row is deliberately NOT written (above), so this crew is
      // tried again on the next beat — but a Resend outage that silences every
      // crew must not report as a night with no fill-in work.
      console.error(`[send failed] the fill-in digest to crew ${v.id}:`, sentRes.error);
      skipped.push(`the fill-in digest to crew ${v.id} ($${total.toFixed(0)} of work) did not send: ${sentRes.error ?? "send failed"}`);
      continue;
    }
    const logged = await admin.from("nudge_log").insert({ user_id: v.user_id, kind: "fillin_digest" });
    // POST-SEND: same rule as the nudge log — the email is gone, and this row
    // is the only thing holding the cooldown.
    if (logged.error) {
      console.error(`[write failed] the fill-in digest cooldown row (crew ${v.id}):`, logged.error);
      skipped.push(`the fill-in digest went to crew ${v.id} but its cooldown row did not save (${logged.error.message ?? "write failed"}) — nothing stops them getting it again tomorrow`);
    }
    sent++;
  }
  return { ok: true, sent, skipped };
}

/**
 * DURATION LEARNING (lib/learning.ts): the first self-tuning dial. Trailing
 * 90 days of real started→completed durations per service walk the
 * services.est_minutes dial toward reality, damped, every night — so the
 * fleet router's time budgets and hours-fit checks get truer on their own.
 * Runs BEFORE the route build so tomorrow's routes use tonight's lesson.
  *
 * SINCE 0083 THIS TUNES THE FALLBACK, NOT THE THING BOOKING USES. A service
 * with a `duration_bands` ladder never consults `est_minutes` at booking time,
 * so nudging that column changes nothing for the seven size-priced services —
 * it still matters for the three flat ones, and as the fallback for any
 * service that has no ladder yet.
 *
 * Tuning the LADDERS is the real job and it is deliberately not done here:
 * every sample would have to be bucketed by the size that job actually had,
 * and with zero measured durations in the system there is nothing yet to
 * bucket. Averaging a 4-section pier with a 16-section one into a single
 * number is precisely the mistake the ladders exist to undo, and doing it
 * automatically would undo them quietly.
*/
export async function learnServiceDurations(): Promise<{ ok: boolean; updated: number; changes: Array<{ service: string; from: number; to: number; samples: number }> }> {
  const admin = createServiceClient();
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const [servicesRes, doneRes] = await Promise.all([
    admin.from("services").select("id, name, est_minutes"),
    admin.from("jobs")
      .select("service_id, started_at, completed_at")
      .in("status", ["complete", "paid"])
      .not("started_at", "is", null)
      .not("completed_at", "is", null)
      .gte("completed_at", since)
      .limit(5000),
  ]);
  // These samples walk a dial that every route build then plans against. An
  // empty read is not "nobody worked for 90 days".
  const services = mustRead("the services", servicesRes);
  const done = mustRead("90 days of completed jobs", doneRes);
  const samplesBySvc = new Map<string, number[]>();
  for (const j of done ?? []) {
    const mins = (new Date(j.completed_at as string).getTime() - new Date(j.started_at as string).getTime()) / 60_000;
    const list = samplesBySvc.get(j.service_id as string) ?? [];
    list.push(mins);
    samplesBySvc.set(j.service_id as string, list);
  }
  const { learnedEstimate } = await import("@/lib/learning");
  const changes: Array<{ service: string; from: number; to: number; samples: number }> = [];
  for (const s of services ?? []) {
    // AUDIT BUG 10c: this used to coerce the stored dial with `|| 60` BEFORE
    // learning, so a 0 dial (the seeded 'Storage overstay (per-diem)' row)
    // never even reached learnedEstimate as invalid — it compared 60 to 60,
    // reported moved=false, and the row stayed 0 forever. Pass what is
    // ACTUALLY stored; learnedEstimate owns the invalid-dial case now.
    const stored = Number(s.est_minutes ?? 0);
    const res = learnedEstimate(stored, samplesBySvc.get(s.id as string) ?? []);
    if (res.moved) {
      await admin.from("services").update({ est_minutes: res.next }).eq("id", s.id);
      changes.push({ service: s.name as string, from: stored, to: res.next, samples: res.samples });
    }
  }
  return { ok: true, updated: changes.length, changes };
}

/**
 * REFUND RECONCILE (docs/refunds-design.md, review hardening): heal the two
 * crash windows the action itself can't. (1) A claim inserted but never
 * settled at the processor (crash before the call, or the compensating
 * delete failed) would strand refundable cash forever — claims older than
 * 30 minutes with no processor_ref are deleted; no cash ever moved for
 * them. (2) A refund that settled but crashed before the invoice flip /
 * referral void gets its downstream effects completed idempotently.
 */
export async function reconcileRefunds(): Promise<{ ok: boolean; orphansCleared: number; flipsCompleted: number }> {
  const admin = createServiceClient();
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const orphans = mustRead("the unsettled refund claims", await admin
    .from("refunds").select("id").is("processor_ref", null).lt("created_at", cutoff).limit(50));
  let orphansCleared = 0;
  for (const o of orphans ?? []) {
    const { data: gone } = await admin.from("refunds").delete().eq("id", o.id).is("processor_ref", null).select("id");
    if (gone && gone.length > 0) orphansCleared++;
  }

  // Durable full refunds whose invoice never flipped: complete the flip +
  // referral void. Small scan — refunds are rare events.
  const recent = mustRead("the week's durable refunds", await admin
    .from("refunds").select("invoice_id, job_id").not("processor_ref", "is", null)
    .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).limit(200));
  const byInvoice = new Map<string, string | null>();
  for (const r of recent ?? []) byInvoice.set(r.invoice_id as string, (r.job_id as string) ?? null);
  let flipsCompleted = 0;
  for (const [invoiceId, jobId] of byInvoice) {
    const [invRes, payRes, rowsRes] = await Promise.all([
      admin.from("invoices").select("id, status").eq("id", invoiceId).maybeSingle(),
      admin.from("payments").select("amount").eq("invoice_id", invoiceId).eq("status", "captured").maybeSingle(),
      admin.from("refunds").select("amount").eq("invoice_id", invoiceId).not("processor_ref", "is", null),
    ]);
    // A failed `rows` read totals $0 refunded and the invoice never flips; a
    // failed `pay` read skips it silently. Both leave the money mis-stated.
    if (invRes.error || payRes.error || rowsRes.error) {
      console.error(`[read failed] the refund state of this invoice (${invoiceId}):`, invRes.error ?? payRes.error ?? rowsRes.error);
      continue;
    }
    const inv = invRes.data, pay = payRes.data, rows = rowsRes.data;
    if (!inv || inv.status === "refunded" || !pay) continue;
    const durable = (rows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    if (durable >= Number(pay.amount ?? 0) - 0.001) {
      await admin.from("invoices").update({ status: "refunded" }).eq("id", invoiceId).eq("status", "paid");
      if (jobId) {
        await admin.from("referral_earnings").update({ status: "void" }).eq("source_job", jobId).eq("status", "accrued");
      }
      flipsCompleted++;
    }
  }
  return { ok: true, orphansCleared, flipsCompleted };
}

/**
 * GAP SLA VALVE (margin-gap design): an open job unclaimed past the window
 * (gap_sla_hours dial, or — water work only — inside 96h of a still-future
 * pull deadline) alerts ops ONCE — the machine never crosses the floor on
 * its own, but nothing sits silently either. The three sanctioned exits are
 * human: recruit, logged override, or proactive rebook.
 */
export async function gapSlaAlerts(): Promise<{ ok: boolean; alerted: number; skipped: string[] }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();
  const today = todayLakeDate();
  const now = Date.now();
  let alerted = 0;
  // THE STRANDED JOBS NOBODY WAS TOLD ABOUT. This valve exists because a job
  // nobody claims needs a person; `alerted: 0` is also what a healthy night
  // looks like, so a job we couldn't alert on has to say so by name.
  const skipped: string[] = [];
  const MAX_ALERTS_PER_RUN = 10; // backlog-burst guard — the rest alert on later runs
  const cutoffIso = new Date(now - settings.gapSlaHours * 3_600_000).toISOString();
  // Oldest first: with more than 50 open jobs, the ones stuck LONGEST are
  // always in the sample — an unordered page could skip a stranded job on
  // every run. Null created_at rows can't be aged, so they're excluded.
  const stuck = mustRead("the jobs sitting unclaimed", await admin
    .from("jobs")
    .select("id, date, created_at, services(name, is_water_work), properties(address, lakes(name, pull_deadline))")
    .eq("status", "requested").is("vendor_id", null).is("group_id", null)
    .gte("date", today).not("created_at", "is", null)
    .order("created_at", { ascending: true }).limit(200));
  // 200-deep page: already-alerted jobs stay 'requested' until a human acts,
  // so a 50-row page could fill up with alerted-but-unresolved rows during a
  // surge and starve job #51. The per-run SMS cap still bounds the noise.
  // Empty reads as "there is no ops team", and the whole valve returns quietly.
  const ops = mustRead("the ops team's phone numbers", await admin.from("users").select("id, phone, email").eq("role", "ops").not("phone", "is", null));
  if (!ops || ops.length === 0) return { ok: true, alerted: 0, skipped };
  for (const j of stuck ?? []) {
    if (alerted >= MAX_ALERTS_PER_RUN) break;
    const svc = one(j.services) as { name?: string; is_water_work?: boolean } | null;
    const lake = one(j.properties) as { lakes?: unknown } | null;
    const lk = one(lake?.lakes) as { name?: string; pull_deadline?: string } | null;
    // Deadline pressure only means anything for WATER work, and only while
    // the deadline is still ahead — a past deadline is a different problem
    // (the season-close rails own it), not a claim-board SLA.
    const deadlineDelta = lk?.pull_deadline
      ? new Date((lk.pull_deadline as string) + "T00:00:00Z").getTime() - now
      : null;
    const nearDeadline = !!svc?.is_water_work && deadlineDelta != null && deadlineDelta > 0 && deadlineDelta < 96 * 3_600_000;
    const overSla = String(j.created_at) < cutoffIso;
    if (!overSla && !nearDeadline) continue;
    // once per job — nudge_log keyed by job id
    const { data: seen, error: seenErr } = await admin
      .from("nudge_log").select("id").eq("kind", `gap_sla:${j.id}`).limit(1);
    // FAILS OPEN IF IGNORED: null reads as "never alerted", and the once-per-job
    // promise becomes a nightly text to every ops phone.
    if (seenErr) {
      console.error(`[read failed] whether this job was already alerted (${j.id}):`, seenErr);
      skipped.push(`no ops alert for stranded job ${j.id}: couldn't read whether it had already been alerted (${seenErr.message ?? "read failed"})`);
      continue;
    }
    if (seen && seen.length > 0) continue;
    const svcName = svc?.name ?? "a job";
    // Cause-neutral copy: "unclaimed" is the fact; rate-vs-capacity is for
    // the Margin Health board to say. Every ops phone hears it; the one-shot
    // dedupe row is only written after at least one SMS actually went out —
    // a Twilio hiccup must not burn the job's single lifetime alert.
    // NAMED FOR WHAT IT IS. This was `delivered`, which it never was — it
    // meant Twilio accepted the message. The dedupe below burns the job's one
    // lifetime alert on that basis, so calling it delivery is how an ops alert
    // gets marked "sent" and never reaches anybody.
    let queuedAny = false;
    for (const o of ops) {
      const told = await notify(
        `ops that a job has sat unclaimed (job ${j.id})`,
        { phone: o.phone as string | null, email: o.email as string | null },
        {
          sms: `LakeLife OPS: ${svcName} on ${lk?.name ?? "a lake"} has sat ${overSla ? `${settings.gapSlaHours}h+` : "into the pull-deadline window"} unclaimed — no crew has taken it at card or fill-in rates. Exits: recruit, logged override, or rebook the customer. Job ${j.id}.`,
          subject: `${svcName} on ${lk?.name ?? "a lake"} has sat unclaimed — job ${j.id}`,
        },
      );
      if (told.reached) queuedAny = true;
    }
    if (queuedAny) {
      const logged = await admin.from("nudge_log").insert({ user_id: ops[0].id, kind: `gap_sla:${j.id}` });
      // POST-SEND: the texts are away. This row is the once-per-job promise —
      // without it every ops phone hears about this same job every run until
      // somebody acts on it, which is how ops learns to ignore the channel.
      if (logged.error) {
        console.error(`[write failed] the once-per-job dedupe row for the SLA alert (${j.id}):`, logged.error);
        skipped.push(`ops were alerted about stranded job ${j.id} but the once-per-job dedupe row did not save (${logged.error.message ?? "write failed"}) — they will be texted about it again on every run until it is claimed`);
      }
      alerted++;
    } else {
      // The dedupe row is deliberately NOT written, so the job keeps its one
      // lifetime alert and this retries next run — but a carrier outage that
      // queues nothing must not look like a night with nothing stranded.
      console.error(`[send failed] the ops SLA alert for job ${j.id}: no message was queued to any ops phone`);
      skipped.push(`the ops alert for stranded job ${j.id} (${svcName} on ${lk?.name ?? "a lake"}) queued to nobody — will retry next run`);
    }
  }
  return { ok: true, alerted, skipped };
}

/**
 * PRICE AUTO-APPLY (Autonomy Ladder, 2026-07-23): margin_stranded raises
 * within the priceAutoapplyMaxPct dial apply THEMSELVES, through the exact
 * same executor (executeMenuUpdate) and the exact same 40% sanity cap a
 * human's one tap uses — gated by an independent dial (0 = off; suggestions
 * stay one-tap-only on the Margin Health board) and a per-service 30-day
 * cooldown so the machine never re-prices the same menu row twice in one
 * lull. A service can carry more than one suggestion tonight (one per lake
 * it's thin on) — the cooldown is re-checked fresh per suggestion and
 * updated IN-MEMORY the instant one applies, so a single run can't
 * double-price the same row even before the DB write would've caught it.
 */
export async function autoApplyPriceSuggestions(): Promise<{
  ok: boolean;
  applied: number;
  changes: Array<{ label: string; service: string }>;
  skipped: string[];
}> {
  // THE PRICES THE MACHINE DIDN'T MOVE, AND THE ONE IT MOVED WITHOUT A
  // COOLDOWN. `applied: 0` is the normal shape of a healthy night, so anything
  // that stopped a price change — or half-finished one — is named here and
  // carried into the digest by the route (noteSkips).
  const skipped: string[] = [];
  const settings = await getPlatformSettings();
  if (!(settings.priceAutoapplyMaxPct > 0)) return { ok: true, applied: 0, changes: [], skipped };

  const admin = createServiceClient();
  const suggestions = await computeMenuSuggestions(admin, settings.marginFloor);
  if (suggestions.length === 0) return { ok: true, applied: 0, changes: [], skipped };

  const serviceIds = [...new Set(suggestions.map((s) => s.serviceId))];
  // FAILS OPEN IF IGNORED: an empty map makes every `last` below null, the
  // 30-day cooldown never triggers, and the machine re-prices a menu row it
  // moved last week — twice in one lull is exactly what the dial forbids.
  const svcRows = mustRead("when these services were last auto-priced", await admin.from("services").select("id, last_auto_priced_at").in("id", serviceIds));
  const lastPriced = new Map<string, string | null>(
    (svcRows ?? []).map((s) => [s.id as string, (s.last_auto_priced_at as string) ?? null]),
  );
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();

  let applied = 0;
  const changes: Array<{ label: string; service: string }> = [];
  for (const s of suggestions) {
    if (s.raisePct > settings.priceAutoapplyMaxPct) continue; // too big a jump for the machine to take alone
    const last = lastPriced.get(s.serviceId) ?? null;
    if (last != null && last >= cutoff) continue; // priced within the last 30 days — leave it be
    // MENU-FOLLOWS-CREW GUARD: the suggestion is driven by a crew's card —
    // if that card CHANGED in the last 30 days, a fresh hike may be the
    // real cause, and auto-applying would let a crew drag the menu up
    // behind their own raises (the loop the fill-in anchor kills for
    // offers). Recent-card suggestions stay one-tap for a human.
    if (s.drivenByVendorId) {
      const { data: card, error: cardErr } = await admin
        .from("vendor_rates").select("updated_at")
        .eq("vendor_id", s.drivenByVendorId).eq("service_id", s.serviceId)
        .maybeSingle();
      // Fails CLOSED already (`!card` skips the auto-apply) — but "no card" and
      // "couldn't look" should not be the same silent event on a price change.
      if (cardErr) {
        console.error(`[read failed] the crew's rate card behind this suggestion (${s.serviceId}):`, cardErr);
        skipped.push(`${s.serviceName} not auto-priced (${s.label}): couldn't read the crew's rate card behind the suggestion (${cardErr.message ?? "read failed"}) — still one tap on the Margin Health board`);
        continue;
      }
      // No card or a card touched in the last 30 days (updated OR brand new —
      // updated_at covers both; the history trigger misses inserts) → the
      // rate isn't proven stable. Leave the suggestion one-tap for a human.
      if (!card || (card.updated_at as string) >= cutoff) continue;
    }
    const res = await executeMenuUpdate(admin, { serviceId: s.serviceId, field: s.field, newValue: s.newValue });
    if (!res.ok) continue; // cap re-check or a stale service row refused it — skip, never force
    const nowIso = new Date().toISOString();
    const stamped = await admin.from("services").update({ last_auto_priced_at: nowIso }).eq("id", s.serviceId);
    // POST-WRITE — THE MENU HAS ALREADY MOVED. Refusing here would undo
    // nothing. But this stamp IS the 30-day cooldown, so a failed one means
    // tomorrow night can price the same row again: "twice in one lull" is
    // exactly what the dial forbids, and the only thing standing between the
    // customer and a second hike is a person reading this line.
    if (stamped.error) {
      console.error(`[write failed] the 30-day cooldown stamp after auto-pricing ${s.serviceName}:`, stamped.error);
      skipped.push(`${s.serviceName} WAS auto-priced (${s.label}) but its 30-day cooldown stamp did not save (${stamped.error.message ?? "write failed"}) — nothing stops it being auto-priced again tomorrow night`);
    }
    lastPriced.set(s.serviceId, nowIso); // in-run guard: a second lake's suggestion for this service tonight won't double-fire
    applied++;
    changes.push({ label: s.label, service: s.serviceName });
  }
  return { ok: true, applied, changes, skipped };
}

/**
 * THE NIGHTLY DIGEST (Autonomy Ladder, 2026-07-23): the ONE email that
 * carries everything the machine did or noticed tonight — humans read only
 * what's non-empty, and a quiet night says so and nothing else.
 * composeNightlyDigest is a pure HTML builder from an already-assembled
 * `sections` object (easy to reason about, easy to test); sendNightlyDigest
 * gathers the few live facts no other nightly runner already produced
 * (currently-escalated disputes, lakes born in the last 24h, AI auto-replies
 * sent), merges them with the results the nightly route already collected,
 * and emails every ops user once.
 */
/** Gathers the live extras, composes, and sends ONE email per ops user.
 *  `results` is whatever the nightly route already collected this run. */
export async function sendNightlyDigest(results: {
  learning: { changes: Array<{ service: string; from: number; to: number; samples: number }> };
  autoPricing: { changes: Array<{ label: string; service: string }> };
  disputeSweep: { fired: number; escalated: number; quietCloses?: number; reconciled?: number };
  routes: { hoursBust?: number };
  gapSla: { alerted: number };
  /**
   * AUDIT BUG 10a — THE MONEY. The nightly runs the payout batches, the
   * referral maturation, the cancellation-fee retries and the refund
   * reconcile, then drops every one of them into an HTTP response nobody
   * reads: month-end, the night the largest sum of the month leaves the
   * account, read as "Quiet night — nothing needed a human."
   *
   * These are OPTIONAL on purpose — the cron route can be wired up on its own
   * schedule and keeps compiling untouched meanwhile; each one absent is
   * simply silence, exactly like every other empty digest section. Pass the
   * results the route ALREADY collects: `payoutBatch`, `monthlyPayouts`,
   * `referrals`, `feeReconcile`, `refundReconcile`.
   */
  payoutBatch?: { beneficiaries: number; total: number };
  monthlyPayouts?: { batches: number; total: number };
  referrals?: { credited: number; creditedAmount?: number };
  feeReconcile?: { collected: number; collectedAmount?: number };
  refundReconcile?: { orphansCleared: number; flipsCompleted: number };
  /**
   * STEPS THAT THREW TONIGHT. The route guards all ~27 of its steps and used
   * to collect the failures and drop them, so a night where a step died sent
   * the same email as a clean one. Optional for the same reason as the money
   * fields: a caller that hasn't been wired yet still compiles.
   */
  failures?: Array<{ step: string; error: string }>;
  /**
   * MISSED VISITS WAITING ON A DECISION (0089). Not money that moved — money
   * that will not move until a person says so. It is the only branch of the
   * reschedule-or-charge path that stalls without one, so it has to be said
   * out loud rather than sitting on a screen nobody opened.
   */
  visitFees?: { proposed: number; skipped: number };
  /** Trip fees paid to crews, and how much of it LakeLife funded (0090). */
  tripFees?: { paid: number; total: number; onUs: number };
  /** Tips customers gave since the last digest — pass-through, never ours. */
  tipsCollected?: { count: number; total: number };
}): Promise<{ ok: boolean; sent: number; skipped: string[] }> {
  const admin = createServiceClient();
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();

  // THE DIGEST CANNOT THROW — it is how ops finds out anything at all, so a
  // failed read here must not cost them the whole email. Instead each one
  // becomes a named failure IN the email, alongside the steps that broke: an
  // empty section that says "we couldn't look" rather than "nothing happened".
  const readFailures: Array<{ step: string; error: string }> = [];
  const noteRead = (what: string, error: { message?: string } | null): void => {
    if (!error) return;
    console.error(`[read failed] ${what}:`, error);
    readFailures.push({ step: `digest — ${what}`, error: error.message ?? "read failed" });
  };

  const { data: escalatedRows, error: escalatedErr } = await admin
    .from("disputes")
    .select("customer_note, jobs!disputes_job_id_fkey(services(name))")
    .eq("status", "escalated")
    .order("opened_at", { ascending: true })
    .limit(20);
  noteRead("the escalated disputes", escalatedErr);
  const escalatedDisputes = (escalatedRows ?? []).map((d) => {
    const job = one((d as { jobs?: unknown }).jobs) as { services?: unknown } | null;
    const svcName = (one(job?.services) as { name?: string } | null)?.name ?? "a job";
    return { service: svcName, note: ((d.customer_note as string) ?? "").slice(0, 140) };
  });

  // Homes with no lake. Crew imports used to mint these on every claim; the
  // ones already on the books can only be fixed by a person, so a person has
  // to be told they exist.
  const { count: lakelessHomes, error: lakelessErr } = await admin
    .from("properties").select("id", { count: "exact", head: true }).is("lake_id", null);
  noteRead("the homes with no lake", lakelessErr);

  const { data: bornRows, error: bornErr } = await admin.from("lakes").select("name, source").gte("created_at", dayAgo);
  noteRead("the lakes born today", bornErr);
  const lakesBorn = (bornRows ?? []).map((l) => ({ name: l.name as string, source: (l.source as string) ?? "ops" }));

  const { count: aiCount, error: aiCountErr } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("ai", true)
    .gte("created_at", dayAgo);
  noteRead("how many AI auto-replies went out", aiCountErr);
  const { data: aiRows, error: aiRowsErr } = await admin
    .from("messages")
    .select("body")
    .eq("ai", true)
    .gte("created_at", dayAgo)
    .order("created_at", { ascending: false })
    .limit(5);
  noteRead("what the AI auto-replies said", aiRowsErr);
  const aiReplyTexts = (aiRows ?? []).map((m) => ((m.body as string) ?? "").slice(0, 200));

  const sections: DigestSections = {
    learning: results.learning,
    autoPricing: results.autoPricing,
    disputeSweep: results.disputeSweep,
    escalatedDisputes,
    lakesBorn,
    routes: results.routes,
    // AUDIT BUG 10b: `aiCount ?? 0` on a null head-count zeroed the section's
    // gate while the TEXTS (a different query) survived — the safety net
    // disappeared silently. Fall back to what we can actually show; the
    // renderer opens the section on texts OR a positive count either way.
    aiAutoReplies: aiCount ?? aiReplyTexts.length,
    aiReplyTexts,
    gapSla: results.gapSla,
    // The money rails (bug 10a). Absent = silence, zero = silence.
    referralPayouts: results.payoutBatch
      ? { beneficiaries: results.payoutBatch.beneficiaries, total: results.payoutBatch.total }
      : undefined,
    crewPayouts: results.monthlyPayouts
      ? { batches: results.monthlyPayouts.batches, total: results.monthlyPayouts.total }
      : undefined,
    referralCredits: results.referrals
      ? { granted: results.referrals.credited, total: results.referrals.creditedAmount }
      : undefined,
    cancellationFees: results.feeReconcile
      ? { collected: results.feeReconcile.collected, total: results.feeReconcile.collectedAmount }
      : undefined,
    refundsReconciled: results.refundReconcile,
    visitFees: results.visitFees,
    tripFees: results.tripFees,
    tipsCollected: results.tipsCollected,
    failures: [...(results.failures ?? []), ...readFailures],
    homesWithNoLake: lakelessHomes ?? 0,
  };
  const html = composeNightlyDigest(sections);

  // The one read here that IS worth throwing over: without it the digest goes
  // to nobody, and "sent: 0" would be the only trace. The route's step guard
  // turns the throw into a named failure in tonight's response.
  const opsUsers = mustRead("the ops team's emails", await admin.from("users").select("email").eq("role", "ops").not("email", "is", null));
  let sent = 0;
  // WHEN THE REPORT ITSELF DOESN'T LAND. Everything above — the money, the
  // failed steps, the crews nobody warned — is in this one email. If it
  // bounces, all of it goes with it, and `sent: 0` alongside `ok: true` is the
  // quietest possible way to lose a night. This is the one thing that cannot
  // be reported by email, so it goes back to the cron route instead.
  const undelivered: string[] = [];
  for (const u of opsUsers ?? []) {
    const email = u.email as string | null;
    if (!email) continue;
    // THE SUBJECT LINE CARRIES THE BAD NEWS. Ops reads this on a phone, in a
    // list, at night — a broken step must be visible without opening it.
    const broke = (results.failures?.length ?? 0) + readFailures.length;
    const subject = broke > 0
      ? `LakeLife nightly — ${broke} step${broke === 1 ? "" : "s"} FAILED`
      : "LakeLife nightly — the machine's report";
    const res = await sendEmail({ to: email, subject, html });
    if (res.ok) sent++;
    else {
      console.error(`[send failed] tonight's digest to ${email}:`, res.error);
      undelivered.push(`tonight's digest did not reach ${email} (${res.error ?? "send failed"}) — ${broke > 0 ? `${broke} failed step${broke === 1 ? "" : "s"} went unread with it` : "nothing else reports the night"}`);
    }
  }
  return { ok: true, sent, skipped: undelivered };
}


/**
 * REMIND A RENTER THEIR STAY IS ENDING, with a one-tap way to keep it.
 *
 * Two jobs in one sweep. For a transient guest this is revenue — turning a
 * short stay into a long one is the highest-value behaviour change in a park,
 * and the moment to ask is before they start packing. For a month-to-month
 * tenant it is CORRECTNESS: their tenancy is a rolling finite range (unbounded
 * ranges make the rent roll report a lot vacant while someone lives on it), and
 * before this nothing rolled it forward — a year after move-in it would quietly
 * lapse with them still on the lot.
 *
 * The renter has NO ACCOUNT, so a signed link in a text is the only thing that
 * can reach her. The token is minted HERE, at send time: a token that was never
 * texted to anybody is a credential lying around for nothing.
 *
 * Exactly-once by the `extend_reminded_at` stamp, same discipline the waitlist
 * warning learned the hard way — a guest texted three nights running about the
 * same checkout stops reading our texts, and the one they stop reading is the
 * freeze warning.
 */
export async function remindExpiringStays(): Promise<{ ok: boolean; reminded: number; skipped: string[] }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  // A stay that is never asked about is a lot the rent roll calls vacant next
  // month. The skips below are all correct — none of them may send on a read
  // that failed — but the park owner has to be able to see them.
  const skipped: string[] = [];

  const stays = mustRead("the stays coming to an end", await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, term, status, extended_count, extend_reminded_at")
    .in("status", ["approved", "active"])
    .is("extend_reminded_at", null));

  let reminded = 0;

  for (const s of stays ?? []) {
    const range = parseDaterange(s.during as string);
    const term = s.term as Term;

    const decision = remindDecision({
      range,
      term,
      status: s.status as string,
      todayISO: today,
      alreadySent: false, // the query already filtered on the stamp
      extendedCount: (s.extended_count as number) ?? 0,
    });
    if (decision !== "send") continue;

    // NEVER TEXT WITHOUT VERIFIED CONSENT.
    //
    // This gate used to be `phone && contact_pref === 'sms'`, and neither half
    // is consent. `buildTenant` sets contact_pref to 'sms' automatically
    // whenever the OWNER types a phone number in — so a number copied off the
    // seller's spreadsheet became a nightly send target, from a cron, with the
    // renter never having said a word. That is precisely what
    // `phone_on_file_with_park` exists to prevent, and the rest of the park
    // module already enforces the real rule: a verified mobile is not
    // permission, the operational-SMS consent is. Both, or nothing.
    const { data: renter, error: renterErr } = await admin
      .from("park_renters")
      .select("display_name, email, mobile_e164, mobile_verified_at, sms_consent_operational_at, contact_pref")
      .eq("id", s.renter_id as string)
      .maybeSingle();
    // Fails closed (no consent read = no text), which is the right direction for
    // a consent gate — but a month-to-month tenancy that never rolls forward is
    // a lot the rent roll will call vacant, so it cannot be silent.
    if (renterErr) {
      console.error(`[read failed] the renter's consent and mobile (${s.renter_id}):`, renterErr);
      skipped.push(`Stay ${s.id}: couldn't read the renter's consent and mobile, so the extend question wasn't asked — the tenancy still ends ${range?.end ?? "on its date"} unless somebody asks by hand.`);
      continue;
    }
    const phone = renter?.mobile_e164 as string | undefined;
    if (
      !phone ||
      renter?.contact_pref !== "sms" ||
      !renter?.mobile_verified_at ||
      !renter?.sms_consent_operational_at
    ) continue;

    const { data: lot, error: lotErr } = await admin
      .from("park_lots").select("lot_number").eq("id", s.park_lot_id as string).maybeSingle();
    const { data: rateRows, error: rateErr } = await admin
      .from("lot_rates").select("term, amount").eq("park_lot_id", s.park_lot_id as string);
    // The text names her site and quotes a price. A failed read would send
    // "your site  is booked" or, worse, price the extension off no rates at all.
    if (lotErr || rateErr) {
      console.error(`[read failed] the lot and its rates (${s.park_lot_id}):`, lotErr ?? rateErr);
      skipped.push(`Stay ${s.id}: couldn't read the lot or its rates, so the extend question wasn't asked — the tenancy still ends ${range?.end ?? "on its date"} unless somebody asks by hand.`);
      continue;
    }
    const price = extensionPrice(
      (rateRows ?? []).map((r) => ({ term: r.term as Term, amount: Number(r.amount) })),
      term,
    );
    // No rate for that term means we have nothing honest to quote, so we do not
    // ask. The park can still extend it by hand.
    if (price == null || !range) continue;

    const next = extendedRange(range, term);
    const token = `x${crypto.randomUUID().replace(/-/g, "")}`;

    // The STAMP IS THE CLAIM: setting it while it is still null is what makes
    // this exactly-once even if two runs race. If it comes back empty, another
    // run already took this stay.
    const { data: claimed } = await admin
      .from("lot_reservations")
      .update({ extend_reminded_at: new Date().toISOString(), extend_token: token })
      .eq("id", s.id as string)
      .is("extend_reminded_at", null)
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    reminded++;
    // THE SMS GATE ABOVE IS UNTOUCHED — nobody new is messaged. The email is
    // the second door to the SAME renter, and the park module already treats
    // it as the one that is always open (invite-channels.ts). It matters here
    // because the token minted just above is the only thing that can roll her
    // tenancy forward, and on text alone it has reached nobody since July.
    const told = await notify(
      `the renter that her stay is ending, with the one tap that extends it (stay ${s.id})`,
      { phone, email: renter?.email as string | null },
      {
        sms:
          `LakeLife: your site ${lot?.lot_number ?? ""} is booked through ${range.end}. ` +
          `Want to keep it through ${next.end} for $${price.toLocaleString()}? ` +
          `One tap: ${site}/x/${token}`,
        subject: `Your site is booked through ${range.end} — keep it through ${next.end}?`,
        body:
          `Your site ${lot?.lot_number ?? ""} is booked through ${range.end}.\n\n` +
          `Want to keep it through ${next.end} for $${price.toLocaleString()}?\n\n` +
          `One tap:\n  ${site}/x/${token}`,
      },
    );
    if (!told.reached && told.note) skipped.push(told.note);
  }

  return { ok: true, reminded, skipped };
}

// ==========================================================================
// UNWORKED VISITS — the nightly half
// ==========================================================================
//
// These two live HERE, not in `src/app/ops/recovery-actions.ts`, and the move
// was a security fix rather than tidying. That file carries "use server", so
// every exported function in it is a SERVER ACTION reachable from any browser
// that knows its id — and `raiseTripFees` releases payouts. It was idempotent,
// so the blast radius was small, but "a stranger can make us pay crews" is not
// a property to leave lying around because today's version happens to be safe.
//
// `automation.ts` is `server-only`: importable by server code, callable by
// nobody over the wire. The nightly cron route is the only caller of either.
// The customer-facing half — charge, waive — stays an action, because a person
// clicks it.

/**
 * RAISE THE TRIP FEE FOR EVERY ATTEMPT THAT HASN'T HAD ONE.
 *
 * Runs nightly, and it accrues WITHOUT asking a person — deliberately. The
 * worst case if it fires wrongly is that we pay a crew $35 they did not earn:
 * small, clawback-able, and invisible to the customer. That is a different
 * animal from putting money on somebody's card, which is why the other half of
 * this path still waits for a human.
 *
 * Idempotent by construction: it only ever looks at attempts whose
 * `trip_fee_payout_id` is null, and stamps it the moment the payout exists. A
 * job attempted, rescheduled and attempted again is TWO trips and is paid
 * twice — correctly — because the unit of work here is the attempt, never the
 * job.
 */
export async function raiseTripFees(): Promise<{ paid: number; total: number; onUs: number }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();

  const attempts = mustRead("the trips not yet paid for", await admin
    .from("job_visit_attempts")
    .select("id, job_id, vendor_id, outcome, jobs(recovery_state, fee_proposed_amount, vendor_cost)")
    .is("trip_fee_payout_id", null)
    .not("vendor_id", "is", null));

  let paid = 0;
  let total = 0;
  let onUs = 0;

  for (const a of attempts ?? []) {
    const job = (Array.isArray(a.jobs) ? a.jobs[0] : a.jobs) as
      { recovery_state?: string; fee_proposed_amount?: number; vendor_cost?: number } | null;

    // Their share of a fee the customer ACTUALLY paid. A proposed fee is not a
    // paid one, so only 'fee_charged' funds anything.
    const collectedCrewShare =
      job?.recovery_state === "fee_charged"
        ? Math.max(0, Number(job.vendor_cost ?? 0)) * settings.cancelFeePct
        : 0;

    const t = tripFeeFor({
      outcome: a.outcome as "no_access" | "stood_down",
      collectedCrewShare,
      tripFee: settings.crewTripFee,
    });
    if (!(t.owed > 0)) continue;

    const { data: payout, error } = await admin
      .from("payouts")
      .insert({
        vendor_id: a.vendor_id,
        job_id: a.job_id,
        amount: t.owed,
        original_amount: t.owed,
        // Released on sight: the trip is the deliverable and it already
        // happened. It rides the same month-end batch as job earnings.
        status: "released",
        kind: "trip",
      })
      .select("id")
      .single();
    if (error || !payout) continue;

    // Stamp it immediately — this is what makes a retry safe. And if the stamp
    // FAILS, take the payout back out: an unstamped payout is one the next
    // night pays again, so a crash between these two writes would double-pay
    // the same trip. Losing a $35 accrual we can re-raise tomorrow is the far
    // better failure of the two.
    const { error: stampErr } = await admin
      .from("job_visit_attempts")
      .update({ trip_fee_payout_id: payout.id })
      .eq("id", a.id)
      .is("trip_fee_payout_id", null);
    if (stampErr) {
      await admin.from("payouts").delete().eq("id", payout.id);
      continue;
    }

    paid += 1;
    total += t.owed;
    if (t.fundedBy === "lakelife") onUs += t.owed;
  }

  return { paid, total: Math.round(total * 100) / 100, onUs: Math.round(onUs * 100) / 100 };
}


/**
 * Nightly: any unworked visit whose window has closed gets a number attached
 * and moves to `fee_proposed`. Nothing is charged and nobody is told.
 *
 * A stand-down is skipped entirely — our record was wrong, and we told the
 * customer in writing that nothing would be charged.
 */
/**
 * WHAT CAME IN AS TIPS SINCE THE LAST DIGEST.
 *
 * A 24-hour window rather than a lake-day boundary, deliberately: the nightly
 * IS the reporting cadence, so "since we last looked" is the honest window and
 * it needs no timezone arithmetic to be exactly right. Everything else in the
 * money section reports what a step just did; this one has no step of its own,
 * because a tip happens when a customer taps, not when a cron runs.
 *
 * Reads `payments` by `tip_job_id`, which is the ONLY place in the codebase
 * that reads a payment without an invoice — every other read is invoice-keyed
 * (0097). If that ever stops being true, this is the reason it was fine.
 */
export async function tipsCollectedSinceLastNight(): Promise<{ count: number; total: number }> {
  const admin = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // A failed read reports "no tips came in", which the digest prints as fact
  // about money a customer actually gave.
  const data = mustRead("the tips collected since last night", await admin
    .from("payments")
    .select("amount")
    .not("tip_job_id", "is", null)
    .eq("status", "captured")
    .gte("created_at", since));
  const rows = data ?? [];
  return {
    count: rows.length,
    total: Math.round(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0) * 100) / 100,
  };
}

export async function proposeOverdueFees(): Promise<{ proposed: number; skipped: number }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const settings = await getPlatformSettings();

  const rows = mustRead("the visits waiting on a customer's decision", await admin
    .from("jobs")
    .select("id, customer_price, vendor_cost, vendor_id, reschedule_deadline, no_show_at, stood_down_at")
    .eq("recovery_state", "awaiting_customer")
    .not("reschedule_deadline", "is", null));

  let proposed = 0;
  let skipped = 0;

  for (const j of rows ?? []) {
    if (!deadlinePassed((j.reschedule_deadline as string) ?? null, today)) continue;

    // Never fee-eligible: the profile was ours and it was wrong.
    if (j.stood_down_at) {
      await admin.from("jobs")
        .update({ recovery_state: "fee_waived", reschedule_deadline: null })
        .eq("id", j.id);
      skipped += 1;
      continue;
    }

    const q = proposedFee(
      {
        hasCrew: !!j.vendor_id,
        customerPrice: Number(j.customer_price ?? 0),
        vendorCost: j.vendor_cost == null ? null : Number(j.vendor_cost),
      },
      {
        cancelFeePct: settings.cancelFeePct,
        cancelRoutineHours: settings.cancelRoutineHours,
        cancelWaterDays: settings.cancelWaterDays,
      },
    );

    if (q.free) {
      // The policy says nothing is owed. Close it rather than parking a $0
      // decision on somebody's desk.
      await admin.from("jobs")
        .update({ recovery_state: "fee_waived", reschedule_deadline: null })
        .eq("id", j.id);
      skipped += 1;
      continue;
    }

    await admin.from("jobs")
      .update({ recovery_state: "fee_proposed", fee_proposed_amount: q.fee })
      .eq("id", j.id);
    proposed += 1;
  }

  return { proposed, skipped };
}

/**
 * A person releases the fee. THIS is where money moves, and only here.
 *
 * Deliberately not implemented as a card charge yet: the processor keys do not
 * exist (CLAUDE.md rule 4 — build against the mock until they do), and a
 * half-built charge path is worse than an honest one. What this does today is
 * record the decision and hand the amount to the existing billing pipeline the
 * same way a late-cancellation fee is handed over.
 */

