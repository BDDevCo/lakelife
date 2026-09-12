import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { planOnboarding, onboardSummary, signingExplainer, contactProblem, type OnboardRow } from "./onboard-helpers";
import { SIGNED_LEASE_LABEL } from "./park-helpers";

// ---------------------------------------------------------------------------
// The last describe in this file drives the REAL `commitOnboarding` against an
// in-memory table, so its mocks are declared up front (vitest hoists them).
// The pure-helper tests are untouched by them.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { parks: [], park_members: [], park_renters: [], lot_reservations: [] };
const inserted: Array<{ table: string; row: Row }> = [];
class Q implements PromiseLike<{ data: Row[] | null; error: null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private ins: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  insert(row: Row) { this.ins = row; return this; }
  private run() {
    if (this.ins) {
      const row = { id: `${this.t}-${db[this.t].length + 1}`, ...this.ins };
      db[this.t].push(row);
      inserted.push({ table: this.t, row });
      return { data: [row], error: null };
    }
    return { data: db[this.t].filter((r) => this.fs.every((f) => f(r))), error: null };
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); }
  single() { return this.maybeSingle(); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/booking", () => ({ todayLakeDate: () => "2026-12-20" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const TODAY = "2026-12-16";

const row = (o: Partial<OnboardRow> = {}): OnboardRow => ({
  lotId: "l1", lotNumber: "3", displayName: "Amberg, Roy",
  rent: "395", movedInOn: "", signedNewLease: false, agreementStartsOn: "",
  email: "roy@example.com", phone: "(260) 555-0142", ...o,
});

describe("filing the households who were already there", () => {
  it("files a row with a name, and leaves an unknown move-in date UNKNOWN", () => {
    // This used to default the date to today. "I don't know when they moved in"
    // then became "they moved in today", and the resident's own screen greeted
    // a household of eleven years with "living here since" this morning.
    const p = planOnboarding([row()], TODAY);
    expect(p.toFile).toHaveLength(1);
    expect(p.toFile[0].movedInOn).toBe("");
    expect(p.toFile[0].rent).toBe(395);
  });

  it("keeps a move-in date the owner DOES know", () => {
    const p = planOnboarding([row({ movedInOn: "2015-04-02" })], TODAY);
    expect(p.toFile[0].movedInOn).toBe("2015-04-02");
  });

  it("SKIPS a blank name in silence and names the lot for later", () => {
    // He will not know all nineteen on the first afternoon. A form that refuses
    // to save until every row is complete is a form that saves nothing.
    const p = planOnboarding([row(), row({ lotId: "l2", lotNumber: "9", displayName: "" })], TODAY);
    expect(p.toFile).toHaveLength(1);
    expect(p.skipped).toBe(1);
    expect(p.blankLotNumbers).toEqual(["9"]);
    expect(p.problems).toEqual([]);
  });

  it("records a blank rent as UNKNOWN, never as zero", () => {
    // The ledger refuses to bill a null and would happily bill a zero, so the
    // difference decides whether the household is silently un-billed forever
    // or visibly missing a rent.
    const p = planOnboarding([row({ rent: "" })], TODAY);
    expect(p.toFile[0].rent).toBeNull();
  });

  it("takes a rent with a dollar sign and commas", () => {
    expect(planOnboarding([row({ rent: "$1,450" })], TODAY).toFile[0].rent).toBe(1450);
  });

  it("refuses junk in a rent rather than guessing at it", () => {
    const p = planOnboarding([row({ rent: "ask michael" })], TODAY);
    expect(p.toFile).toHaveLength(0);
    expect(p.problems[0].why).toMatch(/isn't a dollar amount/);
  });

  it("refuses a move-in date in the future — these are people already here", () => {
    const p = planOnboarding([row({ movedInOn: "2027-03-01" })], TODAY);
    expect(p.problems[0].why).toMatch(/already here/);
  });

  it("keeps a genuine historic move-in date", () => {
    expect(planOnboarding([row({ movedInOn: "2019-04-01" })], TODAY).toFile[0].movedInOn)
      .toBe("2019-04-01");
  });

  it("one bad row never costs the good ones", () => {
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1" }),
      row({ lotId: "b", lotNumber: "2", rent: "nope" }),
      row({ lotId: "c", lotNumber: "3" }),
    ], TODAY);
    expect(p.toFile.map((r) => r.lotNumber)).toEqual(["1", "3"]);
    expect(p.problems).toHaveLength(1);
  });
});

