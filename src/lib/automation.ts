import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { LakeLifePayments } from "@/lib/payments";
import { revalidateJob } from "@/app/book/dispatch";
import { todayLakeDate } from "@/lib/booking";
import { planVendorDay, routeMapUrl, type StopIn } from "@/lib/router";
import { coiRevalidationDue } from "@/app/vendor/onboarding-helpers";
import { proposeAutopilotDate } from "@/lib/autopilot";
import { shouldDemote, healBase } from "@/lib/lake-standing";
import { getPlatformSettings } from "@/lib/settings";

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
}

/**
 * Build routes for a day (default: tomorrow, lake time). Clusters each vendor's
 * scheduled jobs by lake, orders them in drive direction, caps at capacity,
 * writes routes + per-job sequence, texts each crew their map link. Skips crews
 * whose COI lapsed. Deterministic rebuild — clears that day's routes first.
 */
export async function runRouteBuild(dateISO?: string): Promise<RouteBuildOutcome> {
  const date = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : addDays(todayLakeDate(), 1);
  const admin = createServiceClient();

  const { data: jobs, error: loadErr } = await admin
    .from("jobs")
    .select("id, vendor_id, properties(lat, lng, lakes(name)), vendors(daily_capacity, company, user_id, status, coi_expiry)")
    .eq("date", date)
    .eq("status", "scheduled")
    .not("vendor_id", "is", null);
  if (loadErr) return { ok: false, error: loadErr.message };

  const byVendor = new Map<string, { capacity: number; user_id: string | null; stops: StopIn[] }>();
  for (const j of jobs ?? []) {
    const v = one(j.vendors) as { daily_capacity?: number; user_id?: string; status?: string; coi_expiry?: string } | null;
    if (!v || v.status !== "active" || !v.coi_expiry || String(v.coi_expiry) < todayLakeDate()) continue;
    const p = one(j.properties) as { lat?: number; lng?: number; lakes?: unknown } | null;
    const lake = one(p?.lakes) as { name?: string } | null;
    const key = j.vendor_id as string;
    if (!byVendor.has(key)) byVendor.set(key, { capacity: Number(v.daily_capacity ?? 0), user_id: v.user_id ?? null, stops: [] });
    byVendor.get(key)!.stops.push({ id: j.id as string, lat: p?.lat ?? null, lng: p?.lng ?? null, lake_name: lake?.name ?? null });
  }

  await admin.from("routes").delete().eq("date", date);
  await admin.from("jobs").update({ route_id: null, sequence: null }).eq("date", date).eq("status", "scheduled");

  let routes = 0, stops = 0, overflow = 0, texted = 0;
  for (const [vendorId, v] of byVendor) {
    const plan = planVendorDay(v.stops, v.capacity);
    if (!plan.ordered.length) continue;
    const mapUrl = routeMapUrl(plan.ordered);
    const { data: routeRow, error: rErr } = await admin
      .from("routes")
      .insert({ vendor_id: vendorId, date, stops_order: plan.ordered.map((s) => s.id), drive_minutes: plan.driveMinutes, map_url: mapUrl })
      .select("id")
      .single();
    if (rErr) return { ok: false, error: rErr.message };
    for (let i = 0; i < plan.ordered.length; i++) {
      await admin.from("jobs").update({ sequence: i + 1, route_id: routeRow.id }).eq("id", plan.ordered[i].id);
    }
    routes++; stops += plan.ordered.length; overflow += plan.overflow.length;
    if (v.user_id) {
      const { data: u } = await admin.from("users").select("phone").eq("id", v.user_id).maybeSingle();
      if (u?.phone) {
        void sendSms(u.phone as string, `LakeLife route for ${prettyDate(date)}: ${plan.ordered.length} stops, ~${plan.driveMinutes} min drive.${mapUrl ? " Map: " + mapUrl : ""} Details in your Today list. 🌊`);
        texted++;
      }
    }
  }
  return { ok: true, date, routes, stops, overflow, texted };
}

