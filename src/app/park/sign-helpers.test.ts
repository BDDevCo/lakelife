import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  planSigning, defaultSigningDay, firstMonthBills, agreementAlreadyOver, agreementEndFrom,
  alreadyOverClause, signingRentSeed, SIGNED_LEASE_LABEL,
  type Holdover, type SigningContext, type SigningInput,
} from "./sign-helpers";
import { contactProblem, signingExplainer } from "./onboard-helpers";
import {
  buildTenant, capitalise, SIGNED_LEASE_LABEL as LABEL_AT_HOME, alreadyOverClause as CLAUSE_AT_HOME,
  type TenantInput,
} from "./park-helpers";
import { feesForTenancy } from "./fee-helpers";
import { buildStatement } from "./statement-helpers";
import { parseDaterange } from "@/lib/parks";

/**
 * THEY SIGNED THE NEW LEASE — the arithmetic of the transition.
 *
 * The Haven, as it will really be on 1 January 2027: the roll imported as
 * eighteen grandfathered holdovers [2027-01-01, 2028-01-01), the Grounds fee
 * $142.53 monthly, one-month house style under a three-month cap, and every
 * household signing for $400. Before this door existed the January run
 * raised 18 × $400 and no fee, forever.
 */

const HAVEN: SigningContext = {
  todayISO: "2027-01-01",
  cutoverDate: "2027-01-01",
  defaultAgreementMonths: 1,
  maxAgreementMonths: 3,
  nowISO: "2027-01-01T15:00:00.000Z",
  feePerMonth: 142.53,
};

/** The row the importer writes for Lot 14, exactly. */
const imported = (over: Partial<Holdover> = {}): Holdover => ({
  id: "res-14",
  park_lot_id: "lot-14",
  renter_id: "file-14",
  renter_unit_id: null,
  term: "monthly",
  quoted_amount: 275,
  agreement_chain_id: "chain-14",
  agreement_seq: 1,
  due_day: null,
  tenancy_began_on: "2015-04-02",
  amount_source: "prior_roll",
  amount_source_at: null,
  range: { start: "2027-01-01", end: "2028-01-01" },
  status: "active",
  origin: "grandfathered",
  ...over,
});

const signed = (over: Partial<SigningInput> = {}): SigningInput => ({
  signedOn: "2027-01-01", rent: "400", email: "Doris@Example.com", mobile: "(260) 555-0114", ...over,
});

const GROUNDS = [{ label: "Grounds fee", amount: 142.53, cadence: "monthly" }];

