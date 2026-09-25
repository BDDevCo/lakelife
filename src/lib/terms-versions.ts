/**
 * WHAT EACH VERSION OF THE TERMS ACTUALLY SAID.
 *
 * One line per version ever shipped: the version string, and the sha256 of
 * `termsPlainText()` as it stood under that name. Append-only — an entry is
 * never edited, because editing one is exactly the thing this file exists to
 * make impossible.
 *
 * WHY THIS IS NOT JUST A CONSTANT IN A TEST. It was, and the guard had a hole
 * you could drive through: the digest and the version were two independent
 * constants sitting side by side, so changing a word failed one assertion whose
 * own message told you to paste the new digest in. Doing exactly that turned CI
 * green with new words filed under the OLD version string — the precise failure
 * the guard was written to prevent. Nothing compared the new digest to what
 * that version had previously hashed to, because nothing remembered.
 *
 * Now something remembers. Two rules, both enforced in
 * `TermsBody.test.tsx`:
 *
 *   1. the CURRENT version's entry must equal the current text's digest, and
 *   2. the current digest must not appear under ANY OTHER version.
 *
 * Rule 2 is the one with teeth. Change a word without bumping TOS_VERSION and
 * rule 1 fails; "fix" it by editing tos-v3-beta's entry and you have rewritten
 * history, which rule 2 catches the moment the old digest reappears — and which
 * a reviewer can see in the diff, because this file is committed and the test
 * file's constants were not evidence of anything.
 *
 * WHY IT MATTERS BEYOND CI. `acceptances.document_version` records the string,
 * and `acceptances.text_sha256` records the words. If two different documents
 * ever ship under one version, the ledger holds rows that look identical and
 * are not, and the only thing that could tell them apart is a hash nothing
 * compares. This file is what keeps that from happening.
 *
 * tos-v0-beta is deliberately ABSENT: its words were never captured (acceptance
 * was two columns on `users` until 0139), and inventing a digest for it would
 * assert we know something we do not. The four migrated ledger rows carry
 * `provenance = 'migrated_pre_ledger'` and a NULL sha for the same reason.
 */
export const TERMS_DIGESTS: Readonly<Record<string, string>> = {
  // 21 Aug 2026 — added the park-owner and renter sections.
  "tos-v1-beta": "5c1b225decf51f83a8cadb4844c9476fec290861f6a5818ab4dad15d8f075701",
  // 21 Aug 2026 — dropped two capability claims the code does not have
  // (document storage, a delivery log) and made the go-live billing promise
  // conditional on a cutover date actually being set.
  "tos-v2-beta": "6ba022c24bb106f0a23132468013b5faea7f2beb88659b1fc1e1a32aaf2b7011",
  // 21 Aug 2026 — the renter section claimed no payment is credited until the
  // park confirms it, and that LakeLife never handles the money. True of the
  // cash/cheque claim path; FALSE of `payRent`, which charges a saved card and
  // credits the bill immediately. Both paths are now described.
  "tos-v3-beta": "e0770eca1c919c83ed9b23a9d02fca7b293c5441ed25415e5d94e8ce714817f6",
  // 25 Sep 2026 \u2014 the fee sentences. The document named no price and no
  // percentage anywhere: the only occurrence of the word "fee" was a PARK's card
  // fee, which LakeLife receives none of. Four audiences accept these terms and
  // three of them can be charged.
  //
  // WHAT IT NAMES, AND WHY THERE ARE STILL NO FIGURES IN IT: every rate in this
  // product is a tunable row in `platform_settings`, and a hashed document is
  // immutable per version. A "12%" written here would be false the day the dial
  // moved, with every acceptance still standing against the old wording. So the
  // terms name WHO PAYS WHAT and point at the screen that carries the live
  // number \u2014 which is also where somebody can actually check it.
  //
  // It also adds a CREW section. Crews have accepted this document since v0 and
  // it has never described their relationship \u2014 the same gap v1-beta closed
  // for parks and renters, and for the same reason: asking somebody to agree to
  // a document that does not describe their relationship produces a record that
  // reads as evidence and is not one.
  //
  // And it qualifies two clauses that the code had already outgrown: "payment
  // released only after the work is done" (a trip fee releases for a visit on
  // which no work happened) and the renter section, which never said the thing a
  // resident most needs to know \u2014 that they pay LakeLife nothing at all.
  "tos-v4-beta": "d8abf441ab5cb8330f3665650d364d4773b7e82287e11bbaa47d6d2539b64363",
} as const;
