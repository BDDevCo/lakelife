import { describe, it, expect } from "vitest";
import {
  planAllocations, plannedByKey, describeAllocations, allocatedTotal, allocationWords, withRaisedAgain, proratedBasisOf,
  oldestFirst, planSettlement, describeSettlement, money, splitApplied, heldOnAccountFor,
} from "./allocations";

/**
 * WHICH DOLLARS PAY WHICH BILL — the arithmetic behind 0167, checked against
 * the owner's own example: $1,627.59 paid ahead, three months of $542.53.
 * The preview and the run both call planAllocations, so these are the
 * numbers the owner reads on the preview AND the rows the run writes.
 */
const src = (paymentId: string, remaining: number, receivedOn: string, renterId = "r7") =>
  ({ paymentId, renterId, remaining, receivedOn });
const bill = (key: string, owing: number, renterId = "r7") => ({ key, renterId, owing });

describe("planAllocations", () => {
  it("a quarter ahead settles three months exactly and a fourth gets nothing", () => {
    const plan = planAllocations(
      [bill("jan", 542.53), bill("feb", 542.53), bill("mar", 542.53), bill("apr", 542.53)],
      [src("q", 1627.59, "2026-12-28")],
    );
    expect(plan).toEqual([
      { key: "jan", paymentId: "q", amount: 542.53 },
      { key: "feb", paymentId: "q", amount: 542.53 },
      { key: "mar", paymentId: "q", amount: 542.53 },
    ]);
    expect(plannedByKey(plan).total).toBe(1627.59);
    expect(plannedByKey(plan).byKey.get("apr")).toBeUndefined();
  });

  it("oldest money first, and one bill may draw on two payments", () => {
    const plan = planAllocations(
      [bill("feb", 542.53)],
      [src("newer", 100, "2027-01-20"), src("older", 500, "2026-12-28")],
    );
    expect(plan).toEqual([
      { key: "feb", paymentId: "older", amount: 500 },
      { key: "feb", paymentId: "newer", amount: 42.53 },
    ]);
  });

  it("two cheques on one day fall back to created_at, then id, so the order is stable", () => {
    const a = { ...src("b", 100, "2026-12-28"), createdAt: "2026-12-28T10:00:00Z" };
    const b = { ...src("a", 100, "2026-12-28"), createdAt: "2026-12-28T09:00:00Z" };
    expect(planAllocations([bill("jan", 150)], [a, b]).map((p) => p.paymentId)).toEqual(["a", "b"]);
    const c = src("y", 100, "2026-12-28"); const d = src("x", 100, "2026-12-28");
    expect(planAllocations([bill("jan", 150)], [c, d]).map((p) => p.paymentId)).toEqual(["x", "y"]);
  });

  it("never applies another household's money", () => {
    const plan = planAllocations([bill("jan", 542.53, "r7")], [src("theirs", 1000, "2026-12-28", "r9")]);
    expect(plan).toEqual([]);
  });

  it("a bill with no household, a bill owing nothing, and money with nothing left all get nothing", () => {
    expect(planAllocations([bill("jan", 542.53, null as unknown as string)], [src("q", 1000, "2026-12-28")])).toEqual([]);
    expect(planAllocations([bill("jan", 0)], [src("q", 1000, "2026-12-28")])).toEqual([]);
    expect(planAllocations([bill("jan", 542.53)], [src("q", 0, "2026-12-28")])).toEqual([]);
    expect(planAllocations([bill("jan", 542.53)], [src("q", 0.004, "2026-12-28")])).toEqual([]);
  });

  it("the household's pool is shared across its bills in one run", () => {
    // A final part-month and a renewal both billed in one run: $600 on
    // account covers the first and part of the second, not both in full.
    const plan = planAllocations([bill("last", 271.05), bill("next", 542.53)], [src("q", 600, "2026-12-28")]);
    expect(plan).toEqual([
      { key: "last", paymentId: "q", amount: 271.05 },
      { key: "next", paymentId: "q", amount: 328.95 },
    ]);
    expect(plannedByKey(plan).total).toBe(600);
  });

  it("does not drift on cent arithmetic", () => {
    const bills = Array.from({ length: 12 }, (_, i) => bill(`m${i}`, 0.1));
    const plan = planAllocations(bills, [src("q", 1.2, "2026-12-28")]);
    expect(plan).toHaveLength(12);
    expect(plan.every((p) => p.amount === 0.1)).toBe(true);
    expect(plannedByKey(plan).total).toBe(1.2);
  });
});

