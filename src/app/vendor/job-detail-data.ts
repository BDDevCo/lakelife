import "server-only";
import { assignmentIsLive } from "@/lib/job-view";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getMyVendorId, getVendorDay } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { signedJobPhotos, type JobPhoto } from "@/lib/photos";
import { mustRead, mustCount } from "@/lib/must-read";

/**
 * CREW JOB DETAIL + CREW CALENDAR reads (2026-07-26).
 *
 * Everything here is the crew's own view of their own work. Two rules shape
 * every query in this file:
 *
 *  - RULE 1 (absolute): no customer_price, no vendor_cost, no margin, ever.
 *    The only dollars a crew sees are their OWN payout rows (their take-home).
 *    There is no `select("*")` on jobs or job_items anywhere below — job_items
 *    carries both prices on one row, so it is always selected column by column.
 *  - RULE 3: gate/door codes are visible only ON THE DAY of that crew's job at
 *    that property. This page is reachable by URL for ANY job id, so the
 *    same-day guard is re-applied here — see gateCode below.
 *
 * Dispute tokens (crew_token / customer_token) are DELIBERATELY not selected.
 * They are bearer credentials for the SMS cure links; nothing that can reach
 * the browser may carry them. The in-portal cure buttons look the token up
 * server-side inside job-detail-actions.ts and never return it.
 */

