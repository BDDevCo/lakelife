/**
 * FILING THE PEOPLE WHO WERE ALREADY THERE.
 *
 * NOBODY HAS SIGNED ANYTHING YET, so that is the default: a holdover on the
 * arrangement they already had. Some parks will sign everyone onto a new lease
 * on day one and some will never ask, and BOTH kinds of household live here and
 * owe rent. The record says which, per household, rather than picking one story
 * for everybody — because a row that claims an agreement nobody signed is the
 * same class of lie as a bill nobody sent. The tick starts clear for exactly
 * that reason: it is a claim about a piece of paper, and only the person
 * holding the paper may make it.
 *
 * A rent roll is a list of lots and amounts; it usually names nobody. So the
 * importer writes lots and rate cards and — correctly — ZERO tenancies, because
 * putting a name on a lot the sheet did not name would be inventing a person.
 * That leaves the real first day's work, which is sitting down and filing the
 * households one screen at a time.
 *
 * The existing path is one lot at a time: pick a lot, fill a form, save, go
 * back. Nineteen rounds of that is how half of them end up unfiled, and an
 * unfiled household is not billed at all.
 *
 * TWO THINGS MAKE THIS FAST, AND BOTH ARE ABOUT NOT RETYPING WHAT WE ALREADY
 * KNOW:
 *
 *   THE RENT IS ALREADY ON FILE. Each lot's monthly rate is on the lot already,
 *   so every row arrives pre-filled and he is mostly typing names. He can
 *   correct any of them; a correction is still HIS knowledge, not the tenant's,
 *   so the provenance does not improve just because he retyped it.
 *
 *   THE SIGNING STATE IS ONE TICK PER ROW. Ticked writes a real agreement under
 *   the cap, because one exists on paper. Clear writes a holdover on the rolling
 *   horizon, which 0065 exempts from the cap — they are living here on the
 *   arrangement they already had, and until they sign, that is simply the
 *   truth. Clear is the default, because on the first morning it is true of
 *   everybody.
 *
 * A BLANK ROW IS SKIPPED, NOT AN ERROR. He will not know every name on the
 * first afternoon, and a form that refuses to save until all nineteen are
 * complete is a form that saves nothing.
 */

// The same start-date rule the server applies, so the screen refuses what the
// server would refuse and names the lot instead of failing at File.
import { agreementStartFor, dayInWords, SIGNED_LEASE_LABEL } from "./park-helpers";
import { prettyMonth } from "./ledger-helpers";

export interface OnboardRow {
  lotId: string;
  lotNumber: string;
  /** Blank means "not today" — the row is skipped in silence. */
  displayName: string;
  /** Pre-filled from the lot's monthly rate card. */
  rent: string;
  /** Blank means "already here", which is the common case. */
  movedInOn: string;
  /**
   * Have they signed the new lease yet?
   *
   * TRUE writes a fresh agreement under the park's cap — a real agreement,
   * because one exists on paper. FALSE writes a holdover on the rolling
   * horizon, exempt from the cap, because they are living here on the
   * arrangement they already had and nobody has changed that yet.
   */
  signedNewLease: boolean;
  /**
   * THE DAY THE SIGNED LEASE RUNS FROM — read only when the tick is set.
   *
   * Blank means the later of today and the park's cutover date. A lease
   * collected on 20 December for 1 January is filed dated 1 January and bills
   * January whole; typed in with no date of its own it was filed from the day
   * it was typed and billed January short. See `agreementStartFor`.
   */
  agreementStartsOn: string;
  /**
   * HOW TO REACH THEM, taken at signing.
   *
   * The owner's rule: both are a condition of renting a lot in the park. So
   * they are REQUIRED to file rather than optional — but a missing one names
   * its lot rather than failing quietly, because an unfiled household is not
   * billed at all and that is the worse end of this trade.
   *
   * The number goes to `phone_on_file_with_park`, which nothing can text. It
   * becomes a send target only when the resident verifies it themselves.
   */
  email: string;
  phone: string;
}

export interface OnboardPlan {
  toFile: {
    lotId: string;
    lotNumber: string;
    displayName: string;
    rent: number | null;
    movedInOn: string;
    signedNewLease: boolean;
    /** Resolved for a signed row (the typed date or the default); null for a holdover. */
    agreementStartsOn: string | null;
    email: string;
    phone: string;
  }[];
  skipped: number;
  problems: { lotNumber: string; why: string }[];
  /** Lots left blank, by number — named so he can see what is still to do. */
  blankLotNumbers: string[];
}