describe("the transition is end-the-holdover + insert-a-successor", () => {
  it("an imported row signed on its first day never had a day — it is cancelled, not trimmed", () => {
    const p = planSigning(signed(), imported(), HAVEN);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // An empty range is refused by the database (lot_reservations_during_check).
    expect(p.holdover).toEqual({ id: "res-14", cancel: true });
  });

  it("the successor is the same household, one link on, on the park's paper", () => {
    const p = planSigning(signed(), imported(), HAVEN);
    if (!p.ok) throw new Error(p.error);
    expect(p.successor).toMatchObject({
      park_lot_id: "lot-14",
      renter_id: "file-14",             // no second renter file
      during: "[2027-01-01,2027-02-01)", // the house style, not the cap
      status: "active",
      term: "monthly",
      quoted_amount: 400,
      origin: "office",                  // the door's fact — never copied
      agreement_chain_id: "chain-14",    // consecutive: the chain continues
      agreement_seq: 2,
      deposit_amount: null,              // no deposit on a renewal (0062)
      tenancy_began_on: "2015-04-02",    // the household's own facts travel
      due_day: null,
    });
    // The rent changed, so it is the owner's knowledge as of now.
    expect(p.successor.amount_source).toBe("owner_knowledge");
    expect(p.successor.amount_source_at).toBe(HAVEN.nowISO);
  });

  it("the rent on a signed lease is never the seller's roll — even when the number is unchanged", () => {
    // successorRow copies amount_source when the figure did not move, which
    // is right for a renewal and wrong here: a holdover at $275 signing for
    // $275 carried 'prior_roll' onto the park's own paper.
    const p = planSigning(signed({ rent: "275" }), imported({ quoted_amount: 275, amount_source: "prior_roll" }), HAVEN);
    if (!p.ok) throw new Error(p.error);
    expect(p.successor.quoted_amount).toBe(275);
    expect(p.successor.amount_source).not.toBe("prior_roll");
    expect(p.successor.amount_source).toBe("owner_knowledge");
    expect(p.successor.amount_source_at).toBe(HAVEN.nowISO);
  });

  it("the successor is paid MONTHLY whatever the holdover was filed as", () => {
    // The rent typed on this form is a monthly figure and the toast quotes a
    // month. A successor copying a yearly holdover's term would be a row the
    // charge run refuses ('filed as paid yearly') while the toast said
    // January bills $542.53.
    const p = planSigning(signed(), imported({ term: "annual", quoted_amount: 3300 }), HAVEN);
    if (!p.ok) throw new Error(p.error);
    expect(p.successor.term).toBe("monthly");
    expect(p.successor.quoted_amount).toBe(400);
  });

  it("is always active — a signing is only ever recorded on or after its day", () => {
    const p = planSigning(signed(), imported(), HAVEN);
    if (!p.ok) throw new Error(p.error);
    expect(p.successor.status).toBe("active");
  });

  it("a 1 January holdover recorded on the 4th WITH the 1 January date bills the full month", () => {
    // The office records the New Year signings on Monday the 4th. The date on
    // the form is the day the lease runs from — the 1st — so the holdover
    // never had a day and January is the lease's whole month, $542.53. Dated
    // from the 4th instead (the old default: today) the holdover would have
    // billed three days of the seller's $275 and the lease 28/31 of $542.53.
    const onTheFourth = { ...HAVEN, todayISO: "2027-01-04" };
    const p = planSigning(signed({ signedOn: "2027-01-01" }), imported(), onTheFourth);
    if (!p.ok) throw new Error(p.error);
    expect(p.holdover).toEqual({ id: "res-14", cancel: true });
    expect(p.successor.during).toBe("[2027-01-01,2027-02-01)");
    const st = buildStatement({
      month: "2027-01",
      stay: parseDaterange(p.successor.during)!,
      rent: p.successor.quoted_amount,
      fees: feesForTenancy(GROUNDS, { rental_mode: "long_term" }, { origin: p.successor.origin }),
      dueDay: 1,
    });
    expect(st.total).toBe(542.53);
    expect(p.signal).toBe(
      "On the new lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).",
    );

    // And the defect, kept: dated from the day it was recorded.
    const wrong = planSigning(signed({ signedOn: "2027-01-04" }), imported(), onTheFourth);
    if (!wrong.ok) throw new Error(wrong.error);
    expect(wrong.holdover).toEqual({ id: "res-14", trimTo: { start: "2027-01-01", end: "2027-01-04" } });
    const short = buildStatement({
      month: "2027-01",
      stay: parseDaterange(wrong.successor.during)!,
      rent: wrong.successor.quoted_amount,
      fees: feesForTenancy(GROUNDS, { rental_mode: "long_term" }, { origin: wrong.successor.origin }),
      dueDay: 1,
    });
    expect(short.total).toBeLessThan(542.53);
  });

  it("January then bills $542.53 — the number the fee rule promised", () => {
    const p = planSigning(signed(), imported(), HAVEN);
    if (!p.ok) throw new Error(p.error);
    const st = buildStatement({
      month: "2027-01",
      stay: parseDaterange(p.successor.during)!,
      rent: p.successor.quoted_amount,
      fees: feesForTenancy(GROUNDS, { rental_mode: "long_term" }, { origin: p.successor.origin }),
      dueDay: 1,
    });
    expect(st.total).toBe(542.53);
    // And the holdover, had it stood, would have billed no fee at all.
    expect(feesForTenancy(GROUNDS, { rental_mode: "long_term" }, { origin: "grandfathered" })).toEqual([]);
  });

  it("says which month bills first, in words, with the real figure", () => {
    const p = planSigning(signed(), imported(), HAVEN);
    if (!p.ok) throw new Error(p.error);
    expect(p.signal).toBe(
      "On the new lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).",
    );
    expect(p.signal).not.toMatch(/2027-01/);
  });

  it("a holdover already running is TRIMMED to end on the signing day — no move-out, nobody left", () => {
    // Filed on "Who lives here" on 20 December, unsigned; signs on the 15th.
    const p = planSigning(
      signed({ signedOn: "2027-01-15" }),
      imported({ range: { start: "2026-12-20", end: "2027-12-20" } }),
      { ...HAVEN, todayISO: "2027-01-15" },
    );
    if (!p.ok) throw new Error(p.error);
    expect(p.holdover).toEqual({ id: "res-14", trimTo: { start: "2026-12-20", end: "2027-01-15" } });
    expect(p.successor.during).toBe("[2027-01-15,2027-02-15)");
    // BOTH HALVES. The holdover keeps 1–14 January at the seller's $275 and
    // no fee; the lease bills from the 15th. 'January bills from that day'
    // read as if the month started billing on the 15th — and 'then the new
    // lease from that day', sitting right after 'January 14', read as the
    // lease running from the 14th. The lease's own day is named.
    expect(p.signal).toBe(
      "On the new lease from January 15, 2027 — January 2027 bills the arrangement they had to January 14, 2027, " +
      "then the new lease from January 15, 2027 — $542.53 a month after that ($400.00 rent + $142.53 fees).",
    );
  });

  it("a holdover that never had a day before the signing keeps no days — the month bills from that day alone", () => {
    // Filed on the 15th and signed the 15th: cancelled, not trimmed, so
    // nothing bills before the lease.
    const p = planSigning(
      signed({ signedOn: "2027-01-15" }),
      imported({ range: { start: "2027-01-15", end: "2028-01-15" } }),
      { ...HAVEN, todayISO: "2027-01-15" },
    );
    if (!p.ok) throw new Error(p.error);
    expect(p.holdover).toEqual({ id: "res-14", cancel: true });
    expect(p.signal).toBe(
      "On the new lease from January 15, 2027 — January 2027 bills from that day, then $542.53 a month ($400.00 rent + $142.53 fees).",
    );
  });

  it("a park with no fee says so by not inventing one", () => {
    const p = planSigning(signed(), imported(), { ...HAVEN, feePerMonth: 0 });
    if (!p.ok) throw new Error(p.error);
    expect(p.signal).toBe("On the new lease from January 1, 2027 — January 2027 bills $400.00.");
  });

  it("a park with neither dial writes the successor on the horizon", () => {
    const p = planSigning(signed(), imported(), { ...HAVEN, defaultAgreementMonths: null, maxAgreementMonths: null });
    if (!p.ok) throw new Error(p.error);
    expect(p.successor.during).toBe("[2027-01-01,2028-01-01)");
  });

  it("patches the file with the email and the office's number, in one format", () => {
    const p = planSigning(signed(), imported(), HAVEN);
    if (!p.ok) throw new Error(p.error);
    expect(p.renter).toEqual({ email: "doris@example.com", phone_on_file_with_park: "+12605550114" });
    expect(p.renter).not.toHaveProperty("mobile_e164");
  });
});

