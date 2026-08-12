/**
 * FILING THE PEOPLE WHO WERE ALREADY THERE.
 *
 * THE PLAN IS THAT EVERYBODY SIGNS A NEW LEASE AT TAKEOVER, so the default is a
 * fresh agreement under the park's own cap. But on the first morning some will
 * have signed and some will not, and BOTH still live here and still owe rent.
 * The record says which, per household, rather than picking one story for
 * everybody — because a row that claims an agreement nobody signed is the same
 * class of lie as a bill nobody sent.
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
 *   THE SIGNING STATE IS ONE TICK PER ROW. Ticked writes a real agreement under
 *   the cap, because one exists on paper. Clear writes a holdover on the rolling
 *   horizon, which 0065 exempts from the cap — they are living here on whatever
 *   the seller agreed, and until they sign, that is simply the truth.
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
   * horizon, exempt from the cap, because they are living here on whatever the
   * seller agreed and nobody has changed that yet.
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
 * Names the monthly total because that is the number he will check against the
 * seller's roll, and names the lots with no rent because those are the ones
 * that will silently not be billed.
 */
export function onboardSummary(plan: OnboardPlan): string {
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

  // The split he actually cares about on the first morning.
  const signed = plan.toFile.filter((r) => r.signedNewLease).length;
  const holdover = plan.toFile.length - signed;
  if (signed > 0 && holdover > 0) {
    parts.push(`${signed} on the new lease, ${holdover} still on the old arrangement`);
  } else if (holdover > 0) {
    parts.push(
      `${holdover === 1 ? "Nobody has" : "None have"} signed the new lease yet — ` +
      `filed as they are, and your three-month rule doesn't apply until they do`,
    );
  } else {
    parts.push(`all on the new lease, capped by your three-month rule`);
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
 * What the tick means, in his words.
 *
 * A real decision with a legal shape, so it is put plainly and the app takes no
 * position beyond describing what each state records.
 */
export const SIGNING_EXPLAINER =
  "Tick the ones who have signed your new lease — those get a fresh agreement " +
  "under your three-month rule. Leave it clear for anyone still on whatever " +
  "they had with the seller: they keep that arrangement, and the rule starts " +
  "applying when they sign. Either way they're on the roll and they get billed.";
