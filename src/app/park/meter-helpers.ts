/**
 * METERED ELECTRICITY — the one utility billed on what was actually used.
 *
 * The grounds fee covers everything shared: water, sewer, trash, maintenance,
 * and the UNMETERED electric that lights the park. This is the exception —
 * a number read off the pedestal at each lot, turned into consumption by
 * subtracting the previous reading, and billed per unit.
 *
 * THE WHOLE FILE IS ABOUT WHAT IT REFUSES TO DO. Dividing a bill has one
 * failure mode; reading a meter has several, and every one of them lands on
 * somebody's bill:
 *
 *   The dial went BACKWARDS. Rolled over, replaced, or misread — three
 *   different bills, and nothing in the data distinguishes them. So it asks.
 *   A guessed rollover on a misread charges a household for 99,000 kWh.
 *
 *   There is NO PREVIOUS READING. The first read is a baseline. Billing the
 *   face value of the dial charges a new tenant for every unit since the
 *   pedestal was installed.
 *
 *   A MONTH IS MISSING. Consumption spans whatever gap exists between two real
 *   readings. It is never estimated to fill a hole — an estimated utility bill
 *   is where disputes come from, and next month's real reading settles it
 *   correctly anyway.
 */

export interface MeterReading {
  id: string;
  readOn: string;
  reading: number;
  rollover: boolean;
  meterReplaced: boolean;
}

export type MeterProblem =
  | "no_previous"
  | "went_backwards"
  | "no_rate"
  | "unmetered";

export function meterProblemText(p: MeterProblem, lotLabel: string): string {
  switch (p) {
    case "no_previous":
      return `First reading for lot ${lotLabel} — nothing to bill yet. This is the starting point for next time.`;
    case "went_backwards":
      return `Lot ${lotLabel}'s meter reads LOWER than last time. Did it roll past its maximum, get replaced, or get misread? We won't guess — tell us which.`;
    case "no_rate":
      return "No rate set, so there's nothing to bill at. Set cents per kWh first.";
    case "unmetered":
      return `Lot ${lotLabel} has no meter, so there's no electricity to bill.`;
  }
}

export interface MeterCharge {
  lotId: string;
  lotLabel: string;
  from: string;
  to: string;
  previous: number;
  current: number;
  /** kWh. Null when it could not be worked out. */
  used: number | null;
  /** Dollars. Null when there is nothing to bill. */
  amount: number | null;
  problem: MeterProblem | null;
  /** The sentence on the resident's bill. */
  basis: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Work out one lot's charge from its two most recent readings.
 *
 * `readings` must be ordered oldest first. Only the last two matter, but the
 * whole list is taken so a caller cannot accidentally hand over the wrong pair.
 */
export function chargeForLot(input: {
  lotId: string;
  lotLabel: string;
  hasMeter: boolean;
  readings: readonly MeterReading[];
  centsPerKwh: number | null;
  /** The dial's maximum before it wraps — e.g. 99999 on a 5-digit meter. */
  meterMax?: number;
}): MeterCharge {
  const { lotId, lotLabel, hasMeter, readings, centsPerKwh } = input;

  const blank = (problem: MeterProblem | null, prev = 0, cur = 0, from = "", to = ""): MeterCharge => ({
    lotId, lotLabel, from, to, previous: prev, current: cur,
    used: null, amount: null, problem, basis: null,
  });

  if (!hasMeter) return blank("unmetered");
  if (readings.length === 0) return blank("no_previous");

  const current = readings[readings.length - 1];
  const previous = readings[readings.length - 2];

  if (!previous) return blank("no_previous", 0, current.reading, "", current.readOn);
  if (centsPerKwh == null) {
    return blank("no_rate", previous.reading, current.reading, previous.readOn, current.readOn);
  }

  // A REPLACED METER starts from zero. The new dial's reading IS the
  // consumption since it was fitted — there is no earlier number to subtract.
  if (current.meterReplaced) {
    const used = round2(current.reading);
    return {
      lotId, lotLabel, from: previous.readOn, to: current.readOn,
      previous: 0, current: current.reading, used,
      amount: round2((used * centsPerKwh) / 100),
      problem: null,
      basis: `New meter fitted — ${used} kWh since it went in`,
    };
  }

  if (current.reading < previous.reading) {
    // ONLY a human-confirmed rollover carries over the top of the dial.
    if (!current.rollover) {
      return blank("went_backwards", previous.reading, current.reading, previous.readOn, current.readOn);
    }
    const max = input.meterMax ?? nextRollover(previous.reading);
    const used = round2(max + 1 - previous.reading + current.reading);
    return {
      lotId, lotLabel, from: previous.readOn, to: current.readOn,
      previous: previous.reading, current: current.reading, used,
      amount: round2((used * centsPerKwh) / 100),
      problem: null,
      basis: `${used} kWh — meter rolled past ${max}`,
    };
  }

  const used = round2(current.reading - previous.reading);
  return {
    lotId, lotLabel, from: previous.readOn, to: current.readOn,
    previous: previous.reading, current: current.reading, used,
    amount: round2((used * centsPerKwh) / 100),
    problem: null,
    basis: `${used} kWh at ${centsPerKwh}c — ${previous.readOn} to ${current.readOn}`,
  };
}

/** The wrap point for a dial with as many digits as this reading has. */
function nextRollover(previous: number): number {
  const digits = Math.max(4, String(Math.floor(previous)).length);
  return Math.pow(10, digits) - 1;
}

export interface MeterRun {
  charges: MeterCharge[];
  /** Only the ones that will actually be billed. */
  billable: MeterCharge[];
  /** Ones needing a human before they can be. */
  questions: MeterCharge[];
  totalKwh: number;
  totalAmount: number;
}

export function runMeters(charges: readonly MeterCharge[]): MeterRun {
  const billable = charges.filter((c) => c.amount != null && c.problem == null);
  // "Unmetered" and "first reading" are not problems to chase — they are just
  // lots with nothing to bill. Only a genuine ambiguity is a question.
  const questions = charges.filter((c) => c.problem === "went_backwards" || c.problem === "no_rate");
  return {
    charges: [...charges],
    billable,
    questions,
    totalKwh: round2(billable.reduce((s, c) => s + (c.used ?? 0), 0)),
    totalAmount: round2(billable.reduce((s, c) => s + (c.amount ?? 0), 0)),
  };
}

/**
 * What the owner reads before sending anything.
 *
 * Names the QUESTIONS first, because a run with three unresolved meters is not
 * a run he should send — and the total underneath it is incomplete in a way
 * the number itself cannot show.
 */
export function meterRunSummary(run: MeterRun): string {
  if (run.billable.length === 0 && run.questions.length === 0) {
    return "No meters to read yet.";
  }
  const parts: string[] = [];
  if (run.questions.length > 0) {
    parts.push(
      `${run.questions.length} ${run.questions.length === 1 ? "meter needs" : "meters need"} a look before you send anything`,
    );
  }
  if (run.billable.length > 0) {
    parts.push(
      `${run.billable.length} ${run.billable.length === 1 ? "lot" : "lots"}, ${run.totalKwh} kWh, $${run.totalAmount.toFixed(2)}`,
    );
  }
  return parts.join(" · ");
}
