import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { getVendorScores } from "@/lib/scoring-data";
import { computeScore, type CrewTier } from "@/lib/scoring";
import { checkNamedInsured } from "@/lib/named-insured";
import { canEverDo } from "@/lib/dispatch";
import { coiState, docConfirmState, type CoiState, type DocConfirmState } from "./crews-coi";
import { mustRead } from "@/lib/must-read";
import { isCoolingDown } from "@/lib/lake-standing";
import { getPlatformSettings } from "@/lib/settings";

/** Crew (vendor) roster for the ops Crews tab. Ops-only, service-role read —
 *  never import this into a vendor/owner surface (it carries no margin, but it
 *  does carry every crew's documents + contact details). */

export interface OpsCrewContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** true when the crew hasn't signed up yet (email is the invite address). */
  unclaimed: boolean;
}

export interface OpsCrew {
  id: string;
  company: string | null;
  status: "invited" | "active" | "suspended";
  invite_email: string | null;
  /**
   * WHETHER THE INVITATION EVER LEFT (0154). NULL means it has not — including
   * rows that predate the column, which is why the card says "date unknown"
   * rather than inventing one. Without this, a bounced invite and one somebody
   * simply hasn't opened render identically, forever.
   */
  inviteSentAt: string | null;
  /** The last refusal, verbatim, when a send failed. */
  inviteError: string | null;
  contact: OpsCrewContact;
  service_types: string[];
  daily_capacity: number;
  work_days: string[];
  coi_expiry: string | null;
  coiState: CoiState;
  /** Has a person opened the file and agreed the typed expiry? (0152) */
  coiConfirm: DocConfirmState;
  /** The insured name the crew typed off it, and whether it matches (0152). */
  coi_named_insured: string | null;
  namedInsuredMismatch: boolean;
  hasCoiDoc: boolean;
  hasW9Doc: boolean;
  coiSignedUrl: string | null;
  w9SignedUrl: string | null;
  score: number;
  tier: CrewTier;
  onTimeRate: number;
  completedCount: number;
  thumbsUp: number; // customer 👍 confirmations
  thumbsDown: number; // customer 👎 issue flags
  /**
   * WHICH LAKES THIS CREW ACTUALLY WORKS, and which have been taken away.
   *
   * When dispatch says "No crew serves Pretty Lake yet", ops had no way from
   * this board to tell the two apart: a crew who simply never ticked Pretty,
   * and a crew who was auto-demoted off it last night after two strikes. Those
   * need opposite responses — ring them and ask, or look at what went wrong —
   * and the board showed neither.
   */
  lakes: string[];
  /** Demoted off, still inside the cooldown. Empty for almost every crew. */
  pausedLakes: Array<{ name: string; liftsOn: string }>;
}

const FRESH_CREW = computeScore({ completedCount: 0, onTimeCount: 0, ratedCount: 0, flagsApproved: 0, flagsDeclined: 0 });

const DOC_BUCKET = "vendor-docs";
const STATUS_ORDER: Record<string, number> = { invited: 0, active: 1, suspended: 2 };

type Embed<T> = T | T[] | null;
interface CrewRaw {
  id: string;
  company: string | null;
  status: string;
  invite_email: string | null;
  invite_sent_at: string | null;
  invite_error: string | null;
  service_types: string[] | null;
  service_lakes: string[] | null;
  daily_capacity: number | null;
  work_days: string[] | null;
  coi_url: string | null;
  coi_expiry: string | null;
  coi_named_insured: string | null;
  coi_expiry_confirmed_at: string | null;
  w9_url: string | null;
  created_at: string;
  users: Embed<{ name: string | null; email: string | null; phone: string | null }>;
}

