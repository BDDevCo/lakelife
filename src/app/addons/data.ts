import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, softRead } from "@/lib/must-read";
import { getPlatformSettings } from "@/lib/settings";
import { customerPrice } from "@/lib/platform-fee";
import { offerBack, type AddonStatus } from "@/lib/addons";
// THE ONE HOME FOR A SLOT'S ENGLISH NAME. Writing a private de-slugger here
// would be the fourth shape of no-caller: the right function existed one
// import away, and the copy would drift the day a slot is renamed.
import { slotLabel } from "@/lib/shot-list";

/**
 * READING AN EXTRA, FROM EACH SIDE OF IT.
 *
 * TWO LOADERS, AND THE DIFFERENCE BETWEEN THEM IS RULE 1. `job_addons` holds
 * the customer's price on the SAME ROW as the crew's quote, so the crew's
 * loader names an explicit column list that does not include it — the shape
 * `assertVendorJob` already uses — and the table grants a crew no select
 * policy at all (0180). Neither half is decoration: the policy stops a crew's
 * own JWT reading the row, and the column list stops OUR service-role code
 * handing it to them.
 *
 * `src/lib/addons-are-not-a-customer-price.test.ts` scans both of these and
 * fails if a customer number appears on the crew's path.
 */

const CUSTOMER_COLS =
  "id, job_id, property_id, vendor_id, service_id, request_text, status, crew_quote, quoted_at, crew_declined_reason, customer_price, decided_at, unwound_at, created_at";

/** EXPLICITLY WITHOUT customer_price. Rule 1 lives in this string. */
const CREW_COLS =
  "id, job_id, property_id, vendor_id, service_id, request_text, status, crew_quote, quoted_at, crew_declined_reason, created_at";

export interface OwnerAddon {
  id: string;
  jobId: string;
  requestText: string;
  status: AddonStatus;
  /** What the extra costs the customer. Null until they accept it. */
  customerPrice: number | null;
  /**
   * What the customer WOULD pay if they said yes, at this job's own frozen
   * percentages. Null unless the crew has quoted and nothing is decided yet.
   */
  offeredPrice: number | null;
  crewDeclinedReason: string | null;
  quotedAt: string | null;
  decidedAt: string | null;
  /** When a crew change took an accepted extra back off the visit. */
  unwoundAt: string | null;
  /**
   * WHY THIS QUOTE CAN NO LONGER BE TAPPED, in words. Null when it can.
   *
   * A quote had no expiry of its own: a pier job booked in May for an October
   * date could carry a May number accepted in October, because only the
   * REMEMBERED path was age-checked. The same ninety days now applies to a
   * live quote, and it is set here so the card can draw the sentence instead
   * of the buttons rather than letting the owner tap into a refusal.
   */
  staleReason: string | null;
  createdAt: string;
  serviceName: string | null;
  address: string | null;
  crewName: string | null;
  jobDate: string | null;
  jobStatus: string | null;
}

interface AddonRow {
  id: string;
  job_id: string;
  property_id: string;
  vendor_id: string;
  service_id: string | null;
  request_text: string;
  status: AddonStatus;
  crew_quote: number | null;
  quoted_at: string | null;
  crew_declined_reason: string | null;
  customer_price?: number | null;
  decided_at?: string | null;
  unwound_at?: string | null;
  created_at: string;
  jobs?: unknown;
  vendors?: unknown;
}

const one = <T,>(v: unknown): T | null => (Array.isArray(v) ? (v[0] as T) ?? null : (v as T) ?? null);

/**
 * WHAT THE CUSTOMER WOULD PAY, FROM THE PERCENTAGES THAT WILL BE FROZEN.
 *
 * A quoted add-on has a crew number and no frozen fees yet — the freeze
 * happens at the instant the owner accepts (0180), the same way 0174 freezes a
 * job at booking. So the figure on the card has to be computed from the LIVE
 * dial, and `acceptAddon` freezes that same live dial onto the row it writes.
 *
 * AND THE TWO ARE NOT GUARANTEED TO BE THE SAME READ. `getPlatformSettings`
 * is `cache()`d PER REQUEST; the render and the server action that follows it
 * are two requests, so a dial tuned in between would bill a figure the button
 * did not say. That is why `acceptAddon` takes the price the screen showed and
 * refuses to write a different one — the comment that used to sit here claimed
 * the cache closed that gap, and it does not.
 */
async function liveFee() {
  const s = await getPlatformSettings();
  return { customerPct: s.platformFeeCustomerPct, crewPct: s.platformFeeCrewPct };
}