describe("describeAllocations", () => {
  it("names each month in order, then what is still on account", () => {
    expect(describeAllocations(
      [{ periodMonth: "2027-02", amount: 542.53 }, { periodMonth: "2027-01", amount: 542.53 }],
      542.53,
    )).toBe("$542.53 to January 2027, $542.53 to February 2027, $542.53 on account");
  });

  it("says nothing about 'on account' when nothing is left, and nothing at all when nothing happened", () => {
    expect(describeAllocations([{ periodMonth: "2027-01", amount: 200 }], 0)).toBe("$200.00 to January 2027");
    expect(describeAllocations([], 0)).toBe("");
    expect(describeAllocations([], 57.47)).toBe("$57.47 on account");
  });

  it("formats thousands the way a receipt does", () => {
    expect(describeAllocations([], 1085.06)).toBe("$1,085.06 on account");
  });

  it("names the bill raised again for the cancelled bill's own month apart from it (0169), and only that line", () => {
    // The move-out re-raises January under the same period_month, so
    // "$472.53 to January 2027" right after "their January 2027 bill was
    // cancelled" was two bills under one word. Marked lines say which.
    expect(describeAllocations(
      [{ periodMonth: "2027-02", amount: 70 }, { periodMonth: "2027-01", amount: 472.53, raisedAgain: { basis: "27 of 31 days" } }],
      0,
    )).toBe("$472.53 to the bill raised again for January 2027 (27 of 31 days), $70.00 to February 2027");
    // A whole-month re-raise (a new rent) has no days basis to print.
    expect(allocationWords({ periodMonth: "2027-01", amount: 600, raisedAgain: { basis: null } })).toBe("$600.00 to the bill raised again for January 2027");
    // Unmarked, every line keeps its shape.
    expect(allocationWords({ periodMonth: "2027-01", amount: 600 })).toBe("$600.00 to January 2027");
  });

  it("withRaisedAgain marks a line only when its month is the released-from month, with the re-raised bill's own basis", () => {
    const lines = [{ label: "Lot rent", amount: 348.39, basis: "27 of 31 days" }, { label: "Grounds", amount: 124.14, basis: "27 of 31 days" }];
    expect(withRaisedAgain({ periodMonth: "2027-01", amount: 472.53 }, "2027-01", lines))
      .toEqual({ periodMonth: "2027-01", amount: 472.53, raisedAgain: { basis: "27 of 31 days" } });
    // Another month, no released-from month, or a null one: untouched, and no key added.
    expect(withRaisedAgain({ periodMonth: "2027-02", amount: 70 }, "2027-01", lines)).toEqual({ periodMonth: "2027-02", amount: 70 });
    expect(withRaisedAgain({ periodMonth: "2027-01", amount: 472.53 }, null, lines)).toEqual({ periodMonth: "2027-01", amount: 472.53 });
    expect("raisedAgain" in withRaisedAgain({ periodMonth: "2027-01", amount: 472.53 }, undefined, lines)).toBe(false);
    // The basis is the bill's frozen one; "for the month" and no snapshot are no basis.
    expect(proratedBasisOf(lines)).toBe("27 of 31 days");
    expect(proratedBasisOf([{ label: "Lot rent", amount: 400, basis: "for the month" }])).toBeNull();
    expect(proratedBasisOf([])).toBeNull();
    expect(proratedBasisOf(null)).toBeNull();
    expect(withRaisedAgain({ periodMonth: "2027-01", amount: 600 }, "2027-01", null)).toEqual({ periodMonth: "2027-01", amount: 600, raisedAgain: { basis: null } });
  });

  it("allocatedTotal is exact to the cent", () => {
    expect(allocatedTotal([{ periodMonth: "2027-01", amount: 542.53 }, { periodMonth: "2027-02", amount: 542.53 }, { periodMonth: "2027-03", amount: 542.53 }])).toBe(1627.59);
  });
});