const first = <T>(x: T | T[] | null | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

export async function getCrews(): Promise<OpsCrew[]> {
  const admin = createServiceClient();
  const today = todayLakeDate();

  const [crewRes, scores, confirmRes, lakeRes, demotionRes, settings] = await Promise.all([
    admin
      .from("vendors")
      .select(
        "id, company, status, invite_email, invite_sent_at, invite_error, " +
        "service_types, service_lakes, daily_capacity, work_days, " +
          // Named for the same reason as the COI cron: two FKs from vendors to
        // users, so a bare users(...) is PGRST201. Unguarded this showed an
        // empty Crews tab reading "nobody invited yet"; guarded it threw.
        "coi_url, coi_expiry, coi_named_insured, coi_expiry_confirmed_at, w9_url, created_at, users!vendors_user_id_fkey(name, email, phone)",
      ),
    getVendorScores(),
    admin.from("job_confirmations").select("vendor_id, verdict").not("verdict", "is", null),
    admin.from("lakes").select("id, name"),
    admin.from("vendor_lake_demotions").select("vendor_id, lake_id, demoted_at"),
    getPlatformSettings(),
  ]);
  // An empty roster is a real state (nobody invited yet) and the Crews tab says
  // so. A failed read used to say the same thing — and a lost thumbs-down read
  // shows a crew with a clean record they may not have.
  const data = mustRead("the crew roster", crewRes);
  const confirmations = mustRead("the customers' verdicts on each crew", confirmRes);
  // An empty lake list here would print every crew as serving nowhere, which is
  // the exact question this board is being asked to answer.
  const lakeNames = new Map(
    (mustRead("the lakes", lakeRes) ?? []).map((l) => [l.id as string, l.name as string]),
  );
  // And an empty demotion list would say every crew is in good standing on
  // every lake — the reassuring answer, and the one that is sometimes false.
  const demotions = mustRead("which crews are paused off a lake", demotionRes);
  const nowMs = Date.now();
  const pausedByVendor = new Map<string, Array<{ name: string; liftsOn: string }>>();
  for (const d of demotions ?? []) {
    if (!isCoolingDown(d.demoted_at as string, settings.lakeDemotionCooldownDays, nowMs)) continue;
    const lifts = new Date(
      Date.parse(d.demoted_at as string) + settings.lakeDemotionCooldownDays * 86_400_000,
    ).toISOString().slice(0, 10);
    const list = pausedByVendor.get(d.vendor_id as string) ?? [];
    list.push({ name: lakeNames.get(d.lake_id as string) ?? "a lake", liftsOn: lifts });
    pausedByVendor.set(d.vendor_id as string, list);
  }
  const thumbs = new Map<string, { up: number; down: number }>();
  for (const c of confirmations ?? []) {
    const t = thumbs.get(c.vendor_id as string) ?? { up: 0, down: 0 };
    if (c.verdict === "good") t.up++;
    else if (c.verdict === "issue") t.down++;
    thumbs.set(c.vendor_id as string, t);
  }

  const rows = (data ?? []) as unknown as CrewRaw[];

  // One signed URL per document path (private bucket, 1h). Sign only the paths
  // that exist so we never mint a URL for a missing doc.
  async function sign(path: string | null): Promise<string | null> {
    if (!path) return null;
    const signed = await admin.storage.from(DOC_BUCKET).createSignedUrl(path, 3600);
    // Deliberately soft: `hasCoiDoc` / `hasW9Doc` are decided from the stored
    // path, not from this, so a failed signing costs a link and not a fact —
    // the card still says the document is there. It logs so a bucket that has
    // stopped signing does not simply look like a screen with no links.
    if (signed.error) {
      console.error("[read failed] a signed link to a crew document:", signed.error.message);
      return null;
    }
    return signed.data?.signedUrl ?? null;
  }

  const crews = await Promise.all(
    rows.map(async (r): Promise<OpsCrew> => {
      const u = first(r.users) as { name?: string; email?: string; phone?: string } | null;
      const claimed = !!u;
      const [coiSignedUrl, w9SignedUrl] = await Promise.all([sign(r.coi_url), sign(r.w9_url)]);
      const status = (["invited", "active", "suspended"].includes(r.status) ? r.status : "invited") as OpsCrew["status"];
      const sc = scores.get(r.id) ?? FRESH_CREW;
      return {
        id: r.id,
        company: r.company ?? null,
        status,
        invite_email: r.invite_email ?? null,
        inviteSentAt: (r.invite_sent_at as string | null) ?? null,
        inviteError: (r.invite_error as string | null) ?? null,
        contact: {
          name: u?.name ?? null,
          email: (u?.email ?? r.invite_email) ?? null,
          phone: u?.phone ?? null,
          unclaimed: !claimed,
        },
        service_types: r.service_types ?? [],
        daily_capacity: Number(r.daily_capacity ?? 0),
        work_days: r.work_days ?? [],
        coi_expiry: r.coi_expiry ?? null,
        coiState: coiState(r.coi_url, r.coi_expiry, today),
        coiConfirm: docConfirmState(r.coi_url as string | null, r.coi_expiry_confirmed_at as string | null),
        coi_named_insured: (r.coi_named_insured as string | null) ?? null,
        // Grandfathered like every other gate: a crew who predates the field
        // is not "mismatched", they are unasked.
        namedInsuredMismatch:
          r.coi_named_insured != null &&
          !checkNamedInsured(r.coi_named_insured as string, r.company as string | null).ok,
        hasCoiDoc: !!r.coi_url,
        hasW9Doc: !!r.w9_url,
        coiSignedUrl,
        w9SignedUrl,
        score: sc.score,
        tier: sc.tier,
        onTimeRate: sc.onTimeRate,
        completedCount: sc.completedCount,
        thumbsUp: thumbs.get(r.id)?.up ?? 0,
        thumbsDown: thumbs.get(r.id)?.down ?? 0,
        lakes: ((r.service_lakes as string[] | null) ?? [])
          .map((id) => lakeNames.get(id))
          .filter((n): n is string => !!n)
          .sort((a, b) => a.localeCompare(b)),
        pausedLakes: (pausedByVendor.get(r.id) ?? []).sort((a, b) => a.liftsOn.localeCompare(b.liftsOn)),
      };
    }),
  );

  // Invited first, then active, then suspended. Active crews sort by score desc
  // (dispatch priority); invited/suspended keep newest-first within the group.
  return crews.sort((a, b) => {
    const so = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (so !== 0) return so;
    if (a.status === "active" && b.status === "active" && a.score !== b.score) {
      return b.score - a.score;
    }
    const ai = rows.find((r) => r.id === a.id)?.created_at ?? "";
    const bi = rows.find((r) => r.id === b.id)?.created_at ?? "";
    return bi < ai ? -1 : bi > ai ? 1 : 0;
  });
}

/** Names of active, bookable services — the tap-chips for the invite form and
 *  the crew service-type editor. Small helper so the page can pass it as a prop. */
export async function getActiveServiceNames(): Promise<string[]> {
  const admin = createServiceClient();
  // These are the tap-chips ops picks a crew's services from. An empty list
  // reads as "no services are set up", and picking nothing is how a crew ends up
  // invited with no work they can be routed for.
  const data = mustRead(
    "the list of bookable services",
    await admin.from("services").select("name").eq("active", true).order("name", { ascending: true }),
  );
  return [...new Set((data ?? []).map((s) => s.name as string))];
}

// ---- Who can do what, and where ------------------------------------------

/** One service on one lake, and how many crews could ever take it. */
export interface CoverageCell {
  service: string;
  lakeId: string;
  lakeName: string;
  /** Crews who could actually be routed this work: capable AND carrying a rate
   *  for it. Not "free on Tuesday" — but not "capable one day either". */
  crews: number;
  /**
   * CAPABLE, AND STILL UNROUTABLE FOR WANT OF A NUMBER.
   *
   * dispatch drops a crew with no rate AFTER eligibility passes
   * (dispatch.ts:278, `crewRate != null && > 0`), and canClaim refuses them
   * with `no_rate`. So a crew who has ticked the work but never priced it is
   * offered nothing — for ever, silently. Counting them as coverage is how
   * this card would have gone green one step before the router could route,
   * which is the precise failure it exists to catch.
   */
  capableButUnpriced: number;
  /** Protective work (0053) the nightly refuses to auto-cancel. A hole here
   *  strands somebody rather than merely disappointing them. */
  protective: boolean;
}

export interface CrewCoverage {
  /** Every (active service x lake) pair with NOBODY who can do it. */
  holes: CoverageCell[];
  /** How many pairs were examined, so "3 holes" has a denominator. */
  pairs: number;
  /** Crews who count at all: active status, real (non-fixture) account. */
  liveCrews: number;
  /** Services active but with no crew ANYWHERE, on any lake. */
  orphanServices: string[];
  /** Crews who have ticked work they never priced, anywhere. Chase them for a
   *  number; do not go and hire somebody. */
  unpricedCrews: number;
}

/**
 * WHICH WORK CAN NOBODY DO — asked three months early, not on the morning.
 *
 * The dispatch board (ops/dispatch-data.ts) answers a different question: which
 * JOBS failed to find a crew. That is the right question once a job exists, and
 * the wrong one before then — it cannot fire until somebody has already booked
 * work nobody can take, which for protective work in January is the moment it
 * is too late to fix.
 *
 * This asks the structural version. It reuses `canEverDo`, the half of
 * dispatch's own eligibility rule that has nothing to do with a date, so the
 * board and the router can never disagree about who is capable. Copying those
 * rules here would have agreed today and drifted at the first change.
 *
 * FIXTURES ARE EXCLUDED, exactly as dispatch excludes them. That is the whole
 * point of the number: production holds three vendors and all three are test
 * accounts, so the honest answer for every service today is ZERO — and nothing
 * anywhere said so.
 */
export async function getCrewCoverage(): Promise<CrewCoverage> {
  const admin = createServiceClient();
  const today = todayLakeDate();

  const [vendorsRes, servicesRes, lakesRes, ratesRes] = await Promise.all([
    // The SAME fence dispatch uses: a fixture crew may never be counted as
    // coverage any more than it may be dispatched or paid.
    admin
      .from("vendors")
      .select("id, status, coi_expiry, coi_named_insured, company, service_types, service_lakes, users!vendors_user_id_fkey!inner(is_fixture)")
      .eq("users.is_fixture", false),
    admin.from("services").select("id, name, criticality, park_only").eq("active", true),
    admin.from("lakes").select("id, name").eq("is_fixture", false),
    // THE RATE IS A SECOND GATE, and it is the one a new crew fails for days.
    admin.from("vendor_rates").select("vendor_id, service_id, base, unit_rate, band_pricing"),
  ]);

  // EMPTY MEANS "NOBODY IS COVERED", which is the loudest sentence on this
  // screen. A dropped read must not be allowed to say it.
  const vendors = mustRead("the crews who could take work", vendorsRes) ?? [];
  const services = mustRead("the bookable services", servicesRes) ?? [];
  const lakes = mustRead("your lakes", lakesRes) ?? [];
  // An empty rate list reads as "nobody has priced anything", which on this
  // card is the loudest sentence there is. A dropped read must not say it.
  const rates = mustRead("what the crews charge", ratesRes) ?? [];

  /** Has this crew put a real number against this service? Same four shapes
   *  the services table uses (0162) — a row of zeroes is not a rate. */
  const priced = new Set(
    rates
      .filter((r) => {
        const bp = (r.band_pricing ?? null) as Record<string, unknown> | null;
        return (
          Number(r.base ?? 0) > 0 ||
          Number(r.unit_rate ?? 0) > 0 ||
          typeof bp?.small === "number" ||
          (Array.isArray(bp?.tiers) && (bp!.tiers as unknown[]).length > 0)
        );
      })
      .map((r) => `${r.vendor_id}::${r.service_id}`),
  );

  const candidates = vendors.map((v) => ({
    vendorId: v.id as string,
    status: (v.status as string) ?? "",
    coiExpiry: (v.coi_expiry as string | null) ?? null,
    coiNamedInsured: (v.coi_named_insured as string | null) ?? null,
    company: (v.company as string | null) ?? null,
    serviceTypes: (v.service_types as string[] | null) ?? [],
    serviceLakes: (v.service_lakes as string[] | null) ?? [],
  }));

  const holes: CoverageCell[] = [];
  const coveredSomewhere = new Set<string>();
  const unpriced = new Set<string>();
  let pairs = 0;

  for (const s of services) {
    const name = s.name as string;
    const protective = (s.criticality as string) === "protective";
    for (const lk of lakes) {
      pairs += 1;
      const capable = candidates.filter((c) =>
        canEverDo(c, { serviceName: name, lakeId: lk.id as string, todayISO: today }),
      );
      // BOTH GATES, in the order dispatch applies them: eligibility, then a
      // rate. A crew who clears the first and not the second is counted
      // separately rather than as coverage, because the remedy is a phone call
      // about a number and not a hire.
      const ready = capable.filter((c) => priced.has(`${c.vendorId}::${s.id as string}`));
      capable.forEach((c) => { if (!priced.has(`${c.vendorId}::${s.id as string}`)) unpriced.add(c.vendorId); });
      if (ready.length > 0) coveredSomewhere.add(name);
      else {
        holes.push({
          service: name,
          lakeId: lk.id as string,
          lakeName: (lk.name as string) ?? "—",
          crews: ready.length,
          capableButUnpriced: capable.length,
          protective,
        });
      }
    }
  }

  return {
    holes: holes.sort((a, b) =>
      Number(b.protective) - Number(a.protective) || a.service.localeCompare(b.service)),
    pairs,
    liveCrews: candidates.filter((c) => c.status === "active").length,
    unpricedCrews: unpriced.size,
    orphanServices: services
      .map((s) => s.name as string)
      .filter((n) => !coveredSomewhere.has(n))
      .sort(),
  };
}
