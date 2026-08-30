/**
 * DOES THIS CERTIFICATE BELONG TO THIS BUSINESS?
 *
 * The owner's posture, settled 30 Aug 2026, and it is the whole of it:
 *
 *   "we look at the certs and make sure they aren't expired, make sure they
 *    match the business that turned them in and that is it. we do not
 *    validate coverage, we do not determine if the policy is enough $$ —
 *    that's not our job."
 *
 * That is the ordinary third-party-administrator position and it is
 * defensible. It was also, until this file existed, two-thirds untrue: the
 * expiry was a date the crew typed into a form, and NOTHING anywhere compared
 * a certificate to the business that sent it. `vendors.company` is free text
 * and no code had ever read it for this purpose.
 *
 * ============ WHY EXACT-AFTER-NORMALISING, AND NOTHING CLEVERER ============
 *
 * A policy is issued to a legal entity, and the name on it is rarely the
 * trading name typed into a signup form: "Northshore Docks" signs up, the
 * certificate says "NORTHSHORE DOCKS, LLC." Refusing that is useless
 * pedantry, so the normaliser folds case, punctuation, `&`/`and`, and the
 * legal suffixes that carry no identity.
 *
 * Past that it stops. No fuzzy distance, no substring containment, no
 * "close enough" score. Two reasons:
 *
 *   1. A LOOSE MATCH FAILS OPEN, and it fails open on the one document that
 *      exists to say whose insurance this is. "Docks" containing "Docks"
 *      would accept a certificate belonging to somebody else entirely.
 *   2. A MISMATCH IS NOT AN ERROR — it is a question for a person. The crew
 *      is not refused and the document is not thrown away; the file is kept,
 *      the mismatch is recorded with BOTH names, and it becomes an activation
 *      gap somebody has to look at. A genuine DBA is a thirty-second
 *      conversation and an edit to `vendors.company`. That is the correct
 *      amount of friction for an insurance certificate, and a fuzzy matcher
 *      would spend it in the wrong direction.
 *
 * WHAT THIS FILE DOES NOT DO, DELIBERATELY: it does not read the certificate.
 * Nobody at LakeLife opens the document. The crew types the name that is on
 * it and this compares that typing to their business name — which catches the
 * wrong company's certificate, and does not catch a crew who types the right
 * name over the wrong file. Saying so plainly is the point; see the addenda.
 */

/** Legal-form suffixes that carry no identity. Order matters: longest first. */
const SUFFIXES = [
  "incorporated",
  "corporation",
  "limited liability company",
  "limited liability partnership",
  "limited partnership",
  "company",
  "limited",
  "pllc",
  "llc",
  "llp",
  "plc",
  "inc",
  "corp",
  "ltd",
  "lp",
  "co",
  "dba",
];

/**
 * Fold a business name to the part that carries identity.
 *
 * Lower-cased, `&` spelled out, punctuation dropped, whitespace collapsed,
 * then trailing legal suffixes stripped — repeatedly, because "Docks LLC Co"
 * exists in the wild and one pass would leave half of it.
 */
export function normalizeBusinessName(raw: string | null | undefined): string {
  let s = (raw ?? "").toLowerCase();
  // `&` and `and` are the same word to a human reading a certificate.
  s = s.replace(/&/g, " and ");
  // Punctuation carries no identity: "N.D., Inc." and "ND Inc" are one name.
  s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // REJOIN DOTTED INITIALISMS. Dropping punctuation turns "L.L.C." into
  // "l l c", which no longer matches the suffix list — so the very form a
  // certificate is most likely to print would have been treated as three
  // words of identity. Same for "N.D. Marine" → "nd marine". A run of single
  // letters in a business name is an initialism, near enough always.
  s = s.replace(/\b[a-z](?: [a-z])+\b/g, (run) => run.replace(/ /g, ""));

  // Strip trailing suffixes until none is left. Guarded against eating the
  // whole name: "The Company" must not normalise to "".
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      if (s === suf) break; // the name IS the suffix — leave it alone
      if (s.endsWith(` ${suf}`)) {
        const trimmed = s.slice(0, -(suf.length + 1)).trim();
        if (trimmed) {
          s = trimmed;
          changed = true;
          break;
        }
      }
    }
  }
  return s;
}

export type NamedInsuredVerdict =
  | { ok: true }
  | { ok: false; reason: "missing"; message: string }
  | { ok: false; reason: "mismatch"; message: string };

/**
 * Compare the name a crew says is on their certificate to the business name
 * on their account.
 *
 * @param namedInsured what the crew typed off the certificate
 * @param company      `vendors.company`
 */
export function checkNamedInsured(
  namedInsured: string | null | undefined,
  company: string | null | undefined,
): NamedInsuredVerdict {
  const insured = normalizeBusinessName(namedInsured);
  const business = normalizeBusinessName(company);

  if (!insured) {
    return {
      ok: false,
      reason: "missing",
      message: "Type the name of the insured business exactly as it appears on the certificate.",
    };
  }
  // A crew with no company name on file is a different problem, and blaming
  // their certificate for it would send them hunting through the wrong
  // paperwork.
  if (!business) {
    return {
      ok: false,
      reason: "missing",
      message: "Your account has no business name on it yet — add that first, then upload the certificate.",
    };
  }
  if (insured !== business) {
    return {
      ok: false,
      reason: "mismatch",
      // BOTH NAMES, VERBATIM. A crew told only "these don't match" has to
      // guess which one we think is wrong, and the answer is often that the
      // account is wrong rather than the policy.
      message:
        `The certificate names “${(namedInsured ?? "").trim()}” but your account says ` +
        `“${(company ?? "").trim()}”. If the policy is in a different legal name, ` +
        `send us a message and we'll get it straightened out.`,
    };
  }
  return { ok: true };
}