describe("what it refuses, and in what words", () => {
  it("only a holdover may sign onto the new lease", () => {
    const p = planSigning(signed(), imported({ origin: "application" }), HAVEN);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(/already on an agreement with you/);
  });

  it("a closed tenancy has nothing to carry on from", () => {
    expect(planSigning(signed(), imported({ status: "ended" }), HAVEN).ok).toBe(false);
    expect(planSigning(signed(), imported({ status: "cancelled" }), HAVEN).ok).toBe(false);
  });

  it("a lease that runs from a day still to come is not recorded yet — and the sentence names the day", () => {
    const p = planSigning(signed({ signedOn: "2027-01-02" }), imported(), HAVEN);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toBe(
      "The new lease runs from January 2, 2027 — that hasn't come yet. Record it from that day.",
    );
  });

  it("asks for the day the lease runs from, not the day they signed", () => {
    const p = planSigning(signed({ signedOn: "" }), imported(), HAVEN);
    expect(!p.ok && p.error).toBe("Pick the day the new lease runs from.");
  });

  it("nothing begins before the ledger does", () => {
    const p = planSigning(
      signed({ signedOn: "2026-12-28" }),
      imported({ range: { start: "2026-12-20", end: "2027-12-20" } }),
      { ...HAVEN, todayISO: "2027-01-04" },
    );
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toBe("The ledger starts on January 1, 2027 — the new agreement can't begin before that.");
  });

  it("a park with no cutover takes any day up to today", () => {
    const p = planSigning(
      signed({ signedOn: "2026-12-28" }),
      imported({ range: { start: "2026-12-20", end: "2027-12-20" } }),
      { ...HAVEN, cutoverDate: null, todayISO: "2027-01-04" },
    );
    expect(p.ok).toBe(true);
  });

  it("a day after the arrangement ends has nothing to continue", () => {
    const p = planSigning(
      signed({ signedOn: "2028-01-05" }),
      imported(),
      { ...HAVEN, todayISO: "2028-01-05" },
    );
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(/ends on January 1, 2028/);
  });

  it("the lease has a rent on it — never assumed", () => {
    const p = planSigning(signed({ rent: "" }), imported(), HAVEN);
    expect(!p.ok && p.error).toBe("What rent did they sign for?");
    expect(planSigning(signed({ rent: "four hundred" }), imported(), HAVEN).ok).toBe(false);
  });

  it("email AND phone are a condition of the lease — in the filing screen's own words", () => {
    for (const [email, mobile] of [["", ""], ["", "(260) 555-0114"], ["doris@", "(260) 555-0114"], ["doris@example.com", ""], ["doris@example.com", "555"]]) {
      const p = planSigning(signed({ email, mobile }), imported(), HAVEN);
      expect(p.ok).toBe(false);
      expect(!p.ok && p.error).toBe(contactProblem(email, mobile));
    }
  });

  it("needs a date, and a real one", () => {
    expect(planSigning(signed({ signedOn: "" }), imported(), HAVEN).ok).toBe(false);
    expect(planSigning(signed({ signedOn: "New Year" }), imported(), HAVEN).ok).toBe(false);
  });

  it("refuses a lease whose agreement would already be over — nothing trimmed, nothing cancelled", () => {
    // The seeded 1 January, recorded on 15 February under the one-month term:
    // the successor would be [1 Jan, 1 Feb), already over, and the holdover
    // would have been cancelled — so from that moment nothing held the lot
    // and every later run billed them nothing, rent AND fee.
    const p = planSigning(signed({ signedOn: "2027-01-01" }), imported(), { ...HAVEN, todayISO: "2027-02-15" });
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toBe(
      "An agreement from January 1, 2027 under your one-month term would already be over by now — check the day the lease runs from.",
    );
    expect(p).not.toHaveProperty("holdover");
    expect(p).not.toHaveProperty("successor");
  });

  it("the boundary is the term's own end: over ON the day it ends, fine the day before", () => {
    // [1 Jan, 1 Feb) — on 31 January it is still running; on 1 February it is not.
    expect(planSigning(signed(), imported(), { ...HAVEN, todayISO: "2027-01-31" }).ok).toBe(true);
    const onTheFirst = planSigning(signed(), imported(), { ...HAVEN, todayISO: "2027-02-01" });
    expect(onTheFirst.ok).toBe(false);
    expect(!onTheFirst.ok && onTheFirst.error).toMatch(/would already be over by now/);
    // And the same day, dated for the current month, records.
    expect(planSigning(signed({ signedOn: "2027-02-01" }), imported(), { ...HAVEN, todayISO: "2027-02-01" }).ok).toBe(true);
  });

  it("a park with neither dial is over only after the horizon, and the sentence names no term", () => {
    const noDials = { ...HAVEN, defaultAgreementMonths: null, maxAgreementMonths: null, cutoverDate: null };
    expect(planSigning(signed(), imported(), { ...noDials, todayISO: "2027-12-31" }).ok).toBe(true);
    // The horizon from 1 January 2027 ends 1 January 2028, so on that day it
    // is over. (The holdover's own range also ends that day, but the
    // range-end check is `signedOn >= end` — 1 Jan 2027 is not — so it is
    // this clause that refuses.)
    const p = planSigning(signed(), imported(), { ...noDials, todayISO: "2028-01-01" });
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toBe(
      "An agreement from January 1, 2027 would already be over by now — check the day the lease runs from.",
    );
  });

  it("the date is judged whole BEFORE the contacts — a blank email on an over-dated lease learns about the date first", () => {
    // A form whose date is over and whose email is blank got 'No email
    // yet.' and learned the date could not be recorded only on the next tap.
    const p = planSigning(signed({ email: "" }), imported(), { ...HAVEN, todayISO: "2027-02-15" });
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(/^An agreement from January 1, 2027 under your one-month term would already be over by now/);
    expect(!p.ok && p.error).not.toBe(contactProblem("", "(260) 555-0114"));
    // With the date in range, the contacts are judged as before.
    const later = planSigning(signed({ email: "", signedOn: "2027-02-01" }), imported(), { ...HAVEN, todayISO: "2027-02-15" });
    expect(!later.ok && later.error).toBe(contactProblem("", "(260) 555-0114"));
  });

  it("both doors refuse an over-dated agreement with the ONE clause — only the tail names the form's own box", () => {
    // The roll's signing door and the filing screen's tenant builder once
    // said it two ways ('…would already be over by now — check the start
    // date.' with no term clause even when the park has one). The clause
    // now lives in park-helpers and both build from it.
    const clause = CLAUSE_AT_HOME("2027-01-01", 1);
    expect(clause).toBe(alreadyOverClause("2027-01-01", 1));
    const roll = planSigning(signed(), imported(), { ...HAVEN, todayISO: "2027-02-15" });
    expect(!roll.ok && roll.error).toBe(`${capitalise(clause)} — check the day the lease runs from.`);
    const filing: TenantInput = {
      displayName: "Doris", movedInOn: "", agreementStartsOn: "2027-01-01", term: "monthly", rent: "400",
      mobile: "(260) 555-0114", email: "doris@example.com", source: "owner_knowledge", signedNewLease: true,
    };
    const door = buildTenant(filing, "2027-02-15", 1, { cutoverDate: "2027-01-01" });
    expect(!door.ok && door.error).toBe(`${capitalise(clause)} — check the start date.`);
    // A park with neither dial: no term clause, from either door.
    const noTerm = buildTenant(filing, "2028-01-01", null, { cutoverDate: "2027-01-01" });
    expect(!noTerm.ok && noTerm.error).toBe("An agreement from January 1, 2027 would already be over by now — check the start date.");
  });

  it("a 3-month term says 3-month; the clause is the one the form reads", () => {
    const p = planSigning(signed(), imported(), { ...HAVEN, defaultAgreementMonths: 3, todayISO: "2027-04-01" });
    expect(!p.ok && p.error).toMatch(/under your 3-month term/);
    expect(alreadyOverClause("2027-01-01", 1)).toBe("an agreement from January 1, 2027 under your one-month term would already be over by now");
    expect(alreadyOverClause("2027-01-01", null)).toBe("an agreement from January 1, 2027 would already be over by now");
    expect(agreementEndFrom("2027-01-01", 1)).toBe("2027-02-01");
    expect(agreementEndFrom("2027-01-01", null)).toBe("2028-01-01");
    expect(agreementAlreadyOver("2027-01-01", 1, "2027-01-31")).toBe(false);
    expect(agreementAlreadyOver("2027-01-01", 1, "2027-02-01")).toBe(true);
  });
});