export interface SettleOutcome {
  ok: boolean;
  invoiced?: boolean;
  charged?: boolean;
  error?: string;
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
  const { data: job } = await admin
    .from("jobs")
    .select("id, status, customer_price, vendor_cost, vendor_id, property_id, services(name)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "job not found" };
  if (!["complete", "paid"].includes(job.status as string)) return { ok: false, error: "job not complete" };
  const svcName = (one(job.services) as { name?: string } | null)?.name ?? "service";

  // 1) Payout — release once (photo-verified completion already happened).
  const { data: existingPayout } = await admin.from("payouts").select("id").eq("job_id", jobId).maybeSingle();
  if (!existingPayout) {
    const { error: pErr } = await admin.from("payouts").insert({
      vendor_id: job.vendor_id,
      job_id: jobId,
      amount: job.vendor_cost,
      status: job.vendor_cost != null ? "released" : "pending",
    });
    if (pErr) console.error(`[settleJob ${jobId}] payout insert failed:`, pErr.message);
  }

  // 2) Invoice — one per job. Reuse an existing row rather than creating a second.
  let { data: invoice } = await admin.from("invoices").select("id, status").eq("job_id", jobId).maybeSingle();
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
  if (invoice.status !== "paid" && price > 0 && job.property_id) {
    const { data: prop } = await admin
      .from("properties")
      .select("address, owner_id, users(email, name)")
      .eq("id", job.property_id)
      .maybeSingle();
    const ownerId = (prop?.owner_id as string) ?? null;
    const { data: paid } = await admin
      .from("payments")
      .select("id")
      .eq("invoice_id", invoice.id)
      .eq("status", "captured")
      .maybeSingle();
    if (!paid && ownerId) {
      const { data: pm } = await admin
        .from("payment_methods")
        .select("token, last4, brand")
        .eq("user_id", ownerId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (pm?.token) {
        const charge = await LakeLifePayments.charge({ token: pm.token as string, amountCents: Math.round(price * 100), description: `LakeLife — ${svcName}` });
        await admin.from("payments").insert({
          invoice_id: invoice.id,
          amount: job.customer_price,
          status: charge.ok ? "captured" : "failed",
          processor_ref: charge.ref ?? null,
        });
        await admin.from("invoices").update({ status: charge.ok ? "paid" : "due", processor_ref: charge.ref ?? null }).eq("id", invoice.id);
        charged = charge.ok;
        const owner = one((prop as { users?: unknown } | null)?.users) as { email?: string; name?: string } | null;
        if (charge.ok && owner?.email) {
          const amt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(price);
          void sendEmail({
            to: owner.email,
            subject: `Your LakeLife receipt — ${svcName}`,
            html: `<p>Hi ${owner.name ?? "there"},</p><p>Your ${svcName} at ${prop?.address ?? "your property"} is complete.</p><p><b>Charged: ${amt}</b>${pm.brand ? ` to your ${pm.brand} ending ${pm.last4}` : ""}.</p><p>Thank you. 🌊</p>`,
          });
        }
      }
    }
  }

  return { ok: true, invoiced: true, charged };
}

/** Reconcile sweep: settle any job that's complete but wasn't fully billed
 *  (invoice missing, or invoice still 'due' with no captured payment). Safe to
 *  run on a schedule — settleJob is idempotent. Bounded scan of recent jobs. */
export async function reconcileUnsettledJobs(): Promise<{ ok: boolean; settled: number }> {
  const admin = createServiceClient();
  const { data: jobs } = await admin
    .from("jobs")
    .select("id, invoices(status)")
    .eq("status", "complete")
    .limit(500);
  let settled = 0;
  for (const j of jobs ?? []) {
    const inv = j.invoices as { status?: string }[] | { status?: string } | null;
    const rows = Array.isArray(inv) ? inv : inv ? [inv] : [];
    const fullyPaid = rows.length > 0 && rows.every((r) => r.status === "paid");
    if (fullyPaid) continue; // already settled + charged
    const r = await settleJob(j.id as string);
    if (r.ok) settled++;
  }
  return { ok: true, settled };
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
export async function recordNoShows(): Promise<{ ok: boolean; flagged: number }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const { data: stale } = await admin
    .from("jobs")
    .select("id, vendor_id, property_id, date, services(name), properties(address, owner_id, lake_id), vendors(user_id)")
    .lt("date", today)
    .in("status", ["scheduled", "in_progress"])
    .not("vendor_id", "is", null);

  const one = <T>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);
  let flagged = 0;

  for (const j of stale ?? []) {
    const { count } = await admin.from("job_photos").select("id", { count: "exact", head: true }).eq("job_id", j.id as string);
    if ((count ?? 0) > 0) continue; // photos on file → not a ghost, leave for ops

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
      const { data: owner } = await admin.from("users").select("phone").eq("id", prop.owner_id).maybeSingle();
      if (owner?.phone) void sendSms(owner.phone as string, `LakeLife: your crew couldn't make ${svc} at ${prop?.address ?? "your place"} — no charge. Pick any open day to rebook: ${site}/book 🌊`);
    }
    // Crew: reliability warning (standing-based, no fine).
    const crewUser = (one(j.vendors) as { user_id?: string } | null)?.user_id;
    if (crewUser) {
      const { data: cu } = await admin.from("users").select("phone").eq("id", crewUser).maybeSingle();
      if (cu?.phone) void sendSms(cu.phone as string, `LakeLife: a scheduled job was marked missed and affects your standing. If something came up, block the day ahead next time — no penalty for advance notice.`);
    }
  }
  return { ok: true, flagged };
}

