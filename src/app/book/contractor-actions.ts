"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { sendEmail } from "@/lib/email";
import { html } from "@/lib/html-safe";
import { getActivePropertyId } from "@/app/profile/data";
import {
  CROSS_REFERENCE_UNAVAILABLE,
  alreadyCrewMessage,
  checkInviteEmail,
  findSimilarCrews,
  inviteCaseMessage,
  isOpenInviteCollision,
  type SimilarCrew,
} from "@/lib/invite-guard";

export interface InviteContractorResult {
  ok: boolean;
  error?: string;
  company?: string;
  /** Set when the crew was bound as preferred but the invitation email did not
   *  go. Same shape as ops' InviteResult — the caller must show it, because
   *  the duplicate-invite guard makes a second attempt impossible. */
  warning?: string;
  /** NOT AN ERROR, AND `error` IS DELIBERATELY UNSET. The name looks like a
   *  crew already here, so the door stops and ASKS — the screen draws the list
   *  and the owner either picks one or comes back with `inviteAnyway`. */
  needsConfirm?: boolean;
  similar?: SimilarCrew[];
  /** Nothing was invited — they were already here, and are now this property's
   *  crew. The screen says so instead of reporting a send. */
  alreadyHere?: boolean;
  /** The cross-reference could not be run, so the invite went without it. */
  crossReferenceUnavailable?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Bring your own crew" — a HOMEOWNER invites the contractor they already use.
 * We create an unclaimed crew invite (same rails as ops inviteCrew) AND bind it
 * as this property's preferred crew immediately, so:
 *   - the owner keeps their guy — and since 0178 that means a "Your crew" badge
 *     and first place in the sort on the offers screen, NOT a first right of
 *     refusal. Bringing a crew is not a lock: "the owner needing the service
 *     should still see all the options, if any, for the crews available and
 *     their pricing." On the MENU path preferred still takes first refusal.
 *   - dispatch's eligibility gate (active + valid COI) means the crew still can't
 *     be routed until they onboard + get approved — binding early is safe.
 * The contractor gets a warm, continuity-framed invite (they keep their customer).
 *
 * TCPA-safe by design: this is the customer inviting their OWN pro, one at a time,
 * from an authenticated session — not a cold blast.
 */
export async function inviteMyContractor(
  company: string,
  email: string,
  /** The owner saw the near-match list and said none of them is their crew.
   *  Only ever set by a second call from the screen that drew the list —
   *  the cross-reference asks once, it does not nag. */
  inviteAnyway = false,
): Promise<InviteContractorResult> {
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
  // getActivePropertyId reads the property list, which throws on a failed read
  // rather than reporting an empty portfolio.
  let activeId: string | null;
  try {
    activeId = await getActivePropertyId();
  } catch (e) {
    return { ok: false, error: readFailedMessage("your properties", e) };
  }
  if (!activeId) return { ok: false, error: "Add a property first, then invite your crew." };

  const admin = createServiceClient();
  const propRes = await admin
    .from("properties")
    .select("id, owner_id")
    .eq("id", activeId)
    .maybeSingle();
  if (propRes.error) return { ok: false, error: readFailedMessage("your property", propRes.error) };
  const prop = propRes.data;
  if (!prop || prop.owner_id !== user.id) return { ok: false, error: "That property isn't yours." };

  // ONE GUARD, THREE DOORS. This used to be thirty lines of its own, and ops
  // had its own copy, and the park's new door would have been a third — three
  // spellings of one rule that agree today and drift by Christmas.
  //
  // The copy it replaces was also WRONG in a way the database was quietly
  // covering: it matched an open invite with `.eq("invite_email", addr)`, case
  // SENSITIVELY, while the partial unique index that actually enforces it is on
  // `lower(invite_email)`. Invite Josh@x.com when josh@x.com is already pending
  // and this check found nothing, the insert hit a 23505, and `insErr.message`
  // went straight to the screen as "duplicate key value violates unique
  // constraint" — a raw Postgres string shown to a homeowner, with no hint that
  // the answer is "they've already been invited".
  //
  // `checkInviteEmail` matches case-insensitively and NEVER returns "free" on a
  // read it could not make, so a dropped connection refuses rather than waving
  // a second invitation through.
  const found = await checkInviteEmail(admin, addr);
  if (found.kind !== "free") {
    if (found.kind === "already_crew" && !found.isFixture) {
      // CASE 2 IS NOT A REFUSAL, IT IS A BETTER OUTCOME. They are already here,
      // so there is nothing to wait for — say so, and say what happens next.
      return { ok: false, error: alreadyCrewMessage(found, "homeowner") };
    }
    return { ok: false, error: inviteCaseMessage(found, "homeowner") };
  }

  // A DIFFERENT ADDRESS, PROBABLY THE SAME BUSINESS. Nothing links
  // josh@joshsdocks.com to jdocks@gmail.com and no constraint ever will. So this
  // ASKS rather than refuses — a fuzzy name match is a guess, and a guess must
  // never block a real invitation. `error` stays unset on purpose: the screen
  // draws the list and the owner either recognises one or comes back with
  // `inviteAnyway`.
  let crossReferenceUnavailable = false;
  if (!inviteAnyway) {
    const similar = await findSimilarCrews(admin, co);
    if (similar.ok && similar.crews.length > 0) {
      return { ok: false, needsConfirm: true, similar: similar.crews, company: co };
    }
    // "WE COULDN'T CHECK" IS NOT "NO DUPLICATES". A failed cross-reference must
    // not render as an all-clear — the invitation still goes (the exact-email
    // constraint holds regardless), and the screen is told the check did not run.
    if (!similar.ok) {
      crossReferenceUnavailable = true;
      console.warn(`[invite] ${CROSS_REFERENCE_UNAVAILABLE}`);
    }
  }

  // Create the unclaimed crew invite, then bind it as this property's preferred crew.
  const { data: created, error: insErr } = await admin
    .from("vendors")
    // NULL, NOT 1 — the same rule as inviteCrew (app/ops/crews-invite.ts). A
    // seeded 1 already satisfies activationGaps, so the wizard's step 5 renders
    // ticked with a "Saved ✓" pill for a number the crew never chose, they never
    // open it, and dispatch then caps them at one job a day forever.
    .insert({ company: co, invite_email: addr, service_types: [], daily_capacity: null, status: "invited", invited_by: user.id })
    .select("id")
    .single();
  if (insErr || !created) {
    // THE PRE-CHECK IS THE MESSAGE; THE CONSTRAINT IS THE TRUTH; THEY MUST SAY
    // THE SAME THING. `checkInviteEmail` above matches case-insensitively, so
    // this should now be unreachable — but "should be unreachable" is exactly
    // what was believed about the case-sensitive version, and what a homeowner
    // got instead was `duplicate key value violates unique constraint
    // "vendors_invite_email_open"` rendered as their error. If the index bites
    // anyway (a race: two invites to the same address in the same second), say
    // the sentence a person can act on rather than handing them the database.
    if (isOpenInviteCollision(insErr)) {
      return { ok: false, error: inviteCaseMessage({ kind: "open_invite", vendorId: null, company: co }, "homeowner") };
    }
    return { ok: false, error: insErr?.message ?? "Couldn't send the invite." };
  }

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
  const meRes = await admin.from("users").select("name").eq("id", user.id).maybeSingle();
  // Not fatal, deliberately: the invite row is already created and bound, so
  // failing the action here would report "nothing has been changed" when
  // plenty has. The fallback greeting asserts nothing false — it's just
  // impersonal. Log it and send.
  if (meRes.error) console.error("[read failed] your name for the invite email:", meRes.error);
  const ownerName = (meRes.data?.name as string) ?? "your customer";
  // AWAITED, FOR THE REASON crews-invite.ts SPELLS OUT — and this is the file
  // that still `void`ed it.
  //
  // The invitation IS the email: the vendors row above is unreachable until
  // somebody signs in with that exact address. A refused send therefore leaves
  // an invite nobody can claim — and the duplicate guard forty lines up then
  // refuses the retry with "There's already an open invite out to that email."
  // Meanwhile this returned `ok: true` and the card said "✓ Invite sent". A
  // homeowner whose crew never heard from us was told they had, and could
  // never send it again.
  //
  // The copy below carried the same two false promises as the ops invite: text
  // has delivered 0 of 81 since July (notify() sends both doors; email is the
  // one that lands), and no payout can move until the processor is live.
  const sent = await sendEmail({
    to: addr,
    subject: `${ownerName} wants to keep working with you — on LakeLife`,
    html: html`<p>Hi ${co},</p>
<p><b>${ownerName}</b> asked to keep you as their crew through LakeLife — you keep your customer, we just handle the scheduling, invoicing and payment behind the scenes.</p>
<p>Your day's stops come to you in drive order, by email and text, and photo-verifying a job is what releases its payout — you never chase an invoice. Released pay goes to the bank account you give us in step 5, so put one in before your first job. Joining is free.</p>
<p><b>6 steps:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email (${addr}).</li>
<li>Upload your insurance certificate (COI) and W-9.</li>
<li>Tell us what work you do, which lakes you cover, and how many jobs a day you can take. A lake you don't tick is one you never hear about — and the mobile-home and RV parks sit on those same lakes.</li>
<li>Set what you charge — your rate is yours to set, and we never offer you a job you haven't priced. A blank card counts as unpriced.</li>
<li>Add your bank details, so a payout has somewhere to land.</li>
<li>Tap <b>Go live</b>. Jobs for the work you've priced start reaching you from that moment.</li>
</ol>
<p>You'll be set as ${ownerName}'s preferred crew, so their jobs come to you first. 🌊</p>`,
  });

  // The row is already created and bound as this property's preferred crew, so
  // refusing here would report "nothing happened" when plenty has. Say what is
  // true instead: they're your crew, but we couldn't reach them — and hand over
  // the link, because the duplicate guard means this button won't work twice.
  if (!sent.ok) {
    return {
      ok: true,
      company: co,
      warning:
        `${co} is set as your crew, but we couldn't send their invite ` +
        `(${sent.error ?? "unknown"}). Send them this link yourself: ${site}`,
    };
  }

  return { ok: true, company: co, ...(crossReferenceUnavailable ? { crossReferenceUnavailable: true } : {}) };
}
