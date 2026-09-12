import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rentForPeriod, lastDayOfMonth } from "./rerate-helpers";

/**
 * ONE RENT HISTORY, OR THE CONFIRM SCREEN LIES.
 *
 * `previewChargeRun` and `runCharges` both have to answer "what was this
 * household paying in this month?". They used to answer it from two different
 * queries resolved at two different instants, and both halves of the mismatch
 * billed somebody wrongly:
 *
 *   - the preview looked for increases due by TODAY; the run resolved at the
 *     END OF THE MONTH. Billing January on the 2nd with a rise due the 15th,
 *     he approved nineteen bills at the old rent and nineteen households were
 *     charged the new one.
 *   - the run read every non-cancelled change with no notice filter at all, so
 *     an increase `scheduleReRate` had written with `notice_given_on` NULL —
 *     which is every increase, until he records that notice went out — was
 *     billed to people nobody had told.
 *
 * The arithmetic was never the bug, so a test of `rentForPeriod` alone cannot
 * catch this. What has to hold is structural: ONE query, carrying the notice
 * filter, resolved at the same instant by both callers.
 */

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comments describe the bug; they must never be what satisfies the test. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const LEDGER = "src/app/park/ledger-actions.ts";
const RENT_CHANGES = "src/lib/rent-changes.ts";
const RENEW = "src/app/park/renew-actions.ts";
const EXTEND = "src/lib/extend-server.ts";
const AUTOMATION = "src/lib/automation.ts";

describe("the comment stripper", () => {
  it("removes both comment forms and keeps the code", () => {
    const stripped = code(`const a = 1; // lot_rent_changes\n/* lot_rent_changes */\nconst b = 2;`);
    expect(stripped).not.toContain("lot_rent_changes");
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("const b = 2;");
  });

  it("still finds a string that really is in the billing file", () => {
    // Proves the scanner reads the file it thinks it reads — otherwise every
    // assertion below would pass against an empty string.
    expect(code(read(LEDGER))).toContain("runCharges");
  });
});