export async function revalidateAssignments(dateISO?: string): Promise<{ ok: boolean; checked: number; rehomed: number; unfilled: number; crewsTexted?: number }> {
  const date = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : addDays(todayLakeDate(), 1);
  const admin = createServiceClient();
  const { data: jobs } = await admin
    .from("jobs")
    .select("id")
    .eq("date", date)
    .in("status", ["scheduled", "requested"]);
  let rehomed = 0;
  const unfilledIds: string[] = [];
  for (const j of jobs ?? []) {
    const r = await revalidateJob(j.id as string);
    if (r.rehomed) rehomed++;
    if (!r.nowAssigned) unfilledIds.push(j.id as string);
  }

  // Phase D: unfilled jobs go to the CREWS, not ops — broadcast "up for grabs"
  // to every active, insured crew that does one of the open services (any lake:
  // claiming a new lake opts them into it). One text per crew per night. Ops
  // only hears about jobs NO crew could even be asked about (true dead end).
  let crewsTexted = 0;
  const unfilled = unfilledIds.length;
  if (unfilled > 0) {
    const today = todayLakeDate();
    const [{ data: openJobs }, { data: crews }] = await Promise.all([
      admin.from("jobs").select("id, services(name)").in("id", unfilledIds),
      admin.from("vendors").select("id, user_id, service_types, coi_expiry").eq("status", "active").not("user_id", "is", null),
    ]);
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
      const { data: users } = await admin
        .from("users")
        .select("id, phone")
        .in("id", notifiable.map((v) => v.user_id as string))
        .not("phone", "is", null);
      const phoneByUser = new Map((users ?? []).map((u) => [u.id as string, u.phone as string]));
      const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
      for (const v of notifiable) {
        const phone = phoneByUser.get(v.user_id as string);
        if (!phone) continue;
        void sendSms(phone, `LakeLife: ${unfilled} open job${unfilled === 1 ? "" : "s"} up for grabs near you — first crew to claim gets it: ${site}/vendor/open 🌊`);
        crewsTexted++;
      }
    }
    // True dead end: a service nobody on the platform offers ⇒ recruit signal.
    const deadEnd = [...openServices].filter((s) => !claimersByService.has(s));
    if (deadEnd.length > 0 || crewsTexted === 0) {
      const { data: ops } = await admin.from("users").select("phone").eq("role", "ops").not("phone", "is", null);
      const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const what = deadEnd.length > 0 ? deadEnd.join(", ") : "open jobs";
      for (const o of ops ?? []) {
        if (o.phone) void sendSms(o.phone as string, `LakeLife: no crew on the platform can claim ${what} for ${pretty} — recruiting signal, nothing to dispatch. 🌊`);
      }
    }
  }
  return { ok: true, checked: (jobs ?? []).length, rehomed, unfilled, crewsTexted };
}