/**
 * BOTH ARE A CONDITION OF RENTING — one rule, one set of sentences.
 *
 * The filing screen refused a row without an email or a phone; the rent
 * roll's "Someone lives here" door and the new "They signed the new lease"
 * door did not, so the household the strict screen turned away was filed by
 * the lax one with neither. Every door that records a signed agreement now
 * asks this, and the sentence he reads is the same at all of them.
 *
 * Null means both are present and well-formed.
 *
 * WHICH DOORS ASK. `planOnboarding` (Who lives here) asks EVERY row, signed
 * or not — both are a condition of renting here, and that screen files
 * households as a batch. The roll's "Someone lives here" asks only when the
 * signed tick is set, and "They signed the new lease" always: on those two
 * doors the condition is the LEASE's. Two rules, one sentence set; whether
 * a no-email holdover should file at all is the owner's call, not this
 * comment's.
 */
export function contactProblem(email: string, phone: string): string | null {
  const e = email.trim().toLowerCase();
  const p = phone.trim();
  if (!e && !p) return "No email or phone yet — both are needed to file.";
  if (!e) return "No email yet.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return "That email doesn't look right.";
  if (!p) return "No phone number yet.";
  if (p.replace(/\D/g, "").length < 10) return "That phone number looks short.";
  return null;
}

export function planOnboarding(
  rows: readonly OnboardRow[],
  todayISO: string,
  /**
   * The park's cutover date — the floor under any signed agreement's start.
   * Null for a park that never changed hands. Optional so the pure callers
   * that predate it read exactly as before.
   */
  cutoverDate: string | null = null,
): OnboardPlan {
  const toFile: OnboardPlan["toFile"] = [];
  const problems: OnboardPlan["problems"] = [];
  const blankLotNumbers: string[] = [];

  for (const r of rows) {
    const name = r.displayName.trim();
    if (!name) {
      blankLotNumbers.push(r.lotNumber);
      continue;
    }
    if (name.length > 120) {
      problems.push({ lotNumber: r.lotNumber, why: "That name is too long." });
      continue;
    }

    // A rent left blank is a rent nobody set — recorded as unknown rather than
    // as zero, because the ledger refuses to bill a null and would happily
    // bill a zero.
    let rent: number | null = null;
    const raw = r.rent.trim();
    if (raw) {
      const n = Number(raw.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) {
        problems.push({ lotNumber: r.lotNumber, why: "That rent isn't a dollar amount." });
        continue;
      }
      if (n > 100_000) {
        problems.push({ lotNumber: r.lotNumber, why: "That rent looks like a typo." });
        continue;
      }
      rent = Math.round(n * 100) / 100;
    }

    // BLANK STAYS BLANK. This used to default to today, which turned "I don't
    // know when they moved in" into "they moved in today" — and the resident's
    // own screen then greeted a household of eleven years with "living here
    // since August 15, 2026". An unknown date is recorded as unknown; the
    // column is nullable precisely so it can be.
    const movedInOn = r.movedInOn.trim();
    if (movedInOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(movedInOn)) {
        problems.push({ lotNumber: r.lotNumber, why: "That move-in date doesn't look right." });
        continue;
      }
      if (movedInOn > todayISO) {
        problems.push({
          lotNumber: r.lotNumber,
          why: "That move-in date is in the future — these are people already here.",
        });
        continue;
      }
    }

    // BOTH ARE A CONDITION OF RENTING, so a row without them does not file.
    // Named, never silent: the whole point of the screen is that a household
    // left off the roll is a household nobody bills.
    const email = r.email.trim().toLowerCase();
    const phone = r.phone.trim();
    const contact = contactProblem(email, phone);
    if (contact) {
      problems.push({ lotNumber: r.lotNumber, why: contact });
      continue;
    }

    // WHEN THE SIGNED LEASE RUNS FROM. Resolved here so the summary can say
    // which month bills first, and refused here — by the same rule the server
    // applies — so a date before go-live names its lot instead of failing at
    // the end of the afternoon.
    let agreementStartsOn: string | null = null;
    if (r.signedNewLease) {
      const at = agreementStartFor(r.agreementStartsOn, todayISO, cutoverDate);
      if (!at.ok) {
        problems.push({ lotNumber: r.lotNumber, why: at.error });
        continue;
      }
      agreementStartsOn = at.start;
    }

    toFile.push({
      lotId: r.lotId, lotNumber: r.lotNumber, displayName: name, rent, movedInOn,
      signedNewLease: r.signedNewLease, agreementStartsOn, email, phone,
    });
  }

  return { toFile, skipped: blankLotNumbers.length, problems, blankLotNumbers };
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What he is about to write, before he writes it.
 *
 * Names the monthly total because that is the number he will check against his
 * own roll, and names the lots with no rent because those are the ones that
 * will silently not be billed.
 */