describe("the billing paths share one rent history", () => {
  it("neither preview nor run queries lot_rent_changes directly", () => {
    const src = code(read(LEDGER));
    expect(src).not.toContain("lot_rent_changes");
  });

  it("both call servedRentHistory", () => {
    const src = code(read(LEDGER));
    const calls = src.match(/servedRentHistory\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it("both resolve the rate at the end of the month being billed", () => {
    const src = code(read(LEDGER));
    const resolved = src.match(/rentForPeriod\(/g) ?? [];
    expect(resolved.length).toBe(2);
    // Every rentForPeriod call takes lastDayOfMonth(month) as its instant. A
    // caller reaching for todayLakeDate() here is the old divergence returning.
    const atMonthEnd = src.match(/rentForPeriod\([\s\S]{0,200}?lastDayOfMonth\(month\)/g) ?? [];
    expect(atMonthEnd.length).toBe(2);
  });
});

/** `todayLakeDate()` INSIDE a rentForPeriod call's argument list (one level of
 *  nesting allowed, which is what `hist.byRes.get(id) ?? []` needs). A
 *  proximity match — anything within 200 characters — flagged the resident's
 *  loader for calling todayLakeDate() in the NEXT statement. */
const RESOLVED_AT_TODAY = /rentForPeriod\((?:[^()]|\([^()]*\))*todayLakeDate\(\)/;

describe("the successor doors read the same history the bills do", () => {
  // A rent increase is pinned to ONE link of a chain. Both doors that write
  // the next link used to copy `quoted_amount` off the prior row — the number
  // BEFORE the increase, until the nightly applied it — so a $425 served for
  // 1 April was written as $400 on the May–August agreement and evaporated
  // after one month. Now each door resolves the rent in force on the
  // successor's first morning from the served history, exactly as the bills do.
  it("the scanner still catches a door resolving at today", () => {
    expect("rentForPeriod(hist.byRes.get(id) ?? [], todayLakeDate(), quoted)").toMatch(RESOLVED_AT_TODAY);
    expect("rentForPeriod(changes, todayLakeDate(), q)").toMatch(RESOLVED_AT_TODAY);
    expect("rentForPeriod(changes, range.end, q);\n  const t = todayLakeDate();").not.toMatch(RESOLVED_AT_TODAY);
  });

  for (const [door, file] of [["renewAgreement", RENEW], ["extendByToken", EXTEND]] as const) {
    it(`${door} resolves the successor's rent through servedRentHistory + rentForPeriod`, () => {
      const src = code(read(file));
      expect(src).toMatch(/servedRentHistory\(/);
      expect(src).toMatch(/rentForPeriod\(/);
      // Resolved AT THE SUCCESSOR'S START, never at today or the prior's end.
      expect(src).not.toMatch(RESOLVED_AT_TODAY);
      // And never straight off the prior row into the insert.
      expect(src).not.toMatch(/quoted_amount:\s*(current!?|prior|res)\.quoted_amount/);
    });
  }

  it("the resident's tap writes the number the page printed — one field, not a second resolution", () => {
    // `view.price` is resolved once, in `extendViewFor`, and is what the page
    // prints. The token lookup hands its row to that function; the writer
    // takes the field back. A second rentForPeriod in either could disagree
    // with the sentence they tapped.
    const src = code(read(EXTEND));
    const writer = src.slice(src.indexOf("export async function extendByToken"));
    expect(writer).toMatch(/quotedAmount = view\.price/);
    expect(writer).not.toMatch(/rentForPeriod\(/);
    const lookup = src.slice(src.indexOf("export async function loadExtendByToken"), src.indexOf("export async function extendViewFor"));
    expect(lookup).toMatch(/return extendViewFor\(/);
    expect(lookup).not.toMatch(/rentForPeriod\(/);
    const view = src.slice(src.indexOf("export async function extendViewFor"), src.indexOf("export async function extendByToken"));
    expect(view.match(/rentForPeriod\(/g) ?? []).toHaveLength(1);
    expect(view).toMatch(/servedRentHistory\(/);
    expect(view).toMatch(/rentForPeriod\([^;]*range\.end/);
  });

  it("neither door queries lot_rent_changes on its own", () => {
    expect(code(read(RENEW))).not.toContain("lot_rent_changes");
    expect(code(read(EXTEND))).not.toContain("lot_rent_changes");
  });

  it("the ledger still uses it twice — the scanner has not gone blind", () => {
    expect((code(read(LEDGER)).match(/servedRentHistory\(/g) ?? []).length).toBe(2);
  });
});

describe("the text that mints the token quotes the page's resolution", () => {
  // The nightly reminder is the only path that creates an extend link. It
  // used to price the offer itself — the park's card, thirty nights out —
  // while the page it linked to showed the household's rent in force and a
  // new three-month agreement. Now both are ONE function, `extendViewFor`,
  // and the reminder resolves nothing on its own.
  const reminder = () => {
    const src = code(read(AUTOMATION));
    const a = src.indexOf("export async function remindExpiringStays");
    expect(a).toBeGreaterThan(-1);
    return src.slice(a, src.indexOf("export function extendReminderText", a));
  };

  it("the sweep hands each stay to extendViewFor and prices nothing itself", () => {
    const body = reminder();
    expect(body).toMatch(/await extendViewFor\(/);
    for (const own of [/extensionPrice\(/, /extendedRange\(/, /rentForPeriod\(/, /servedRentHistory\(/, /lot_rates/, /max_agreement_months/]) {
      expect(body).not.toMatch(own);
    }
    // And the module no longer imports the pieces it used to resolve with.
    const imports = code(read(AUTOMATION)).match(/import \{[^}]*\} from "@\/lib\/extend-stay"/)?.[0] ?? "";
    expect(imports).toContain("remindDecision");
    expect(imports).not.toMatch(/extendedRange|extensionPrice/);
  });

  it("a refusal the page would show stops the text BEFORE the token is minted", () => {
    const body = reminder();
    const refuse = body.indexOf("view.refusal");
    const mint = body.indexOf("extend_token: token");
    expect(refuse).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(refuse);
    // A failed read is a skip the owner can see, not a text priced off nothing.
    expect(body).toMatch(/instanceof ReadFailed/);
    expect(body).toMatch(/skipped\.push\(`Stay \$\{s\.id\}: couldn't read \$\{e\.what\}/);
  });

  it("the words come from the view's own fields — price, start, end, cap, deposit", () => {
    const src = code(read(AUTOMATION));
    const a = src.indexOf("export function extendReminderText");
    // Anchored on CODE at both ends. The window used to end at a section
    // banner that lives only in a comment — stripped, so indexOf was -1 and
    // the window ran to the end of the file, applying the negative match
    // below to every function after this one.
    const b = src.indexOf("export async function raiseTripFees", a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const words = src.slice(a, b);
    for (const f of ["view.price", "view.newStart", "view.newEnd", "view.currentEnd", "view.capMonths", "view.isRenewal", "view.depositHeld"]) {
      expect(words).toContain(f);
    }
    // Dates in words, never ISO.
    expect(words.match(/longDate\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(words).not.toMatch(/\$\{(view|range|next)\.(newEnd|newStart|currentEnd|end|start)\}/);
    // A deposit is mentioned only behind the fact — never as a bare literal.
    expect(words).toMatch(/view\.depositHeld \? " Your deposit carries over\." : ""/);
  });

  it("a failed read is named for the reader who sees it — the office, about somebody else's household", () => {
    // `e.what` from extendViewFor lands on the nightly's skipped list and in
    // the server log; the resident's page renders its own sentence and never
    // sees it. So no read in extendViewFor may be voiced to the tenant.
    const src = code(read(EXTEND));
    const view = src.slice(src.indexOf("export async function extendViewFor"), src.indexOf("export async function extendByToken"));
    const named = [...view.matchAll(/(?:mustRead|new ReadFailed)\("([^"]+)"/g)].map((m) => m[1]);
    expect(named.length, "the scanner still finds the reads").toBeGreaterThanOrEqual(6);
    for (const what of named) expect(what).not.toMatch(/\byour\b/);
    expect(named).toContain("the household's rent history");
    expect(named).toContain("the household's deposit");
  });

  it("the consent gate still sits in front of the view and the send", () => {
    const body = reminder();
    const gate = body.indexOf('renter?.contact_pref !== "sms"');
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf("await extendViewFor(")).toBeGreaterThan(gate);
    expect(body.indexOf("notify(")).toBeGreaterThan(gate);
  });
});

describe("applying a due change carries it down the chain", () => {
  const fn = () => {
    const src = code(read(RENT_CHANGES));
    return src.slice(src.indexOf("export async function applyDueRentChangesFor"), src.indexOf("export async function servedRentHistory"));
  };

  it("updates later links of the same chain still at the old number", () => {
    const body = fn();
    expect(body).toMatch(/\.eq\("agreement_chain_id"/);
    expect(body).toMatch(/\.gt\("agreement_seq"/);
    expect(body).toMatch(/\.eq\("quoted_amount",\s*c\.from_amount\)/);
  });

  it("marks the change applied only AFTER the chain write", () => {
    const body = fn();
    expect(body.indexOf('.gt("agreement_seq"')).toBeLessThan(body.indexOf("applied_at: new Date()"));
  });
});

describe("servedRentHistory", () => {
  const src = code(read(RENT_CHANGES));

  it("excludes increases whose notice was never served", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    expect(fn).toContain('.not("notice_given_on", "is", null)');
  });

  it("excludes cancelled changes, which are not history", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    expect(fn).toContain('.is("cancelled_at", null)');
  });

  it("does NOT filter applied_at — a past month needs applied changes", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    expect(fn).not.toContain("applied_at");
  });

  it("reports a failed read instead of returning an empty history", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    // An empty map reads as "nobody's rent ever changed", which bills every
    // month at today's rate.
    expect(fn).toMatch(/if \(res\.error\) return \{ byRes, error: res\.error \}/);
  });
});

describe("rentForPeriod, resolved at month end", () => {
  const JAN = lastDayOfMonth("2027-01");

  it("bills January at January's rent when the rise lands in February", () => {
    const changes = [{ effective_on: "2027-02-01", from_amount: 272, to_amount: 400 }];
    expect(rentForPeriod(changes, JAN, 400)).toBe(272);
  });

  it("bills January at the new rent once the rise has taken effect", () => {
    const changes = [{ effective_on: "2027-01-01", from_amount: 272, to_amount: 400 }];
    expect(rentForPeriod(changes, JAN, 400)).toBe(400);
  });

  it("falls back to today's rent only when nothing ever changed", () => {
    expect(rentForPeriod([], JAN, 272)).toBe(272);
  });

  it("lastDayOfMonth knows February, including a leap year", () => {
    expect(lastDayOfMonth("2027-02")).toBe("2027-02-28");
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2027-01")).toBe("2027-01-31");
  });
});