describe("what he is told before he writes it", () => {
  it("names the monthly total, because that is what he checks against the roll", () => {
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1", rent: "395" }),
      row({ lotId: "b", lotNumber: "2", rent: "410" }),
    ], TODAY);
    expect(onboardSummary(p, null)).toContain("File 2 households — $805.00 a month");
  });

  it("NAMES the lots with no rent, because those quietly never get billed", () => {
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1", rent: "395" }),
      row({ lotId: "b", lotNumber: "9", rent: "" }),
    ], TODAY);
    const s = onboardSummary(p, null);
    expect(s).toContain("1 with no rent set (lot 9)");
    expect(s).toMatch(/won't be billed until you set one/);
  });

  it("reports the SPLIT between signed and not, because both will exist", () => {
    // On the first morning some have signed and some haven't, and both still
    // live here and still owe rent.
    const mixed = planOnboarding([
      row({ lotId: "a", lotNumber: "1", signedNewLease: true }),
      row({ lotId: "b", lotNumber: "2", signedNewLease: false }),
    ], TODAY);
    expect(onboardSummary(mixed, 3))
      .toContain("1 on the new lease, 1 on the arrangement they already had");
  });

  it("treats nobody-has-signed as the ORDINARY state, not a chore outstanding", () => {
    // Onboarding an occupied park means exactly this: everyone is on whatever
    // they already had. It read "None have signed the new lease YET".
    const none = planOnboarding([row({ signedNewLease: false })], TODAY);
    expect(onboardSummary(none, null)).toContain("all on the arrangement they already had");
    expect(onboardSummary(none, null)).not.toMatch(/yet/i);
  });

  it("says plainly when everybody has", () => {
    const all = planOnboarding([row({ signedNewLease: true })], TODAY);
    expect(onboardSummary(all, null)).toMatch(/all on the new lease/);
  });

  // ---- the cap the park may not have ---------------------------------------

  it("never invents an agreement cap the park has not set", () => {
    // THE BUG: three sentences said "your three-month rule" as flat fact.
    // `max_agreement_months` is a per-park dial and NO park in the database has
    // ever set one — including The Haven. The screen was quoting a policy back
    // at owners who had never written it.
    const all = planOnboarding([row({ signedNewLease: true })], TODAY);
    const none = planOnboarding([row({ signedNewLease: false })], TODAY);
    for (const line of [onboardSummary(all, null), onboardSummary(none, null),
                        signingExplainer(null)]) {
      expect(line).not.toMatch(/three-month/);
      expect(line).not.toMatch(/\d+-month rule/);
    }
  });

  it("names the park's OWN cap when it has one", () => {
    const all = planOnboarding([row({ signedNewLease: true })], TODAY);
    expect(onboardSummary(all, 6)).toContain("capped by your 6-month rule");
  });

  it("the explainer quotes the TERM a signed agreement is written for — never the cap as the length", () => {
    // The Haven: one-month house style under a three-month cap. This read
    // 'a fresh agreement under your 3-month rule' while commitOnboarding
    // wrote one month. It takes agreementMonthsFor(default, max) now.
    expect(signingExplainer(1)).toContain("those get a fresh one-month agreement.");
    expect(signingExplainer(6)).toContain("those get a fresh 6-month agreement.");
    expect(signingExplainer(null)).toContain("those get a fresh agreement.");
    for (const line of [signingExplainer(1), signingExplainer(3), signingExplainer(null)]) {
      expect(line).not.toMatch(/-month rule/);
      expect(line).not.toMatch(/under your/);
    }
  });

  it("names the control that records a signing, rather than promising one", () => {
    // "The rule starts applying when they sign" was a sentence about a door
    // that did not exist: nothing on the rent roll could record a signature,
    // so a household filed clear stayed clear — and fee-exempt — forever.
    for (const line of [signingExplainer(null), signingExplainer(1)]) {
      expect(line).toContain("record it from their row on the rent roll");
      expect(line).toContain("'They signed the new lease'");
      // The control's words from their one home (park-helpers), never
      // retyped here — sign-helpers.test.ts scans this file's source for it.
      expect(line).toContain(`('${SIGNED_LEASE_LABEL}')`);
      expect(line).not.toMatch(/starts applying when they sign/);
    }
  });

  it("does not say the CAP starts when they sign — the successor runs the park's term, not its ceiling", () => {
    // The Haven: one-month house style under a three-month cap. The sentence
    // read "the new agreement, and your 3-month rule, starts from that day"
    // while recordSigning wrote ONE month. The cap is quoted where it is a
    // cap ("under your 3-month rule"); the signing sentence quotes no length.
    const line = signingExplainer(3);
    const signing = line.slice(line.indexOf("When one of them signs"));
    expect(signing, "the signing sentence is gone — this scan measures nothing").not.toBe("");
    expect(signing).not.toMatch(/\d+-month rule/);
    expect(signing).not.toMatch(/one-month rule/);
    expect(signing).toMatch(/starts from the day the lease runs from/);
  });

  // ---- park-agnostic -------------------------------------------------------

  it("mentions no seller anywhere, because most parks were never bought", () => {
    // Most parks joining already own themselves and have had the same
    // households for years. A screen that invents a seller reads as software
    // written for somebody else's deal.
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1", signedNewLease: true }),
      row({ lotId: "b", lotNumber: "2", signedNewLease: false }),
    ], TODAY);
    for (const line of [onboardSummary(p, null), onboardSummary(p, 3),
                        signingExplainer(null), signingExplainer(3)]) {
      expect(line).not.toMatch(/seller|closing|purchase|takeover/i);
    }
  });

  it("carries the signing state through to what gets written", () => {
    const p = planOnboarding([row({ signedNewLease: false })], TODAY);
    expect(p.toFile[0].signedNewLease).toBe(false);
  });

  it("counts what was left for later without calling it a failure", () => {
    const p = planOnboarding([row(), row({ lotId: "b", lotNumber: "9", displayName: "" })], TODAY);
    expect(onboardSummary(p, null)).toContain("1 still to do");
  });

  it("says nothing is filled in rather than reporting a zero total", () => {
    expect(onboardSummary(planOnboarding([], TODAY), null)).toBe("Nothing filled in yet.");
  });

  it("points at the problems when every row has one", () => {
    const p = planOnboarding([row({ rent: "nope" })], TODAY);
    expect(onboardSummary(p, null)).toMatch(/fix the lines below/);
  });
});

