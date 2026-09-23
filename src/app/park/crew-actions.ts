"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { sendEmail } from "@/lib/email";
import { html } from "@/lib/html-safe";
import { likeLiteral } from "@/lib/sql-like";
import { assertMyPark } from "@/app/park/data";

/**
 * A PARK BRINGS A CREW — the door that did not exist.
 *
 * Brendon, 23 September 2026: "Just like a home owner that has their own crews
 * that they can add, I want that to happen to the park, we will add josh, but
 * then josh will be on the platform and he can have access to more
 * homeowners/clients who need pier installs. And that will go for any crew who
 * is added onto the platform."
 *
 * SAME RAILS AS `inviteMyContractor` (app/book/contractor-actions.ts): an
 * unclaimed `vendors` row, the same one-account-per-email and one-open-invite
 * guards, the same awaited send, one at a time from an authenticated session
 * (TCPA-safe by construction — this is a customer inviting their OWN pro, not
 * a cold blast).
 *
 * ONE DELIBERATE DIFFERENCE: IT BINDS NO EXCLUSIVITY. The homeowner version
 * sets the crew as that property's `preferred_vendor`; this one does not bind
 * anything, because a park's grounds is one property and pinning a crew to it
 * would be the soft lock the owner has just ruled out. Under 0178 preferred is
 * a badge and a sort on the offers screen and never a filter anyway — but a
 * park adding a second crew should not have to think about which of them the
 * column happens to hold.
 *
 * THE KNOWN BUG IN THE RAILS, NOT RE-BROKEN: an invitation is matched on the
 * email address ALONE, so a crew who signs up with a different address (Apple's
 * private relay, a personal account) lands in the homeowner wizard instead of
 * the crew one. The email below says to use THIS address, in the same words the
 * ops and homeowner invitations use.
 */

export interface ParkInviteCrewResult {
  ok: boolean;
  error?: string;
  company?: string;
  /** The invite row exists but the email did not go. The caller MUST show
   *  this: the duplicate guard makes a second attempt impossible. */
  warning?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function parkInviteCrew(
  parkId: string,
  company: string,
  email: string,
): Promise<ParkInviteCrewResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // NEVER TRUST A parkId FROM THE BROWSER — the guard every park action calls.
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: "You don't manage that park." };

  const co = (company ?? "").trim().slice(0, 120);
  const addr = (email ?? "").trim().toLowerCase();
  if (!co) return { ok: false, error: "What's the crew's name?" };
  if (!EMAIL_RE.test(addr)) return { ok: false, error: "That email doesn't look right." };

  const admin = createServiceClient();

  // ONE ACCOUNT PER EMAIL; ONE OPEN INVITE PER EMAIL — the same two guards as
  // the homeowner door, and they FAIL OPEN if left alone: a failed read reads
  // as "no such account / no open invite" and waves a second invitation
  // through, or collides with an account that already exists.
  const existingRes = await admin.from("users").select("id").ilike("email", likeLiteral(addr)).maybeSingle();
  if (existingRes.error) return { ok: false, error: readFailedMessage("whether that email is already with us", existingRes.error) };
  if (existingRes.data) {
    const vendorRes = await admin.from("vendors").select("id").eq("user_id", existingRes.data.id).maybeSingle();
    if (vendorRes.error) return { ok: false, error: readFailedMessage("that crew's account", vendorRes.error) };
    return {
      ok: false,
      error: vendorRes.data
        // AND THIS IS NOW TRUE OF EVERY CREW ON THE PLATFORM, which is the
        // whole point: a crew already here is already one of the options on
        // your park's Choose-your-crew screen. Nothing needs setting.
        ? "Good news — they're already on LakeLife, so they'll show up as one of your options when you book work for the park."
        : "That email already has an account — the crew should use a different email to join as a crew.",
    };
  }
  const openInviteRes = await admin
    .from("vendors")
    .select("id")
    .eq("invite_email", addr)
    .is("user_id", null)
    .maybeSingle();
  if (openInviteRes.error) return { ok: false, error: readFailedMessage("open invites for that email", openInviteRes.error) };
  if (openInviteRes.data) return { ok: false, error: "There's already an open invite out to that email." };

  // The unclaimed crew invite, and NOTHING ELSE IS BOUND. `daily_capacity` is
  // NULL, not 1, for the reason inviteCrew spells out: a seeded 1 already
  // satisfies the activation check, so the wizard's capacity step renders
  // ticked for a number the crew never chose and dispatch caps them at one job
  // a day forever.
  const { data: created, error: insErr } = await admin
    .from("vendors")
    .insert({ company: co, invite_email: addr, service_types: [], daily_capacity: null, status: "invited", invited_by: user.id })
    .select("id")
    .single();
  if (insErr || !created) return { ok: false, error: insErr?.message ?? "Couldn't send the invite." };

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const parkRes = await admin.from("parks").select("name").eq("id", parkId).maybeSingle();
  // Not fatal: the invite row exists, so failing here would report "nothing
  // changed" when plenty has. The fallback names nobody and asserts nothing.
  if (parkRes.error) console.error("[read failed] the park's name for the invite email:", parkRes.error);
  const parkName = (parkRes.data?.name as string) ?? "the park";

  // AWAITED, for the reason the other two doors spell out: the vendors row
  // above is unreachable until somebody signs in with that exact address, so a
  // refused send leaves an invite nobody can claim — and the duplicate guard
  // then refuses the retry.
  //
  // THE PITCH IS HIS, IN HIS TERMS: they keep the customer who brought them AND
  // get access to more. No promise of texts (0 of 81 delivered since July) and
  // no promise of payouts (the processor is not live).
  const sent = await sendEmail({
    to: addr,
    subject: `${parkName} wants to keep working with you — on LakeLife`,
    html: html`<p>Hi ${co},</p>
<p><b>${parkName}</b> asked to keep you as their crew through LakeLife — you keep their business, we just handle the scheduling, invoicing and payment behind the scenes.</p>
<p><b>And you don't only get the park.</b> Once you're on LakeLife you're one of the options for every homeowner on Big Long, Pretty and Big Turkey who needs the work you do — they see the crews who can do their job, what each one charges, and they pick. You set your own prices; we add our percentage on top for the customer and take our percentage out of your side, and both numbers are on your rates page before you agree to anything.</p>
<p>Your day's stops come to you in drive order by email, and photo-verifying a job is what releases its payout — you never chase an invoice. Joining is free.</p>
<p><b>6 steps:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email (${addr}). A different address lands you in the homeowner sign-up instead of the crew one.</li>
<li>Upload your insurance certificate (COI) and W-9.</li>
<li>Tell us what work you do, which lakes you cover, and how many jobs a day you can take. A lake you don't tick is one you never hear about — and the mobile-home and RV parks sit on those same lakes.</li>
<li>Set what you charge — your rate is yours to set, and we never offer you a job you haven't priced. A blank card counts as unpriced.</li>
<li>Add your bank details, so a payout has somewhere to land.</li>
<li>Tap <b>Go live</b>. Jobs for the work you've priced start reaching you from that moment.</li>
</ol>
<p>See you on the water. 🌊</p>`,
  });

  if (!sent.ok) {
    return {
      ok: true,
      company: co,
      warning:
        `${co} is invited, but we couldn't send their email ` +
        `(${sent.error ?? "unknown"}). Send them this link yourself: ${site} — and tell them to sign up with ${addr}, because a different address lands them in the homeowner sign-up.`,
    };
  }

  return { ok: true, company: co };
}
