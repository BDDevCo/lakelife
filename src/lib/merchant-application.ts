/**
 * THE MERCHANT APPLICATION — what US Card Solutions needs, and how much of it
 * we already know.
 *
 * His directive, 29 October 2026:
 *
 *   "...should be a part of the onboarding process or where they do a file
 *    dump to set up their park, we need to extract the correct information
 *    from the data they upload and populate into the US Card application / use
 *    their API to push the data over to them then ask or capture anything
 *    outstanding then once we have a completed file for US Card Solutions it's
 *    a one tap confirmation."
 *
 * So the shape is: UPLOAD -> EXTRACT -> PREFILL -> ASK ONLY WHAT IS MISSING ->
 * ONE TAP. This module is the middle three. It is pure — no server imports —
 * so the screen, the server action and the tests all read the same list.
 *
 * ===========================================================================
 * THE FIELD LIST IS A GUESS, AND IS MEANT TO BE REPLACED
 * ===========================================================================
 *
 * He is getting the real application form from US Card Solutions. Until it
 * arrives these are the fields a card-processing boarding application
 * conventionally asks for, and they are deliberately in ONE ARRAY so that
 * swapping in the real spec is editing a list rather than hunting through a
 * screen, an action, a migration and three tests.
 *
 * `migrations/0201` added a column for each of these. When the real form
 * lands, expect to add a few and drop a few; the ones that move should move
 * here first and the migration follows.
 *
 * ===========================================================================
 * A DERIVED VALUE IS A SUGGESTION, NEVER A STATEMENT
 * ===========================================================================
 *
 * This codebase has already paid for the opposite. A pre-ticked "they signed"
 * once wrote nineteen leases nobody had signed — the bug class it calls
 * "the default that asserts a fact".
 *
 * An underwriting application is a document a park owner is ASSERTING things
 * in. So every value we work out for him carries its `source` and, where the
 * number was computed, the `workings` that produced it — and the screen shows
 * both. He confirms or corrects; nothing derived is submitted as though he
 * typed it.
 *
 * That matters most on the two volume questions, which are exactly the ones
 * applicants guess at and underwriters stall on:
 *
 *   - We know The Haven's rent roll: 21 lots, all rated, $8,400/month base.
 *   - But from 1 Jan each lot is billed $542.53 (rent plus the shared-cost
 *     fee), which is a different number — and it is the BILLED total, while an
 *     underwriter is asking what will run over THEIR rails.
 *   - And in January most of it is hand-keyed cash and cheque, which never
 *     touches a processor at all.
 *
 * Three defensible numbers, and only he can pick. So we show the roll, show
 * the arithmetic, and let him say.
 */

/** Where a value on the application came from. */
export type FieldSource =
  | "park"       // already on the park record
  | "owner"      // the signed-in owner's own account
  | "rent-roll"  // computed from lots and their rates
  | "default"    // a convention we propose (e.g. the MCC for a park)
  | "typed";     // he entered it himself

export type FieldKind = "text" | "email" | "phone" | "money" | "choice" | "postal" | "last4";

export interface ApplicationField {
  id: string;
  label: string;
  kind: FieldKind;
  /** Must be present before the application can go. */
  required: boolean;
  /** One line under the label, when the field needs explaining. */
  help?: string;
  /** For `choice` fields. The stored values, not the labels. */
  options?: readonly { value: string; label: string }[];
  /**
   * TRUE for anything that must never be stored here — it goes from the form
   * to the processor and nowhere else. 0201's post-condition FAILS the
   * migration if a column is even named like one of these.
   */
  writeOnly?: boolean;
}

