"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { getActivePropertyId } from "@/app/profile/data";

export interface InviteContractorResult {
  ok: boolean;
  error?: string;
  company?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Bring your own crew" — a HOMEOWNER invites the contractor they already use.
 * We create an unclaimed crew invite (same rails as ops inviteCrew) AND bind it
 * as this property's preferred crew immediately, so:
 *   - the owner keeps their guy (preferred = first right of refusal at dispatch),
 *   - dispatch's eligibility gate (active + valid COI) means the crew still can't
 *     be routed until they onboard + get approved — binding early is safe.
 * The contractor gets a warm, continuity-framed invite (they keep their customer).
 *
 * TCPA-safe by design: this is the customer inviting their OWN pro, one at a time,
 * from an authenticated session — not a cold blast.
 */
export async function inviteMyContractor(company: string, email: string): Promise<InviteContractorResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const co = (company ?? "").trim().slice(0, 120);
  const addr = (email ?? "").trim().toLowerCase();
  if (!co) return { ok: false, error: "What's your crew's name?" };
  if (!EMAIL_RE.test(addr)) return { ok: false, error: "That email doesn't look right." };

  // The invite binds to the owner's ACTIVE property — verify they own it.
  const activeId = await getActivePropertyId();
  if (!activeId) return { ok: false, error: "Add a property first, then invite your crew." };

  const admin = createServiceClient();
  const { data: prop } = await admin
    .from("properties")
    .select("id, owner_id")
    .eq("id", activeId)
    .maybeSingle();
  if (!prop || prop.owner_id !== user.id) return { ok: false, error: "That property isn't yours." };

  // One account per email; one open invite per email (same guard as ops invites).
  const { data: existingUser } = await admin.from("users").select("id").ilike("email", addr).maybeSingle();
  if (existingUser) {
    const { data: alreadyVendor } = await admin.from("vendors").select("id").eq("user_id", existingUser.id).maybeSingle();
    return {
      ok: false,
      error: alreadyVendor
        ? "Good news — they're already on LakeLife. Ask ops to set them as your crew."
        : "That email already has an account — your crew should use a different email to join as a crew.",
    };
  }
  const { data: openInvite } = await admin
    .from("vendors")
    .select("id")
    .ilike("invite_email", addr)
    .is("user_id", null)
    .maybeSingle();
  if (openInvite) return { ok: false, error: "There's already an open invite out to that email." };

  // Create the unclaimed crew invite, then bind it as this property's preferred crew.
  const { data: created, error: insErr } = await admin
    .from("vendors")
    .insert({ company: co, invite_email: addr, service_types: [], daily_capacity: 1, status: "invited", invited_by: user.id })
    .select("id")
    .single();
  if (insErr || !created) return { ok: false, error: insErr?.message ?? "Couldn't send the invite." };

  const { error: bindErr } = await admin
    .from("properties")
    .update({ preferred_vendor: created.id })
    .eq("id", activeId);
  if (bindErr) {
    // Roll back the orphan invite rather than leave a dangling row.
    await admin.from("vendors").delete().eq("id", created.id);
    return { ok: false, error: bindErr.message };
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data: me } = await admin.from("users").select("name").eq("id", user.id).maybeSingle();
  const ownerName = (me?.name as string) ?? "your customer";
  void sendEmail({
    to: addr,
    subject: `${ownerName} wants to keep working with you — on LakeLife`,
    html: `<p>Hi ${co},</p>
<p><b>${ownerName}</b> asked to keep you as their crew through LakeLife — you keep your customer, we just handle the scheduling, invoicing and payment behind the scenes.</p>
<p>Your day's stops arrive by text in drive order, and your payout releases the moment a job is photo-verified complete. Joining is free.</p>
<p><b>3 steps:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email (${addr}).</li>
<li>Upload your insurance certificate (COI) and W-9.</li>
<li>Set what you charge — your rate is yours to set.</li>
</ol>
<p>You'll be set as ${ownerName}'s preferred crew, so their jobs come to you first. 🌊</p>`,
  });

  return { ok: true, company: co };
}
