import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RETURN_REASONS, RETRIES_ALLOWED, UNAUTHORISED_RETURN_WINDOW_DAYS,
  LANDS_WITHIN_WEEKDAYS, STUCK_AFTER_WEEKDAYS,
  returnReason, isListedReturnCode, returnRefusal, clearingRefusal,
  weekdaysBetween, inFlight, whatToDoAfterReturn, returnSaidToResident,
  describeReturn, inFlightSummary,
} from "./clearing-helpers";

/**
 * MONEY THAT NEVER LANDS.
 *
 * Verified on 17 Oct 2026, against the source and against production:
 *
 *   NOTHING IN THE APPLICATION WRITES `method: 'ach'`. Every one of the
 *   sixteen `'ach'` sites in src/ is a READ — a branch choosing a refund
 *   rail, a sentence, or a refusal. `pay-actions.ts` writes `method: "card"`;
 *   the hand-keyed and resident-claim pickers offer check / cash / transfer /
 *   other. So the bank rail had no INLET.
 *
 *   AND NOTHING WRITES `settled_at` OR `returned_at` on park_payments. 0155
 *   said so in its own header — "the writer is the webhook that does not
 *   exist" — and 0191 added settlement the same way. So the rail had no
 *   OUTLET either.
 *
 * Between those two facts sat five screens that explain money on its way: a
 * `clearing` pill on the rent roll and on statements, a clearing line on the
 * morning screen, a reminder run that refuses to chase a clearing bill, and
 * `RenterHome` telling the household "$X is on its way from your bank and
 * takes a few days". All correct. None of them could ever stop being true.
 *
 * This file pins the outlet. The inlet is a separate build; until it exists
 * these doors have a caller and no subjects, which is the state the ops
 * payment-setup panel shipped in and is the honest one.
 */

// ---------------------------------------------------------------- codes --

