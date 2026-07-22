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
import { shouldDemote, healBase, isCoolingDown } from "@/lib/lake-standing";
import { warningDue, isExpired } from "@/lib/waitlist";
import { rushWindowOpen } from "@/lib/rush";
import { isLastDayOfMonth, nudgeCooling } from "@/lib/growth";
import { withinSunset, customerReferralAccrual, crewShareAccrual, creditToApply } from "@/lib/referrals";
import { getPlatformSettings } from "@/lib/settings";
import { autoAssignJob, loadPricingProfileById } from "@/app/book/dispatch";
import { computeScarcityOffer } from "@/app/requests/offer-data";
import { priceService, type ServiceRule } from "@/lib/pricing";

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
    .select("id, status, customer_price, vendor_cost, vendor_id, property_id, margin, services(name)")
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
      // SERVICE CREDITS first (§8b: homeowner referral rewards are credits, not
      // cash — no 1099s, and the money comes home as bookings). Idempotent:
      // exactly one application row per invoice (partial unique index); a
      // re-run reuses the existing application instead of double-spending.
      let creditApplied = 0;
      try {
        const { data: existingApp } = await admin
          .from("user_credits").select("amount").eq("invoice_id", invoice.id).maybeSingle();
        if (existingApp) {
          creditApplied = Math.abs(Number(existingApp.amount ?? 0));
        } else {
          const { data: creditRows } = await admin.from("user_credits").select("amount").eq("user_id", ownerId);
          const balance = (creditRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
          const apply = creditToApply(balance, price);
          if (apply > 0) {
            const { error: capErr } = await admin.from("user_credits").insert({
              user_id: ownerId, amount: -apply, reason: `Applied to ${svcName}`, invoice_id: invoice.id,
            });
            if (!capErr) creditApplied = apply;
          }
        }
      } catch { /* credits are a bonus — never block a settle */ }
      const cashDue = Math.round((price - creditApplied) * 100) / 100;

      const { data: pm } = await admin
        .from("payment_methods")
        .select("token, last4, brand")
        .eq("user_id", ownerId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
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
        const charge = await LakeLifePayments.charge({ token: pm.token as string, amountCents: Math.round(cashDue * 100), description: `LakeLife — ${svcName}` });
        await admin.from("payments").insert({
          invoice_id: invoice.id,
          amount: cashDue,
          status: charge.ok ? "captured" : "failed",
          processor_ref: charge.ref ?? null,
        });
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

  return { ok: true, invoiced: true, charged };
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
  const { data: refUser } = await admin.from("users").select("id, referred_by, created_at").eq("id", p.ownerId).maybeSingle();
  const referrerId = (refUser?.referred_by as string) ?? null;
  if (referrerId && withinSunset((refUser?.created_at as string) ?? null, Date.now(), settings.referralSunsetDays)) {
    const { data: refVendor } = await admin.from("vendors").select("id").eq("user_id", referrerId).maybeSingle();
    let kind: "customer_referral" | "cross_sell" | null = null;
    let pct = 0;
    if (!refVendor) {
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
    const { data: crew } = await admin.from("vendors").select("invited_by").eq("id", p.vendorId).maybeSingle();
    const bringer = (crew?.invited_by as string) ?? null;
    if (bringer && bringer !== p.ownerId) { // no earning on your own bills
      const { data: prior } = await admin
        .from("referral_earnings")
        .select("amount")
        .eq("beneficiary", bringer)
        .eq("source_vendor", p.vendorId)
        .eq("kind", "crew_referral")
        .neq("status", "void");
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

export async function revalidateAssignments(
  dateISO?: string,
  opts: { broadcast?: boolean } = {},
): Promise<{ ok: boolean; checked: number; rehomed: number; unfilled: number; crewsTexted?: number }> {
  const broadcast = opts.broadcast ?? true; // intraday heartbeat passes false — no SMS every 30 min
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
  if (broadcast && unfilled > 0) {
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

/**
 * Retry UNCOLLECTED late-cancellation fees (closes the adversarial-review gap:
 * the completed-job reconciler never touched cancelled jobs, so a failed fee
 * charge sat 'due' forever). Nightly: find cancelled jobs whose fee invoice
 * isn't paid, retry the saved card, and — only once the money is actually in —
 * release the crew's proportional share (roadmap §2: paid from fees COLLECTED).
 */
export async function reconcileCancelledFees(): Promise<{ ok: boolean; retried: number; collected: number }> {
  const admin = createServiceClient();
  // Inner-join on UNPAID invoices so paid/free-cancelled rows never occupy the
  // scan window (expired-waitlist cancels accumulate forever — an unfiltered
  // limit could starve real fee invoices out of the batch permanently).
  const { data: jobs } = await admin
    .from("jobs")
    .select("id, customer_price, vendor_cost, vendor_id, property_id, created_at, services(name), invoices!inner(id, status, amount, created_at), properties(owner_id)")
    .eq("status", "cancelled")
    .neq("invoices.status", "paid")
    .order("created_at", { ascending: false })
    .limit(200);

  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  let retried = 0, collected = 0;
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
    const { count: failCount } = await admin
      .from("payments").select("id", { count: "exact", head: true })
      .eq("invoice_id", inv.id).eq("status", "failed");
    if ((failCount ?? 0) >= 5) continue;

    // Never double-charge: skip if a captured payment already exists.
    const { data: paid } = await admin.from("payments").select("id").eq("invoice_id", inv.id).eq("status", "captured").maybeSingle();
    if (paid) {
      await admin.from("invoices").update({ status: "paid" }).eq("id", inv.id);
    } else {
      const ownerId = (one(j.properties) as { owner_id?: string } | null)?.owner_id;
      if (!ownerId) continue;
      const { data: pm } = await admin
        .from("payment_methods")
        .select("token")
        .eq("user_id", ownerId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!pm?.token) continue; // still no card — try again tomorrow
      retried++;
      const svc = (one(j.services) as { name?: string } | null)?.name ?? "service";
      const charge = await LakeLifePayments.charge({ token: pm.token as string, amountCents: Math.round(fee * 100), description: `LakeLife — late cancellation, ${svc}` });
      await admin.from("payments").insert({ invoice_id: inv.id, amount: fee, status: charge.ok ? "captured" : "failed", processor_ref: charge.ref ?? null });
      if (!charge.ok) continue;
      await admin.from("invoices").update({ status: "paid", processor_ref: charge.ref ?? null }).eq("id", inv.id);
    }
    collected++;

    // Fee is in — release the crew's proportional share (same pct of THEIR
    // rate as the fee is of the customer price), once.
    const price = Number(j.customer_price ?? 0);
    const cost = Number(j.vendor_cost ?? 0);
    if (j.vendor_id && price > 0 && cost > 0) {
      const crewShare = Math.round((fee / price) * cost * 100) / 100;
      if (crewShare > 0) {
        const { data: existing } = await admin.from("payouts").select("id").eq("job_id", j.id as string).maybeSingle();
        if (!existing) {
          await admin.from("payouts").insert({ vendor_id: j.vendor_id, job_id: j.id, amount: crewShare, status: "released" });
        }
      }
    }
  }
  return { ok: true, retried, collected };
}

/** Referral maturation (§8b): accruals become SPENDABLE after the clawback
 *  window. Homeowner/HOA beneficiaries get service credits; crew beneficiaries
 *  flip to 'matured' and ride the payout batch when it runs. Idempotent —
 *  guarded status flips, one credit grant per earning row. */
export async function matureReferralEarnings(): Promise<{ ok: boolean; matured: number; credited: number }> {
  const admin = createServiceClient();
  const { referralMaturationDays } = await getPlatformSettings();
  const cutoff = new Date(Date.now() - referralMaturationDays * 86_400_000).toISOString();
  const { data: due } = await admin
    .from("referral_earnings")
    .select("id, beneficiary, amount, kind")
    .eq("status", "accrued")
    .lt("accrued_at", cutoff)
    .order("accrued_at", { ascending: true })
    .limit(200);

  let matured = 0, credited = 0;
  for (const e of due ?? []) {
    // GRANT FIRST, idempotently (user_credits.earning_id unique) — a crash
    // between grant and flip re-runs safely: the dup grant no-ops on the
    // index and the flip then completes. Money can't vanish in the gap.
    const { data: isVendor } = await admin.from("vendors").select("id").eq("user_id", e.beneficiary as string).maybeSingle();
    if (!isVendor && Number(e.amount) > 0) {
      const { error: gErr } = await admin.from("user_credits").insert({
        user_id: e.beneficiary, amount: Number(e.amount), earning_id: e.id,
        reason: e.kind === "crew_referral" ? "Referral reward — you brought a crew aboard" : "Referral reward — thanks for spreading the word",
      });
      if (gErr && !/duplicate|unique/i.test(gErr.message)) {
        console.error(`[referral mature ${e.id}] credit grant failed:`, gErr.message);
        continue; // don't flip — retry tomorrow
      }
      credited++;
    }
    const { data: won } = await admin
      .from("referral_earnings")
      .update({ status: "matured", matured_at: new Date().toISOString() })
      .eq("id", e.id)
      .eq("status", "accrued")
      .select("id");
    if (won && won.length > 0) matured++;
  }
  return { ok: true, matured, credited };
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
export async function runReferralPayoutBatch(force = false): Promise<{ ok: boolean; ran: boolean; beneficiaries: number; total: number }> {
  const today = todayLakeDate();
  if (!force && !isLastDayOfMonth(today)) return { ok: true, ran: false, beneficiaries: 0, total: 0 };
  const admin = createServiceClient();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const { data: matured } = await admin
    .from("referral_earnings")
    .select("id, beneficiary, amount")
    .eq("status", "matured")
    .limit(500);

  // Only vendor/HOA-type beneficiaries batch out; (customers were already
  // granted credits at maturation and never reach 'matured' with money owed).
  const byUser = new Map<string, { ids: string[]; total: number }>();
  for (const e of matured ?? []) {
    const u = byUser.get(e.beneficiary as string) ?? { ids: [], total: 0 };
    u.ids.push(e.id as string);
    u.total += Number(e.amount ?? 0);
    byUser.set(e.beneficiary as string, u);
  }

  let beneficiaries = 0, total = 0;
  for (const [userId, u] of byUser) {
    const { data: vendorRow } = await admin.from("vendors").select("id, company").eq("user_id", userId).maybeSingle();
    if (!vendorRow) continue; // non-vendor matured rows shouldn't exist; leave for audit
    let paidThis = 0;
    for (const id of u.ids) {
      const { data: won } = await admin
        .from("referral_earnings")
        .update({ status: "paid" })
        .eq("id", id)
        .eq("status", "matured")
        .select("amount");
      if (won && won.length > 0) paidThis += Number(won[0].amount ?? 0);
    }
    if (paidThis <= 0) continue;
    beneficiaries++;
    total += paidThis;
    // Still-maturing remainder for the digest line.
    const { data: pending } = await admin
      .from("referral_earnings").select("amount").eq("beneficiary", userId).eq("status", "accrued");
    const maturing = (pending ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const { data: u2 } = await admin.from("users").select("email, name").eq("id", userId).maybeSingle();
    if (u2?.email) {
      void sendEmail({
        to: u2.email,
        subject: `Referral payout approved — $${paidThis.toFixed(2)} 🌊`,
        html: `<p>Hi ${vendorRow.company ?? u2.name ?? "there"},</p><p>Your referral earnings for the month are in: <b>$${paidThis.toFixed(2)}</b> approved and riding your next remittance.${maturing > 0 ? ` Another $${maturing.toFixed(2)} is maturing and lands next batch.` : ""}</p><p>Keep sharing — it stacks. 🌊</p><p style="font-size:12px;color:#5D7681">Manage notifications: ${site}/settings/notifications</p>`,
      });
    }
  }
  return { ok: true, ran: true, beneficiaries, total: Math.round(total * 100) / 100 };
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
export async function runNudges(): Promise<{ ok: boolean; creditNudges: number; territoryNudges: number }> {
  const admin = createServiceClient();
  const { nudgeCreditThreshold, nudgeCooldownDays, lakeDemotionCooldownDays } = await getPlatformSettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const now = Date.now();

  const optedOut = async (userId: string): Promise<boolean> => {
    const { data } = await admin
      .from("notification_prefs").select("enabled")
      .eq("user_id", userId).eq("type", "growth").eq("channel", "email").maybeSingle();
    return data?.enabled === false;
  };
  const cooling = async (userId: string, kind: string): Promise<boolean> => {
    const { data } = await admin
      .from("nudge_log").select("sent_at")
      .eq("user_id", userId).eq("kind", kind)
      .order("sent_at", { ascending: false }).limit(1).maybeSingle();
    return nudgeCooling((data?.sent_at as string) ?? null, nudgeCooldownDays, now);
  };
  const send = async (userId: string, kind: string, subject: string, html: string): Promise<boolean> => {
    if (await optedOut(userId)) return false;
    if (await cooling(userId, kind)) return false;
    const { data: u } = await admin.from("users").select("email").eq("id", userId).maybeSingle();
    if (!u?.email) return false;
    void sendEmail({ to: u.email, subject, html: html + `<p style="font-size:12px;color:#5D7681">Manage notifications: ${site}/settings/notifications</p>` });
    await admin.from("nudge_log").insert({ user_id: userId, kind });
    return true;
  };

  // A) Credits now cover a visit.
  let creditNudges = 0;
  const { data: creditRows } = await admin.from("user_credits").select("user_id, amount");
  const balances = new Map<string, number>();
  for (const c of creditRows ?? []) balances.set(c.user_id as string, (balances.get(c.user_id as string) ?? 0) + Number(c.amount ?? 0));
  for (const [userId, bal] of balances) {
    if (bal < nudgeCreditThreshold) continue;
    const ok = await send(
      userId, "credit_covers_visit",
      `You've got $${bal.toFixed(2)} in LakeLife credits 🌊`,
      `<p>Your referral credits just crossed <b>$${bal.toFixed(2)}</b> — enough to cover a visit on us.</p><p>Book anything at <a href="${site}/book">${site}/book</a> and it applies automatically at billing. Keep sharing your link and the next one's on us too.</p>`,
    );
    if (ok) creditNudges++;
  }

  // B) Territory expansion — waiting demand next door, priced at THEIR rates.
  let territoryNudges = 0;
  const today = todayLakeDate();
  const { data: waiting } = await admin
    .from("jobs")
    .select("id, service_id, property_id, services(name, pricing_model), properties(lake_id, lakes(name))")
    .eq("status", "requested").is("vendor_id", null).gte("date", today).limit(50);
  if (waiting && waiting.length > 0) {
    const { data: crews } = await admin
      .from("vendors")
      .select("id, user_id, company, service_types, service_lakes, coi_expiry")
      .eq("status", "active").not("user_id", "is", null);
    const { data: rates } = await admin.from("vendor_rates").select("vendor_id, service_id, base, unit_rate, band_pricing");
    const rateBy = new Map((rates ?? []).map((r) => [`${r.vendor_id}|${r.service_id}`, r]));

    for (const v of crews ?? []) {
      if (!v.coi_expiry || String(v.coi_expiry) < today) continue;
      const myLakes = new Set((v.service_lakes as string[]) ?? []);
      // Group this crew's claimable-if-they-expanded demand by lake.
      const byLake = new Map<string, { name: string; jobs: typeof waiting; est: number }>();
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
        const profile = await loadPricingProfileById(admin, j.property_id as string);
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
      // Best single lake pitch; skip lakes the crew is paused on (Phase E).
      let best: { lakeId: string; name: string; count: number; est: number } | null = null;
      for (const [lakeId, e] of byLake) {
        if (e.jobs.length === 0 || e.est <= 0) continue;
        const { data: pause } = await admin
          .from("vendor_lake_demotions").select("demoted_at")
          .eq("vendor_id", v.id as string).eq("lake_id", lakeId).maybeSingle();
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

  return { ok: true, creditNudges, territoryNudges };
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

export async function sweepWaitlist(lakeId?: string, limit = 60): Promise<{ ok: boolean; checked: number; filled: number }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
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
  const { data: waiting } = await q;

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
        const { data: owner } = await admin.from("users").select("phone").eq("id", prop.owner_id).maybeSingle();
        if (owner?.phone) void sendSms(owner.phone as string, `LakeLife: good news — a crew is locked in for your ${svc} on ${prettyDate(j.date as string)}. You'll get a reminder before we arrive. 🌊`);
      }
    } catch {
      /* keep sweeping */
    }
  }
  return { ok: true, checked: (waiting ?? []).length, filled };
}

/**
 * WAITLIST TERMINAL (ladder rung 8): the honest floor. At `waitlist_warning_days`
 * out, a still-unfilled job's customer gets the self-serve fork (exact-boundary,
 * one send). If the date passes with nobody to send, the machine cancels,
 * says so plainly, and reminds them they were never charged — no silent rot,
 * no ops queue. The demand history stays on the books as the recruit signal.
 */
export async function expireUnfilledJobs(): Promise<{ ok: boolean; warned: number; expired: number }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const { waitlistWarningDays } = await getPlatformSettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const { data: unfilled } = await admin
    .from("jobs")
    .select("id, date, services(name), properties(owner_id, address, nickname)")
    .eq("status", "requested")
    .is("vendor_id", null)
    .eq("is_rush", false) // rush stragglers get their own, kinder fallback rung
    .not("date", "is", null);

  let warned = 0, expired = 0;
  for (const j of unfilled ?? []) {
    const svc = (one(j.services) as { name?: string } | null)?.name ?? "your service";
    const prop = one(j.properties) as { owner_id?: string; address?: string; nickname?: string } | null;
    const where = prop?.nickname || prop?.address || "your place";
    const phone = prop?.owner_id
      ? ((await admin.from("users").select("phone").eq("id", prop.owner_id).maybeSingle()).data?.phone as string | undefined)
      : undefined;

    if (isExpired(j.date as string, today)) {
      // Guarded flip — never race a same-moment claim/assign.
      const { data: gone } = await admin
        .from("jobs")
        .update({ status: "cancelled" })
        .eq("id", j.id as string)
        .eq("status", "requested")
        .is("vendor_id", null)
        .select("id");
      if (!gone || gone.length === 0) continue;
      expired++;
      if (phone) {
        void sendSms(phone, `LakeLife: we couldn't line up a crew in time for ${svc} at ${where} — so we've cancelled it and you were never charged. Rebook any open day (${site}/book), or invite a crew you trust and they're always first on your jobs (${site}/book). We're recruiting on your lake. 🌊`);
      }
    } else if (warningDue(j.date as string, today, waitlistWarningDays)) {
      warned++;
      if (phone) {
        // If a price bump would unlock a crew RIGHT NOW (rung 3), say so in
        // the same text — the fix shouldn't hide on a page they may not visit.
        let boost = "";
        try {
          const offer = await computeScarcityOffer(j.id as string);
          if (offer) boost = ` Crews are tight that day — add $${offer.uplift.toFixed(2)} (new total $${offer.newPrice.toFixed(2)}) on your requests page and we'll lock one in now.`;
        } catch {
          /* offer is a bonus, never a blocker */
        }
        void sendSms(phone, `LakeLife: still lining up a crew for ${svc} at ${where} on ${prettyDate(j.date as string)}. You can hold tight (no charge unless it's done), pick a different day (${site}/requests), or invite a crew you know (${site}/book) — they'd be first on all your jobs.${boost} 🌊`);
      }
    }
  }
  return { ok: true, warned, expired };
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
  const { data: stuck } = await q;

  const tomorrow = addDays(today, 1);
  let rolled = 0, cancelled = 0;
  for (const j of stuck ?? []) {
    const svcRow = one(j.services) as { name?: string; pricing_model?: string; base?: number; unit_rate?: number; band_pricing?: unknown } | null;
    const prop = one(j.properties) as { owner_id?: string; address?: string; nickname?: string } | null;
    const svcName = svcRow?.name ?? "your service";
    const where = prop?.nickname || prop?.address || "your place";
    const phone = prop?.owner_id
      ? ((await admin.from("users").select("phone").eq("id", prop.owner_id).maybeSingle()).data?.phone as string | undefined)
      : undefined;

    if ((j.rush_fallback as string) === "cancel") {
      const { data: gone } = await admin
        .from("jobs").delete().eq("id", j.id as string).eq("status", "requested").is("vendor_id", null).select("id");
      if (!gone || gone.length === 0) continue; // claimed at the buzzer — leave it
      cancelled++;
      if (phone) void sendSms(phone, `LakeLife: no crew could free up today for ${svcName} at ${where} — cancelled as you asked, nothing charged. Book any other day at your standard price. 🌊`);
      continue;
    }

    // Roll: tomorrow at the STANDARD menu price, recomputed server-side.
    let standard = Number(j.customer_price ?? 0); // fallback: keep rush price only if repricing fails
    const profile = await loadPricingProfileById(admin, j.property_id as string);
    if (svcRow?.name && profile) {
      const rule: ServiceRule = {
        name: svcRow.name,
        pricing_model: svcRow.pricing_model as ServiceRule["pricing_model"],
        base: Number(svcRow.base ?? 0),
        unit_rate: Number(svcRow.unit_rate ?? 0),
        band_pricing: (svcRow.band_pricing as ServiceRule["band_pricing"]) ?? null,
      };
      const p = priceService(rule, profile);
      if (p > 0) standard = p;
    }
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
    if (phone) {
      void sendSms(phone, `LakeLife: no crew could free up today for ${svcName} at ${where}, so it's moved to tomorrow at the standard price ($${standard.toFixed(2)})${assignedNow ? " — and a crew is already locked in" : " — we're lining up a crew now"}. 🌊`);
    }
  }
  return { ok: true, rolled, cancelled };
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
