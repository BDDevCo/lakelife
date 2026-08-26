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
}

export interface OnboardPlan {
  toFile: {
    lotId: string;
    lotNumber: string;
    displayName: string;
    rent: number | null;
    movedInOn: string;
    signedNewLease: boolean;
  }[];
  skipped: number;
  problems: { lotNumber: string; why: string }[];
  /** Lots left blank, by number — named so he can see what is still to do. */
  blankLotNumbers: string[];
}

export function planOnboarding(rows: readonly OnboardRow[], todayISO: string): OnboardPlan {
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

    toFile.push({
      lotId: r.lotId, lotNumber: r.lotNumber, displayName: name, rent, movedInOn,
      signedNewLease: r.signedNewLease,
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
 */
export function signingExplainer(capMonths: number | null): string {
  return (
    "Tick anyone who has signed your new lease — those get a fresh agreement" +
    (capMonths == null ? ". " : ` under your ${capRule(capMonths)}. `) +
    "Leave it clear for everyone still on the arrangement they already had: " +
    "that carries on exactly as it is" +
    (capMonths == null ? "" : ", and the rule starts applying when they sign") +
    ". Either way they're on the roll and they get billed."
  );
}
