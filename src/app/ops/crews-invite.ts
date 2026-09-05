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
  // Lake list is DYNAMIC — an invite sent the day a new lake launches must
  // name it. Fixtures excluded by lakes.is_fixture (0124): this list goes out
  // in a real email to a real crew, so a scratch lake here is not a cosmetic
  // slip, it is a fake place named in correspondence.
  const lakeRes = await admin
    .from("lakes").select("name").eq("is_fixture", false).order("name");
  // Soft on purpose: the vendors row is already inserted above, so refusing here
  // would leave an invite nobody can claim (see the send comment below). The
  // fallback names no place that doesn't exist — but it logs, because "your
  // local lakes" going out in real correspondence is worth knowing about.
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
  // until the processor is live. So the sentence now describes what photo
  // verification DOES, and dates nothing.
  const sent = await sendEmail({
    to: email,
    subject: `${company} — you're invited to LakeLife crews`,
    html: `<p>Hi ${company},</p>
<p>LakeLife routes lake-home jobs on ${lakeList} to trusted local crews. Your day's stops come to you in drive order, by email and text, and photo-verifying a job is what releases its payout — you never chase an invoice.</p>
<p><b>Getting started takes 3 steps:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email address (${email}).</li>
<li>Upload your insurance certificate (COI) and W-9.</li>
<li>Tell us what work you do — LakeLife reviews and jobs start routing.</li>
</ol>
<p>No insurance on file, no jobs — it's how we keep every dock covered. 🌊</p>`,
  });

  // THE SEND USED TO BE `void`ed, WHICH STOPPED BEING SAFE AT 0126. The invite
  // IS the email — the crew row is unreachable until somebody signs in with
  // that address — so a refused send leaves an invite nobody can claim and an
  // ops screen saying "invited". Worse, the row now blocks a second attempt:
  // inviteCrew above refuses a duplicate open invite. Ops has to hear it here
  // or not at all.
  if (!sent.ok) {
    return {
      ok: true,
      warning: `Crew added, but the invite email didn't send (${sent.error ?? "unknown"}). Send them the link yourself: ${site}`,
    };
  }

  return { ok: true };
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
