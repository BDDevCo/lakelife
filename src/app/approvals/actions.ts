"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { serviceMinutes, type DurationBands } from "@/lib/duration";

export interface ApprovalResult {
  ok: boolean;
  error?: string;
  /** How many still-open jobs on this property were repriced. */
  repriced?: number;
  /**
   * The visit the crew was standing on when they raised this is already
   * finished and billed. Repricing only touches `requested`/`scheduled`, so
   * that one visit keeps its old numbers on BOTH sides — the owner pays the
   * old price and the crew keeps the old cost. That may well be the right
   * product answer (you don't re-bill someone for a job that's done), but it
   * must be SAID rather than silently done, because it is the most common
   * shape: the crew flags on site, finishes the work, and the owner approves
   * that evening.
   */
  flaggedJobAlreadyDone?: boolean;
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
  let repriced = 0;
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
        .select("id, name, pricing_model, base, unit_rate, band_pricing, est_minutes, duration_bands");
      // Typed to INCLUDE the duration fields, not merely to carry them at
      // runtime — a plain ServiceRule cast would still compile if the select
      // above dropped them, and serviceMinutes would quietly return the flat
      // figure forever. That is the failure mode this codebase keeps hitting.
      type TimedRule = ServiceRule & {
        est_minutes?: number | null;
        duration_bands?: DurationBands | null;
      };
      const byId = new Map((services ?? []).map((s) => [s.id, s as unknown as TimedRule]));
      const pp = toPricingProfile(profile);
      const { data: openJobs } = await admin
        .from("jobs")
        .select("id, service_id, vendor_id, vendor_cost")
        .eq("property_id", ctx.propertyId)
        .is("group_id", null) // package jobs price as a SUM of legs — repricing by the anchor alone would collapse the bundle (component-aware reprice = S3)
        .in("status", ["requested", "scheduled"]);

      // THE CREW'S SIDE HAS TO MOVE TOO.
      //
      // This used to reprice the CUSTOMER off the corrected profile and keep
      // the crew on the old `vendor_cost` — so a flag reading "twelve pier
      // sections, not eight" billed the owner for twelve and paid the crew for
      // eight, with our margin silently absorbing the whole difference. The
      // crew who told us the truth was the only party who lost by it.
      //
      // Re-derived from THAT crew's own rate card, the same way dispatch
      // derives it. No rate on file means we leave their cost alone rather
      // than invent one — an unset rate is not a rate of zero.
      const vendorIds = [...new Set((openJobs ?? []).map((j) => j.vendor_id).filter(Boolean))] as string[];
      const rateByVendorService = new Map<string, { base: unknown; unit_rate: unknown; band_pricing: unknown }>();
      if (vendorIds.length > 0) {
        const { data: rateRows } = await admin
          .from("vendor_rates")
          .select("vendor_id, service_id, base, unit_rate, band_pricing")
          .in("vendor_id", vendorIds);
        for (const r of rateRows ?? []) {
          rateByVendorService.set(`${r.vendor_id}:${r.service_id}`, r);
        }
      }

      for (const j of openJobs ?? []) {
        const rule = j.service_id ? byId.get(j.service_id) : undefined;
        if (!rule) continue;
        const price = priceService(rule, pp);

        // THE DAY HAS TO MOVE TOO.
        //
        // Approving "twelve pier sections, not eight" used to change the money
        // and nothing else. Since 0083 the job also carries the minutes it was
        // budgeted, and twelve sections is 255 minutes where eight was 180 —
        // so leaving the old figure would bill the owner for the bigger job
        // and still hand the crew a day sized for the smaller one. The
        // afternoon is where that difference gets paid.
        const minutes = serviceMinutes(rule, pp);

        const update: {
          customer_price: number; est_minutes: number; vendor_cost?: number; margin?: number;
        } = { customer_price: price, est_minutes: minutes };

        const vr = j.vendor_id && j.service_id
          ? rateByVendorService.get(`${j.vendor_id}:${j.service_id}`)
          : undefined;
        if (vr) {
          const cost = priceService({
            name: rule.name,
            pricing_model: rule.pricing_model,
            base: Number(vr.base ?? 0),
            unit_rate: Number(vr.unit_rate ?? 0),
            band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
          }, pp);
          update.vendor_cost = cost;
          update.margin = price - cost;
        } else if (j.vendor_cost != null) {
          // No rate card to re-derive from — keep what was agreed and let the
          // margin follow the new price rather than inventing a crew number.
          update.margin = price - Number(j.vendor_cost);
        }
        await admin.from("jobs").update(update).eq("id", j.id);
        repriced += 1;
      }
    }
  }

  // RELEASE THE CREW.
  //
  // 0084 holds an at-arrival job so it cannot be completed while the owner is
  // deciding. Now they have decided, so the hold comes off — and it comes off
  // whether they said yes or no, because a hold nobody can clear is a job that
  // can never be finished and a crew that can never be paid.
  if (ctx.flag.job_id) {
    await admin
      .from("jobs")
      .update({ held_at: null, held_flag_id: null })
      .eq("id", ctx.flag.job_id as string);
  }

  // Was the job they flagged already finished? Reported, not acted on.
  let flaggedJobAlreadyDone = false;
  if (ctx.flag.job_id) {
    const { data: flagged } = await admin
      .from("jobs").select("status").eq("id", ctx.flag.job_id as string).maybeSingle();
    const st = flagged?.status as string | undefined;
    flaggedJobAlreadyDone = st === "complete" || st === "paid";
  }

  return { ok: true, repriced, flaggedJobAlreadyDone };
}

/** Owner declines a flag — nothing changes, nothing reprices. */
export async function declineFlag(flagId: string): Promise<ApprovalResult> {
  const ctx = await assertOwnerFlag(flagId);
  if (!ctx) return { ok: false, error: "That approval isn't yours." };
  if (ctx.flag.status !== "pending") return { ok: false, error: "Already decided." };
  const admin = createServiceClient();
  const { error } = await admin.from("flags").update({ status: "declined" }).eq("id", flagId);
  if (error) return { ok: false, error: error.message };

  // DECLINING IS AN ANSWER, AND IT UNBLOCKS THE CREW.
  //
  // The hold exists so nothing is done-and-billed before the owner decides.
  // "No" is deciding. The crew now does exactly the scope that was booked —
  // the eight sections on file — and gets paid for it. Leaving the hold on
  // would strand a crew in a driveway for a decision that has already been
  // made against them.
  if (ctx.flag.job_id) {
    await admin
      .from("jobs")
      .update({ held_at: null, held_flag_id: null })
      .eq("id", ctx.flag.job_id as string);
  }

  return { ok: true };
}