export const ENTITY_TYPES = [
  { value: "sole_proprietor", label: "Sole proprietor" },
  { value: "llc", label: "LLC" },
  { value: "s_corp", label: "S corporation" },
  { value: "c_corp", label: "C corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "non_profit", label: "Non-profit" },
  { value: "trust", label: "Trust" },
] as const;

/**
 * THE ONE HOME FOR THE FIELD LIST. Replace this when the real form arrives.
 *
 * `id` matches the column on `processor_accounts` (0201), except `tax_id`,
 * which is write-only: we keep `tax_id_last4` for a screen and send the rest.
 */
export const APPLICATION_FIELDS: readonly ApplicationField[] = [
  { id: "legal_name", label: "Legal business name", kind: "text", required: true,
    help: "Exactly as it appears with the IRS — not the park's trading name." },
  { id: "dba_name", label: "Trading name (DBA)", kind: "text", required: false,
    help: "What residents call it. Usually the park's name." },
  { id: "entity_type", label: "Business type", kind: "choice", required: true, options: ENTITY_TYPES },
  { id: "tax_id", label: "EIN or SSN", kind: "text", required: true, writeOnly: true,
    help: "Sent straight to the processor. We keep the last four digits and nothing else." },
  { id: "address_line1", label: "Business address", kind: "text", required: true },
  { id: "address_city", label: "City", kind: "text", required: true },
  { id: "address_state", label: "State", kind: "text", required: true },
  { id: "address_postal", label: "ZIP", kind: "postal", required: true },
  { id: "contact_phone", label: "Business phone", kind: "phone", required: true },
  { id: "contact_email", label: "Business email", kind: "email", required: true },
  { id: "mcc", label: "Merchant category", kind: "text", required: true,
    help: "6513 is the code for rentals of residential property." },
  { id: "expected_monthly_cents", label: "Expected monthly card and ACH volume", kind: "money", required: true,
    help: "What you expect residents to pay ONLINE each month — not the whole rent roll, if some still pay cash." },
  { id: "average_ticket_cents", label: "Average payment", kind: "money", required: true,
    help: "One resident's typical monthly payment." },
  { id: "control_person_name", label: "Who controls the business", kind: "text", required: true,
    help: "The person the processor will verify. Usually the owner." },
  { id: "control_person_title", label: "Their title", kind: "text", required: true },
] as const;

/** Columns on `processor_accounts` that this module may write. */
export const STORED_FIELD_IDS: readonly string[] = APPLICATION_FIELDS
  .filter((f) => !f.writeOnly)
  .map((f) => f.id);

export interface Derived {
  value: string | number | null;
  source: FieldSource | null;
  /** How a computed number was reached, in words, for the screen to show. */
  workings?: string;
}

/** What we know about the park, as the loader reads it. */
export interface ParkFacts {
  name: string | null;
  address: string | null;
  /** Lots that are active and carry a rate, and what they sum to per month. */
  ratedLots: number;
  monthlyRentTotal: number | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
}

/**
 * Split a one-line address into the parts an application asks for.
 *
 * DELIBERATELY CONSERVATIVE. `parks.address` is one free-text line a person
 * typed — The Haven's is "9085 E 500 S, Wolcottville, IN 46795" — and an
 * address that does not split cleanly must yield NOTHING rather than a wrong
 * guess. A half-parsed address on an underwriting application is worse than an
 * empty one, because an empty one gets asked about.
 */
export function splitAddress(line: string | null | undefined): {
  line1: string | null; city: string | null; state: string | null; postal: string | null;
} {
  const empty = { line1: null, city: null, state: null, postal: null };
  const s = (line ?? "").trim();
  if (!s) return empty;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return empty;
  const tail = parts[parts.length - 1];
  // "IN 46795" or "IN 46795-1234"
  const m = /^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(tail);
  if (!m) return empty;
  return {
    line1: parts.slice(0, parts.length - 2).join(", ") || null,
    city: parts[parts.length - 2] || null,
    state: m[1].toUpperCase(),
    postal: m[2],
  };
}

/** The merchant category for a mobile-home or RV park: rentals of property. */
export const PARK_MCC = "6513";

/**
 * Work out everything we can, and say where each piece came from.
 *
 * Returns a value for a field only when we are confident enough that a person
 * reading it would say "yes, that's right" rather than "where did that come
 * from". Everything else is left null and lands in `applicationGaps`.
 */
export function deriveApplication(facts: ParkFacts): Record<string, Derived> {
  const out: Record<string, Derived> = {};
  const addr = splitAddress(facts.address);

  if (facts.name) out.dba_name = { value: facts.name, source: "park" };
  if (addr.line1) out.address_line1 = { value: addr.line1, source: "park" };
  if (addr.city) out.address_city = { value: addr.city, source: "park" };
  if (addr.state) out.address_state = { value: addr.state, source: "park" };
  if (addr.postal) out.address_postal = { value: addr.postal, source: "park" };
  if (facts.ownerEmail) out.contact_email = { value: facts.ownerEmail, source: "owner" };
  if (facts.ownerPhone) out.contact_phone = { value: facts.ownerPhone, source: "owner" };
  if (facts.ownerName) out.control_person_name = { value: facts.ownerName, source: "owner" };
  // NO `workings` HERE ON PURPOSE. The field's own `help` already says what
  // 6513 means, and rendered together they said it twice — "From 6513 —
  // rentals of residential property" directly above "6513 is the code for
  // rentals of residential property". `workings` is for arithmetic a person
  // could not otherwise check, not for restating the label.
  out.mcc = { value: PARK_MCC, source: "default" };

  // THE TWO VOLUME QUESTIONS. Proposed with their arithmetic attached, never
  // asserted: an underwriter is asking what will run over THEIR rails, and
  // part of this park's rent will be hand-keyed cash for the foreseeable
  // future. He is the only one who can say how much.
  if (facts.monthlyRentTotal != null && facts.ratedLots > 0) {
    const cents = Math.round(facts.monthlyRentTotal * 100);
    out.expected_monthly_cents = {
      value: cents,
      source: "rent-roll",
      workings:
        `your rent roll: ${facts.ratedLots} ${facts.ratedLots === 1 ? "lot" : "lots"} ` +
        `priced, ${money(cents)} a month in total. Lower it if some residents ` +
        `will keep paying cash or by cheque.`,
    };
    const avg = Math.round(cents / facts.ratedLots);
    out.average_ticket_cents = {
      value: avg,
      source: "rent-roll",
      workings: `${money(cents)} across ${facts.ratedLots} ${facts.ratedLots === 1 ? "lot" : "lots"}`,
    };
  }
  return out;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * WHAT IS STILL MISSING — the same shape as `activationGaps` for a crew, on
 * purpose, because it is the same question asked of a different party.
 *
 * Returns the labels of required fields with no value. Empty means every
 * required field is answered, which is the ONLY condition under which the
 * one-tap submit may be offered.
 */
export function applicationGaps(
  draft: Readonly<Record<string, unknown>>,
  fields: readonly ApplicationField[] = APPLICATION_FIELDS,
): string[] {
  return fields
    .filter((f) => f.required && isBlank(draft[f.id]))
    .map((f) => f.label);
}

function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  // A zero volume is a real answer to "how much" only if somebody typed it;
  // as a stored value it means the field was never filled.
  if (typeof v === "number") return !Number.isFinite(v) || v <= 0;
  return false;
}

/**
 * May the one-tap submit be offered?
 *
 * `alreadySent` is the row's `submitted_at`. 0196 makes a submitted account
 * immutable and 0201 refuses an edit after it has gone, so offering the tap
 * twice would be offering an action the database will refuse.
 */
export function readyToSubmit(
  draft: Readonly<Record<string, unknown>>,
  alreadySent: string | null,
  fields: readonly ApplicationField[] = APPLICATION_FIELDS,
): boolean {
  return !alreadySent && applicationGaps(draft, fields).length === 0;
}

/**
 * The sentence above the tap. Says what is about to happen and to whom —
 * a one-tap action whose consequence is not on the screen is not consent.
 */
export function submitSentence(parkName: string | null, provider: string): string {
  const who = parkName?.trim() || "this park";
  return (
    `One tap sends ${who}'s application to ${provider}. They decide, not us — ` +
    `it can come back approved or declined, and either way we will tell you. ` +
    `Nothing about rent changes until they approve it.`
  );
}

/** The four digits we keep of a tax id, or null if it is not a usable one. */
export function taxIdLast4(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  // An EIN is 9 digits and so is an SSN. Anything else is a typo, and a typo
  // submitted to an underwriter comes back as a rejection.
  if (digits.length !== 9) return null;
  return digits.slice(-4);
}