/** Night-before reminder text to each owner who has a scheduled job on `date`
 *  (default tomorrow). One text per property/day. */
export async function sendNightBeforeReminders(dateISO?: string): Promise<{ ok: boolean; sent: number }> {
  const date = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : addDays(todayLakeDate(), 1);
  const admin = createServiceClient();
  const { data: jobs } = await admin
    .from("jobs")
    .select("id, slot, services(name), properties(address, users(phone))")
    .eq("date", date)
    .eq("status", "scheduled");

  // De-dupe by phone so an owner with two jobs tomorrow gets one text.
  const seen = new Set<string>();
  let sent = 0;
  for (const j of jobs ?? []) {
    const p = one(j.properties) as { address?: string; users?: unknown } | null;
    const phone = (one(p?.users) as { phone?: string } | null)?.phone;
    const svc = (one(j.services) as { name?: string } | null)?.name ?? "your service";
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    void sendSms(phone, `LakeLife reminder: ${svc} is scheduled tomorrow (${prettyDate(date)}) at ${p?.address ?? "your place"}. We'll text you when it's done, with photos. 🌊`);
    sent++;
  }
  return { ok: true, sent };
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
  const { data: crews } = await admin
    .from("vendors")
    .select("id, company, coi_expiry, verified_at, users(email, name)")
    .eq("status", "active");

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

/** PHASE E: per-lake auto-demotion. A crew whose net strikes (no-shows minus
 *  completions) on ONE lake reach the dial gets paused there: the lake is
 *  removed from their service area and a cooldown row blocks claims/re-adds
 *  until the clock runs out. Nobody suspends anyone — the marketplace heals. */
export async function demoteLakeStrikes(): Promise<{ ok: boolean; demoted: number }> {
  const admin = createServiceClient();
  const { lakeStrikeLimit } = await getPlatformSettings();

  const [{ data: vendors }, { data: misses }, { data: dones }, { data: lakes }] = await Promise.all([
    admin.from("vendors").select("id, user_id, service_lakes").eq("status", "active"),
    admin.from("vendor_no_shows").select("vendor_id, lake_id").not("lake_id", "is", null),
    admin.from("jobs").select("vendor_id, properties(lake_id)").in("status", ["complete", "paid"]).not("vendor_id", "is", null),
    admin.from("lakes").select("id, name"),
  ]);
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
        const { data: cu } = await admin.from("users").select("phone").eq("id", v.user_id as string).maybeSingle();
        if (cu?.phone) {
          void sendSms(cu.phone as string, `LakeLife: after repeated missed jobs on ${lakeName.get(lk) ?? "a lake"}, we've paused routing you there for a while. Keep completing jobs on your other lakes and it reopens automatically. Advance-notice blocks never count against you. 🌊`);
        }
      }
      break; // one demotion per crew per night — no pile-ons
    }
  }
  return { ok: true, demoted };
}

/** PHASE E: base-pin self-heal. The rolling median of where a crew actually
 *  COMPLETES jobs is ground truth for proximity ranking — set a missing pin
 *  from it, correct a wildly-wrong one (>25 mi), leave sane pins alone. */
