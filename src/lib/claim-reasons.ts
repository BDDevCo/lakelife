/**
 * REFUSAL CODES IN THE WORDS OPS NEEDS.
 *
 * Two audiences, two vocabularies, and they are not interchangeable. The
 * resident is told what to DO next — "sign out and use that address" — because
 * she is the one who can fix it. Ops is told what HAPPENED, because whoever
 * picks up the phone should know before they dial.
 *
 * Pure and lib-side so it can be tested without a database. `claims-data.ts`
 * carries `server-only` and cannot be imported from a test at all, which is
 * the codebase's normal split: pure helpers here, reads there.
 */
/**
 * Reason codes in the words ops needs, which are NOT the words the resident
 * saw. She is told what to do next; ops is told what actually happened, so the
 * person picking up the phone knows before they dial.
 */
const OPS_REASON: Record<string, string> = {
  claim_code_wrong: "typed the wrong code",
  claim_code_expired: "their slip had expired",
  claim_code_malformed: "the code wasn't the right shape",
  claim_locked: "locked out after five tries",
  claim_no_code_open: "no slip is out for them",
  claim_already_set_up: "the lot is already claimed by another account",
  claim_already_here: "their account already holds another lot here",
  claim_member_may_not_claim: "they're signed in as park staff",
  claim_no_open_lot: "no current tenancy matched",
  claim_file_merged: "their record was merged into another",
  invite_wrong_account: "signed in with a different email from the invite",
  invite_expired: "their invite link had expired",
  invite_unknown: "the link no longer matches anything",
  invite_bad_token: "the link arrived broken or truncated",
};

export const REISSUABLE = new Set([
  "claim_code_expired", "claim_no_code_open", "invite_expired", "invite_unknown",
  "claim_locked",
]);

export function opsReasonText(code: string): string {
  return OPS_REASON[code] ?? `refused (${code})`;
}