export function onboardSummary(
  plan: OnboardPlan,
  capMonths: number | null,
  /**
   * What the biller will ADD to each signed household, per month.
   *
   * THE SCREEN TOTALLED RENT AND THE RUN CHARGES MORE. A grounds fee lands on
   * every tenancy signed with this owner (feesForTenancy), and the word "fee"
   * did not appear anywhere on this screen — so filing twenty households at
   * $400 read "$8,000 a month" and the January run would raise $10,850.60. The
   * number he checks against his own roll has to be the number that bills.
   *
   * Defaulted to 0, so a park with no fees reads exactly as it did before.
   */
  feePerSignedLot = 0,
): string {
  if (plan.toFile.length === 0) {
    return plan.problems.length > 0
      ? "Nothing to file yet — fix the lines below."
      : "Nothing filled in yet.";
  }

  const withRent = plan.toFile.filter((r) => r.rent != null);
  const rentTotal = withRent.reduce((s, r) => s + (r.rent ?? 0), 0);

  // Only a SIGNED household is charged a fee, and only one with a rent is
  // billed at all — so the fee rides on the intersection, not on the headcount.
  const feePayers = withRent.filter((r) => r.signedNewLease).length;
  const feeTotal = Math.round(feePerSignedLot * feePayers * 100) / 100;
  const total = Math.round((rentTotal + feeTotal) * 100) / 100;

  const parts = [
    `File ${plan.toFile.length} ${plan.toFile.length === 1 ? "household" : "households"}` +
    (withRent.length === 0
      ? ""
      : feeTotal > 0
        // Shown as its own arithmetic. A single total he cannot decompose is a
        // number he has to trust rather than check.
        ? ` — ${money(rentTotal)} rent + ${money(feeTotal)} fees = ${money(total)} a month`
        : ` — ${money(rentTotal)} a month`),
  ];

  // The split he actually cares about on the first morning.
  const signedRows = plan.toFile.filter((r) => r.signedNewLease);
  const holdoverRows = plan.toFile.filter((r) => !r.signedNewLease);
  const signed = signedRows.length;
  const holdover = holdoverRows.length;
  if (signed > 0 && holdover > 0) {
    // NAMED, NOT COUNTED. One missed tick is a household on the old
    // arrangement — no new lease and, because a fee never lands on an
    // inherited tenancy, no fee either. At twenty rows a bare count will not
    // find which one, and the difference is silent on every later screen.
    const named = holdoverRows.map((r) => `lot ${r.lotNumber}`).join(", ");
    parts.push(
      `${signed} on the new lease, ${holdover} on the arrangement they already had ` +
      `(${named})` +
      (feePerSignedLot > 0 ? ` — no fee will bill for ${holdover === 1 ? "it" : "those"}` : ""),
    );
  } else if (holdover > 0) {
    // THE ORDINARY CASE, AND NOT A FAILING. On the first morning nobody has
    // signed anything — that is what onboarding an occupied park means. This
    // used to read "None have signed the new lease YET", which turns the normal
    // state into a chore outstanding.
    parts.push(
      `all on the arrangement they already had` +
      (capMonths == null ? "" : `, so your ${capRule(capMonths)} doesn't apply until they sign`),
    );
  } else {
    parts.push(
      `all on the new lease` +
      (capMonths == null ? "" : `, capped by your ${capRule(capMonths)}`),
    );
  }

  // WHICH MONTH BILLS FIRST, AND FOR HOW MUCH. The total above is "a month";
  // the first month is only that when every signed lease starts on the 1st.
  // Filed on the 4th for the 4th it is a part month, and the number he checks
  // against his leases has to be the one that bills.
  const firstMonth = firstBilledMonth(plan, feePerSignedLot);
  if (firstMonth) parts.push(firstMonth);

  const noRent = plan.toFile.filter((r) => r.rent == null).map((r) => r.lotNumber);
  if (noRent.length > 0) {
    parts.push(
      `${noRent.length} with no rent set (${noRent.map((l) => `lot ${l}`).join(", ")}) — ` +
      `those won't be billed until you set one`,
    );
  }
  if (plan.skipped > 0) parts.push(`${plan.skipped} still to do`);

  return parts.join(" · ");
}