/**
 * OLDEST BILL FIRST (R1). "Applied to the months if there is a prepay" read
 * both ways: a household in arrears has its OLDEST open bill settled before
 * the one being raised, and money recorded on account settles what is open
 * the moment it arrives. The order is a pure function of the bills' own
 * months, so the preview, the run and every recording door agree.
 */
describe("planSettlement — the household's oldest open bill first", () => {
  const open = (key: string, periodMonth: string, owing: number, dueOn = `${periodMonth}-01`) =>
    ({ key, renterId: "r7", owing, periodMonth, dueOn });

  it("January in arrears is settled before February, whatever order the bills arrived in", () => {
    const plan = planSettlement(
      [open("feb", "2027-02", 542.53), open("jan", "2027-01", 542.53)],
      [src("q", 600, "2027-01-20")],
    );
    expect(plan).toEqual([
      { key: "jan", paymentId: "q", amount: 542.53 },
      { key: "feb", paymentId: "q", amount: 57.47 },
    ]);
  });

  it("oldestFirst: month, then due date, then key — stable for two bills in one month", () => {
    const bills = [
      open("renewal", "2027-02", 542.53, "2027-02-01"),
      open("part", "2027-02", 271.05, "2027-01-15"),
      open("dec", "2026-12", 40),
      open("b", "2027-03", 1), open("a", "2027-03", 1),
    ];
    expect(oldestFirst(bills).map((b) => b.key)).toEqual(["dec", "part", "renewal", "a", "b"]);
    // Not sorted in place.
    expect(bills[0].key).toBe("renewal");
  });

  it("a bill with no month sorts first only against itself — the plan still never over-applies", () => {
    const plan = planSettlement(
      [{ key: "x", renterId: "r7", owing: 10 }, open("jan", "2027-01", 10)],
      [src("q", 15, "2027-01-20")],
    );
    expect(plannedByKey(plan).total).toBe(15);
  });

  it("describeSettlement names the months in order, and a filter narrows it to one payment's lines", () => {
    const s = {
      lines: [
        { key: "jan", paymentId: "old", amount: 542.53 },
        { key: "dec", paymentId: "new", amount: 40 },
        { key: "jan", paymentId: "new", amount: 17.47 },
      ],
      bills: [open("dec", "2026-12", 40), open("jan", "2027-01", 560)],
    };
    expect(describeSettlement(s)).toBe("$40.00 went against December 2026 and $560.00 against January 2027");
    expect(describeSettlement(s, (l) => l.paymentId === "new")).toBe("$40.00 went against December 2026 and $17.47 against January 2027");
    expect(describeSettlement(s, (l) => l.paymentId === "old")).toBe("$542.53 went against January 2027");
    expect(describeSettlement(s, () => false)).toBe("");
  });

  it("money() is the one shape — thousands with a comma, always two decimals", () => {
    expect(money(1085.06)).toBe("$1,085.06");
    expect(money(600)).toBe("$600.00");
    expect(money(0)).toBe("$0.00");
  });
});