// ---------------------------------------------------------------------------

describe("the tick that claims a lease exists", () => {
  // THE WORST FINDING OF THE GO-LIVE REHEARSAL, and it is not in a pure
  // function — it is one word in a component's initial state, which is why it
  // survived every test up to now.
  //
  // Every checkbox defaulted to TICKED. The instruction above them reads "tick
  // anyone who has signed your new lease", which only makes sense from a clear
  // baseline. An owner who followed that instruction, ticked nobody because on
  // day one nobody has signed, and pressed File wrote a signed agreement for
  // every household in the park — and the summary line called it "all on the
  // new lease" as though describing his own work.
  const source = () => {
    const raw = readFileSync(
      new URL("../../components/ParkOnboard.tsx", import.meta.url), "utf8");
    // Comments are stripped, because the comment explaining this fix names the
    // old value and a naive grep would match it and pass forever.
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
  };

  it("finds the initial state it is scanning, so a rename cannot make this vacuous", () => {
    expect(source()).toMatch(/signedNewLease\s*:/);
  });

  it("starts every household CLEAR of the new lease", () => {
    expect(source()).toMatch(/signedNewLease\s*:\s*false/);
    expect(source()).not.toMatch(/signedNewLease\s*:\s*true/);
  });
});

// ---------------------------------------------------------------------------