function shape(r: AddonRow, fee: { customerPct: number; crewPct: number }, now: Date): OwnerAddon {
  const job = one<{ date?: string; status?: string; services?: unknown; properties?: unknown }>(r.jobs);
  const svc = job ? one<{ name?: string }>(job.services) : null;
  const prop = job ? one<{ address?: string }>(job.properties) : null;
  const vendor = one<{ company?: string }>(r.vendors);
  const q = r.crew_quote == null ? null : Number(r.crew_quote);
  // THE SAME NINETY DAYS, ON A LIVE QUOTE TOO. `acceptAddon` re-checks it at
  // the write — a rule in one doorway of two is not a rule — and this is the
  // half that stops the owner tapping into a refusal.
  const fresh = r.status === "quoted" ? offerBack(r.quoted_at ?? null, now) : null;
  const stale = fresh != null && !fresh.offerable;
  return {
    id: r.id,
    jobId: r.job_id,
    requestText: r.request_text,
    status: r.status,
    customerPrice: r.customer_price == null ? null : Number(r.customer_price),
    offeredPrice: r.status === "quoted" && q != null ? customerPrice(q, fee) : null,
    crewDeclinedReason: r.crew_declined_reason ?? null,
    quotedAt: r.quoted_at ?? null,
    decidedAt: r.decided_at ?? null,
    unwoundAt: r.unwound_at ?? null,
    staleReason: stale ? (fresh?.why ?? null) : null,
    createdAt: r.created_at,
    serviceName: svc?.name ?? null,
    address: prop?.address ?? null,
    crewName: vendor?.company ?? null,
    jobDate: job?.date ?? null,
    jobStatus: job?.status ?? null,
  };
}

/**
 * Every extra on the signed-in owner's properties that is still moving, plus
 * the recently decided ones — the same shape `getOwnerFlags` returns for the
 * approvals screen, because they share that screen.
 *
 * mustRead, not a bare read: `{data:null,error}` here would render as "you
 * have no extras waiting" to somebody whose crew is waiting on an answer.
 */
