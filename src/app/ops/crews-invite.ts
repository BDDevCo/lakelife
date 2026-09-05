"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { likeLiteral } from "@/lib/sql-like";
import { assertOps } from "./data";
import { readFailedMessage } from "@/lib/must-read";

export interface InviteResult {
  ok: boolean;
  error?: string;
  /** Set when the crew row was created but the invitation email did not go. */
  warning?: string;
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

  // Whitelist service types against real, active services. A failed read
  // whitelists NOTHING, so the crew is created with an empty service_types and
  // the dispatch engine — which matches on exact service-name membership — will
  // never offer them a job. Silent, permanent, and indistinguishable on the
  // Crews tab from a crew who was invited for nothing.
  const svcRes = await admin.from("services").select("name").eq("active", true);
  if (svcRes.error) return { ok: false, error: readFailedMessage("the list of services", svcRes.error) };
  const valid = new Set((svcRes.data ?? []).map((s) => s.name as string));
  const serviceTypes = [...new Set((input.serviceTypes ?? []).filter((t) => valid.has(t)))];

  // One account per email, one open invite per email.
  // users.email is synced from Supabase auth (0003), so this repo cannot
  // promise its case — it stays case-insensitive and escapes the wildcards.
  //
  // BOTH OF THESE READS ARE GUARDS, AND A FAILED READ WAVES THEM THROUGH. `data:
  // null` is what "no such account" and "no open invite" look like, so a dropped
  // connection produced a SECOND vendors row on an address that already has one
  // — and the duplicate is what the next invite attempt then trips over.
  const existingRes = await admin.from("users").select("id").ilike("email", likeLiteral(email)).maybeSingle();
  if (existingRes.error) {
    return { ok: false, error: readFailedMessage("whether that email already has an account", existingRes.error) };
  }
  const existingUser = existingRes.data;
  if (existingUser) {
    const vendorRes = await admin.from("vendors").select("id").eq("user_id", existingUser.id).maybeSingle();
    // Which of the two sentences below is true is decided entirely by this read.
    if (vendorRes.error) {
      return { ok: false, error: readFailedMessage("what that account already is", vendorRes.error) };
    }
    const alreadyVendor = vendorRes.data;
    return {
      ok: false,
      error: alreadyVendor
        ? "That email is already a LakeLife crew."
        : "That email already has a homeowner account — use a different email for the crew.",
    };
  }
  const openRes = await admin
    .from("vendors")
    .select("id")
    .eq("invite_email", email)
    .is("user_id", null)
    .maybeSingle();
  if (openRes.error) {
    return { ok: false, error: readFailedMessage("open invites for that email", openRes.error) };
  }
  if (openRes.data) return { ok: false, error: "There's already an open invite for that email." };

  const { error: insErr } = await admin.from("vendors").insert({
    company,
    invite_email: email,
    service_types: serviceTypes,
    daily_capacity: 1, // routable default; the crew sets their real number at onboarding
    status: "invited",
  });
  if (insErr) return { ok: false, error: insErr.message };

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const sent = await sendInvitation(admin, { company, email, site });

  // THE SEND USED TO BE `void`ed, WHICH STOPPED BEING SAFE AT 0126. The invite
  // IS the email — the crew row is unreachable until somebody signs in with
  // that address — so a refused send leaves an invite nobody can claim and an
  // ops screen saying "invited". Worse, the row now blocks a second attempt:
  // inviteCrew above refuses a duplicate open invite. Ops has to hear it here
  // or not at all.
  //
  // AND NOW IT IS WRITTEN DOWN (0154). The toast above was the only place this
  // was ever said, and Toast.tsx clears it after 3800ms — after which a bounced
  // invite and an ignored one looked identical on the board forever.
  await stampInvite(admin, email, sent);
  if (!sent.ok) {
    return {
      ok: true,
      warning: `Crew added, but the invite email didn't send (${sent.error ?? "unknown"}). Send them the link yourself: ${site} — or press Resend on their card.`,
    };
  }

  return { ok: true };
}

/**
 * THE INVITATION ITSELF — built once, so the first send and every resend say
 * the same thing. Two copies would be two sets of promises to keep true, and
 * the copy corrections below would have to be made twice.
 */
