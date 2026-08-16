/**
 * WHAT WE SAY WHEN IT DOES NOT WORK.
 *
 * `claim_park_file` returns one of a dozen refusal reasons (0129). Each one
 * gets its own sentence here, and the rule is that the sentence tells the
 * person WHAT TO DO NEXT. "That didn't work, try again" is the failure this
 * module exists to prevent: she is 78, standing in her kitchen with a slip of
 * paper, and a screen that says nothing useful is a phone call to the office —
 * the exact call the whole park module exists to stop.
 *
 * PARK-AGNOSTIC THROUGHOUT. No "closing", no "seller", no "purchase". Most
 * parks joining LakeLife have been owned by the same person for years.
 *
 * AND NOTHING HERE BLAMES HER. Every one of these is either the park's job to
 * fix or a fact about a piece of paper. None of them is a mistake she made,
 * even when she typed the code wrong — the code is hard to read and that is
 * ours to own.
 */

export type ClaimOutcome =
  | "claimed"
  | "claim_not_signed_in"
  | "claim_code_malformed"
  | "claim_park_not_open"
  | "claim_no_open_lot"
  | "claim_file_merged"
  | "claim_already_set_up"
  | "claim_no_code_open"
  | "claim_code_expired"
  | "claim_locked"
  | "claim_code_wrong"
  | "claim_member_may_not_claim"
  | "claim_already_here";

const SAY: Record<ClaimOutcome, string> = {
  claimed:
    "That's you — your lot and your rent are on your screen now.",

  claim_not_signed_in:
    "Sign in first, then come back to this page and enter your code.",

  // She mistyped, or misread — the alphabet has no O, I, L, U, 0 or 1 for
  // exactly this reason, so anything outside it means the code was misread.
  claim_code_malformed:
    "That code isn't quite right. It's 8 characters, like K7QM-3XR9 — check it against the slip and try once more.",

  claim_park_not_open:
    "We can't find that park. Check the name on your slip, or ask the office to look at their end.",

  // Deliberately the SAME message for "no such lot" and "no live tenancy on
  // it". Distinguishing them would let a stranger map which lots are occupied.
  claim_no_open_lot:
    "We can't match that lot number to a current household. The office can check it in a moment.",

  claim_file_merged:
    "Your records were joined with another file. Ask the office to send a fresh slip.",

  // Says a lot is spoken for WITHOUT naming who, and points at the one action
  // that helps. If it was her on another device, the office can release it.
  claim_already_set_up:
    "Someone has already set this lot up. If that was you on another phone, sign in with that account — if not, tell the office and they'll sort it.",

  claim_no_code_open:
    "There's no code open for this lot right now. Ask the office to print you one.",

  claim_code_expired:
    "That code has expired. The office can print a fresh one — it only takes a moment.",

  claim_locked:
    "Too many tries on this lot, so it's locked for the day. The office can print a new code whenever you're ready.",

  claim_code_wrong:
    "That code doesn't match this lot. Double-check the lot number too — they go together.",

  // A manager claiming a resident file is the shape of the abuse the design
  // exists to prevent, so the refusal is plain rather than apologetic.
  claim_member_may_not_claim:
    "This account manages the park, so it can't also be set up as a household here. Ops can help if you genuinely rent a lot.",

  claim_already_here:
    "This account is already set up with a lot at this park.",
};

/** The sentence to put on screen for a claim outcome. */
export function claimSays(outcome: string): string {
  return (
    SAY[outcome as ClaimOutcome] ??
    // An unknown code means the database grew a reason nobody wrote copy for.
    // Say something honest and non-alarming rather than printing a raw enum.
    "That didn't go through. The office can check it and print a fresh slip."
  );
}

/** True when the outcome means the resident is now attached to their file. */
export const claimWorked = (outcome: string) => outcome === "claimed";

/**
 * Whether the OFFICE can fix this by printing another slip. Drives which
 * button the screen offers, so she is never left reading a sentence with no
 * next step attached.
 */
export function officeCanReprint(outcome: string): boolean {
  return (
    outcome === "claim_no_code_open" ||
    outcome === "claim_code_expired" ||
    outcome === "claim_locked" ||
    outcome === "claim_file_merged"
  );
}

// ---------------------------------------------------------------------------
// The owner's side. Fewer cases, and he is at a desk rather than in a kitchen,
// so these are shorter — but they still say what to do.

export type IssueOutcome =
  | "issued"
  | "issue_not_signed_in"
  | "issue_code_malformed"
  | "issue_no_file"
  | "issue_not_your_park"
  | "issue_already_set_up"
  | "issue_file_merged"
  | "issue_declined"
  | "issue_too_many_today";

const ISSUE_SAY: Record<IssueOutcome, string> = {
  issued: "Slip ready — print it or write it down now.",
  issue_not_signed_in: "Sign in again and retry.",
  issue_code_malformed: "Something went wrong generating that code. Try once more.",
  issue_no_file: "That household isn't on this park any more.",
  issue_not_your_park: "That household belongs to a different park.",
  issue_already_set_up: "They're already set up — no slip needed.",
  issue_file_merged: "Their records were joined with another file. Open that one instead.",
  // Declining is permanent and respectable (0055). The message does not nudge.
  issue_declined: "They said no thanks. Clear that first if they've changed their mind.",
  issue_too_many_today: "That's a lot of slips today. Give it a few hours, or call ops if it's a real push.",
};

export function issueSays(outcome: string): string {
  return ISSUE_SAY[outcome as IssueOutcome] ?? "That didn't go through.";
}

export const issueWorked = (outcome: string) => outcome === "issued";
