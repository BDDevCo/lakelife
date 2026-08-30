import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { getVendorScores } from "@/lib/scoring-data";
import { computeScore, type CrewTier } from "@/lib/scoring";
import { checkNamedInsured } from "@/lib/named-insured";
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
        "id, company, status, invite_email, service_types, service_lakes, daily_capacity, work_days, " +
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