async function sendInvitation(
  admin: ReturnType<typeof createServiceClient>,
  { company, email, site }: { company: string; email: string; site: string },
): Promise<{ ok: boolean; error?: string }> {
  // Lake list is DYNAMIC — an invite sent the day a new lake launches must
  // name it. Fixtures excluded by lakes.is_fixture (0124): this list goes out
  // in a real email to a real crew, so a scratch lake here is not a cosmetic
  // slip, it is a fake place named in correspondence.
  const lakeRes = await admin
    .from("lakes").select("name").eq("is_fixture", false).order("name");
  // Soft on purpose: the vendors row is already inserted by the caller, so
  // refusing here would leave an invite nobody can claim. The fallback names no
  // place that doesn't exist — but it logs, because "your local lakes" going
  // out in real correspondence is worth knowing about.
  if (lakeRes.error) console.error("[read failed, degraded] the lakes named in the invite email:", lakeRes.error);
  const shortNames = (lakeRes.data ?? []).map((l) => (l.name as string).replace(/ Lake$/, ""));
  const lakeList = shortNames.length > 1
    ? `${shortNames.slice(0, -1).join(", ")} &amp; ${shortNames[shortNames.length - 1]}`
    : shortNames[0] ?? "your local lakes";

  // BOTH DOORS, AND NO CLOCK ON THE MONEY.
  //
  // This paragraph used to say "your day's stops arrive by text, in drive
  // order, and payouts release the moment a job is photo-verified complete."
  // Text has delivered 0 of 81 since 19 July — the A2P registration was
  // rejected twice and the EIN is too new — while `notify()` sends by both
  // doors at once, so the route link a crew actually receives comes by EMAIL.
  // Naming only the dead channel tells a stranger to watch their phone for the
  // one thing that decides whether they make money that day.
  //
  // And "the moment" was a promise about timing. Photo verification really
  // does release the payout — that is the crew's protection and it is worth
  // saying — but the money moves in a batch, and no money can move at all
  // until the processor is live. So the sentence describes what photo
  // verification DOES, and dates nothing.
  //
  // THE THIRD STEP USED TO SAY "LakeLife reviews and jobs start routing."
  // There is no review. finishOnboarding's own header calls this "ZERO-OPS
  // SELF-ACTIVATION (Phase A) — the crew flips THEMSELVES from 'invited' to
  // 'active' ... no ops approval", and the Crews board says the same back to
  // ops: "they go live THEMSELVES — zero touch from you." So the sentence
  // invented a queue and sat the crew in it, waiting for something nobody was
  // going to do. It also named three steps while five gate go-live — the lakes
  // and the daily number were never mentioned at all, and neither was the
  // button. A crew who does every step in this list is still not live.
  return sendEmail({
    to: email,
    subject: `${company} — you're invited to LakeLife crews`,
    html: `<p>Hi ${company},</p>
<p>LakeLife routes lake-home jobs on ${lakeList} to trusted local crews. Your day's stops come to you in drive order, by email and text, and photo-verifying a job is what releases its payout — you never chase an invoice.</p>
<p><b>You set yourself up — there's no queue and nobody to wait for:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email address (${email}).</li>
<li>Upload your insurance certificate (COI) and W-9.</li>
<li>Tell us what work you do, which lakes you cover, and how many jobs a day you can take.</li>
<li>Set what you charge for each kind of work — we never offer you a job you haven't priced.</li>
<li>Tap <b>Go live</b>. Jobs start reaching you from that moment.</li>
</ol>
<p>No insurance on file, no jobs — it's how we keep every dock covered. 🌊</p>`,
  });
}

/**
 * Write down what happened to the invitation (0154). NULL invite_sent_at means
 * it has never left our hands, which is what lets the board tell a bounced
 * invite from one somebody simply hasn't opened.
 *
 * DELIBERATELY NOT FATAL. The email has already gone (or already failed) by the
 * time this runs, and failing the action over the bookkeeping would report
 * "invite not sent" about one sitting in the crew's inbox. It logs instead.
 */
async function stampInvite(
  admin: ReturnType<typeof createServiceClient>,
  email: string,
  sent: { ok: boolean; error?: string },
): Promise<void> {
  const patch = sent.ok
    ? { invite_sent_at: new Date().toISOString(), invite_error: null }
    : { invite_error: (sent.error ?? "unknown").slice(0, 500) };
  const { error } = await admin
    .from("vendors").update(patch).eq("invite_email", email).is("user_id", null);
  if (error) console.error("[write failed] recording the invite send for", email, error);
}

export interface ResendResult {
  ok: boolean;
  error?: string;
  /** The address it went to, for the confirmation. */
  email?: string;
}

/**
 * SEND THE INVITATION AGAIN — the recovery that did not exist.
 *
 * `inviteCrew` refuses a duplicate open invite, which is right and is exactly
 * what made a failed send a dead end: the only way through was a database edit.
 * This is the same email to the same still-open row, so the duplicate guard
 * stays untouched.
 *
 * ONLY A STILL-OPEN INVITE. `.is("user_id", null)` on the lookup: a crew who
 * has signed up does not need an invitation, and re-sending one to somebody
 * already working reads as us having lost track of them.
 */