const one = <T>(x: T | T[] | null | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? x[0] ?? null : x;

/**
 * Confirm the job is assigned to the signed-in vendor. Returns the job row or null.
 *
 * Copied VERBATIM from `assertVendorJob` in src/app/vendor/actions.ts — same
 * gate, same deliberately narrow select. It is duplicated rather than imported
 * because a "use server" module may only export async actions, and this gate
 * must also run inside plain server loaders. Keep the two in lockstep; in
 * particular NEVER widen this select (see rule 1 above).
 */
export async function assertVendorJob(jobId: string) {
  const vendorId = await getMyVendorId();
  if (!vendorId) return null;
  const admin = createServiceClient();
  // `null` from this gate means "that job isn't yours", and both the page and
  // job-detail-actions.ts say exactly that. A failed read must not be able to
  // tell a crew their own job belongs to somebody else, so it throws instead.
  const data = mustRead(
    "your job",
    await admin
      .from("jobs")
      // Deliberately NO customer_price / vendor_cost: this is the crew code path,
      // and rule 1 forbids a vendor from ever seeing menu price or margin. Keeping
      // those columns out of reach by construction (settleJob re-loads them ops-side).
      .select("id, status, vendor_id, service_id, date, property_id, group_id, pickup_address, pickup_lat, pickup_lng, pickup_contact, pickup_phone, release_confirmed_at, services(name, min_photos, required_photo_slots)")
      .eq("id", jobId)
      .maybeSingle(),
  );
  if (!data || data.vendor_id !== vendorId) return null;
  return data;
}

/** One payout row for this job, as the crew sees it (their take-home only). */
export interface CrewPayoutRow {
  id: string;
  amount: number;
  status: string; // 'pending' | 'released' | 'held'
  kind: "earning" | "adjustment";
  createdAt: string | null;
}

/** The dispute, stripped of every credential before it can reach a client. */
export interface CrewDisputeView {
  id: string;
  status: string;
  customerNote: string | null;
  openedAt: string | null;
  respondBy: string | null;
  correctionJobId: string | null;
  /** Which cure choices the lib functions will still accept (src/lib/disputes.ts). */
  canFix: boolean;
  canVerify: boolean;
  canTalk: boolean;
}

export interface CrewJobFlag {
  id: string;
  type: string | null;
  note: string | null;
  status: string;
  createdAt: string | null;
}

export interface CrewJobLink {
  id: string;
  date: string | null;
  status: string;
  serviceName: string | null;
}

export interface CrewJobDetail {
  id: string;
  serviceName: string | null;
  status: string;
  date: string | null;
  /** True when this job is scheduled for today at the lakes (drives rule 3). */
  isToday: boolean;
  address: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * WHERE THE BOAT IS (0148), when that is not the property above. Spring
   * collection only. Null on every ordinary visit, and the UI must show the
   * property address in that case — this never REPLACES the address, because
   * the boat comes back to the property afterwards.
   */
  pickupAddress: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  /** 0151: who to ask for, and a number to ring before driving out. */
  pickupContact: string | null;
  pickupPhone: string | null;
  /** 0151: when the OWNER said they'd told the holder we're coming. Their
   *  statement, not our authorisation — the crew still asks at the gate. */
  releaseConfirmedAt: string | null;
  lakeName: string | null;
  ownerName: string | null;
  facts: string;
  unitName: string | null;
  /** Package-visit leg NAMES only — never a leg price. */
  legs: string[];
  minPhotos: number;
  /**
   * The named walk-around for this service (0146). EMPTY FOR A PACKAGE VISIT
   * — same reason as VendorStop.photo_slots: a package's gate is the sum of
   * its legs and two legs can both want an "overall", so a merged list would
   * tick one leg's slot off with the other leg's photo.
   */
  photoSlots: string[];
  photoCount: number;
  photos: JobPhoto[];
  /** Rule 3: non-null ONLY on the day of this crew's job at this property. */
  gateCode: string | null;
  payouts: CrewPayoutRow[];
  takeHome: number;
  payOnHold: boolean;
  dispute: CrewDisputeView | null;
  /** Set when THIS job is the free make-it-right visit for an earlier job. */
  correctionOf: CrewJobLink | null;
  /** Set when a make-it-right visit was booked to cure THIS job. */
  correctionVisit: CrewJobLink | null;
  flags: CrewJobFlag[];
}

/** Statuses src/lib/disputes.ts still treats as open (payout stays held). */
const OPEN_DISPUTE = ["crew_review", "fixing", "verifying", "talk", "escalated"];

/**
 * The full crew-facing file for one job. Returns null when the caller is not
 * this job's crew — the page turns that into an honest "not on your route".
 */
export async function getCrewJobDetail(jobId: string): Promise<CrewJobDetail | null> {
  const job = await assertVendorJob(jobId);
  if (!job) return null;

  const admin = createServiceClient();
  const today = todayLakeDate();
  const date = (job.date as string | null) ?? null;
  const isToday = date != null && date === today;
  const svc = one(job.services) as
    { name?: string; min_photos?: number; required_photo_slots?: string[] } | null;

  // The ONE extra job column the gate deliberately doesn't carry. Narrow by
  // hand: never select("*") on jobs (customer_price/vendor_cost/margin).
  const extra = mustRead(
    "whether this is a make-it-right visit",
    await admin
      .from("jobs")
      .select("id, correction_of")
      .eq("id", jobId)
      .maybeSingle(),
  );
  const correctionOfId = (extra?.correction_of as string | null) ?? null;

  // Reuse the Today list's own day loader for the crew-facing facts: address,
  // pin, lake, owner, the profile "facts" string, the truck label — and the
  // gate code, which getVendorDay only decrypts when the day IS today. That
  // shared guard is then re-applied below, because this page (unlike the Today
  // list) can be opened by URL for any job id on any date.
  const day = date ? await getVendorDay(date) : null;
  const stop = day?.stops.find((s) => s.id === jobId) ?? null;

  let address = stop?.address ?? null;
  let lat = stop?.lat ?? null;
  let lng = stop?.lng ?? null;
  let lakeName = stop?.lake_name ?? null;
  let ownerName = stop?.owner_name ?? null;
  if (!stop) {
    // Undated job, or a day the route view doesn't cover — fetch the property
    // facts directly. NOTE: no gate_code_encrypted in this select. A job we
    // can't place on a day can never be "today", so it never shows a code.
    const prop = mustRead(
      "where this job is",
      await admin
        .from("properties")
        .select("address, lat, lng, lakes(name), users(name)")
        .eq("id", job.property_id as string)
        .maybeSingle(),
    );
    address = (prop?.address as string | null) ?? null;
    lat = (prop?.lat as number | null) ?? null;
    lng = (prop?.lng as number | null) ?? null;
    lakeName = (one(prop?.lakes) as { name?: string } | null)?.name ?? null;
    ownerName = (one(prop?.users) as { name?: string } | null)?.name ?? null;
  }

  // RULE 3, RE-APPLIED HERE. getVendorDay already refuses to decrypt on any
  // other day; this second check means the guard is stated in the lane that
  // renders the code, not inherited from a caller.
  //
  // The date alone is not the rule: rule 3 says the code is visible on the day
  // of THAT VENDOR'S SCHEDULED JOB. A job that was cancelled, or pulled back
  // from this crew and left unassigned, is no longer their scheduled job — and
  // a URL-reachable page would otherwise still hand over the code for the rest
  // of the day (review finding). Only a live assignment opens the door.
  // The same predicate getVendorDay uses — one definition, so the two lanes
  // that render this value cannot drift apart again.
  const stillTheirs = assignmentIsLive(job.status as string);
  const gateCode = isToday && stillTheirs ? stop?.gate_code ?? null : null;

  // Photo minimum. For a package visit the gate is the SUM of every leg's
  // minimum — the same rule completeJob() enforces server-side in
  // src/app/vendor/actions.ts. What's shown here is only the label; that
  // action remains the authority that refuses an under-photographed job.
  let minPhotos = svc?.min_photos ?? 0;
  // The walk-around, and only for a single-service visit — see photoSlots.
  let photoSlots: string[] = job.group_id ? [] : svc?.required_photo_slots ?? [];
  let legs: string[] = [];
  if (job.group_id) {
    // A failed read leaves minPhotos at the ANCHOR service's minimum, so the
    // card says "2 / 2 — ready to complete" and the server then refuses the
    // completion at 2/6 with a counter that never moves.
    const items = mustRead(
      "the legs of this package visit",
      await admin
        .from("job_items")
        // Column-by-column on purpose: job_items also carries customer_price and
        // vendor_cost on the same row (rule 1).
        .select("created_at, services(name, min_photos)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
    );
    if (items && items.length > 0) {
      photoSlots = [];
      minPhotos = items.reduce((sum, it) => {
        const ls = one(it.services) as { min_photos?: number } | null;
        return sum + (ls?.min_photos ?? 0);
      }, 0);
      legs = items
        .map((it) => (one(it.services) as { name?: string } | null)?.name ?? null)
        .filter((n): n is string => Boolean(n));
    }
  }

  // The dispute read is the one to watch here: an unread dispute renders as no
  // dispute at all, which removes the customer's note, the respond-by date and
  // the cure buttons from a screen whose whole job is to say "answer this by
  // Thursday or the payout stays held".
  const [countRes, photos, payRes, disputeRes, flagRes] = await Promise.all([
    admin.from("job_photos").select("id", { count: "exact", head: true }).eq("job_id", jobId),
    signedJobPhotos(jobId), // signs only — this call site is the authorization
    admin
      .from("payouts")
      .select("id, amount, status, kind, created_at")
      .eq("job_id", jobId)
      .eq("vendor_id", job.vendor_id as string)
      .order("created_at", { ascending: true }),
    admin
      .from("disputes")
      // No crew_token / customer_token: those are bearer credentials and this
      // object crosses into a client component.
      .select("id, status, customer_note, opened_at, respond_by, correction_job_id")
      .eq("job_id", jobId)
      .order("opened_at", { ascending: false }),
    admin
      .from("flags")
      .select("id, type, note, status, created_at")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
  ]);
  const count = mustCount("the photos on this job", countRes);
  const payRows = mustRead("your pay for this job", payRes);
  const disputeRows = mustRead("whether this job is disputed", disputeRes);
  const flagRows = mustRead("what's been flagged on this job", flagRes);

  const payouts: CrewPayoutRow[] = (payRows ?? []).map((p) => ({
    id: p.id as string,
    amount: Number(p.amount) || 0,
    status: (p.status as string) ?? "pending",
    kind: (p.kind as string) === "adjustment" ? "adjustment" : "earning",
    createdAt: (p.created_at as string) ?? null,
  }));
  const takeHome = Math.round(payouts.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  const payOnHold = payouts.some((p) => p.status === "held");

  // The open dispute wins; otherwise the most recent one (so a settled job
  // still explains itself). Order is opened_at desc from the query.
  const rawDisputes = disputeRows ?? [];
  const raw = rawDisputes.find((d) => OPEN_DISPUTE.includes(d.status as string)) ?? rawDisputes[0] ?? null;
  const dispute: CrewDisputeView | null = raw
    ? {
        id: raw.id as string,
        status: raw.status as string,
        customerNote: (raw.customer_note as string | null) ?? null,
        openedAt: (raw.opened_at as string) ?? null,
        respondBy: (raw.respond_by as string) ?? null,
        correctionJobId: (raw.correction_job_id as string | null) ?? null,
        // Mirrors the guards inside src/lib/disputes.ts. The lib re-checks on
        // every call — this only decides which buttons are worth offering.
        canFix: ["crew_review", "talk", "verifying"].includes(raw.status as string),
        canVerify: raw.status === "crew_review",
        canTalk: raw.status === "crew_review",
      }
    : null;

  const linkIds = [correctionOfId, dispute?.correctionJobId ?? null].filter((v): v is string => Boolean(v));
  const links = new Map<string, CrewJobLink>();
  if (linkIds.length > 0) {
    const linkRows = mustRead(
      "the visit this one is linked to",
      await admin
        .from("jobs")
        .select("id, date, status, services(name)")
        .in("id", linkIds),
    );
    for (const r of linkRows ?? []) {
      links.set(r.id as string, {
        id: r.id as string,
        date: (r.date as string | null) ?? null,
        status: (r.status as string) ?? "scheduled",
        serviceName: (one(r.services) as { name?: string } | null)?.name ?? null,
      });
    }
  }

  return {
    id: jobId,
    serviceName: svc?.name ?? stop?.service_name ?? null,
    status: (job.status as string) ?? "scheduled",
    date,
    isToday,
    address,
    lat,
    lng,
    pickupAddress: (job.pickup_address as string | null) ?? null,
    pickupLat: (job.pickup_lat as number | null) ?? null,
    pickupLng: (job.pickup_lng as number | null) ?? null,
    pickupContact: (job.pickup_contact as string | null) ?? null,
    pickupPhone: (job.pickup_phone as string | null) ?? null,
    releaseConfirmedAt: (job.release_confirmed_at as string | null) ?? null,
    lakeName,
    ownerName,
    facts: stop?.facts ?? "",
    unitName: stop?.unit_name ?? null,
    legs,
    minPhotos,
    photoSlots,
    photoCount: count ?? 0,
    photos,
    gateCode,
    payouts,
    takeHome,
    payOnHold,
    dispute,
    correctionOf: correctionOfId ? links.get(correctionOfId) ?? null : null,
    correctionVisit: dispute?.correctionJobId ? links.get(dispute.correctionJobId) ?? null : null,
    flags: (flagRows ?? []).map((f) => ({
      id: f.id as string,
      type: (f.type as string | null) ?? null,
      note: (f.note as string | null) ?? null,
      status: (f.status as string) ?? "pending",
      createdAt: (f.created_at as string) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// THE CREW CALENDAR
// ---------------------------------------------------------------------------

/** One job on the crew's month grid. Their own take-home only — never a price. */
export interface CrewCalRow {
  id: string;
  date: string; // "YYYY-MM-DD"
  status: string;
  service_name: string | null;
  address: string | null;
  lake_name: string | null;
  /** The crew's own pay for this job (rule 1 safe); null before a payout exists. */
  takeHome: number | null;
  payoutStatus: string | null; // 'pending' | 'released' | 'held'
  /** A $0 make-it-right return visit (jobs.correction_of is set). */
  isCorrection: boolean;
}

/**
 * Every job this crew is assigned in one calendar year, newest-day last.
 *
 * The read goes through the price-free `vendor_jobs` view, whose own WHERE
 * clause pins it to `ll_my_vendor_id()` — a crew physically cannot select
 * another crew's rows through it, and the view has no price columns at all.
 * A vendor id is never accepted from the caller.
 */
export async function getCrewCalendarYear(year: number): Promise<CrewCalRow[]> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return [];
  const y = Math.floor(Number(year));
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return [];

  const supabase = await createClient();
  // An empty year is a real answer for a crew's first season. A failed read
  // rendering that same blank grid is not, and there is nothing on the page to
  // tell the two apart.
  const rows = mustRead(
    "your calendar",
    await supabase
      .from("vendor_jobs")
      .select("id, date, status, service_name, address, lake_name")
      .gte("date", `${y}-01-01`)
      .lte("date", `${y}-12-31`)
      .order("date", { ascending: true }),
  );

  const jobs = (rows ?? []).filter((r) => r.date);
  if (jobs.length === 0) return [];

  const ids = jobs.map((r) => r.id as string);
  const admin = createServiceClient();
  const [calPayRes, corrRes] = await Promise.all([
    // Take-home per job: 'earning' rows only. Clawback adjustments are dated
    // to when they were APPLIED, not to the job (see earnings-data.ts), so
    // folding them into a calendar day would misdate the crew's own money.
    admin
      .from("payouts")
      .select("job_id, amount, status")
      .eq("vendor_id", vendorId)
      .eq("kind", "earning")
      .in("job_id", ids),
    admin.from("jobs").select("id, correction_of").in("id", ids),
  ]);
  // Unread pay is not unpaid work, and an unread correction flag turns a $0
  // make-it-right visit into a day that merely looks like it was never paid.
  const payRows = mustRead("your pay for the year", calPayRes);
  const corrRows = mustRead("which visits were make-it-rights", corrRes);

  const payByJob = new Map<string, { amount: number; status: string }>();
  for (const p of payRows ?? []) {
    const key = p.job_id as string;
    const prev = payByJob.get(key);
    payByJob.set(key, {
      amount: (prev?.amount ?? 0) + (Number(p.amount) || 0),
      status: (p.status as string) ?? prev?.status ?? "pending",
    });
  }
  const correctionIds = new Set(
    (corrRows ?? []).filter((r) => r.correction_of != null).map((r) => r.id as string),
  );

  return jobs.map((r) => {
    const pay = payByJob.get(r.id as string) ?? null;
    return {
      id: r.id as string,
      date: String(r.date),
      status: (r.status as string) ?? "scheduled",
      service_name: (r.service_name as string | null) ?? null,
      address: (r.address as string | null) ?? null,
      lake_name: (r.lake_name as string | null) ?? null,
      takeHome: pay ? Math.round(pay.amount * 100) / 100 : null,
      payoutStatus: pay?.status ?? null,
      isCorrection: correctionIds.has(r.id as string),
    };
  });
}