export async function getOwnerAddons(): Promise<OwnerAddon[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const admin = createServiceClient();
  const rows = mustRead("your extras", await admin
    .from("job_addons")
    .select(
      CUSTOMER_COLS +
      ", jobs!job_addons_job_id_fkey!inner(date, status, services(name), properties!inner(address, owner_id))" +
      ", vendors!job_addons_vendor_id_fkey(company)",
    )
    .eq("jobs.properties.owner_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50));

  const fee = await liveFee();
  const now = new Date();
  return (rows ?? []).map((r) => shape(r as unknown as AddonRow, fee, now));
}

/** The extras on ONE visit, for the owner's job file. Ownership is re-checked. */
export async function getAddonsForOwnerJob(jobId: string): Promise<OwnerAddon[] | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createServiceClient();
  // THE GATE BEFORE THE READ. A guessed job id must learn nothing, and a
  // FAILED read must not be able to say "no extras" — mustRead throws into
  // the page's error boundary instead.
  const job = mustRead("this visit", await admin
    .from("jobs")
    .select("id, properties!inner(owner_id)")
    .eq("id", jobId)
    .maybeSingle());
  const prop = job ? one<{ owner_id?: string }>((job as { properties?: unknown }).properties) : null;
  if (!prop || prop.owner_id !== user.id) return null;

  const rows = mustRead("the extras on this visit", await admin
    .from("job_addons")
    .select(
      CUSTOMER_COLS +
      ", jobs!job_addons_job_id_fkey(date, status, services(name), properties(address, owner_id))" +
      ", vendors!job_addons_vendor_id_fkey(company)",
    )
    .eq("job_id", jobId)
    .order("created_at", { ascending: false }));

  const fee = await liveFee();
  const now = new Date();
  return (rows ?? []).map((r) => shape(r as unknown as AddonRow, fee, now));
}

/* ------------------------------------------------------- the crew's view -- */

export interface CrewAddon {
  id: string;
  requestText: string;
  status: AddonStatus;
  /** The crew's OWN number, before the platform fee. Never a customer price. */
  crewQuote: number | null;
  crewDeclinedReason: string | null;
  createdAt: string;
}

/**
 * The extras on one of THIS crew's jobs.
 *
 * `vendorId` is passed in by a caller that has already established it — the
 * page has `getMyVendorId`, the actions have their own gate — and it is
 * applied as a filter here as well, so a job id from somewhere else returns
 * nothing rather than somebody else's work.
 *
 * SOFT, AND IT SAYS SO. This is the only loader in the feature that does not
 * throw on a failed read, and the reason is where it renders: the crew's job
 * screen carries the gate code, the navigation and the photo upload, and a
 * crew standing in a driveway must not lose all of that because a side panel
 * could not load. But "we could not read this" is NOT "there are none" —
 * `failed` carries the difference to the panel, which prints it.
 */
export async function getAddonsForCrewJob(
  jobId: string,
  vendorId: string,
): Promise<{ addons: CrewAddon[]; failed: boolean }> {
  const admin = createServiceClient();
  const [rows, failed] = softRead(
    "the extras this owner asked for",
    await admin
      .from("job_addons")
      .select(CREW_COLS)
      .eq("job_id", jobId)
      .eq("vendor_id", vendorId)
      .order("created_at", { ascending: false }),
    null,
  );
  return {
    failed,
    addons: (rows ?? []).map((r) => ({
      id: r.id as string,
      requestText: r.request_text as string,
      status: r.status as AddonStatus,
      crewQuote: r.crew_quote == null ? null : Number(r.crew_quote),
      crewDeclinedReason: (r.crew_declined_reason as string | null) ?? null,
      createdAt: r.created_at as string,
    })),
  };
}

/* ------------------------------------------------------------- the memory -- */

export interface RememberedAddon {
  /** The accepted row this offer copies. */
  sourceId: string;
  requestText: string;
  /** The crew's own number, as they gave it. */
  crewQuote: number;
  /**
   * WHAT THIS HOUSEHOLD WAS ACTUALLY BILLED LAST TIME — the frozen
   * `customer_price` off the accepted row, not a recomputation. "What this
   * crew charged last time" is a claim about the past and it has to be read
   * out of the past.
   */
  chargedThen: number;
  /** What the same quote costs the customer TODAY, at today's dial. */
  priceNow: number;
  /**
   * WHEN THE CREW NAMED THE NUMBER — `quoted_at`, which a repeat carries
   * forward unchanged, so this is the origin of the chain and not the day
   * somebody last tapped it.
   */
  namedOn: string;
  ageDays: number;
}

/**
 * "THAT NEW PRICING FROM THE CREW PREVIOUSLY."
 *
 * The memory is the HISTORY, read back by (property, crew, service) — there is
 * no saved-add-on table, because a second store for the same number is a price
 * with two authors and the second one goes stale silently.
 *
 * BOTH CUSTOMER FIGURES COME BACK, AND THEY ARE DIFFERENT CLAIMS. What this
 * household was CHARGED is the frozen `customer_price` off the accepted row —
 * a fact about the past, which must be read out of the past and never
 * recomputed. What it would cost TODAY is that same crew quote at today's
 * dial, because that is the number the button will actually bill. They are
 * equal until the dial moves, and the screen names the difference when it
 * does rather than leaving the owner to find it.
 *
 * WHAT IS CARRIED FORWARD IS THE CREW'S QUOTE. `repeatAddon` files it at that
 * number and at today's percentages, because the work is agreed today.
 *
 * NOTHING HERE AUTO-ANYTHING. It returns candidates. The owner still has to
 * tap, and `repeatAddon` still writes a fresh row.
 */
export async function getRememberedAddons(input: {
  propertyId: string;
  vendorId: string;
  serviceId: string | null;
  /** Requests already on this visit — the same words are not offered twice. */
  excludeTexts?: string[];
  now?: Date;
}): Promise<RememberedAddon[]> {
  const admin = createServiceClient();
  let q = admin
    .from("job_addons")
    .select("id, request_text, crew_quote, customer_price, quoted_at")
    .eq("property_id", input.propertyId)
    .eq("vendor_id", input.vendorId)
    .eq("status", "accepted")
    .order("quoted_at", { ascending: false })
    .limit(25);
  // A service-less job (there are legacy ones) remembers per property+crew
  // only; `.is()` and `.eq()` are different filters and using the wrong one
  // returns everything.
  q = input.serviceId ? q.eq("service_id", input.serviceId) : q.is("service_id", null);

  const rows = mustRead("what this crew has charged you before", await q);
  const fee = await liveFee();
  const now = input.now ?? new Date();
  const already = new Set((input.excludeTexts ?? []).map((t) => t.trim().toLowerCase()));

  const out: RememberedAddon[] = [];
  const seen = new Set<string>();
  for (const r of rows ?? []) {
    const text = (r.request_text as string) ?? "";
    const key = text.trim().toLowerCase();
    if (!key || seen.has(key) || already.has(key)) continue;
    const quote = r.crew_quote == null ? null : Number(r.crew_quote);
    if (quote == null || !(quote > 0)) continue;
    // A row we cannot say what they were billed for is not a row we can say
    // "this is what you were charged" about. Skipped rather than dressed up
    // with a recomputation.
    const charged = r.customer_price == null ? null : Number(r.customer_price);
    if (charged == null || !Number.isFinite(charged)) continue;
    // FROM THE DAY THE CREW NAMED IT. `repeatAddon` carries `quoted_at`
    // forward, so a chain of repeats ages from its origin and dies ninety days
    // after the quote rather than ninety days after the last tap.
    const fresh = offerBack(r.quoted_at as string | null, now);
    // STALE MEANS NOT OFFERED AT ALL. The words come back through the ordinary
    // box instead, where the crew names a current number.
    if (!fresh.offerable) continue;
    seen.add(key);
    out.push({
      sourceId: r.id as string,
      requestText: text,
      crewQuote: quote,
      chargedThen: charged,
      priceNow: customerPrice(quote, fee),
      namedOn: r.quoted_at as string,
      ageDays: fresh.ageDays,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/* --------------------------------------------- everything the panel needs -- */

export interface ExtrasPanel {
  jobId: string;
  serviceName: string;
  /** The extras already on this visit, newest first. */
  addons: OwnerAddon[];
  /** Fresh prices this crew has given at this property for this service. */
  remembered: RememberedAddon[];
  /** The named shots the crew must take. EVIDENCE, not a scope — see addons.ts. */
  photographed: string[];
  /** May they ask for something on this visit at all? */
  canAsk: boolean;
  /** Why not, in words, when they cannot. Null when they can. */
  whyNot: string | null;
}

/**
 * ONE LOAD FOR THE OWNER'S "WANT SOMETHING EXTRA?" PANEL.
 *
 * Returns null for a job that is not this owner's — the same answer a job that
 * never existed gets, so a guessed id confirms nothing. A FAILED read throws
 * (mustRead) into the page's error boundary rather than rendering an empty
 * panel over a house that has three extras waiting.
 */
export async function getExtrasPanel(jobId: string): Promise<ExtrasPanel | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createServiceClient();
  const job = mustRead("this visit", await admin
    .from("jobs")
    .select("id, status, property_id, service_id, vendor_id, group_id, services(name, required_photo_slots), properties!inner(owner_id)")
    .eq("id", jobId)
    .maybeSingle());
  if (!job) return null;
  const prop = one<{ owner_id?: string }>((job as { properties?: unknown }).properties);
  if (prop?.owner_id !== user.id) return null;

  const svc = one<{ name?: string; required_photo_slots?: unknown }>((job as { services?: unknown }).services);
  const serviceName = svc?.name ?? "visit";
  const status = job.status as string;
  const vendorId = (job.vendor_id as string | null) ?? null;

  const addons = (await getAddonsForOwnerJob(jobId)) ?? [];

  // A DIFFERENT SENTENCE FOR EACH REASON. "You can't add extras" over a
  // finished visit and over an unassigned one are two different facts, and the
  // second one resolves itself the moment a crew is booked.
  let canAsk = true;
  let whyNot: string | null = null;
  if (!["requested", "scheduled", "in_progress"].includes(status)) {
    canAsk = false;
    whyNot =
      `This visit is already ${status === "paid" ? "paid for" : status}, so nothing more can be added to it. ` +
      "If you'd still like the work doing, book it and we'll put a crew on it.";
  } else if (!vendorId) {
    canAsk = false;
    whyNot = "No crew is on this visit yet. Once one is assigned you'll be able to ask them for extras here.";
  } else if ((job.group_id as string | null) != null) {
    // A PACKAGE'S BILL IS THE SUM OF ITS LEGS (requests/package-data.ts) and
    // an extra is not a leg: folding one into `jobs.customer_price` would
    // leave the breakdown the owner reads short of the invoice by exactly the
    // extra, with no line explaining it. `accept_job_addon` refuses it at the
    // write too. Said out loud rather than shipped as a total that does not
    // add up.
    canAsk = false;
    whyNot =
      "This visit is part of a package, and we can't add an extra to a package visit yet — the breakdown you see is the sum of its parts and an extra wouldn't appear in it. " +
      "Book the extra as its own job and we'll price it.";
  }

  const remembered = vendorId
    ? await getRememberedAddons({
        propertyId: job.property_id as string,
        vendorId,
        serviceId: (job.service_id as string | null) ?? null,
        // The same words are not offered back while they are already on this
        // visit — including one the owner has only just asked for.
        excludeTexts: addons
          .filter((a) => a.status !== "owner_declined" && a.status !== "crew_declined" && a.status !== "withdrawn")
          .map((a) => a.requestText),
      })
    : [];

  const slots = Array.isArray(svc?.required_photo_slots) ? (svc.required_photo_slots as unknown[]) : [];

  return {
    jobId,
    serviceName,
    addons,
    remembered,
    photographed: slots.map((x) => slotLabel(String(x))).filter((x) => x.length > 0),
    canAsk,
    whyNot,
  };
}