describe("the number he checks before he taps File", () => {
  /**
   * THE SCREEN TOTALLED RENT AND THE RUN CHARGES MORE.
   *
   * A grounds fee lands on every tenancy signed with this owner, and the word
   * "fee" appeared nowhere on this screen. So filing twenty households at $400
   * read "$8,000 a month" while the January run would raise $10,850.60 — the
   * number he checks against his own roll was not the number that bills.
   */
  const signed = (o: Partial<OnboardRow> = {}) =>
    row({ signedNewLease: true, rent: "400", ...o });

  it("shows rent and fees as their own arithmetic, not one opaque total", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }), signed({ lotId: "b", lotNumber: "2" })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("$800.00 rent + $285.06 fees = $1,085.06 a month");
  });

  it("reads exactly as before for a park with no fees", () => {
    const p = planOnboarding([signed({ lotNumber: "1" })], TODAY);
    expect(onboardSummary(p, 3, 0)).toContain("$400.00 a month");
    expect(onboardSummary(p, 3, 0)).not.toContain("fees");
    // And the parameter is defaulted, so old callers are untouched.
    expect(onboardSummary(p, 3)).toBe(onboardSummary(p, 3, 0));
  });

  it("charges the fee only to the SIGNED rows", () => {
    // A holdover is an inherited tenancy and a fee never lands on one.
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       row({ lotId: "b", lotNumber: "2", rent: "400", signedNewLease: false })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("$800.00 rent + $142.53 fees = $942.53 a month");
  });

  it("does not count a fee for a row with no rent, which will not be billed", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       signed({ lotId: "b", lotNumber: "6", rent: "" })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("$400.00 rent + $142.53 fees = $542.53 a month");
  });

  it("NAMES the households left on the old arrangement", () => {
    // One missed tick is a household with no new lease and — because a fee
    // never lands on an inherited tenancy — no fee either. At twenty rows a
    // bare count will not tell him which one, and nothing later says so.
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       signed({ lotId: "b", lotNumber: "2" }),
       row({ lotId: "c", lotNumber: "14", rent: "400", signedNewLease: false })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("2 on the new lease, 1 on the arrangement they already had (lot 14)");
    expect(s).toContain("no fee will bill for it");
  });

  it("says nothing about fees in that sentence when the park has none", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       row({ lotId: "c", lotNumber: "14", rent: "400", signedNewLease: false })],
      TODAY,
    );
    expect(onboardSummary(p, 3, 0)).toContain("(lot 14)");
    expect(onboardSummary(p, 3, 0)).not.toContain("no fee will bill");
  });
});

// ---------------------------------------------------------------------------