export async function selfHealCrewBases(): Promise<{ ok: boolean; set: number; corrected: number }> {
  const admin = createServiceClient();
  const { data: vendors } = await admin
    .from("vendors")
    .select("id, base_lat, base_lng")
    .eq("status", "active");

  let setCount = 0, corrected = 0;
  for (const v of vendors ?? []) {
    const { data: recent } = await admin
      .from("jobs")
      .select("date, properties(lat, lng)")
      .eq("vendor_id", v.id as string)
      .in("status", ["complete", "paid"])
      .order("date", { ascending: false })
      .limit(20);
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
  return { ok: true, set: setCount, corrected };
}

/** AUTOPILOT (§8d): propose each enrolled service's next visit and text the
 *  owner a one-tap confirm/skip. One OPEN proposal per enrollment (DB-enforced);
 *  nothing is booked without the customer's tap; skip is free. Proposals older
 *  than 14 days quietly expire (no nagging). */
export async function generateAutopilotProposals(): Promise<{ ok: boolean; proposed: number; expired: number; texted: number }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  // Expire stale proposals (their token links die with them).
  const { data: stale } = await admin
    .from("autopilot_events")
    .update({ status: "expired" })
    .eq("status", "proposed")
    .lt("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
    .select("id");
  const expired = stale?.length ?? 0;

  const { data: enrollments } = await admin
    .from("autopilot_enrollments")
    .select("id, property_id, service_id, locked_price, services(name, is_water_work), properties(owner_id, address, nickname, lake_id, lakes(ice_out_actual, pull_deadline))")
    .eq("active", true);

  let proposed = 0, texted = 0;
  for (const e of enrollments ?? []) {
    // One open proposal at a time (also DB-enforced by the partial unique index).
    const { data: open } = await admin
      .from("autopilot_events").select("id").eq("enrollment_id", e.id).eq("status", "proposed").maybeSingle();
    if (open) continue;
    // Don't propose when a manual/confirmed booking is already ahead.
    const { data: upcoming } = await admin
      .from("jobs").select("id")
      .eq("property_id", e.property_id).eq("service_id", e.service_id)
      .in("status", ["requested", "scheduled", "in_progress"])
      .gte("date", today)
      .limit(1);
    if (upcoming && upcoming.length > 0) continue;

    const svc = one(e.services) as { name?: string; is_water_work?: boolean } | null;
    const prop = one(e.properties) as { owner_id?: string; address?: string; nickname?: string; lakes?: unknown } | null;
    const lake = one(prop?.lakes) as { ice_out_actual?: string; pull_deadline?: string } | null;
    if (!svc?.name || !prop?.owner_id) continue;

    const { data: lastDone } = await admin
      .from("jobs").select("date")
      .eq("property_id", e.property_id).eq("service_id", e.service_id)
      .in("status", ["complete", "paid"])
      .order("date", { ascending: false })
      .limit(1);
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

    const { data: owner } = await admin.from("users").select("phone").eq("id", prop.owner_id).maybeSingle();
    if (owner?.phone) {
      const where = prop.nickname || prop.address || "your place";
      void sendSms(
        owner.phone as string,
        `LakeLife Autopilot 🌊: time for ${svc.name} at ${where} — we've penciled ${prettyDate(date)} at your locked price. Book it: ${site}/a/${ev.confirm_token}/confirm  ·  Skip: ${site}/a/${ev.confirm_token}/skip`,
      );
      texted++;
    }
  }
  return { ok: true, proposed, expired, texted };
}

/** Seasonal "book your fall pull before freeze" email. Fires the day a lake's
 *  pull deadline is exactly `leadDays` out (default 14) — so it sends once per
 *  lake per season, no per-user tracking column needed. */
export async function sendSeasonalPullReminders(leadDays = 14): Promise<{ ok: boolean; lakes: number; emailed: number }> {
  const target = addDays(todayLakeDate(), leadDays);
  const admin = createServiceClient();
  const { data: lakes } = await admin.from("lakes").select("id, name, pull_deadline").eq("pull_deadline", target);
  if (!lakes || lakes.length === 0) return { ok: true, lakes: 0, emailed: 0 };

  let emailed = 0;
  for (const lake of lakes) {
    const { data: props } = await admin
      .from("properties")
      .select("address, users(email, name)")
      .eq("lake_id", lake.id);
    const seen = new Set<string>();
    for (const p of props ?? []) {
      const u = one((p as { users?: unknown }).users) as { email?: string; name?: string } | null;
      const email = u?.email;
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const deadline = prettyDate(lake.pull_deadline as string);
      void sendEmail({
        to: email,
        subject: `Book your fall pull on ${lake.name} before the freeze`,
        html: `<p>Hi ${u?.name ?? "there"},</p><p>${lake.name}'s pull deadline is <b>${deadline}</b> — that's when piers, lifts and boats need to be out ahead of the hard freeze (we build in an 8-day safety buffer). Book your fall pull now so your crew has a slot before the rush.</p><p>Open LakeLife to schedule. 🌊</p>`,
      });
      emailed++;
    }
  }
  return { ok: true, lakes: lakes.length, emailed };
}
