/**
 * THE WORDS OF THE AGREEMENT, IN ONE PLACE.
 *
 * These used to live as JSX inside `TermsBody`, which was fine while the only
 * thing we did with them was render them. It stops being fine the moment we
 * record that somebody ACCEPTED them: a timestamp and a version string record
 * THAT a person agreed and cannot answer WHAT they agreed to, and the terms on
 * screen change while the old acceptances sit there pointing at whatever is
 * current.
 *
 * 0133 settled this pattern for SMS consent and stated the reason plainly:
 *
 *   "One constant, used twice, so the sentence in the record is by
 *    construction the sentence they read. The alternative — copy in a
 *    component and a paraphrase in an action — is how a consent record ends up
 *    describing something nobody was shown."
 *
 * So the sections below are the single source. `TermsBody` renders them, and
 * `termsPlainText()` renders the identical words for the acceptance ledger.
 * Neither can drift from the other without this file changing.
 *
 * RUNS, RATHER THAN MARKUP IN A STRING. A body is a list of plain strings and
 * emphasised strings. The component maps an emphasised run to <b>; the plain
 * text maps it to its own words and nothing else. There is no mini-language to
 * parse and therefore no way for the two renderings to disagree about what the
 * words even are — a test asserts every run appears verbatim in the text.
 */

/** A stretch of body copy. A bare string is plain; `{ b }` is emphasised. */
export type Run = string | { b: string };

export interface TermsSection {
  heading: string;
  body: Run[];
}

/**
 * Changing any word here changes what people are agreeing to. Bump
 * TOS_VERSION in the same commit, or the ledger records new words under an old
 * version — see `termsVersionGuard` in the tests.
 */
export const TERMS_SECTIONS: readonly TermsSection[] = [
  {
    heading: "What LakeLife is",
    body: [
      "LakeLife is a ",
      { b: "third-party administrator" },
      ": we run the booking, scheduling, photo-verification, and payment rails that connect lake homeowners with independent local crews. The services themselves — mowing, winterizing, hauling, storing — are performed by those independent crews, not by LakeLife.",
    ],
  },
  {
    heading: "Who you’re agreeing with",
    body: [
      "When a job is booked, the service agreement is ",
      { b: "between the homeowner and the crew" },
      " — both sides accept these shared terms as the rules of that relationship. LakeLife administers it: one all-in price, photo-verified completion, payment released only after the work is done.",
    ],
  },
  {
    heading: "What LakeLife verifies",
    body: [
      "Every active crew has ",
      { b: "insurance on file" },
      " (a certificate of insurance, re-validated yearly; storage crews additionally carry custody coverage) and a ",
      { b: "W-9 with a valid EIN or SSN" },
      " on file before they can be routed work. Verification of documents is the extent of LakeLife’s role — crews are independent businesses responsible for their own work.",
    ],
  },
] as const;

/** The words of one run, whether it is emphasised or not. */
export function runText(run: Run): string {
  return typeof run === "string" ? run : run.b;
}

/**
 * THE CANONICAL TEXT — what goes into the acceptance ledger, verbatim.
 *
 * Deterministic by construction: same sections in, same string out, every
 * time. That matters because the hash of this string is what proves two
 * acceptances were of identical terms, and a rendering that varied by
 * whitespace would make every acceptance look like a different document.
 *
 * Emphasis is dropped because it is presentation, not agreement. The WORDS are
 * identical to the screen's, which is the part anybody would argue about.
 */
export function termsPlainText(): string {
  return TERMS_SECTIONS
    .map((s) => `${s.heading}\n\n${s.body.map(runText).join("")}`)
    .join("\n\n");
}