describe("how to reach them, taken at signing", () => {
  /**
   * THE SCREEN CAPTURED NEITHER, AND HARDCODED BOTH TO EMPTY.
   *
   * Twenty households would have gone onto the roll with no address of any
   * kind — the invite refuses outright ("No email on file for them — print a
   * slip instead"), so nothing could ever be delivered and no file could be
   * claimed. The owner's rule is that both are a condition of renting a lot.
   *
   * REQUIRED, BUT NEVER SILENT. A row missing one is named with the reason
   * rather than dropped, because an unfiled household is not billed at all and
   * that is the worse end of this trade.
   */
  it("files a row that has both", () => {
    const p = planOnboarding([row()], TODAY);
    expect(p.toFile).toHaveLength(1);
    expect(p.toFile[0].email).toBe("roy@example.com");
    expect(p.toFile[0].phone).toBe("(260) 555-0142");
  });

  it("lower-cases the email, so two spellings are one address", () => {
    const p = planOnboarding([row({ email: "Roy.A@Example.COM" })], TODAY);
    expect(p.toFile[0].email).toBe("roy.a@example.com");
  });

  it("names the lot when one is missing, rather than filing them without it", () => {
    const p = planOnboarding([row({ lotNumber: "14", email: "" })], TODAY);
    expect(p.toFile).toHaveLength(0);
    expect(p.problems).toEqual([{ lotNumber: "14", why: "No email yet." }]);
  });

  it("says which one is missing when only one is", () => {
    expect(planOnboarding([row({ lotNumber: "6", phone: "" })], TODAY).problems)
      .toEqual([{ lotNumber: "6", why: "No phone number yet." }]);
    expect(planOnboarding([row({ lotNumber: "6", email: "", phone: "" })], TODAY).problems)
      .toEqual([{ lotNumber: "6", why: "No email or phone yet — both are needed to file." }]);
  });

  it("refuses an address that is not one, and a number too short to be one", () => {
    expect(planOnboarding([row({ email: "roy@" })], TODAY).problems[0].why)
      .toBe("That email doesn't look right.");
    expect(planOnboarding([row({ phone: "555" })], TODAY).problems[0].why)
      .toBe("That phone number looks short.");
  });

  it("still lets the rest of the afternoon file around a bad row", () => {
    // Eighteen good rows must never be lost to one incomplete one.
    const p = planOnboarding(
      [row({ lotId: "a", lotNumber: "1" }),
       row({ lotId: "b", lotNumber: "2", email: "" }),
       row({ lotId: "c", lotNumber: "7" })],
      TODAY,
    );
    expect(p.toFile.map((r) => r.lotNumber)).toEqual(["1", "7"]);
    expect(p.problems).toHaveLength(1);
  });

  it("leaves a wholly blank row as work still to do, not as a problem", () => {
    // A lot he has not got to yet is not an error, and never was.
    const p = planOnboarding([row({ lotNumber: "9", displayName: "", email: "", phone: "" })], TODAY);
    expect(p.problems).toHaveLength(0);
    expect(p.blankLotNumbers).toEqual(["9"]);
  });
});

// ---------------------------------------------------------------------------

describe("the day a signed lease runs from", () => {
  /**
   * A LEASE DATED 1 JANUARY, TYPED IN ON ANY OTHER DAY. The plan resolves the
   * start by the same rule the server applies (`agreementStartFor`), names
   * the lot when the date is refused, and says which month bills first.
   */
  const CUTOVER = "2027-01-01";
  const signed = (o: Partial<OnboardRow> = {}) => row({ signedNewLease: true, rent: "400", ...o });

  it("defaults a signed row filed before go-live to the cutover, not today", () => {
    const p = planOnboarding([signed()], "2026-12-20", CUTOVER);
    expect(p.toFile[0].agreementStartsOn).toBe("2027-01-01");
  });

  it("defaults to today after go-live, and keeps a typed date either side", () => {
    expect(planOnboarding([signed()], "2027-01-04", CUTOVER).toFile[0].agreementStartsOn).toBe("2027-01-04");
    expect(planOnboarding([signed({ agreementStartsOn: "2027-01-01" })], "2027-01-04", CUTOVER).toFile[0].agreementStartsOn)
      .toBe("2027-01-01");
    expect(planOnboarding([signed({ agreementStartsOn: "2027-02-01" })], "2027-01-04", CUTOVER).toFile[0].agreementStartsOn)
      .toBe("2027-02-01");
  });

  it("a holdover carries no agreement start at all", () => {
    const p = planOnboarding([row({ agreementStartsOn: "2027-01-01" })], "2026-12-20", CUTOVER);
    expect(p.toFile[0].agreementStartsOn).toBeNull();
  });

  it("names the lot whose date is before the ledger starts", () => {
    const p = planOnboarding([signed({ lotNumber: "14", agreementStartsOn: "2026-12-20" })], "2026-12-20", CUTOVER);
    expect(p.toFile).toHaveLength(0);
    expect(p.problems).toEqual([{
      lotNumber: "14",
      why: "The ledger starts on January 1, 2027 — an agreement can't begin before that.",
    }]);
  });

  it("says which month bills first, and for how much, when the leases start on the 1st", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }), signed({ lotId: "b", lotNumber: "2" })],
      "2026-12-20", CUTOVER,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("from January 1, 2027 — January 2027 bills $1,085.06");
    expect(s).not.toMatch(/2027-01/);
  });

  it("counts only the leases that start in the first month on its bill", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1", agreementStartsOn: "2027-01-01" }),
       signed({ lotId: "b", lotNumber: "2", agreementStartsOn: "2027-02-01" })],
      "2026-12-20", CUTOVER,
    );
    expect(onboardSummary(p, 3, 142.53)).toContain("from January 1, 2027 — January 2027 bills $542.53");
  });

  it("says a part month when a lease starts mid-month, rather than quoting a number the run will not raise", () => {
    const p = planOnboarding([signed({ agreementStartsOn: "2027-01-04" })], "2027-01-04", CUTOVER);
    expect(onboardSummary(p, 3, 142.53)).toContain("from January 4, 2027, so January 2027 bills a part month");
  });

  it("says nothing about a first month when nobody has signed", () => {
    const p = planOnboarding([row()], "2026-12-20", CUTOVER);
    expect(onboardSummary(p, 3, 142.53)).not.toMatch(/bills/);
  });
});

