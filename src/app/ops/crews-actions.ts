"use server";

import { checkNamedInsured } from "@/lib/named-insured";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { assertOps } from "./data";
import { readFailedMessage } from "@/lib/must-read";

export interface CrewResult {
  ok: boolean;
  error?: string;
}

/** Clamp to a whole-number daily capacity in the allowed 1–20 range. */
function validCapacity(n: unknown): number | null {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 20) return null;
  return v;
}

/**
 * Re-check the "no COI, no jobs" gate server-side before a crew can go active.
 * A crew is routable only with a COI document, a W-9 document, and a COI expiry
 * that is still in the future. Returns an error string, or null if clear.
 */
async function assertRoutable(admin: ReturnType<typeof createServiceClient>, vendorId: string): Promise<string | null> {
  const res = await admin
    .from("vendors")
    .select("id, coi_url, w9_url, coi_expiry, coi_named_insured, company")
    .eq("id", vendorId)
    .maybeSingle();
  // THIS IS THE GATE THAT DECIDES WHETHER A CREW MAY BE ROUTED, and every
  // sentence it returns is a claim about their paperwork. A failed read takes
  // the `!v` branch and tells ops the crew doesn't exist — about a crew whose
  // COI and W-9 are both on file. Say what actually happened instead.
  if (res.error) return readFailedMessage("that crew's insurance and W-9", res.error);
  const v = res.data;
  if (!v) return "That crew doesn't exist.";
  if (!v.coi_url) return "No insurance certificate (COI) on file — the crew must upload one before they can be routed.";
  if (!v.w9_url) return "No W-9 on file — the crew must upload one before they can be routed.";
  if (v.coi_expiry == null || String(v.coi_expiry) < todayLakeDate()) {
    return "The COI on file is missing an expiry or already expired — get a current certificate first.";
  }
  // AND IT HAS TO BE THEIRS (0152). Grandfathered the same way as dispatch: a
  // null name is a crew who predates the field, not one who failed the check.
  if (v.coi_named_insured != null) {
    const named = checkNamedInsured(v.coi_named_insured as string, v.company as string | null);
    if (!named.ok) return named.message;
  }
  return null;
}

/**
 * Approve an onboarding (or re-approve a suspended) crew: verifies documents +
 * an unexpired COI, then flips status to 'active' and sets the daily capacity.
 * This is the gate — the router only touches active crews with a valid COI.
 */
export async function approveCrew(vendorId: string, dailyCapacity: number): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const cap = validCapacity(dailyCapacity);
  if (cap == null) return { ok: false, error: "Daily capacity must be a whole number from 1 to 20." };

  const admin = createServiceClient();
  const gate = await assertRoutable(admin, vendorId);
  if (gate) return { ok: false, error: gate };

  const { error } = await admin
    .from("vendors")
    .update({ status: "active", daily_capacity: cap })
    .eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Take a crew off the board — no new routing until reactivated. */
/**
 * CONFIRM THAT SOMEBODY OPENED THE CERTIFICATE (0152).
 *
 * The expiry on a crew's row is a date THEY typed. This records that a named
 * person at LakeLife opened the file and agreed it. It is the whole of the
 * "we look at the certs" half of the owner's posture — and deliberately not
 * one inch more: it says a human read a date, not that the cover is adequate,
 * not that the policy is real, not that the limit is enough. Those are not
 * our job and nothing here should ever imply they are.
 *
 * Confirming something that is not there would be a claim about a document
 * nobody has, so a crew with no certificate on file is refused.
 */
export async function confirmCoiExpiry(vendorId: string): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const admin = createServiceClient();
  const res = await admin.from("vendors").select("coi_url, coi_expiry").eq("id", vendorId).maybeSingle();
  // A failed read here would otherwise confirm a certificate we could not see.
  if (res.error) return { ok: false, error: readFailedMessage("that crew's certificate", res.error) };
  if (!res.data) return { ok: false, error: "That crew doesn't exist." };
  if (!res.data.coi_url) return { ok: false, error: "There's no certificate on file to confirm." };
  if (!res.data.coi_expiry) return { ok: false, error: "That certificate has no expiry date on it yet." };

  const { error } = await admin
    .from("vendors")
    .update({ coi_expiry_confirmed_at: new Date().toISOString(), coi_expiry_confirmed_by: ops.id })
    .eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function suspendCrew(vendorId: string): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ status: "suspended" }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Bring a suspended crew back. Re-runs the full document + COI gate because the
 * COI may have lapsed while they were off the board (spec: no COI, no jobs).
 */
export async function reactivateCrew(vendorId: string): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const admin = createServiceClient();
  const gate = await assertRoutable(admin, vendorId);
  if (gate) return { ok: false, error: gate };

  const { error } = await admin.from("vendors").update({ status: "active" }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Adjust a crew's daily job capacity (1–20). */
export async function setCrewCapacity(vendorId: string, n: number): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const cap = validCapacity(n);
  if (cap == null) return { ok: false, error: "Daily capacity must be a whole number from 1 to 20." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ daily_capacity: cap }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * CORRECT A CREW'S BUSINESS NAME — the edit three sentences already promise.
 *
 * `vendors.company` was written in exactly two places, both INSERTs, both
 * invite paths, and appeared in no UPDATE anywhere. Meanwhile 0152's insurance
 * rule compares that name to the one printed on the certificate, and a
 * mismatch blocks activation, auto-dispatch and the claim board at once. The
 * remedy named by named-insured.ts ("a thirty-second conversation and an edit
 * to vendors.company"), by the crew's own message ("send us a message and
 * we'll get it straightened out") and by the ops board ("check which is wrong
 * before approving") had no control behind it in any of the three places.
 *
 * It bites hardest on the path about to get the most use: ops types the name
 * they know a crew by — "Bob's Mowing" — while Bob's policy is issued to
 * "Robert Klein Landscaping LLC". `inviteMyContractor` makes it likelier
 * still, because a homeowner types whatever they call their guy.
 *
 * OPS-ONLY, DELIBERATELY. A crew who could rename their own business would
 * make the insurance gate self-certifying — retype the account to whatever the
 * certificate says and every certificate matches. named-insured.ts refuses
 * fuzzy matching for precisely that reason; a self-serve field here would hand
 * back the failure it was avoiding.
 *
 * It does NOT re-run assertRoutable. This is the fix FOR a failing gate, so
 * gating it on the gate is the loop that made the suspended-crew COI upload
 * unreachable. It changes one text column and nothing about status.
 */
export async function setCrewCompany(vendorId: string, name: string): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  // Same bound as both invite paths, so a name that can be typed in one place
  // can be corrected in the other.
  const company = (name ?? "").trim().slice(0, 120);
  if (!company) return { ok: false, error: "Give the crew a business name." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ company }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
