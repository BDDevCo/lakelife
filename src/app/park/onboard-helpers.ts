/**
 * FILING THE PEOPLE WHO WERE ALREADY THERE.
 *
 * The Haven's rent roll names nobody, so the importer wrote 21 lots and 21 rate
 * cards and — correctly — ZERO tenancies: putting a name on a lot the sheet did
 * not name would be inventing a person. That leaves the real first day's work,
 * which is sitting down after closing and filing nineteen households.
 *
 * The existing path is one lot at a time: pick a lot, fill a form, save, go
 * back. Nineteen rounds of that is how half of them end up unfiled, and an
 * unfiled household is not billed at all.
 *
 * TWO THINGS MAKE THIS FAST, AND BOTH ARE ABOUT NOT RETYPING WHAT WE ALREADY
 * KNOW:
 *
 *   THE RENT IS ALREADY ON FILE. The importer wrote each lot's monthly rate off
 *   the seller's roll, so every row arrives pre-filled and he is mostly typing
 *   names. He can correct any of them; a correction is still HIS knowledge, not
 *   the tenant's, so the provenance does not improve just because he retyped it.
 *
 *   THE GRANDFATHERED QUESTION IS ASKED ONCE. Nineteen people who have lived
 *   there for years never agreed to a three-month cap, and imposing one at
 *   closing by default would silently change everybody's terms on day one. So
 *   the default is 'grandfathered' — the database exempts those from the cap
 *   (0065) and they keep the rolling horizon they had.
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
}

export interface OnboardPlan {
  toFile: {
    lotId: string;
    lotNumber: string;
    displayName: string;
    rent: number | null;
    movedInOn: string;
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

    const movedInOn = r.movedInOn.trim() || todayISO;
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

    toFile.push({ lotId: r.lotId, lotNumber: r.lotNumber, displayName: name, rent, movedInOn });
  }

  return { toFile, skipped: blankLotNumbers.length, problems, blankLotNumbers };
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What he is about to write, before he writes it.
 *
 * Names the monthly total because that is the number he will check against the
 * seller's roll, and names the lots with no rent because those are the ones
 * that will silently not be billed.
 */
export function onboardSummary(plan: OnboardPlan, grandfathered: boolean): string {
  if (plan.toFile.length === 0) {
    return plan.problems.length > 0
      ? "Nothing to file yet — fix the lines below."
      : "Nothing filled in yet.";
  }

  const withRent = plan.toFile.filter((r) => r.rent != null);
  const total = withRent.reduce((s, r) => s + (r.rent ?? 0), 0);
  const parts = [
    `File ${plan.toFile.length} ${plan.toFile.length === 1 ? "household" : "households"}` +
    (withRent.length > 0 ? ` — ${money(total)} a month` : ""),
  ];

  const noRent = plan.toFile.filter((r) => r.rent == null).map((r) => r.lotNumber);
  if (noRent.length > 0) {
    parts.push(
      `${noRent.length} with no rent set (${noRent.map((l) => `lot ${l}`).join(", ")}) — ` +
      `those won't be billed until you set one`,
    );
  }
  if (plan.skipped > 0) parts.push(`${plan.skipped} left for later`);

  parts.push(
    grandfathered
      ? "Recorded as already living here, so your three-month rule doesn't apply to them"
      : "Recorded as new agreements under your three-month rule",
  );
  return parts.join(" · ");
}

/**
 * The choice, in his words, asked once.
 *
 * This is a real decision with a legal shape, so it is put plainly and the app
 * takes no position beyond describing what each option does.
 */
export const GRANDFATHERED_EXPLAINER =
  "These nineteen were living here before you bought it, on whatever Michael " +
  "agreed with them. Filing them as already here keeps their arrangement as it " +
  "was — your three-month rule starts applying when you next write an agreement " +
  "with them, not on day one.";

export const NEW_AGREEMENT_EXPLAINER =
  "This writes everybody a fresh three-month agreement starting now. That is a " +
  "change to their terms, so it needs whatever notice their arrangement and " +
  "Indiana law require — worth asking your attorney before you pick this.";