export async function resendCrewInvite(vendorId: string): Promise<ResendResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const admin = createServiceClient();
  const res = await admin
    .from("vendors")
    .select("id, company, invite_email")
    .eq("id", vendorId)
    .is("user_id", null)
    .maybeSingle();
  // "They've already signed up" is a claim about the crew's account, and a
  // dropped read has no standing to make it — ops would stop chasing somebody
  // who never heard from us.
  if (res.error) return { ok: false, error: readFailedMessage("that crew's invite", res.error) };
  const v = res.data;
  if (!v) return { ok: false, error: "That crew has already signed up — nothing to resend." };
  const email = (v.invite_email as string | null) ?? "";
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "There's no valid email on that invite — add the crew again with the right address." };
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const sent = await sendInvitation(admin, { company: (v.company as string) ?? "there", email, site });
  await stampInvite(admin, email, sent);
  if (!sent.ok) {
    return { ok: false, error: `Still couldn't send it (${sent.error ?? "unknown"}). Send them this link yourself: ${site}` };
  }
  return { ok: true, email };
}

/**
 * Claim a pending crew invite for the SIGNED-IN user (called from the portal
 * router, not the browser directly). The match is strict: the auth email must
 * equal the invite email. On claim: vendors.user_id is set and users.role
 * flips to 'vendor' (guard_role_change allows the service role as of 0013).
 * Idempotent: no pending invite -> no-op.
 *
 * THE EMAIL IS THE CREDENTIAL, SO IT HAS TO COME FROM THE SESSION.
 *
 * "Called from the portal router, not the browser directly" was a description
 * of the intended caller, not a property of the code. This file carries
 * "use server", so this export is a POST endpoint like any other, and both
 * arguments arrived from whoever called it. `inviteCrew` above says plainly
 * that the invited address IS the credential — and this took that credential
 * as a parameter. Anyone signed in could pass an invited crew's email with
 * their OWN user id, attach themselves to that vendors row, and be flipped to
 * role='vendor': the crew's route, their jobs, their payout account.
 *
 * So the session decides who is claiming and which address they hold. The
 * arguments must AGREE with it or the claim is refused — the portal passes
 * exactly these two values from its own getUser(), so nothing legitimate
 * changes, and there is no longer a caller-supplied path to somebody else's
 * invite.
 */
export async function claimCrewInvite(userId: string, userEmail: string | null | undefined): Promise<boolean> {
  if (!userId || !userEmail) return false;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.id !== userId) return false;

  const email = (user.email ?? "").trim().toLowerCase();
  if (!email || email !== userEmail.trim().toLowerCase()) return false;
  if (!EMAIL_RE.test(email)) return false;

  const admin = createServiceClient();
  // `.eq`, NOT `.ilike`. THIS IS THE LINE THE TAKEOVER RAN THROUGH.
  //
  // `.ilike` sends the address to Postgres as a PATTERN, and `_` matches any
  // single character. Invite `crew.mow@outlook.com`, and a stranger who
  // registers the real address `crew_mow@outlook.com` matches it, claims the
  // vendors row, and is flipped to role='vendor' — the crew's route, jobs and
  // payout account. Deriving the email from the session (the fix above) proves
  // who they are; it does not stop them being a wildcard.
  //
  // No escaping needed here: `invite_email` is ours and written lower-cased
  // (inviteCrew above, inviteMyContractor in book/contractor-actions.ts), and
  // `email` is lower-cased on the line above, so exact match is correct AND
  // strictly safer than any pattern.
  const inviteRes = await admin
    .from("vendors")
    .select("id")
    .eq("invite_email", email)
    .is("user_id", null)
    .maybeSingle();
  // NOT CONVERTED TO A THROW, deliberately: the only caller is /portal, which
  // uses the boolean to decide where to send somebody, and this returns false on
  // every ordinary homeowner sign-in. It stays false on a failed read — the
  // claim is idempotent, so their next portal load tries again — but it says so
  // in the log, because a crew silently landing in the homeowner portal on the
  // day they join has otherwise no explanation anywhere.
  if (inviteRes.error) console.error("[read failed] a pending crew invite for", email, inviteRes.error);
  const invite = inviteRes.data;
  if (!invite) return false;

  // Attach the person to the crew row first; only claim a still-open row.
  const claimRes = await admin
    .from("vendors")
    .update({ user_id: userId })
    .eq("id", invite.id)
    .is("user_id", null)
    .select("id");
  // Same posture as the read above: an empty result means somebody else claimed
  // it first, a failed one means we don't know. Both are safe to retry, neither
  // may be silent.
  if (claimRes.error) console.error("[write failed] claiming the crew invite for", email, claimRes.error);
  const claimed = claimRes.data;
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
