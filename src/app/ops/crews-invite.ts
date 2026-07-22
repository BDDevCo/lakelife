"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { assertOps } from "./data";

export interface InviteResult {
  ok: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Ops invites a crew: creates an UNCLAIMED vendors row (user_id null,
 * invite_email set) and emails the crew a join link. The invite is claimed
 * when someone signs in with that exact email (claimCrewInvite below) —
 * so the email address is the credential, and only ops can mint one.
 */
export async function inviteCrew(input: {
  company: string;
  email: string;
  serviceTypes: string[];
}): Promise<InviteResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const company = (input.company ?? "").trim().slice(0, 120);
  const email = (input.email ?? "").trim().toLowerCase();
  if (!company) return { ok: false, error: "Give the crew a company name." };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "That email doesn't look right." };

  const admin = createServiceClient();

  // Whitelist service types against real, active services.
  const { data: svcs } = await admin.from("services").select("name").eq("active", true);
  const valid = new Set((svcs ?? []).map((s) => s.name as string));
  const serviceTypes = [...new Set((input.serviceTypes ?? []).filter((t) => valid.has(t)))];

  // One account per email, one open invite per email.
  const { data: existingUser } = await admin.from("users").select("id").ilike("email", email).maybeSingle();
  if (existingUser) {
    const { data: alreadyVendor } = await admin.from("vendors").select("id").eq("user_id", existingUser.id).maybeSingle();
    return {
      ok: false,
      error: alreadyVendor
        ? "That email is already a LakeLife crew."
        : "That email already has a homeowner account — use a different email for the crew.",
    };
  }
  const { data: openInvite } = await admin
    .from("vendors")
    .select("id")
    .ilike("invite_email", email)
    .is("user_id", null)
    .maybeSingle();
  if (openInvite) return { ok: false, error: "There's already an open invite for that email." };

  const { error: insErr } = await admin.from("vendors").insert({
    company,
    invite_email: email,
    service_types: serviceTypes,
    daily_capacity: 1, // routable default; the crew sets their real number at onboarding
    status: "invited",
  });
  if (insErr) return { ok: false, error: insErr.message };

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  void sendEmail({
    to: email,
    subject: `${company} — you're invited to LakeLife crews`,
    html: `<p>Hi ${company},</p>
<p>LakeLife routes lake-home jobs on Big Long, Pretty &amp; Big Turkey to trusted local crews — your day's stops arrive by text, in drive order, and payouts release the moment a job is photo-verified complete.</p>
<p><b>Getting started takes 3 steps:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email address (${email}).</li>
<li>Upload your insurance certificate (COI) and W-9.</li>
<li>Tell us what work you do — LakeLife reviews and jobs start routing.</li>
</ol>
<p>No insurance on file, no jobs — it's how we keep every dock covered. 🌊</p>`,
  });

  return { ok: true };
}

/**
 * Claim a pending crew invite for the SIGNED-IN user (called from the portal
 * router, not the browser directly). The match is strict: the auth email must
 * equal the invite email. On claim: vendors.user_id is set and users.role
 * flips to 'vendor' (guard_role_change allows the service role as of 0013).
 * Idempotent: no pending invite -> no-op.
 */
export async function claimCrewInvite(userId: string, userEmail: string | null | undefined): Promise<boolean> {
  if (!userId || !userEmail) return false;
  const email = userEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return false;

  const admin = createServiceClient();
  const { data: invite } = await admin
    .from("vendors")
    .select("id")
    .ilike("invite_email", email)
    .is("user_id", null)
    .maybeSingle();
  if (!invite) return false;

  // Attach the person to the crew row first; only claim a still-open row.
  const { data: claimed } = await admin
    .from("vendors")
    .update({ user_id: userId })
    .eq("id", invite.id)
    .is("user_id", null)
    .select("id");
  if (!claimed || claimed.length === 0) return false;

  // Then flip their role so /portal routes them to the crew side.
  const { error: roleErr } = await admin.from("users").update({ role: "vendor" }).eq("id", userId);
  if (roleErr) {
    // Roll the claim back rather than leave a half-vendor.
    await admin.from("vendors").update({ user_id: null }).eq("id", invite.id);
    console.error(`[claimCrewInvite] role flip failed for ${userId}:`, roleErr.message);
    return false;
  }
  return true;
}