describe("contactProblem — one rule, one set of sentences, every door", () => {
  it("is the rule planOnboarding applies", () => {
    expect(contactProblem("roy@example.com", "(260) 555-0142")).toBeNull();
    expect(contactProblem("", "")).toBe("No email or phone yet — both are needed to file.");
    expect(contactProblem("", "(260) 555-0142")).toBe("No email yet.");
    expect(contactProblem("roy@", "(260) 555-0142")).toBe("That email doesn't look right.");
    expect(contactProblem("roy@example.com", "")).toBe("No phone number yet.");
    expect(contactProblem("roy@example.com", "555")).toBe("That phone number looks short.");
  });

  it("and planOnboarding says exactly what it says", () => {
    for (const [email, phone] of [["", ""], ["", "(260) 555-0142"], ["roy@", "x"], ["roy@example.com", ""], ["roy@example.com", "555"]]) {
      const p = planOnboarding([row({ email, phone })], TODAY);
      expect(p.problems[0]?.why).toBe(contactProblem(email, phone));
    }
  });
});

// ---------------------------------------------------------------------------
// THE PROP NOTHING PASSED. getOnboardSeeds returned the cutover and the screen
// accepted it, defaulting to null — and the page between them never handed it
// over. So before go-live the seeded date was today, the input had no floor,
// the summary promised December would bill, and the server refused every
// signed row by name. The whole of the f02 fix, built and never reached.
// ---------------------------------------------------------------------------
describe("the screen actually gets the cutover", () => {
  const page = readFileSync(new URL("./onboard/page.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\/.*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("finds the element it is scanning", () => {
    expect(page).toMatch(/<ParkOnboard[\s\S]*?\/>/);
  });

  it("the page hands the cutover to the screen — a prop nothing passes is no default", () => {
    const el = page.match(/<ParkOnboard[\s\S]*?\/>/)?.[0] ?? "";
    expect(el, "onboard/page.tsx does not pass cutoverDate").toMatch(/cutoverDate=\{res\.cutoverDate \?\? null\}/);
  });

  it("and the seeds carry it, or the prop is always null", () => {
    const actions = readFileSync(new URL("./onboard-actions.ts", import.meta.url), "utf8");
    const seeds = actions.slice(actions.indexOf("export async function getOnboardSeeds("), actions.indexOf("export async function commitOnboarding("));
    expect(seeds).toMatch(/\.select\("max_agreement_months, default_agreement_months, cutover_date"\)/);
    expect(seeds).toMatch(/cutoverDate: \(parkRow\?\.cutover_date as string \| null\) \?\? null/);
  });

  it("the term reaches the explainer: seeds → page → screen, with the arithmetic commitOnboarding writes", () => {
    // A prop nothing passes defaults to null and the explainer says 'a
    // fresh agreement' at a park writing one month — quietly, forever.
    const actions = readFileSync(new URL("./onboard-actions.ts", import.meta.url), "utf8");
    const seeds = actions.slice(actions.indexOf("export async function getOnboardSeeds("), actions.indexOf("export async function commitOnboarding("));
    expect(seeds).toMatch(/termMonths: agreementMonthsFor\(\s*\(parkRow\?\.default_agreement_months as number \| null\) \?\? null,\s*\(parkRow\?\.max_agreement_months as number \| null\) \?\? null,?\s*\)/);
    const el = page.match(/<ParkOnboard[\s\S]*?\/>/)?.[0] ?? "";
    expect(el).toMatch(/termMonths=\{res\.termMonths \?\? null\}/);
    const screen = readFileSync(new URL("../../components/ParkOnboard.tsx", import.meta.url), "utf8");
    expect(screen).toMatch(/\{signingExplainer\(termMonths\)\}/);
    expect(screen).not.toMatch(/signingExplainer\(capMonths\)/);
  });
});

