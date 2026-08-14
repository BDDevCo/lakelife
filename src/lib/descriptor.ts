/**
 * WHAT THE CHARGE LOOKS LIKE ON A BANK STATEMENT.
 *
 * A card statement gives you about twenty-two characters and no punctuation to
 * speak of. Everything we sent was written for a receipt instead:
 *
 *   "LakeLife — thank-you for the crew, Pier Install / Removal"
 *
 * which reaches the customer's statement as roughly `LAKELIFE  THANK-YOU F`.
 * An unrecognisable line on a bank statement is the single most common reason
 * somebody disputes a charge — they are not disputing the work, they genuinely
 * cannot tell what it was.
 *
 * This matters more since 0097 made a tip its OWN charge, which is what Uber
 * and Lyft do too: the fare is captured at drop-off and the tip is a separate
 * transaction days later. Two charges from one company is only calm if the
 * second one plainly says TIP. That single word is the whole mitigation.
 *
 * SO THE DESCRIPTOR NAMES THE KIND OF CHARGE, NOT THE JOB. Twenty-two
 * characters cannot hold "Pier Install / Removal" and the brand, and a
 * half-truncated service name is worse than none — it looks like corruption.
 * Which visit it was belongs in the emailed receipt and on the Billing page,
 * both of which carry the date, the amount and the service in full.
 */

/** What a card network will actually carry. Kept conservative on purpose. */
export const DESCRIPTOR_MAX = 22;

/**
 * The kinds of money we take from a customer. One descriptor each, so a person
 * scanning a statement can tell two LakeLife lines apart without calling us.
 */
export type ChargeKind = "service" | "tip" | "cancel_fee" | "visit_fee";

const DESCRIPTORS: Record<ChargeKind, string> = {
  service: "LAKELIFE SERVICE",
  tip: "LAKELIFE TIP",
  cancel_fee: "LAKELIFE CANCEL FEE",
  visit_fee: "LAKELIFE VISIT FEE",
};

/**
 * Make any string safe to hand a processor.
 *
 * Uppercase because statements are anyway; strip everything outside the set
 * networks reliably carry (an em dash and a slash both survive our code and
 * die somewhere in the banking system, usually as a `?`); collapse the runs of
 * spaces that stripping leaves behind; and truncate on a WORD boundary, since
 * a descriptor cut mid-word reads as a glitch rather than as a name.
 */
export function sanitiseDescriptor(raw: string, max: number = DESCRIPTOR_MAX): string {
  const cleaned = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 &.,#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;

  const cut = cleaned.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a word boundary if that leaves something worth reading —
  // otherwise a long first word would truncate to almost nothing.
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

/** The descriptor for a kind of charge. Always statement-safe. */
export function statementDescriptor(kind: ChargeKind): string {
  return sanitiseDescriptor(DESCRIPTORS[kind]);
}

/**
 * RENT CARRIES THE PARK'S NAME, NOT OURS.
 *
 * Every other descriptor here says LAKELIFE because LakeLife is the merchant.
 * Rent is the opposite: it is the park's money and we only move it. A resident
 * who pays "The Haven" and sees LAKELIFE SERVICE on their statement does not
 * recognise it, and an unrecognised line is how a chargeback starts.
 *
 * Falls back to LAKELIFE RENT when a park's name sanitises to nothing (all
 * punctuation, or empty) — an unrecognisable descriptor is still better than
 * a blank one, which some processors reject outright.
 */
export function rentDescriptor(parkName: string | null | undefined): string {
  const park = sanitiseDescriptor(`${parkName ?? ""} RENT`);
  return park.replace(/^RENT$/, "") ? park : sanitiseDescriptor("LAKELIFE RENT");
}