describe("the day the form starts from — never today", () => {
  it("an imported row's own first day, when the ledger already covers it", () => {
    // Everybody's lease runs from the takeover day; on the 4th the box
    // already says the 1st.
    expect(defaultSigningDay("2027-01-01", "2027-01-01")).toBe("2027-01-01");
    expect(defaultSigningDay("2027-01-01", null)).toBe("2027-01-01");
  });

  it("blank for a holdover filed by hand before go-live — its first day is not a day a lease can run from", () => {
    expect(defaultSigningDay("2026-12-20", "2027-01-01")).toBe("");
    expect(defaultSigningDay(null, "2027-01-01")).toBe("");
  });

  it("takes no notion of today at all", () => {
    // The signature has no today in it, on purpose: there is no way for the
    // day the office got round to it to leak into the agreement's start.
    expect(defaultSigningDay.length).toBe(2);
  });
});

describe("what the first month bills is said BEFORE the write, in the toast's own words", () => {
  it("is the one sentence the plan's signal is built from", () => {
    const p = planSigning(signed(), imported(), HAVEN);
    if (!p.ok) throw new Error(p.error);
    expect(p.signal).toBe(`On the new lease from January 1, 2027 — ${firstMonthBills("2027-01-01", 400, 142.53)}.`);
    expect(firstMonthBills("2027-01-15", 400, 142.53)).toBe(
      "January 2027 bills from that day, then $542.53 a month ($400.00 rent + $142.53 fees)",
    );
    expect(firstMonthBills("2027-01-01", 400, 0)).toBe("January 2027 bills $400.00");
  });

  it("says both halves when the arrangement they had keeps days in the month — and names the lease's own day", () => {
    expect(firstMonthBills("2027-01-15", 400, 142.53, "2026-12-20")).toBe(
      "January 2027 bills the arrangement they had to January 14, 2027, then the new lease from January 15, 2027 — $542.53 a month after that ($400.00 rent + $142.53 fees)",
    );
    // 'from that day' after 'January 14, 2027' read as the lease running from the 14th.
    expect(firstMonthBills("2027-01-15", 400, 142.53, "2026-12-20")).not.toMatch(/January 14, 2027, then the new lease from that day/);
    // From the 1st the old arrangement's days are last month's, not this one's.
    expect(firstMonthBills("2027-01-01", 400, 142.53, "2026-12-20")).toBe("January 2027 bills $542.53 ($400.00 rent + $142.53 fees)");
    // Starting the same day it keeps none.
    expect(firstMonthBills("2027-01-15", 400, 142.53, "2027-01-15")).toBe(
      "January 2027 bills from that day, then $542.53 a month ($400.00 rent + $142.53 fees)",
    );
  });
});