// ---------------------------------------------------------------------------
// A ROW THE SERVER REFUSES IS NAMED, NEVER DROPPED. The screen plans from the
// same inputs, but the server holds a rule the screen can lack (the cutover,
// when the page did not hand it over) and a typed date can sit below the
// input's floor — so a signed row can be refused here alone. It used to leave
// the batch in silence: "N households filed" with the refused ones gone, or
// "Nothing filled in to file." when every row was filled in and refused.
// ---------------------------------------------------------------------------
const { commitOnboarding } = await import("./onboard-actions");

describe("commitOnboarding names what it refused", () => {
  beforeEach(() => {
    db.parks = [{ id: "park-1", cutover_date: "2027-01-01", default_agreement_months: 1, max_agreement_months: 3 }];
    db.park_members = [{ park_id: "park-1", user_id: "owner", role: "owner" }];
    db.park_renters = [];
    db.lot_reservations = [];
    inserted.length = 0;
  });

  // A signed lease typed with a date the client did not know was below the
  // floor — 20 December, on a ledger that starts 1 January.
  const signedTooEarly = row({ lotId: "l1", lotNumber: "1", signedNewLease: true, agreementStartsOn: "2026-12-20" });
  const holdover = row({ lotId: "l2", lotNumber: "2", displayName: "Reyes, Donna", signedNewLease: false });

  it("every row refused: says so, names each lot and why, and writes nothing", async () => {
    const res = await commitOnboarding("park-1", [signedTooEarly]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("None of those could be filed.");
    expect(res.error).not.toMatch(/Nothing filled in/);
    expect(res.failed).toEqual([
      { lotNumber: "1", why: "The ledger starts on January 1, 2027 — an agreement can't begin before that." },
    ]);
    expect(inserted).toEqual([]);
  });

  it("some refused: files the rest, and the refused one is on the list with its reason", async () => {
    const res = await commitOnboarding("park-1", [signedTooEarly, holdover]);
    expect(res.ok, res.error).toBe(true);
    expect(res.filed).toBe(1);
    expect(res.failed).toEqual([
      { lotNumber: "1", why: "The ledger starts on January 1, 2027 — an agreement can't begin before that." },
    ]);
    expect(res.signal).toBe("1 household filed, 1 couldn't be.");
    expect(inserted.map((i) => i.table)).toEqual(["park_renters", "lot_reservations"]);
    expect(inserted[1].row).toMatchObject({ park_lot_id: "l2", origin: "grandfathered" });
  });

  it("nothing typed at all is still 'nothing filled in' — that sentence is for an empty screen only", async () => {
    const res = await commitOnboarding("park-1", [row({ displayName: "" })]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Nothing filled in to file.");
    expect(res.failed).toBeUndefined();
  });
});
