import { describe, it, expect } from "vitest";
import {
  chargeForLot, runMeters, meterRunSummary, meterProblemText,
  type MeterReading, type MeterProblem,
} from "./meter-helpers";

const r = (readOn: string, reading: number, over = {}): MeterReading => ({
  id: `r-${readOn}`, readOn, reading, rollover: false, meterReplaced: false, ...over,
});

const base = { lotId: "l1", lotLabel: "1", hasMeter: true, centsPerKwh: 12.4 };

describe("the ordinary month", () => {
  it("bills the difference between two readings", () => {
    const c = chargeForLot({ ...base, readings: [r("2027-03-01", 10_450), r("2027-04-01", 10_902)] });
    expect(c.used).toBe(452);
    expect(c.amount).toBe(56.05);          // 452 × 12.4c
    expect(c.problem).toBeNull();
    expect(c.basis).toContain("452 kWh");
  });

  it("spans whatever gap exists — a missed month is not estimated", () => {
    // Two months between readings. The real reading settles it correctly;
    // inventing a middle one is where disputes come from.
    const c = chargeForLot({ ...base, readings: [r("2027-01-01", 10_000), r("2027-03-01", 11_000)] });
    expect(c.used).toBe(1000);
    expect(c.from).toBe("2027-01-01");
    expect(c.to).toBe("2027-03-01");
  });

  it("bills nothing for a month with no usage", () => {
    const c = chargeForLot({ ...base, readings: [r("2027-03-01", 500), r("2027-04-01", 500)] });
    expect(c.used).toBe(0);
    expect(c.amount).toBe(0);
    expect(c.problem).toBeNull();
  });
});

describe("what it REFUSES to bill", () => {
  it("treats a FIRST reading as a baseline, never a bill", () => {
    // Billing the face value charges a new tenant for every unit since the
    // pedestal was installed.
    const c = chargeForLot({ ...base, readings: [r("2027-03-01", 10_450)] });
    expect(c.problem).toBe("no_previous");
    expect(c.amount).toBeNull();
    expect(meterProblemText("no_previous", "1")).toMatch(/starting point/i);
  });

  it("REFUSES a backwards dial rather than guessing why", () => {
    // Rolled over, replaced, or misread — three very different bills, and
    // nothing in the data tells them apart.
    const c = chargeForLot({ ...base, readings: [r("2027-03-01", 99_500), r("2027-04-01", 300)] });
    expect(c.problem).toBe("went_backwards");
    expect(c.amount).toBeNull();
    expect(meterProblemText("went_backwards", "1")).toMatch(/won't guess/i);
  });

  it("carries over the dial ONLY when a human confirms the rollover", () => {
    const c = chargeForLot({
      ...base,
      readings: [r("2027-03-01", 99_500), r("2027-04-01", 300, { rollover: true })],
    });
    // 99999 − 99500 + 1 + 300 = 800
    expect(c.used).toBe(800);
    expect(c.amount).toBe(99.2);
    expect(c.basis).toContain("rolled past");
  });

  it("starts from zero on a replaced meter", () => {
    const c = chargeForLot({
      ...base,
      readings: [r("2027-03-01", 99_500), r("2027-04-01", 240, { meterReplaced: true })],
    });
    expect(c.used).toBe(240);
    expect(c.basis).toMatch(/new meter/i);
  });

  it("bills nothing on a lot with no meter", () => {
    const c = chargeForLot({ ...base, hasMeter: false, readings: [] });
    expect(c.problem).toBe("unmetered");
    expect(c.amount).toBeNull();
  });

  it("bills nothing with no rate set", () => {
    const c = chargeForLot({
      ...base, centsPerKwh: null,
      readings: [r("2027-03-01", 100), r("2027-04-01", 200)],
    });
    expect(c.problem).toBe("no_rate");
    expect(c.amount).toBeNull();
  });

  it("gives every problem a sentence", () => {
    for (const p of ["no_previous", "went_backwards", "no_rate", "unmetered"] as MeterProblem[]) {
      expect(meterProblemText(p, "7").length).toBeGreaterThan(20);
    }
  });
});

describe("the monthly run", () => {
  const charges = [
    chargeForLot({ ...base, lotId: "a", lotLabel: "1", readings: [r("2027-03-01", 100), r("2027-04-01", 300)] }),
    chargeForLot({ ...base, lotId: "b", lotLabel: "2", readings: [r("2027-03-01", 500), r("2027-04-01", 650)] }),
    // A backwards dial — must not be sent.
    chargeForLot({ ...base, lotId: "c", lotLabel: "3", readings: [r("2027-03-01", 900), r("2027-04-01", 10)] }),
    // A brand-new meter — nothing to bill, and NOT a question to chase.
    chargeForLot({ ...base, lotId: "d", lotLabel: "4", readings: [r("2027-04-01", 20)] }),
    // No meter at all.
    chargeForLot({ ...base, lotId: "e", lotLabel: "5", hasMeter: false, readings: [] }),
  ];

  it("bills only what it can, and holds the rest back", () => {
    const run = runMeters(charges);
    expect(run.billable.map((c) => c.lotLabel)).toEqual(["1", "2"]);
    expect(run.totalKwh).toBe(350);
    expect(run.totalAmount).toBe(43.4);
  });

  it("counts a backwards dial as a QUESTION but a first reading as neither", () => {
    const run = runMeters(charges);
    expect(run.questions.map((c) => c.lotLabel)).toEqual(["3"]);
  });

  it("names the questions BEFORE the total", () => {
    // A run with an unresolved meter is not one he should send, and the total
    // underneath is incomplete in a way the number cannot show.
    const s = meterRunSummary(runMeters(charges));
    expect(s.indexOf("needs a look")).toBeLessThan(s.indexOf("$"));
    expect(s).toContain("1 meter needs a look");
  });

  it("says so plainly when there is nothing to read", () => {
    expect(meterRunSummary(runMeters([]))).toMatch(/no meters/i);
  });
});