// ---------------------------------------------------------------------------
// WHICH DOLLARS ARE THE NEW BILLS' AND WHICH ARE OLDER BILLS' — one partition
// for the preview and the run. The preview planned the older-bill dollars
// and discarded them; the run partitioned by hand; the two sentences did not
// match. One helper, sorted by month, no subtraction.
// ---------------------------------------------------------------------------
describe("splitApplied", () => {
  const monthOf = (k: string) => ({ jan: "2027-01", dec: "2026-12" } as Record<string, string>)[k];

  it("sorts each applied dollar once: new bills to fromOnAccount, older ones named by month, oldest first", () => {
    const applied = new Map([["feb-res", 57.47], ["jan", 542.53], ["dec", 40]]);
    const out = splitApplied(applied, new Set(["feb-res"]), monthOf);
    expect(out.fromOnAccount).toBe(57.47);
    expect(out.toOlderBills).toEqual([
      { key: "dec", periodMonth: "2026-12", amount: 40 },
      { key: "jan", periodMonth: "2027-01", amount: 542.53 },
    ]);
  });

  it("nothing older reads as none, and a zero line is not a line", () => {
    expect(splitApplied(new Map([["feb-res", 542.53]]), new Set(["feb-res"]), monthOf)).toEqual({ fromOnAccount: 542.53, toOlderBills: [] });
    expect(splitApplied(new Map([["jan", 0]]), new Set(), monthOf)).toEqual({ fromOnAccount: 0, toOlderBills: [] });
    expect(splitApplied(new Map(), new Set(["feb-res"]), monthOf)).toEqual({ fromOnAccount: 0, toOlderBills: [] });
  });

  it("is exact to the cent across many new bills", () => {
    const applied = new Map(Array.from({ length: 18 }, (_, i) => [`r${i}`, 542.53] as [string, number]));
    expect(splitApplied(applied, new Set(applied.keys()), monthOf).fromOnAccount).toBe(9765.54);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE PARK STILL HOLDS OF ONE HOUSEHOLD'S — the close-out door's read
// after a move-out, from the same view the held panel uses. A failed read
// travels back as an error, never as "nothing held".
// ---------------------------------------------------------------------------
describe("heldOnAccountFor", () => {
  type Row = Record<string, unknown>;
  const fake = (rows: Record<string, Row[]>, fail: string | null = null) => ({
    from: (t: string) => {
      const fs: Array<(r: Row) => boolean> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { fs.push((r) => r[c] === v); return q; },
        gt: (c: string, v: number) => { fs.push((r) => Number(r[c]) > v); return q; },
        is: (c: string, v: unknown) => { fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
        then: (ok: (x: { data: Row[] | null; error: unknown }) => unknown) =>
          Promise.resolve(fail === t ? { data: null, error: { message: "boom" } } : { data: (rows[t] ?? []).filter((r) => fs.every((f) => f(r))), error: null }).then(ok),
      };
      return q;
    },
  });
  const rows = {
    park_on_account_payments: [
      { park_id: "p", renter_id: "r9", remaining: 57.47 },
      { park_id: "p", renter_id: "r9", remaining: 0 },
      { park_id: "p", renter_id: "r14", remaining: 1085.06 },
    ],
    park_payments: [
      { park_id: "p", renter_id: "r9", kind: "deposit", amount: 500, reversed_at: null, returned_at: null, returned_on: null },
      { park_id: "p", renter_id: "r9", kind: "deposit", amount: 200, reversed_at: null, returned_at: null, returned_on: "2027-01-05" },
      { park_id: "p", renter_id: "r9", kind: "rent", amount: 999, reversed_at: null, returned_at: null, returned_on: null },
    ],
  };

  it("sums the household's remaining and its deposits still held — theirs only", async () => {
    expect(await heldOnAccountFor(fake(rows) as never, "p", "r9")).toEqual({ remaining: 57.47, depositsHeld: 500, error: null });
    expect(await heldOnAccountFor(fake(rows) as never, "p", "r14")).toEqual({ remaining: 1085.06, depositsHeld: 0, error: null });
    expect(await heldOnAccountFor(fake(rows) as never, "p", "r1")).toEqual({ remaining: 0, depositsHeld: 0, error: null });
  });

  it("a failed read is an error, not nothing held", async () => {
    const a = await heldOnAccountFor(fake(rows, "park_on_account_payments") as never, "p", "r9");
    expect(a.error).toBeTruthy();
    const b = await heldOnAccountFor(fake(rows, "park_payments") as never, "p", "r9");
    expect(b.error).toBeTruthy();
  });
});
