import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { getVendorScores } from "@/lib/scoring-data";
import { computeScore, type CrewTier } from "@/lib/scoring";
import { coiState, type CoiState } from "./crews-coi";

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
  hasCoiDoc: boolean;
  hasW9Doc: boolean;
  coiSignedUrl: string | null;
  w9SignedUrl: string | null;
  score: number;
  tier: CrewTier;
  onTimeRate: number;
  completedCount: number;
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
  daily_capacity: number | null;
  work_days: string[] | null;
  coi_url: string | null;
  coi_expiry: string | null;
  w9_url: string | null;
  created_at: string;
  users: Embed<{ name: string | null; email: string | null; phone: string | null }>;
}

const first = <T>(x: T | T[] | null | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

export async function getCrews(): Promise<OpsCrew[]> {
  const admin = createServiceClient();
  const today = todayLakeDate();

  const [{ data }, scores] = await Promise.all([
    admin
      .from("vendors")
      .select(
        "id, company, status, invite_email, service_types, daily_capacity, work_days, " +
          "coi_url, coi_expiry, w9_url, created_at, users(name, email, phone)",
      ),
    getVendorScores(),
  ]);

  const rows = (data ?? []) as unknown as CrewRaw[];

  // One signed URL per document path (private bucket, 1h). Sign only the paths
  // that exist so we never mint a URL for a missing doc.
  async function sign(path: string | null): Promise<string | null> {
    if (!path) return null;
    const { data: s } = await admin.storage.from(DOC_BUCKET).createSignedUrl(path, 3600);
    return s?.signedUrl ?? null;
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
        hasCoiDoc: !!r.coi_url,
        hasW9Doc: !!r.w9_url,
        coiSignedUrl,
        w9SignedUrl,
        score: sc.score,
        tier: sc.tier,
        onTimeRate: sc.onTimeRate,
        completedCount: sc.completedCount,
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
  const { data } = await admin.from("services").select("name").eq("active", true).order("name", { ascending: true });
  return [...new Set((data ?? []).map((s) => s.name as string))];
}