describe("what the rent box starts from — a monthly figure or nothing", () => {
  it("the rate card first, whatever the holdover was", () => {
    expect(signingRentSeed(400, "annual", 3300)).toBe(400);
    expect(signingRentSeed(400, "monthly", 275)).toBe(400);
  });

  it("what they paid before only when that was monthly — a yearly figure is never seeded", () => {
    // The successor is written monthly and the sentence quotes a month:
    // $3,300 in the box read 'January 2027 bills $3,442.53'.
    expect(signingRentSeed(null, "monthly", 275)).toBe(275);
    expect(signingRentSeed(null, "annual", 3300)).toBeNull();
    expect(signingRentSeed(null, "seasonal", 1200)).toBeNull();
    expect(signingRentSeed(null, null, 275)).toBeNull();
    expect(signingRentSeed(null, "monthly", null)).toBeNull();
  });
});

describe("the form on the roll asks for the same fact the arithmetic uses", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const roll = strip(readFileSync(
    fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8"));
  const form = roll.slice(roll.indexOf("function SignedNewLease("), roll.indexOf("function Stat("));

  it("finds the form — a scan of nothing proves nothing", () => {
    expect(form.length).toBeGreaterThan(500);
    expect(form).toContain("recordSigning(");
  });

  it("labels the date as the day the new lease runs from — the day on the paper", () => {
    expect(form).toContain("The new lease runs from");
    expect(form).not.toMatch(/Day they signed/);
    expect(form).toMatch(/The day on the paper, not today/);
    expect(form).not.toMatch(/ends the day they signed/);
  });

  it("seeds the date from the holdover's own day and never from today", () => {
    const seeded = form.match(/const seededDay = ([^;]+);/)?.[1] ?? "";
    expect(seeded, "the form no longer computes seededDay — this scan measures nothing").not.toBe("");
    expect(seeded).toMatch(/defaultSigningDay\(/);
    expect(seeded).not.toMatch(/\btoday\b/);
    const seed = form.match(/signedOn:\s*([^,\n]+)/)?.[1] ?? "";
    expect(seed, "the form no longer seeds signedOn").not.toBe("");
    expect(seed).not.toMatch(/\btoday\b/);
  });

  it("leaves the date BLANK when an agreement from the seeded day would already be over, and says why", () => {
    // 1 January under a one-month term, opened on 15 February: the planner
    // refuses that day, so seeding it and saying 'keep the day on the paper'
    // offered him the one date that cannot be recorded.
    const seed = form.match(/signedOn:\s*([^,\n]+)/)?.[1] ?? "";
    expect(seed).toMatch(/^seededDayOver \? "" : seededDay$/);
    const over = form.match(/const seededDayOver = ([^;]+);/)?.[1] ?? "";
    expect(over, "the form no longer decides seededDayOver").not.toBe("");
    expect(over).toMatch(/agreementAlreadyOver\(seededDay, seed\.termMonths, today\)/);
    expect(form).toMatch(/The day is left blank: \{alreadyOverClause\(seededDay, seed\.termMonths\)\}, so it\s+can&apos;t be recorded from that day here\./);
  });

  it("when the box is blank for that reason, it does NOT send him to type the day on the paper — that is the day refused", () => {
    // 'The day on the paper, not today … Type the day the lease runs from'
    // named 1 January twice on the one form that refuses 1 January. The
    // over-branch says what any typed day does; the lead line is the other
    // branch's alone.
    const helper = form.slice(form.indexOf("{seededDayOver ? ("), form.indexOf("{seed.rentFromRateCard"));
    expect(helper, "the helper line's branch is gone — this scan measures nothing").not.toBe("");
    const [overBranch, elseBranch] = helper.split(") : (");
    expect(overBranch).toMatch(/The day you type is the day the new\s+agreement runs from, and the first month bills from it\./);
    expect(overBranch).not.toMatch(/The day on the paper/);
    expect(overBranch).not.toMatch(/Type the\s+day the lease runs from/);
    expect(elseBranch).toMatch(/The day on the paper, not today — the first month bills from this day\./);
  });

  it("shows the phone back the way a person writes it", () => {
    const mobile = form.match(/mobile:\s*([^,\n]+)/)?.[1] ?? "";
    expect(mobile, "the form no longer seeds mobile").not.toBe("");
    expect(mobile).toMatch(/^prettyPhone\(seed\.phone\)$/);
  });

  it("a yearly holdover with no rate card opens with an empty rent box and says why", () => {
    expect(form).toMatch(/seed\.holdoverTerm && seed\.holdoverTerm !== "monthly"/);
    expect(form).toMatch(/They were filed as paid \$\{TERM_OPTION\[seed\.holdoverTerm\] \?\? seed\.holdoverTerm\} — type what the lease says each month\./);
    // And the 'what they paid before' sentence is only said when a figure IS in the box.
    expect(form).toMatch(/seed\.rent != null\s*\?\s*"The rent starts from what they paid before/);
    expect(form).not.toMatch(/\/\s*12\b/);
  });

  it("the sentence before the write carries the holdover's first day, so it can say both halves", () => {
    expect(form).toMatch(/firstMonthBills\(form\.signedOn, Math\.round\(rentTyped \* 100\) \/ 100, seed\.feePerMonth, seed\.holdoverFrom\)/);
  });

  it("the control is labelled from the one home for its words", () => {
    expect(SIGNED_LEASE_LABEL).toBe("They signed the new lease");
    // ONE home: park-helpers, the leaf every reader already imports. The
    // sign-helpers export is that same value, re-exported.
    expect(LABEL_AT_HOME).toBe(SIGNED_LEASE_LABEL);
    expect(roll).toMatch(/\? "Cancel" : SIGNED_LEASE_LABEL\}/);
    // No retyped copy of the label anywhere on the roll.
    expect(roll.replace(/SIGNED_LEASE_LABEL = "They signed the new lease"/, "")).not.toMatch(/"They signed the new lease"/);
  });

  it("the filing screen's explainer reads the label from the same home — never retyped", () => {
    const helpers = strip(readFileSync(fileURLToPath(new URL("./onboard-helpers.ts", import.meta.url)), "utf8"));
    const at = helpers.indexOf("export function signingExplainer(");
    const next = helpers.indexOf("\nexport ", at + 1);
    const explainer = helpers.slice(at, next === -1 ? undefined : next);
    expect(explainer, "signingExplainer is gone — this scan measures nothing").toContain("rent roll");
    expect(explainer).toMatch(/\$\{SIGNED_LEASE_LABEL\}/);
    expect(helpers).not.toMatch(/They signed the new lease/);
    expect(helpers).toMatch(/import \{[^}]*\bSIGNED_LEASE_LABEL\b[^}]*\} from "\.\/park-helpers"/);
    // And the rendered sentence carries the label the roll's button wears.
    expect(signingExplainer(1)).toContain(`('${SIGNED_LEASE_LABEL}')`);
    // ONE DEFINITION, in agreement-helpers — the leaf under park-helpers, so
    // the renewal refusal can render it without a cycle. park-helpers and
    // sign-helpers only re-export it.
    const signHelpers = strip(readFileSync(fileURLToPath(new URL("./sign-helpers.ts", import.meta.url)), "utf8"));
    expect(signHelpers).not.toMatch(/SIGNED_LEASE_LABEL = /);
    const parkHelpers = strip(readFileSync(fileURLToPath(new URL("./park-helpers.ts", import.meta.url)), "utf8"));
    expect(parkHelpers).not.toMatch(/SIGNED_LEASE_LABEL = /);
    expect(parkHelpers).toMatch(/export \{ SIGNED_LEASE_LABEL \} from "\.\/agreement-helpers";/);
    const agreementHelpers = strip(readFileSync(fileURLToPath(new URL("./agreement-helpers.ts", import.meta.url)), "utf8"));
    expect(agreementHelpers).toMatch(/export const SIGNED_LEASE_LABEL = "They signed the new lease";/);
  });

  it("the picker's floor is the cutover, as the filing form's already is", () => {
    const input = form.match(/<input type="date" value=\{form\.signedOn\}[^>]*>/)?.[0] ?? "";
    expect(input, "the date input is gone — this scan measures nothing").not.toBe("");
    expect(input).toMatch(/min=\{cutoverDate \?\? undefined\}/);
    expect(input).toMatch(/max=\{today\}/);
  });

  it("says what the first month bills before the write, from the shared sentence", () => {
    expect(form).toMatch(/firstMonthBills\(form\.signedOn/);
    expect(form).toMatch(/On the new lease from <strong>\{dayInWords\(form\.signedOn\)\}<\/strong> — \{firstMonth\}\./);
  });
});

describe("the page seeds the form from the same helpers the planner refuses on", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const page = strip(readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"));
  const signing = page.slice(page.indexOf("signing: holdover"), page.indexOf("pending: r.pending.map("));

  it("finds the seed — a scan of nothing proves nothing", () => {
    expect(signing.length).toBeGreaterThan(200);
    expect(signing).toContain("reservationId: holdover.id");
  });

  it("the rent is signingRentSeed — never the holdover's figure by itself", () => {
    expect(signing).toMatch(/rent: signingRentSeed\(rateCard, holdover\.term, holdover\.quotedAmount\)/);
    expect(signing).not.toMatch(/rent: rateCard \?\? holdover\.quotedAmount/);
    expect(signing).toMatch(/holdoverTerm: holdover\.term/);
  });

  it("the term is read from the park's dials with the arithmetic recordSigning uses", () => {
    expect(signing).toMatch(/termMonths,/);
    expect(page).toMatch(/const termMonths = agreementMonthsFor\(/);
    expect(page).toMatch(/default_agreement_months, max_agreement_months"\)/);
  });
});
