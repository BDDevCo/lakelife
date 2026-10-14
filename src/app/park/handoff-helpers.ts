/**
 * HANDING THE PARK TO A SECOND PERSON.
 *
 * Verified against production on 13 Oct 2026, because the shape of this defect
 * is one this codebase has a name for:
 *
 *   park_members : 1 row, role='owner'. managers: 0.
 *   users.role   : an ENUM of exactly (owner, vendor, ops).
 *
 * `park_members.role` has allowed 'manager' since 0052, and the word is READ in
 * four places that gate real behaviour. It is WRITTEN by one statement in the
 * whole product — `createPark`, which hard-codes "owner". A working, enforced,
 * tested permission tier with no door to it: [[a-symbol-with-no-caller]], at
 * the level of a whole role.
 *
 * So "I need to hand this off to an admin" had no answer. This file holds the
 * decisions that can be made without a database.
 *
 * WHAT A MANAGER MAY NOT DO IS NOT WRITTEN DOWN HERE TWICE. The two owner-only
 * gates live in their own modules (`setParkLive`, `canEnableParkServices`) and
 * this file names them for the invitation copy. A source-scanning test asserts
 * the set below is exactly the set of gates that exist, so adding a third
 * owner-only act and forgetting the sentence is a failing test rather than an
 * invitation that over-promises.
 */

/** What an invitation is allowed to say a manager can do. */
export const MANAGER_CAN = [
  "see the rent roll and every household's standing",
  "raise the month's bills, record payments and chase what's late",
  "answer a household who says they've paid",
  "print and send notices, and run the costs and statements",
] as const;

/**
 * The two acts that stay the owner's. Each string names the screen's own
 * words, and the test pins them to the real gates.
 */
export const MANAGER_CANNOT = [
  "put the park in front of the public",
  "commit the park to buying a service",
  // THE THIRD ONE IS THIS DOOR ITSELF, and it was missing from this list
  // until the test below counted the gates and found three. A manager who
  // could invite another manager could hand out access to the owner's rent
  // roll — so `assertOwner` refuses it, and an invitation that did not say so
  // promised more than the software allows.
  "add or remove who helps run it",
] as const;

export type InviteBlock =
  /** The address is free, or belongs to an ordinary account. Send it. */
  | { kind: "ok" }
  | { kind: "already_on_this_park"; role: string }
  | { kind: "already_invited" }
  | { kind: "is_a_crew" }
  | { kind: "is_ops" }
  | { kind: "is_you" }
  | { kind: "read_failed" };

/**
 * Tidy an address, or refuse it.
 *
 * LOWER-CASED HERE AND CHECKED BY THE TABLE. 0193 puts `email = lower(email)`
 * in a CHECK rather than trusting this function, because the crew doors
 * learned what a case-sensitive pre-check against a case-insensitive index
 * costs: a constraint-name error on screen and a retry that can never work.
 */
export function cleanInviteEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v.length < 3 || v.length > 254) return null;
  // Deliberately loose. An address this app cannot deliver to is a bounce we
  // record, not a keystroke to argue with — and a strict pattern rejects valid
  // addresses far more often than it catches a typo.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) return null;
  return v;
}

/**
 * What to say when the invitation cannot go.
 *
 * Every sentence names the move available on the screen the reader is on —
 * the rule lib/invite-guard.ts set for the crew doors, applied here.
 */
