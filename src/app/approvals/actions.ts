"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";
import { priceService, type ServiceRule } from "@/lib/pricing";

export interface ApprovalResult {
  ok: boolean;
  error?: string;
}

/** Confirm this flag belongs to a property the signed-in owner owns. */
async function assertOwnerFlag(flagId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("flags")
    .select("id, status, job_id, jobs(property_id, properties(owner_id))")
    .eq("id", flagId)
    .maybeSingle();
  if (!data) return null;
  const job = Array.isArray(data.jobs) ? data.jobs[0] : data.jobs;
  const prop = job && (Array.isArray(job.properties) ? job.properties[0] : job.properties);
  if ((prop as { owner_id?: string } | null)?.owner_id !== user.id) return null;
  return { flag: data, propertyId: (job as { property_id?: string } | null)?.property_id ?? null };
}

/**
 * Owner approves a vendor flag (rule 6): the profile change and the flag
 * approval happen atomically in the DB (apply_flag_change), THEN every open
 * job on that property is re-priced from the new profile — so approval and
 * repricing move together, and nothing bills until the owner says yes.
 */
export async function approveFlag(flagId: string): Promise<ApprovalResult> {
  const ctx = await assertOwnerFlag(flagId);
  if (!ctx) return { ok: false, error: "That approval isn't yours." };
  // Pending -> apply the change. Already-approved -> allow a re-price retry
  // (if the profile change landed but repricing failed the first time).
  if (ctx.flag.status === "declined") return { ok: false, error: "Already declined." };

  const admin = createServiceClient();
  if (ctx.flag.status === "pending") {
    // Atomic: apply the proposed profile change + mark the flag approved.
    const { error: rpcErr } = await admin.rpc("apply_flag_change", { p_flag_id: flagId });
    if (rpcErr) return { ok: false, error: rpcErr.message };
  }

  // Re-price the owner's open jobs on this property from the updated profile.
  // vendor_cost/margin are preserved; margin is re-derived when a cost exists.
  if (ctx.propertyId) {
    const profile = await getFullProfile(ctx.propertyId);
    if (profile?.hasProfile) {
      const { data: services } = await admin
        .from("services")
        .select("id, name, pricing_model, base, unit_rate, band_pricing");
      const byId = new Map((services ?? []).map((s) => [s.id, s as unknown as ServiceRule]));
      const pp = toPricingProfile(profile);
      const { data: openJobs } = await admin
        .from("jobs")
        .select("id, service_id, vendor_cost")
        .eq("property_id", ctx.propertyId)
        .is("group_id", null) // package jobs price as a SUM of legs — repricing by the anchor alone would collapse the bundle (component-aware reprice = S3)
        .in("status", ["requested", "scheduled"]);
      for (const j of openJobs ?? []) {
        const rule = j.service_id ? byId.get(j.service_id) : undefined;
        if (!rule) continue;
        const price = priceService(rule, pp);
        const update: { customer_price: number; margin?: number } = { customer_price: price };
        if (j.vendor_cost != null) update.margin = price - Number(j.vendor_cost);
        await admin.from("jobs").update(update).eq("id", j.id);
      }
    }
  }
  return { ok: true };
}

/** Owner declines a flag — nothing changes, nothing reprices. */
export async function declineFlag(flagId: string): Promise<ApprovalResult> {
  const ctx = await assertOwnerFlag(flagId);
  if (!ctx) return { ok: false, error: "That approval isn't yours." };
  if (ctx.flag.status !== "pending") return { ok: false, error: "Already decided." };
  const admin = createServiceClient();
  const { error } = await admin.from("flags").update({ status: "declined" }).eq("id", flagId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