describe("what a return actually means", () => {
  it("ONLY BEING SHORT OF MONEY MAY BE ASKED FOR AGAIN", () => {
    // The whole reason this classification exists. R01 is almost every
    // return; everything else needs a different act, and two of the classes
    // make a second debit a rule violation rather than a nuisance.
    const retryable = RETURN_REASONS.filter((r) => r.next === "retry").map((r) => r.code);
    expect(retryable.sort()).toEqual(["R01", "R09"]);
  });

  it("A DENIED AUTHORISATION IS NEVER RETRYABLE", () => {
    // R05, R07, R08, R10, R11, R29 all mean the account holder has told their
    // bank no. Debiting again breaks NACHA, comes back again, and costs a fee
    // each time — and "returned" on its own reads to a reasonable person as
    // "try again", which is exactly why the class carries the sentence.
    for (const code of ["R05", "R07", "R08", "R10", "R11", "R29"]) {
      expect(returnReason(code)?.next, code).toBe("reauthorise");
    }
  });

  it("and a dead or wrong account needs different details, not permission", () => {
    for (const code of ["R02", "R03", "R04", "R16", "R20"]) {
      expect(returnReason(code)?.next, code).toBe("redetails");
    }
  });

  it("every listed code has words a person could read", () => {
    for (const r of RETURN_REASONS) {
      expect(r.said.length, r.code).toBeGreaterThan(8);
      // No code numbers inside the words — the picker shows the code beside
      // them, and "R01 — R01 insufficient" is how that happens.
      expect(r.said, r.code).not.toMatch(/R\d\d/);
    }
  });

  it("the codes are unique", () => {
    const codes = RETURN_REASONS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("a code we do not have words for", () => {
  it("is accepted, because an unrecordable return gets recorded as the nearest lie", () => {
    const r = returnReason("R24");
    expect(r).not.toBeNull();
    expect(r!.code).toBe("R24");
    expect(isListedReturnCode("R24")).toBe(false);
  });

  it("AND IT IS NEVER CLASSED RETRYABLE", () => {
    // The asymmetry decides it: guessing "retry" costs a second return fee
    // and may break a rule; guessing "stop" costs a phone call.
    for (const code of ["R24", "R50", "R99", "R13"]) {
      expect(returnReason(code)?.next, code).not.toBe("retry");
    }
  });

  it("and the advice admits it does not know, rather than inventing a reason", () => {
    const said = whatToDoAfterReturn("R24");
    expect(said).toMatch(/don't have words for that code/i);
    // It must still carry the warning, because an unknown code may BE one of
    // the ones you must not debit again.
    expect(said).toMatch(/must not debit/i);
    // And it must not claim the thing the listed `redetails` sentence claims.
    expect(said).not.toMatch(/account can't be used/i);
  });

  it("the household is told the fact without the explanation", () => {
    const said = returnSaidToResident({ code: "R24", amount: "$542.53" });
    expect(said).toMatch(/\$542\.53/);
    expect(said).toMatch(/get in touch/i);
    expect(said).not.toMatch(/wasn't enough/i);
    expect(said).not.toMatch(/not authorised/i);
  });
});

describe("the shape of a code, which this application is alone in checking", () => {
  it("R AND TWO DIGITS, because the database checks nothing at all", () => {
    // Proven against production: `return_code` has no CHECK, so the database
    // accepted R73 and accepted the string "the bank phoned" just as readily.
    // 0155 left the column unformatted on purpose — it did not know what a
    // processor would send — which puts the whole guard here.
    for (const bad of [
      "", "   ", "R1", "R001", "01", "RR1", "R0", "r", "OTHER",
      "the bank phoned", "R01 insufficient", "R-1", "R1A", "ACH",
    ]) {
      expect(returnReason(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("but case and whitespace are a typist's business, not the bank's", () => {
    expect(returnReason("r01")?.code).toBe("R01");
    expect(returnReason("  R10  ")?.code).toBe("R10");
  });
});

// ------------------------------------------------------------- refusals --

describe("when a return cannot be recorded", () => {
  const ok = {
    code: "R01",
    method: "ach",
    alreadyReturnedAt: null,
    reversedAt: null,
  };

  it("is null when there is nothing wrong — or this whole block proves nothing", () => {
    expect(returnRefusal(ok)).toBeNull();
  });

  it("ONLY MONEY ON A RAIL CAN BE SENT BACK BY A BANK", () => {
    // 0155: `check (returned_at is null or method in ('card', 'ach'))`.
    // A hand-keyed bank transfer is the office reading its own statement; if
    // that was wrong it is a reversal, which is a different act.
    for (const method of ["cash", "check", "transfer", "other", "", null]) {
      const said = returnRefusal({ ...ok, method });
      expect(said, String(method)).not.toBeNull();
      expect(said, String(method)).toMatch(/take the record back instead/i);
    }
    expect(returnRefusal({ ...ok, method: "card" })).toBeNull();
  });

  it("a return is recorded once", () => {
    expect(returnRefusal({ ...ok, alreadyReturnedAt: "2026-10-09T00:00:00Z" }))
      .toMatch(/recorded once/i);
  });

  it("and money already taken back has nothing for a bank to return", () => {
    expect(returnRefusal({ ...ok, reversedAt: "2026-10-09T00:00:00Z" }))
      .toMatch(/already taken back/i);
  });

  it("a code nobody picked is refused in words that say what one looks like", () => {
    const said = returnRefusal({ ...ok, code: "" });
    expect(said).toMatch(/R01|R10/);
  });
});

describe("when a payment cannot be marked as landed", () => {
  const ok = { settledAt: null, returnedAt: null, reversedAt: null, method: "ach" };

  it("is null when there is nothing wrong", () => {
    expect(clearingRefusal(ok)).toBeNull();
  });

  it("already landed is the ordinary case, not an error", () => {
    // Two people on one office login, or a reload. 0191 makes settlement
    // one-way at the database with a long sentence; this is the short one.
    expect(clearingRefusal({ ...ok, settledAt: "2026-10-09T00:00:00Z" }))
      .toMatch(/already landed/i);
  });

  it("MONEY THAT CAME BACK CANNOT ALSO HAVE LANDED", () => {
    expect(clearingRefusal({ ...ok, returnedAt: "2026-10-09T00:00:00Z" }))
      .toMatch(/sent that one back/i);
  });

  it("and money taken back has nothing to land", () => {
    expect(clearingRefusal({ ...ok, reversedAt: "2026-10-09T00:00:00Z" }))
      .toMatch(/taken back/i);
  });

  it("ONLY A BANK DEBIT WAITS. Everything else was stamped by the database", () => {
    // 0191's `payment_settles_on_arrival` stamps settled_at on insert for
    // every rail but ACH, and a CHECK enforces it. An unsettled row on any
    // other rail means something upstream is wrong, and a button that papered
    // over it would hide the real fault.
    for (const method of ["cash", "check", "card", "transfer", "other", null]) {
      expect(clearingRefusal({ ...ok, method }), String(method))
        .toMatch(/only a bank debit waits/i);
    }
  });
});

// ------------------------------------------------------------ how long --

describe("how long it has been on its way", () => {
  it("counts weekdays and does not count the day it started", () => {
    expect(weekdaysBetween("2026-10-05", "2026-10-05")).toBe(0);
    expect(weekdaysBetween("2026-10-05", "2026-10-06")).toBe(1);
    expect(weekdaysBetween("2026-10-05", "2026-10-08")).toBe(3);
  });

  it("A WEEKEND IS NOT A BANKING DELAY", () => {
    // Fri 9th to Mon 12th is three calendar days and one working day. Without
    // this, every debit asked for on a Thursday reads as late by Monday.
    expect(weekdaysBetween("2026-10-09", "2026-10-10")).toBe(0); // Sat
    expect(weekdaysBetween("2026-10-09", "2026-10-11")).toBe(0); // Sun
    expect(weekdaysBetween("2026-10-09", "2026-10-12")).toBe(1); // Mon
  });

  it("A NONSENSE DATE IS NULL, NOT A NUMBER", () => {
    // `Number("")` is 0 and 0 is finite, which is how a blank date produced a
    // real-looking month elsewhere in this codebase. The shape is checked.
    for (const bad of ["", "   ", "2026-10", "2026-13-01", "26-10-05", "nonsense", "2026-10-32", "2026-00-05"]) {
      expect(weekdaysBetween(bad, "2026-10-20"), JSON.stringify(bad)).toBeNull();
      expect(weekdaysBetween("2026-10-05", bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("and a date before the start is nothing, not a negative run", () => {
    expect(weekdaysBetween("2026-10-20", "2026-10-05")).toBe(0);
  });

  it("is bounded rather than looping on a far-apart pair", () => {
    const n = weekdaysBetween("1990-01-01", "2026-10-20");
    expect(n).not.toBeNull();
    expect(n!).toBeLessThanOrEqual(400);
  });
});

describe("the three states a debit can be in", () => {
  const from = "2026-10-05"; // a Monday

  it("lands quietly inside the normal window", () => {
    for (const today of ["2026-10-05", "2026-10-06", "2026-10-08"]) {
      expect(inFlight({ receivedOn: from, today }).kind, today).toBe("landing");
    }
  });

  it("is slow rather than wrong just past it", () => {
    // THE MIDDLE STATE EARNS ITS PLACE: a screen that jumps from silence to
    // alarm trains the reader to ignore the alarm.
    for (const today of ["2026-10-09", "2026-10-12", "2026-10-13"]) {
      expect(inFlight({ receivedOn: from, today }).kind, today).toBe("slow");
    }
  });

  it("and is stuck when it has taken longer than a bank debit takes", () => {
    for (const today of ["2026-10-14", "2026-10-15", "2026-10-20"]) {
      expect(inFlight({ receivedOn: from, today }).kind, today).toBe("stuck");
    }
  });

  it("THE BOUNDARIES ARE WHERE THE CONSTANTS SAY", () => {
    // Pins the states to the named numbers rather than to the dates above, so
    // moving a constant moves the behaviour and not just a comment.
    expect(inFlight({ receivedOn: from, today: "2026-10-08" }).weekdays).toBe(LANDS_WITHIN_WEEKDAYS);
    expect(inFlight({ receivedOn: from, today: "2026-10-14" }).weekdays).toBe(STUCK_AFTER_WEEKDAYS);
    expect(STUCK_AFTER_WEEKDAYS).toBeGreaterThan(LANDS_WITHIN_WEEKDAYS);
  });

  it("an unreadable date says it cannot tell, rather than reading as fine", () => {
    const v = inFlight({ receivedOn: "", today: "2026-10-20" });
    expect(v.kind).toBe("unknown");
    expect(v.weekdays).toBeNull();
    expect(v.said).toMatch(/can't tell/i);
  });

  it("the stuck sentence says what to do, and names the invisible cause", () => {
    // A debit the processor never sent looks exactly like patience from this
    // side, and it is the likeliest reason for a long wait.
    const said = inFlight({ receivedOn: from, today: "2026-10-20" }).said;
    expect(said).toMatch(/check it actually went/i);
    expect(said).toMatch(/ask the household/i);
  });
});

// ------------------------------------------------------------ sentences --

describe("what to do next, said to the office", () => {
  it("THE PROHIBITION IS IN THE WORDS, not left to be inferred", () => {
    const said = whatToDoAfterReturn("R10");
    expect(said).toMatch(/do not debit that account again/i);
    expect(said).toMatch(/costs a fee/i);
    // And it must not offer the retry the retryable class offers.
    expect(said).not.toMatch(/ask their bank again/i);
  });

  it("the retryable one names the ceiling, because a third attempt is a violation", () => {
    const said = whatToDoAfterReturn("R01");
    expect(said).toMatch(new RegExp(`${RETRIES_ALLOWED} more times`));
    expect(RETRIES_ALLOWED).toBe(2);
  });

  it("every class says the bill is open again", () => {
    // The one fact common to all of them, and the one the office acts on.
    for (const code of ["R01", "R10", "R02", "R24"]) {
      expect(whatToDoAfterReturn(code), code).toMatch(/bill is open again/i);
    }
  });

  it("and a malformed code gets the stop without a reason", () => {
    expect(whatToDoAfterReturn("")).toMatch(/find out what the bank said/i);
  });
});

describe("the same fact said to the household", () => {
  it("NAMES THE MONEY AND NEVER ACCUSES", () => {
    for (const code of ["R01", "R10", "R02"]) {
      const said = returnSaidToResident({ code, amount: "$542.53" });
      expect(said, code).toMatch(/\$542\.53/);
      expect(said, code).toMatch(/open again/i);
      // The office's version names the rule and the fee risk. Theirs does not:
      // they have done nothing wrong until proven otherwise, and a fee the
      // park pays is not their sentence to read.
      expect(said, code).not.toMatch(/violation|NACHA|costs a fee|do not debit/i);
    }
  });

  it("being short of money is said plainly, because it is a thing that happens", () => {
    const said = returnSaidToResident({ code: "R01", amount: "$542.53" });
    expect(said).toMatch(/wasn't enough in the account/i);
    expect(said).toMatch(/whenever you're ready/i);
  });

  it("and a denied authorisation tells them what they have to do", () => {
    const said = returnSaidToResident({ code: "R07", amount: "$542.53" });
    expect(said).toMatch(/set the payment up afresh|pay another way/i);
  });
});

describe("one line about a returned payment, wherever it is shown", () => {
  const fmt = {
    prettyMonth: (p: string) => `[${p}]`,
    dayInWords: (d: string) => `<${d}>`,
  };

  it("names the day, the reason and the bill", () => {
    const said = describeReturn({
      code: "R01", returnedAt: "2026-10-09T14:00:00Z", periodMonth: "2027-01", ...fmt,
    });
    expect(said).toContain("<2026-10-09>");
    expect(said).toContain("[2027-01]");
    expect(said).toMatch(/not enough in the account/i);
    expect(said).toMatch(/open again/i);
  });

  it("and money that was on account, not against a bill, says where it went instead", () => {
    const said = describeReturn({
      code: "R01", returnedAt: "2026-10-09T14:00:00Z", periodMonth: null, ...fmt,
    });
    expect(said).not.toMatch(/bill is open/i);
    expect(said).toMatch(/off their account/i);
  });

  it("a missing code says the bank did not say, rather than inventing one", () => {
    expect(describeReturn({ code: null, returnedAt: null, periodMonth: null, ...fmt }))
      .toMatch(/didn't say why/i);
  });
});

describe("the one line over everything in flight", () => {
  const rows = [
    { amountCents: 54_253, kind: "landing" as const },
    { amountCents: 40_000, kind: "stuck" as const },
  ];
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  it("ALWAYS SAYS IT IS NOT ARREARS", () => {
    // The whole reason the arrears figure on the same screen is lower than
    // the bills suggest, and the first question this panel gets asked.
    expect(inFlightSummary({ rows, money })).toMatch(/none of it is arrears/i);
  });

  it("totals the money and counts the payments", () => {
    const said = inFlightSummary({ rows, money })!;
    expect(said).toContain("$942.53");
    expect(said).toMatch(/2 payments/);
  });

  it("and names how many have waited too long", () => {
    expect(inFlightSummary({ rows, money })).toMatch(/1 of them has been waiting longer/i);
    expect(inFlightSummary({ rows: [rows[0]], money })).not.toMatch(/waiting longer/i);
  });

  it("nothing in flight is no line at all", () => {
    expect(inFlightSummary({ rows: [], money })).toBeNull();
  });
});

describe("a cleared debit is not a final one", () => {
  it("the sixty-day unauthorised-return window is named, not assumed away", () => {
    // A consumer may claim an unauthorised debit for sixty days after their
    // statement shows it. Anything that eventually treats cleared money as
    // final — a payout, a closed month, a deposit released — has to reckon
    // with it, and the next reader finds the number here.
    expect(UNAUTHORISED_RETURN_WINDOW_DAYS).toBe(60);
  });
});

// --------------------------------------------------------- the writers --

describe("the door itself", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const src = strip(readFileSync(
    fileURLToPath(new URL("./clearing-actions.ts", import.meta.url)), "utf8"));

  it("every door proves the park is the caller's", () => {
    for (const fn of ["getMoneyInFlight", "markBankPaymentCleared", "recordBankReturn"]) {
      const at = src.indexOf(`export async function ${fn}`);
      expect(at, `${fn} is gone — repoint this`).toBeGreaterThan(-1);
    }
    // The two writers go through one helper, which asserts and then fences the
    // row on park_id as well — an id out of a form is a value from a browser.
    const guard = src.slice(src.indexOf("async function theRow"));
    expect(guard).toMatch(/assertMyPark\(parkId\)/);
    expect(guard).toMatch(/\.eq\("park_id", parkId\)/);
    expect(src.slice(src.indexOf("export async function getMoneyInFlight")))
      .toMatch(/assertMyPark\(parkId\)/);
  });

  it("NOTHING HERE TALKS TO A PROCESSOR", () => {
    // It records what a bank already did. A clearing stamp is not a charge and
    // a return is not a refund — 0155 is explicit that sending money back here
    // would pay out a second time against a debit that never settled.
    for (const forbidden of [/fetch\(/, /https:\/\//, /takePayment/, /giveRefund/, /axios/]) {
      expect(src, `clearing-actions reaches out: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("THE CLEARING WRITE FILTERS ON UNSETTLED, not just checks it", () => {
    // Two people on one office login is the ordinary case. Without the filter
    // the second click reaches 0191's one-way trigger and a human reads
    // "settlement is recorded once" as a database error.
    const body = src.slice(src.indexOf("export async function markBankPaymentCleared"));
    const write = body.slice(body.indexOf(".update("), body.indexOf("if (error)"));
    expect(write.length, "the update is gone — this scan is measuring nothing")
      .toBeGreaterThan(40);
    expect(write).toMatch(/\.is\("settled_at", null\)/);
    expect(write).toMatch(/\.is\("returned_at", null\)/);
    expect(write).toMatch(/\.is\("reversed_at", null\)/);
  });

  it("and the return write filters the same way", () => {
    const body = src.slice(src.indexOf("export async function recordBankReturn"));
    const write = body.slice(body.indexOf(".update("), body.indexOf("if (error)"));
    expect(write.length, "the update is gone — this scan is measuring nothing")
      .toBeGreaterThan(40);
    expect(write).toMatch(/\.is\("returned_at", null\)/);
    expect(write).toMatch(/\.is\("reversed_at", null\)/);
  });

  it("THE RETURN TOUCHES NOTHING ELSE ON THE ROW", () => {
    // The first draft of this appended what the bank said to `note`. 0191
    // FREEZES that column — "the note that went on the receipt" — and
    // production refused the write. The code carries the reason instead.
    const body = src.slice(
      src.indexOf("export async function recordBankReturn"),
      src.length,
    );
    const write = body.slice(body.indexOf(".update({"), body.indexOf("if (error)"));
    expect(write).toMatch(/returned_at:/);
    expect(write).toMatch(/return_code:/);
    for (const frozen of [/\bnote:/, /\bamount:/, /\bmethod:/, /received_on:/, /reference:/, /receipt_no:/]) {
      expect(write, `the return write touches a frozen column: ${frozen}`).not.toMatch(frozen);
    }
  });

  it("A FAILED READ IS NOT AN EMPTY LIST", () => {
    // "Nothing is on its way" makes a stuck debit invisible, and the arrears
    // figure on the same screen deliberately leaves clearing money out — so
    // the two states must not render the same.
    const body = src.slice(src.indexOf("export async function getMoneyInFlight"));
    const branch = body.slice(body.indexOf("if (payRes.error)"), body.indexOf("if (lotRes.error)"));
    expect(branch.length, "the error branch is gone — this scan is measuring nothing")
      .toBeGreaterThan(20);
    expect(branch).toMatch(/return null;/);
    expect(branch).not.toMatch(/return \[\]/);
  });

  it("the three exclusions are the ones every other reader of this table uses", () => {
    const body = src.slice(
      src.indexOf("export async function getMoneyInFlight"),
      src.indexOf("async function theRow"),
    );
    const read = body.slice(body.indexOf('.from("park_payments")'), body.indexOf(".order("));
    expect(read).toMatch(/\.is\("settled_at", null\)/);
    expect(read).toMatch(/\.is\("reversed_at", null\)/);
    expect(read).toMatch(/\.is\("returned_at", null\)/);
  });
});

describe("the screen that calls it", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("the rent page loads it and renders the panel", () => {
    // A writer whose only caller is a test is the shape this codebase named
    // "a symbol with no caller". These are reachable from a screen a park
    // owner opens.
    const page = strip(readFileSync(
      fileURLToPath(new URL("./rent/page.tsx", import.meta.url)), "utf8"));
    expect(page).toMatch(/getMoneyInFlight\(park\.id\)/);
    expect(page).toMatch(/<ParkMoneyInFlight/);
    expect(page).toMatch(/rows=\{inFlight\}/);
  });

  it("the panel says a failed read is not an empty one, and empty renders nothing", () => {
    const panel = strip(readFileSync(
      fileURLToPath(new URL("../../components/ParkMoneyInFlight.tsx", import.meta.url)), "utf8"));
    expect(panel).toMatch(/rows === null/);
    expect(panel).toMatch(/couldn&apos;t read what&apos;s still clearing/);
    // An empty card on this screen every month is clutter that teaches the
    // reader to skip the column.
    expect(panel).toMatch(/rows\.length === 0\) return null/);
  });

  it("BOTH WRITES ARE CONFIRMED, because neither can be unsaid", () => {
    const panel = strip(readFileSync(
      fileURLToPath(new URL("../../components/ParkMoneyInFlight.tsx", import.meta.url)), "utf8"));
    expect(panel).toMatch(/can&apos;t be unsaid/);
    // Inside a {…} expression it is a JS string, so the apostrophe is bare —
    // JSX text would need &apos; and this is not JSX text.
    expect(panel).toMatch(/Yes, it's in the account/);
    expect(panel).toMatch(/Record the return/);
  });

  it("and it shows what the return will MEAN before it is recorded", () => {
    // The one that earns it: a return saying the household denied the
    // authorisation must not be answered by debiting them again, and nothing
    // about the word "returned" says so.
    const panel = readFileSync(
      fileURLToPath(new URL("../../components/ParkMoneyInFlight.tsx", import.meta.url)), "utf8");
    expect(panel).toMatch(/whatToDoAfterReturn\(codeFor\(r\.id\)\)/);
  });

  it("the statements screen finally renders the code it has always fetched", () => {
    // `return_code` has been selected into the Receipt row since 0155 and
    // rendered by nothing — so a household who was short and one who denied
    // the debit produced the same red pill.
    const st = readFileSync(
      fileURLToPath(new URL("../../components/ParkStatements.tsx", import.meta.url)), "utf8");
    expect(st).toMatch(/describeReturn\(\{/);
    expect(st).toMatch(/code: r\.returnCode/);
  });
});
