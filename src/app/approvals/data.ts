import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { summariseCorrection, correctionCard, type CorrectionCard, type TimedRule } from "@/lib/arrival";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";

export interface OwnerFlag {
  id: string;
  type: string | null;
  note: string | null;
  status: string;
  created_at: string;
  service_name: string | null;
  address: string | null;
  proposed_change: Record<string, unknown> | null;
  /** Raised by the crew standing on site, before starting (0084). */
  at_arrival: boolean;
  /**
   * The crew's answer to "if they say no, can you still do what was booked?"
   * FALSE means declining stands them down — no work today. It has to reach
   * this screen, or the owner taps "no" believing they'll get a smaller job
   * when what they'll actually get is a crew driving away (0088).
   */
  crew_can_proceed: boolean | null;
  crew_cannot_reason: string | null;
  /**
   * What saying yes costs, in the same numbers the notification quoted.
   *
   * PENDING FLAGS ONLY, and that is not a shortcut. `summariseCorrection`
   * diffs the proposal against the CURRENT profile — so the moment a flag is
   * approved the profile holds the new values and re-running it would report
   * "nothing to change" about a decision that changed the price. There is no
   * snapshot of what the profile was, so a decided card says what it can
   * (the proposal) and does not invent what it can't.
   *
   * Null on a pending flag means we could not work it out. Best-effort by
   * design: this is the one screen in the product with a person physically
   * standing in a driveway waiting on the answer, and it must render.
   */
  correction: CorrectionCard | null;
}

/** Flags awaiting the signed-in owner's decision (plus recent decided ones). */
export async function getOwnerFlags(): Promise<OwnerFlag[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // Service role + an explicit owner filter through the join: reliable
  // regardless of RLS, and the nested job/service/property embed (otherwise
  // RLS-blocked on the ops-only jobs table) resolves.
  const admin = createServiceClient();
  // THE COMMENT BELOW DIAGNOSED THIS AND THEN SWALLOWED IT ANYWAY. Naming the
  // foreign key fixed the ONE error that was happening; every other error still
  // arrived as {error, data:null} and still rendered "No approvals waiting" —
  // to an owner whose crew is standing in their driveway waiting on a decision,
  // which is the one screen in the product with somebody physically blocked on
  // it. The season simulation confirmed it. Sole caller is approvals/page.tsx,
  // a server component under src/app/error.tsx, so throwing lands honestly.
  const data = mustRead("your approvals", await admin
    .from("flags")
    // `jobs!flags_job_id_fkey` NAMES THE RELATIONSHIP ON PURPOSE.
    // 0084 added jobs.held_flag_id -> flags(id), so there are now TWO
    // foreign keys between these tables. A bare `jobs(...)` became
    // ambiguous and PostgREST answers 300 PGRST201 — which supabase-js
    // surfaces as {error, data:null}, i.e. an EMPTY approvals screen with
    // nothing logged. Naming the key is the fix and the documentation.
    .select("id, type, note, status, created_at, proposed_change, at_arrival, crew_can_proceed, crew_cannot_reason, jobs!flags_job_id_fkey!inner(service_id, property_id, services(name), properties!inner(address, owner_id))")
    .eq("jobs.properties.owner_id", user.id)
    .order("created_at", { ascending: false }));

  const rows = data ?? [];

  // THE MONEY THE EMAIL QUOTED, RECOMPUTED THE SAME WAY.
  //
  // One rule read and one profile read per distinct service/property among the
  // PENDING flags — deduped, because a pier flag and a lift flag at the same
  // house share both. In practice this is one or two extra reads on a screen
  // that usually holds a single card.
  const jobOf = (f: Record<string, unknown>) =>
    (Array.isArray(f.jobs) ? f.jobs[0] : f.jobs) as
      { service_id?: string; property_id?: string } | null;

  const needsPricing = rows.filter(
    (f) => f.status === "pending" && f.proposed_change && Object.keys(f.proposed_change).length > 0,
  );
  const serviceIds = [...new Set(needsPricing.map((f) => jobOf(f)?.service_id).filter(Boolean))] as string[];
  const propertyIds = [...new Set(needsPricing.map((f) => jobOf(f)?.property_id).filter(Boolean))] as string[];

  const rulesById = new Map<string, TimedRule>();
  const profilesById = new Map<string, ReturnType<typeof toPricingProfile>>();
  if (serviceIds.length > 0 || propertyIds.length > 0) {
    // BEST-EFFORT, LOUDLY. A crew is standing in the driveway; losing the
    // priced line is survivable and losing the Approve button is not. The card
    // falls back to the proposal on its own, which is what it showed before.
    try {
      const [ruleRes, ...profiles] = await Promise.all([
        serviceIds.length
          ? admin
              .from("services")
              .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands, needs_interior_access")
              .in("id", serviceIds)
          : Promise.resolve({ data: [], error: null }),
        // asService: the flag is on a property this owner owns — already
        // enforced by the owner filter on the query above — but getFullProfile's
        // default path re-scopes to the SESSION user, and these run under the
        // service client.
        ...propertyIds.map((id) => getFullProfile(id, { asService: true })),
      ]);
      if (ruleRes.error) {
        console.error("[read failed] the pricing rules behind your approvals:", ruleRes.error);
      }
      for (const r of ruleRes.data ?? []) rulesById.set(r.id as string, r as unknown as TimedRule);
      propertyIds.forEach((id, i) => {
        const p = profiles[i];
        if (p?.hasProfile) profilesById.set(id, toPricingProfile(p));
      });
    } catch (e) {
      console.error("[approvals] couldn't price the proposed changes:", e);
    }
  }

  function priceIt(f: (typeof rows)[number]): CorrectionCard | null {
    if (f.status !== "pending") return null;
    const proposed = f.proposed_change as Record<string, unknown> | null;
    if (!proposed || Object.keys(proposed).length === 0) return null;
    const j = jobOf(f);
    const rule = j?.service_id ? rulesById.get(j.service_id) : undefined;
    const profile = j?.property_id ? profilesById.get(j.property_id) : undefined;
    if (!rule || !profile) return null;
    try {
      return correctionCard(
        summariseCorrection(rule, profile, proposed as Parameters<typeof summariseCorrection>[2]),
      );
    } catch (e) {
      console.error("[approvals] couldn't summarise a proposed change:", e);
      return null;
    }
  }

  return rows
    .map((f) => {
      const job = Array.isArray(f.jobs) ? f.jobs[0] : f.jobs;
      const svc = job && (Array.isArray(job.services) ? job.services[0] : job.services);
      const prop = job && (Array.isArray(job.properties) ? job.properties[0] : job.properties);
      return {
        id: f.id as string,
        type: f.type as string | null,
        note: f.note as string | null,
        status: f.status as string,
        created_at: f.created_at as string,
        service_name: (svc as { name?: string } | null)?.name ?? null,
        address: (prop as { address?: string } | null)?.address ?? null,
        proposed_change: (f.proposed_change as Record<string, unknown> | null) ?? null,
        at_arrival: !!f.at_arrival,
        crew_can_proceed: (f.crew_can_proceed as boolean | null) ?? null,
        crew_cannot_reason: (f.crew_cannot_reason as string | null) ?? null,
        correction: priceIt(f),
      };
    });
}
