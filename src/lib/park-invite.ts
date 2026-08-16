import { randomBytes, createHash } from "node:crypto";

/**
 * THE INVITE, AND WHAT IT IS ALLOWED TO SAY.
 *
 * One message, to the address the park already had, telling a household how to
 * see their own lot. Not a code. Not a bill. Not the start of a mailing list.
 *
 * Everything here is shaped by who reads it: somebody who has paid rent to this
 * park for years, has never heard of us, and has every reason to think an
 * unexpected email about their home is a scam. So the message names their park
 * in the subject, says plainly that nothing about how they pay is changing, and
 * tells them what we will never ask for — which is more use than telling them
 * we are trustworthy.
 */

/** 32 bytes. Long enough that the only way to hold one is to be sent one. */
export function mintInviteToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * What the database stores. SHA-256 rather than bcrypt, deliberately: this is
 * high-entropy and has to be found by equality, which a per-row salt makes
 * impossible. See 0132.
 */
export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/i;

export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/parks/welcome?t=${token}`;
}

// ------------------------------------------------------------- the words ----

export interface InviteCopy { subject: string; text: string; html: string }

/**
 * THE MESSAGE. Plain, short, and honest about how little it changes.
 *
 * NO CODE IN IT, EVER. The slip's promise — "we will never ring or text you
 * asking for this code" — only survives if a code never travels by message. A
 * link is a different thing: it cannot be read aloud to somebody on the phone
 * pretending to be the office.
 */
export function inviteCopy(input: {
  parkName: string;
  lotNumber: string;
  displayName: string;
  url: string;
}): InviteCopy {
  const { parkName, lotNumber, displayName, url } = input;
  const first = firstNameFrom(displayName);
  const greeting = first ? `Hello ${first},` : "Hello,";

  const lines = [
    greeting,
    ``,
    `${parkName} keeps its rent records with LakeLife now. This is a one-off note to say you can see your own lot — number ${lotNumber} — on your phone if you'd like to: your rent, what it's made of, and your receipts.`,
    ``,
    `Nothing about how you pay is changing. If you pay by cheque or in cash at the office, carry on exactly as you do now.`,
    ``,
    `See lot ${lotNumber}: ${url}`,
    ``,
    `If you'd rather not, just ignore this — nothing happens and nobody will chase you about it.`,
    ``,
    `LakeLife will never ask you for card or bank details to set your lot up, and will never phone or text you asking for a code or a password.`,
  ];

  return {
    // The park's name first: it is the only word in the inbox they recognise.
    subject: `${parkName} — seeing your lot online, if you want to`,
    text: lines.join("\n"),
    html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#12303a;max-width:520px">
  <p>${esc(greeting)}</p>
  <p><strong>${esc(parkName)}</strong> keeps its rent records with LakeLife now. This is a one-off note to say you can see your own lot — number ${esc(lotNumber)} — on your phone if you&rsquo;d like to: your rent, what it&rsquo;s made of, and your receipts.</p>
  <p>Nothing about how you pay is changing. If you pay by cheque or in cash at the office, carry on exactly as you do now.</p>
  <p style="margin:26px 0">
    <a href="${esc(url)}" style="background:#0f6d7d;color:#fff;padding:13px 22px;border-radius:9px;text-decoration:none;display:inline-block;font-weight:600">See lot ${esc(lotNumber)}</a>
  </p>
  <p style="color:#5b7580;font-size:14px">If you&rsquo;d rather not, just ignore this — nothing happens and nobody will chase you about it.</p>
  <p style="color:#5b7580;font-size:13px">LakeLife will never ask you for card or bank details to set your lot up, and will never phone or text you asking for a code or a password.</p>
</div>`,
  };
}

/**
 * HER NAME, OR NO NAME AT ALL.
 *
 * Rolls write people as "Reyes, Donna" about as often as "Donna Reyes", and
 * the first draft took the text before the comma — greeting her as "Reyes".
 * Being called by your surname by a company you have never heard of, in an
 * unexpected email about your home, reads as a mail merge at best and a scam
 * at worst.
 *
 * So: after the comma when there is one, the first word when there isn't, and
 * NOTHING when the name is a household rather than a person ("The Reyes
 * Family", "Lot 14 household"). A plain "Hello," is warmer than a wrong name.
 */
export function firstNameFrom(displayName: string | null | undefined): string | null {
  const raw = (displayName ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  const candidate = raw.includes(",")
    ? raw.slice(raw.indexOf(",") + 1).trim().split(" ")[0]
    : raw.split(" ")[0];

  const name = (candidate ?? "").trim();
  if (name.length < 2 || name.length > 24) return null;
  // Letters, and the punctuation real names carry. A "household", a "&", or a
  // digit means this is a label for a home rather than a person.
  if (!/^[\p{L}][\p{L}'’.-]*$/u.test(name)) return null;
  if (/^(the|lot|unit|space|household|family|tenant|resident|occupant|estate|trust)$/i.test(name)) {
    return null;
  }
  return name;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;");

// --------------------------------------------------------- what came back ---

/**
 * Every outcome the two database functions can return, as a sentence.
 *
 * A resident following a link that does not work is the person least able to
 * do anything about it, so each one says what to do next rather than what went
 * wrong internally.
 */
const CLAIM_SAYS: Record<string, string> = {
  claim_not_signed_in:
    "Sign in first — use the same email address this message was sent to.",
  invite_bad_token:
    "That link looks incomplete. Try tapping it again from the email rather than copying it.",
  invite_unknown:
    "This link isn't one we recognise any more. Ask the office and they'll set you up.",
  invite_expired:
    "This link has expired. Ask the office for a new one — it takes them a moment.",
  invite_wrong_account:
    "You're signed in with a different email from the one this was sent to. Sign out and sign in with that address, and the link will work.",
  claim_already_set_up:
    "This lot is already set up. If that was you on another phone, sign in with that account.",
  claim_member_may_not_claim:
    "This account manages the park, so it can't also be set up as a household here.",
  claim_already_here:
    "This account already has a lot at this park.",
  claim_no_open_lot:
    "We can't find a current tenancy for this link. Have a word with the office.",
  claim_file_merged:
    "This record has been merged into another one. The office can point you at the right lot.",
};

export function inviteClaimSays(outcome: string): string {
  if (outcome === "claimed") return "You're all set.";
  return CLAIM_SAYS[outcome] ?? "That didn't work. Ask the office and they'll sort it.";
}

/** True when the office can fix it by sending or printing another. */
export function officeCanReissue(outcome: string): boolean {
  return outcome === "invite_expired" || outcome === "invite_unknown";
}

const ISSUE_SAYS: Record<string, string> = {
  invited: "Sent.",
  invite_not_signed_in: "Sign in again — your session expired.",
  invite_not_your_park: "You don't manage that park.",
  invite_no_file: "We couldn't find that household.",
  invite_bad_email: "That email address doesn't look right.",
  invite_bad_token: "Something went wrong making that invite. Try again.",
  invite_already_set_up: "They've already set their lot up.",
  invite_declined: "They said no thanks — we won't email them.",
  invite_file_merged: "That record has been merged into another one.",
  invite_too_soon: "They were emailed in the last day. Give it until tomorrow.",
};

export function inviteIssueSays(outcome: string): string {
  return ISSUE_SAYS[outcome] ?? "That didn't send.";
}

export const inviteWorked = (outcome: string) => outcome === "invited";