/**
 * THE AGREEMENT CAP, IN WORDS, ONLY WHEN ONE EXISTS.
 *
 * `parks.max_agreement_months` is a per-park dial and it is frequently unset —
 * as of today NO park in the database has one. Three separate sentences used to
 * say "your three-month rule" as a flat fact, which was a rule the reader had
 * never set, on a screen asking them to file nineteen real households. Copy
 * that states a policy the park does not have teaches the owner to stop
 * believing the screen.
 */
function capRule(months: number): string {
  return `${months === 1 ? "one" : months}-month rule`;
}

/**
 * The first month a signed lease bills, in words, with its figure.
 *
 * Only the SIGNED rows with a rent are counted — a holdover starts today and
 * is billed as it always was, and a row with no rent is not billed at all.
 * When every signed lease starts on the 1st of one month the figure is the
 * whole month; otherwise it is a part month and says so rather than quoting a
 * number the run will not raise.
 */
function firstBilledMonth(plan: OnboardPlan, feePerSignedLot: number): string | null {
  const signed = plan.toFile.filter((r) => r.signedNewLease && r.rent != null && r.agreementStartsOn);
  if (signed.length === 0) return null;
  const earliest = signed.map((r) => r.agreementStartsOn!).sort()[0];
  const month = earliest.slice(0, 7);
  // Only the leases that START in the first month are on its bill; one dated
  // for the month after is simply not there yet.
  const inMonth = signed.filter((r) => r.agreementStartsOn!.slice(0, 7) === month);
  if (!inMonth.every((r) => r.agreementStartsOn!.endsWith("-01"))) {
    return `from ${dayInWords(earliest)}, so ${prettyMonth(month)} bills a part month`;
  }
  const rent = inMonth.reduce((s, r) => s + (r.rent ?? 0), 0);
  const total = Math.round((rent + feePerSignedLot * inMonth.length) * 100) / 100;
  return `from ${dayInWords(earliest)} — ${prettyMonth(month)} bills ${money(total)}`;
}

/**
 * What the tick means, in his words.
 *
 * A real decision with a legal shape, so it is put plainly and the app takes no
 * position beyond describing what each state records.
 *
 * PARK-AGNOSTIC. This used to say "whatever they had with the seller", which is
 * only true for a park that just changed hands. Most parks joining LakeLife
 * already own themselves and have had the same households for years — there is
 * no seller anywhere in their story, and a screen that invents one reads as
 * software written for somebody else.
 *
 * NAMES THE DOOR. "The rule starts applying when they sign" was a promise
 * about a control that did not exist: nothing on the rent roll could record a
 * signature, so a household filed clear stayed clear — and fee-exempt —
 * forever. The control exists now and this sentence says where it is.
 *
 * THE TERM, NOT THE CAP. This took the park's ceiling and said 'a fresh
 * agreement under your 3-month rule' at The Haven, where commitOnboarding
 * writes ONE month (agreementMonthsFor: the house style under the cap). It
 * takes the length now — what is actually written — and says that.
 */
export function signingExplainer(termMonths: number | null): string {
  return (
    "Tick anyone who has signed your new lease — those get a fresh" +
    (termMonths == null ? " agreement. " : ` ${termMonths === 1 ? "one" : termMonths}-month agreement. `) +
    "Leave it clear for everyone still on the arrangement they already had: " +
    "that carries on exactly as it is. When one of them signs, record it from " +
    // The control's own words, from their one home — never retyped here.
    `their row on the rent roll ('${SIGNED_LEASE_LABEL}') — the new ` +
    // The CAP is not the length: a park with a one-month house style under
    // a three-month cap writes one month, so "your 3-month rule starts from
    // that day" would quote a number the successor does not carry.
    "agreement starts from the day the lease runs from. Either way they're " +
    "on the roll and they get billed."
  );
}
