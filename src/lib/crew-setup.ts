import { toE164 } from "@/lib/phone";
import { longDate } from "@/lib/lake-time";

/**
 * WHAT OPS TYPED FROM THE CALL — AND THE RULE THAT GOVERNS ALL OF IT.
 *
 * Brendon, 24 September 2026: "me add them directly and answer most of the
 * questions in some ops portal, then they get sent a confirmation email or text
 * where all they have to do is upload or input a few small items".
 *
 * He is going to be on the phone with Josh and with the landscaper. Typing what
 * they tell him beats a contractor filling a six-card wizard on a phone at a
 * job site, and it is MORE accurate: a wrong lake tick silently drops a crew
 * from every job on that water, and he knows which lakes they work because he
 * just asked them.
 *
 * ============ A PRE-FILLED VALUE IS A PROPOSAL, NOT A FACT ============
 *
 * Nothing in here writes anything the product reads. It builds a proposal that
 * sits in its own table (0181) until the crew settles it, and the crew's own
 * tap is what copies it — edited or not — onto `vendors` and `vendor_rates`.
 * If they change nothing, their tap is still the act that made it real.
 *
 * This is not fussiness. He abolished LakeLife-set pricing this week ("I do
 * not want lakelife setting the pricing for crews, that doesnt make us 3rd part
 * enough"), and a rate ops typed that goes live unconfirmed is LakeLife setting
 * a crew's price with extra steps. The same trap already cost a real bug: a
 * seeded `daily_capacity` of 1 satisfied `activationGaps`, rendered the wizard's
 * capacity step ticked with a "Saved" pill for a number nobody had chosen, and
 * capped that crew at one job a day forever.
 *
 * And NOTHING downstream measures against the typed number. His correction the
 * same day: "Im wouldnt be building a quote around $50, its whatever his pricing
 * is or another contractor pricing is. we are not setting anypricing." So there
 * is no variance report here, no "ops proposed X, crew set Y", no comparison
 * anywhere — a screen that reports a crew's pricing back to the operator is
 * supervision, not a marketplace.
 */

/**
 * THE WORKING WEEK, IN THE ONLY SPELLING DISPATCH UNDERSTANDS.
 *
 * `isEligible` asks `c.workDays.includes(input.weekday)` and the weekday comes
 * from `WEEKDAYS[new Date(...).getDay()]` in app/book/dispatch.ts — three-letter
 * English abbreviations, Sunday first. A day stored in any other spelling is a
 * day the router will never match, so the crew simply never gets offered work
 * and nothing anywhere says why.
 *
 * Exported as the single vocabulary so the ops form, the crew's chips and the
 * validation all mean the same seven strings.
 */
export const WORK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type WorkDay = (typeof WORK_DAYS)[number];

/** Monday-first, which is how a week reads to a person planning one. */
export const WORK_DAYS_IN_READING_ORDER: readonly WorkDay[] = [
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
];

const WORK_DAY_SET: ReadonlySet<string> = new Set(WORK_DAYS);

export function isWorkDay(day: unknown): day is WorkDay {
  return typeof day === "string" && WORK_DAY_SET.has(day);
}

/**
 * Whatever arrived, reduced to real days, de-duplicated, in dispatch's own
 * order. A day the router cannot match is dropped rather than stored: stored,
 * it would look like availability on every screen and be invisible to the one
 * thing that reads it.
 */
export function cleanWorkDays(input: unknown): WorkDay[] {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set<WorkDay>();
  for (const d of raw) if (isWorkDay(d)) seen.add(d);
  return WORK_DAYS.filter((d) => seen.has(d));
}

/**
 * HOW MANY JOBS A DAY. The same 1–20 band `approveCrew` validates, and the
 * same refusal `activationGaps` makes at `cap < 1`.
 *
 * `null` for anything else — INCLUDING an empty box, which is the honest
 * answer when ops did not ask. A zero, a blank or a fat-fingered 200 must never
 * become a number the crew is then held to.
 */
export const MIN_DAILY_CAPACITY = 1;
export const MAX_DAILY_CAPACITY = 20;

export function cleanCapacity(input: unknown): number | null {
  if (input == null || input === "") return null;
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n)) return null;
  if (n < MIN_DAILY_CAPACITY || n > MAX_DAILY_CAPACITY) return null;
  return n;
}

/**
 * The number the crew read out on the call, in the shape Twilio needs.
 *
 * IT IS NEVER A VERIFIED NUMBER. `users.phone_verified` means they gave it to
 * us AND proved they hold the handset; a number somebody else typed is neither,
 * so this only ever pre-fills the verify box. Nothing here writes a phone
 * anywhere a message could be sent from.
 */
export function cleanProposedPhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const e164 = toE164(trimmed);
  // THE SAME SHAPE THE COLUMN ENFORCES, asked here so the two agree.
  //
  // `toE164` is looser than 0181's `crew_setup_proposals_phone_is_e164`: it
  // passes anything starting with "+" and 8-15 digits, including a leading
  // zero, which the constraint refuses. Left to disagree, a mistyped number
  // would bounce the INSERT and take the crew's lakes, days and rate down with
  // it — the whole call lost to one typo. Refused here, the rest of the
  // proposal lands and the caller names the phone as the thing that did not.
  return e164 && STORABLE_PHONE.test(e164) ? e164 : null;
}

/** 0181's `crew_setup_proposals_phone_is_e164`, character for character. */
const STORABLE_PHONE = /^\+[1-9][0-9]{6,14}$/;

/**
 * THE SENTENCE AT THE TOP OF THE CREW'S CARD.
 *
 * It has one job: make it obvious that a person did this, which person, and
 * when — so the crew reads the numbers below as somebody's notes to be checked
 * rather than as settings the system arrived at. An unattributed pre-fill is
 * indistinguishable from a default, and a default that asserts a fact is the
 * shape that wrote nineteen leases nobody had signed.
 *
 * The name is snapshotted on the proposal row, not joined live: this is a
 * record of what we told the crew, and it must not change later because a users
 * row did.
 */
export function setupAttribution(input: {
  proposerName: string | null;
  proposedAt: string | null;
}): string {
  const who = (input.proposerName ?? "").trim() || "Someone at LakeLife";
  const when = longDate(input.proposedAt);
  return when
    ? `${who} set this up from your call on ${when}.`
    : `${who} set this up from your call.`;
}

/**
 * What the crew still has to do themselves, in the words the card uses.
 *
 * FOUR THINGS, AND THEY ARE NOT ON THE OPS FORM AT ALL — not as masked fields,
 * not as optional ones. Each is a hard line:
 *
 *   BANK. One person typing another person's payout destination is the
 *   cleanest fraud available in this product.
 *   THE TERMS. "Courier, not witness" — no signature LakeLife is not party to.
 *   THE COI AND W-9. Their documents, and the gate checks the certificate
 *   NAMES THEIR BUSINESS (0152), so ops uploading one proves nothing.
 *   THEIR MOBILE. Has to be their handset.
 */
export const ONLY_THE_CREW_CAN: readonly string[] = [
  "Upload your insurance certificate (COI)",
  "Upload your W-9",
  "Add the bank account your payouts land in",
  "Agree to the crew terms",
];
