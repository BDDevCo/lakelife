import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { LakeLifePayments } from "@/lib/payments";
import { revalidateJob } from "@/app/book/dispatch";
import { todayLakeDate } from "@/lib/booking";
import { planVendorDay, routeMapUrl, type StopIn } from "@/lib/router";

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
export async function revalidateAssignments(dateISO?: string): Promise<{ ok: boolean; checked: number; rehomed: number; unfilled: number }> {
  const date = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : addDays(todayLakeDate(), 1);
  const admin = createServiceClient();
  const { data: jobs } = await admin
    .from("jobs")
    .select("id")
    .eq("date", date)
    .in("status", ["scheduled", "requested"]);
  let rehomed = 0;
  let unfilled = 0;
  for (const j of jobs ?? []) {
    const r = await revalidateJob(j.id as string);
    if (r.rehomed) rehomed++;
    if (!r.nowAssigned) unfilled++;
  }
  // One "needs attention" text to ops if anything couldn't be crewed.
  if (unfilled > 0) {
    const { data: ops } = await admin.from("users").select("phone").eq("role", "ops").not("phone", "is", null);
    const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    for (const o of ops ?? []) {
      if (o.phone) void sendSms(o.phone as string, `LakeLife ops: ${unfilled} job${unfilled === 1 ? "" : "s"} for ${pretty} need a crew — no eligible/qualified crew available. Time to recruit or adjust. 🌊`);
    }
  }
  return { ok: true, checked: (jobs ?? []).length, rehomed, unfilled };
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