export function inviteBlockMessage(block: InviteBlock, name?: string | null): string {
  switch (block.kind) {
    case "ok":
      return "";
    case "already_on_this_park":
      return block.role === "owner"
        ? `${name ?? "That person"} already owns this park.`
        : `${name ?? "That person"} already helps run this park — they're in the list below.`;
    case "already_invited":
      return "You've already invited that email and they haven't taken it up yet. Withdraw it below if you want to send a fresh one.";
    case "is_a_crew":
      // NOT a guess at what he meant. /portal rewrites users.role to 'vendor'
      // when it claims a crew invitation, so one account cannot be both — and
      // which identity wins is a product decision, not something an invite
      // door gets to settle in passing.
      return "That email belongs to a crew account. A crew account can't also run a park — ask them for a different email.";
    case "is_ops":
      return "That's a LakeLife operations account. They can already see every park.";
    case "is_you":
      return "That's your own email — you already own this park.";
    case "read_failed":
      // A failed read is not an empty one. Nothing was written.
      return "We couldn't check that email just now, so nothing has been sent. Try again in a moment.";
  }
}

/**
 * The invitation email's body text, as plain lines.
 *
 * SAYS WHAT THEY ARE BEING GIVEN, in full, before they accept. A park
 * membership is read access to every household's name, lot and payment
 * history — somebody should know that is what the link does.
 */
export function handoffEmailLines(opts: {
  parkName: string;
  invitedByName: string | null;
  note: string | null;
  /**
   * THE BARE SITE, not /portal.
   *
   * /portal redirects a visitor with no session straight to the marketing
   * homepage, so the first draft's link bounced the one reader it was written
   * for — somebody with no account yet — and changed the URL under them on the
   * way, which reads as broken. The crew invitation links the bare site for
   * exactly this reason. A signed-in reader is no worse off: the homepage
   * carries a shortcut into their portal, and /portal is still where the
   * invitation is claimed.
   */
  joinUrl: string;
  /** Named in the body, because it is the whole mechanism. */
  email: string;
}): string[] {
  const who = opts.invitedByName?.trim() || "The owner";
  const lines = [
    `${who} has asked you to help run ${opts.parkName} on LakeLife.`,
  ];
  if (opts.note?.trim()) lines.push(`Their note: “${opts.note.trim()}”`);
  lines.push(
    "If you take this up, you'll be able to " + joinWords(MANAGER_CAN) + ".",
    "That includes every household's name, lot and payment history, so only accept if you expect to be running the park.",
    "You won't be able to " + joinWords(MANAGER_CANNOT) + " — those stay with the owner.",
    // CREATE OR SIGN IN, BOTH SAID. The first draft said "sign in", which is
    // the wrong instruction for the likeliest reader: somebody being handed a
    // park usually has no LakeLife account at all. The crew invitation learned
    // this already and says "Create your account at …" for the same reason.
    //
    // AND THE ADDRESS IS THE WHOLE MECHANISM, so it is named twice and in
    // capitals once: the invitation is matched on it, and 0193 refuses an
    // acceptance by any other account. Signing up with a different address is
    // the one mistake that makes this email do nothing, silently.
    `Go to ${opts.joinUrl} and create your account — or sign in, if you already have one — using THIS email address (${opts.email}). The park is waiting there.`,
    "If you sign up with a different address we can't match you to the invitation, and you'll land on the lake-house pages instead.",
    "If you weren't expecting this, you can ignore it — nothing happens until you sign in.",
  );
  return lines;
}

/** "a, b, c and d" — the repo's one list voice. */
function joinWords(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export { joinWords as joinHandoffWords };

/**
 * What the list of people says when there is only the owner on it.
 *
 * Says what it checked, rather than rendering an empty box — and names the act
 * that ends it, because this card exists precisely because that act had no
 * door.
 */
export function handoffQuietSentence(parkName: string): string {
  return (
    `You're the only person who can open ${parkName}. If you're away, nobody ` +
    `can raise a bill, record a payment or answer a household. Invite somebody ` +
    `above and they'll be able to do all of that without being able to ` +
    `${joinWords(MANAGER_CANNOT)}.`
  );
}

/** How an invitation reads in the list. A date a person reads, never an ISO. */
export function inviteStanding(row: {
  acceptedAt: string | null;
  revokedAt: string | null;
}): "open" | "accepted" | "withdrawn" {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "withdrawn";
  return "open";
}
