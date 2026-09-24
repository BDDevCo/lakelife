import { describe, it, expect } from "vitest";
import {
  ADDON_OFFER_BACK_DAYS,
  ADDON_REQUEST_MAX,
  addonMoney,
  crewStateSentence,
  lastChargedLine,
  normaliseAddonRequest,
  normaliseCrewQuote,
  offerBack,
  ownerStateSentence,
  standardScopeLine,
  withAddons,
  type AddonStatus,
} from "./addons";
import { customerPrice, crewPayout, platformTake } from "./platform-fee";

/**
 * THE EXTRA THEY ASKED FOR — the arithmetic, the bounds and the sentences.
 *
 * Nothing here recomputes a figure from the expression under test: every
 * expected number is written out by hand from a seeded quote and a seeded
 * percentage, so a bug in the helper cannot agree with itself.
 */

const FEE = { customerPct: 0.12, crewPct: 0.12 };

describe("the money rides the platform fee and nothing re-derives it", () => {
  it("bills the crew's number plus the customer fee and pays it less the crew fee", () => {
    // $40 at 12/12, by hand: 40 x 1.12 = 44.80, 40 x 0.88 = 35.20.
    const m = addonMoney(40, FEE);
    expect(m.crewQuote).toBe(40);
    expect(m.customerPrice).toBe(44.8);
    expect(m.crewPayout).toBe(35.2);
  });

  it("ties on awkward cents — the difference of the two ROUNDED ends", () => {
    // $67.49 at 12/12. By hand: 67.49 x 1.12 = 75.5888 -> 75.59;
    //                            67.49 x 0.88 = 59.3912 -> 59.39.
    const m = addonMoney(67.49, FEE);
    expect(m.customerPrice).toBe(75.59);
    expect(m.crewPayout).toBe(59.39);
    // The identity the whole ledger rests on, asserted against the SHARED
    // helper rather than against a subtraction this test performed.
    expect(m.customerPrice - m.crewPayout).toBeCloseTo(platformTake(67.49, FEE), 10);
    expect(platformTake(67.49, FEE)).toBe(16.2);
  });

  it("uses the same two functions the rest of the product uses", () => {
    for (const q of [1, 12.34, 99.99, 416, 1250.5]) {
      const m = addonMoney(q, FEE);
      expect(m.customerPrice).toBe(customerPrice(q, FEE));
      expect(m.crewPayout).toBe(crewPayout(q, FEE));
    }
  });

  it("a dial out of band is loud, not silent", () => {
    expect(() => addonMoney(40, { customerPct: 0.12, crewPct: 1 })).toThrow(/crewPct/);
  });
});

describe("an agreed extra survives a reprice", () => {
  it("adds both ends and keeps margin equal to their difference", () => {
    // Base visit: $604 to the customer, $480 to the crew. Extra: $44.80 / $35.20.
    const t = withAddons({ customer: 604, cost: 480 }, { customer: 44.8, payout: 35.2 });
    expect(t.customer).toBe(648.8);
    expect(t.cost).toBe(515.2);
    expect(t.margin).toBe(133.6);
    expect(t.margin).toBeCloseTo(t.customer - t.cost, 10);
  });

  it("no extras leaves the base untouched", () => {
    const t = withAddons({ customer: 465.92, cost: 366.08 }, { customer: 0, payout: 0 });
    expect(t.customer).toBe(465.92);
    expect(t.cost).toBe(366.08);
    // 465.92 - 366.08 lands on 99.83999999999997 in float; the row must carry 99.84.
    expect(t.margin).toBe(99.84);
  });
});

describe("the box the owner types into", () => {
  it("collapses whitespace but never mangles the words", () => {
    const r = normaliseAddonRequest("  Trim the cedars &\n\n  haul the clippings — don't touch the dock  ");
    expect(r.ok).toBe(true);
    // `&`, `'` and an em dash survive: the ONE escaper (lib/html-safe) makes
    // them safe in a mail body, and stripping them here would mean the crew
    // reads a different sentence from the one the owner wrote.
    expect(r.text).toBe("Trim the cedars & haul the clippings — don't touch the dock");
  });

  it("refuses an empty box without accusing them of leaving it empty", () => {
    const r = normaliseAddonRequest("   \n  ");
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
    expect(r.problem).toMatch(/Tell your crew/);
  });

  it("names the number they hit rather than describing an absent value", () => {
    const r = normaliseAddonRequest("x".repeat(ADDON_REQUEST_MAX + 1));
    expect(r.ok).toBe(false);
    // A sanitised value looks like an absent one: the ATTEMPT is carried
    // through so the refusal can name it.
    expect(r.attemptedLength).toBe(ADDON_REQUEST_MAX + 1);
    expect(r.problem).toContain(String(ADDON_REQUEST_MAX + 1));
    expect(r.problem).toContain(String(ADDON_REQUEST_MAX));
  });

  it("accepts exactly the bound", () => {
    expect(normaliseAddonRequest("y".repeat(ADDON_REQUEST_MAX)).ok).toBe(true);
  });
});

describe("the crew names the number, and nobody names it for them", () => {
  it("an empty box asks a question and is not answered with a default", () => {
    const r = normaliseCrewQuote("");
    expect(r.ok).toBe(false);
    expect(r.amount).toBe(0);
    // No suggestion, no "crews near you charge", no placeholder figure.
    expect(r.problem).not.toMatch(/\$\d/);
  });

  it("zero is refused — zero is this platform's word for unpriceable", () => {
    expect(normaliseCrewQuote("0").ok).toBe(false);
    expect(normaliseCrewQuote("-5").ok).toBe(false);
  });

  it("reads $ and thousands separators, and holds the answer to two places", () => {
    expect(normaliseCrewQuote("$1,250.50")).toEqual({ ok: true, amount: 1250.5, problem: null });
    // A third decimal is the one input on which Postgres and JavaScript can
    // round a half in opposite directions (0180's whole-cents CHECK).
    expect(normaliseCrewQuote("40.125").ok).toBe(false);
  });

  it("refuses something that is not a number at all", () => {
    expect(normaliseCrewQuote("about fifty").ok).toBe(false);
  });
});

describe("a saved price goes stale, and that is the dangerous part", () => {
  const MAY = new Date("2026-05-12T15:00:00Z");

  it("offers back a price from last week", () => {
    const got = offerBack(MAY, new Date("2026-05-19T15:00:00Z"));
    expect(got.offerable).toBe(true);
    expect(got.ageDays).toBe(7);
    expect(got.why).toBeNull();
  });

  it("offers back on the ninetieth day and refuses on the ninety-first", () => {
    const day = 86_400_000;
    const on90 = offerBack(MAY, new Date(MAY.getTime() + ADDON_OFFER_BACK_DAYS * day));
    expect(on90.offerable).toBe(true);
    const on91 = offerBack(MAY, new Date(MAY.getTime() + (ADDON_OFFER_BACK_DAYS + 1) * day));
    expect(on91.offerable).toBe(false);
    expect(on91.why).toMatch(/price it as it stands today/);
  });

  it("refuses a May price in October — the whole point of the rule", () => {
    const october = offerBack(MAY, new Date("2026-10-14T15:00:00Z"));
    expect(october.offerable).toBe(false);
    expect(october.ageDays).toBeGreaterThan(ADDON_OFFER_BACK_DAYS);
  });

  it("a date we cannot read is never fresh", () => {
    expect(offerBack(null).offerable).toBe(false);
    expect(offerBack("not a date").offerable).toBe(false);
    expect(offerBack(undefined).why).toMatch(/can't tell when/);
  });

  it("shows the number AND the day it was given, never a bare figure", () => {
    expect(lastChargedLine({ charged: "$44.80", named: "August 12, 2026" }))
      .toBe("This crew charged you $44.80 for this, at a price they named on August 12, 2026.");
  });

  it("states the past in PAST figures, and names today's only when it differs", () => {
    // The historical claim is the frozen customer_price off the accepted row.
    // Recomputing it at today's dial made "what this crew charged last time"
    // a number nobody was ever charged, the moment the dial moved.
    const same = lastChargedLine({ charged: "$44.80", named: "August 12, 2026", todayPrice: "$44.80" });
    expect(same).not.toMatch(/today/);
    const moved = lastChargedLine({ charged: "$44.80", named: "August 12, 2026", todayPrice: "$46.20" });
    expect(moved).toContain("$44.80");
    expect(moved).toContain("$46.20");
    expect(moved).toMatch(/Our fee has changed since/);
  });
});

describe("the ninety days runs from the day the crew NAMED the number", () => {
  // THE BUG THIS PINS: freshness used to be measured from `decided_at`, and
  // `repeatAddon` files a fresh row and accepts it — so every tap moved the
  // clock and a January price was still "fresh" in 2028. `repeatAddon` now
  // carries `quoted_at` forward unchanged and this is the function that reads
  // it, so a chain ages from its origin.
  const NAMED = new Date("2026-05-12T15:00:00Z");
  const day = 86_400_000;

  it("a chain of repeats cannot outlive the quote that started it", () => {
    // Tapped on day 80, day 160, day 240 — the number was named once, in May.
    for (const tapped of [80, 160, 240]) {
      const at = new Date(NAMED.getTime() + tapped * day);
      const got = offerBack(NAMED, at);
      expect(got.offerable, `a ${tapped}-day-old quote was still offerable`).toBe(tapped <= ADDON_OFFER_BACK_DAYS);
    }
  });

  it("and the date it reports is the one a screen prints as 'your crew priced it on'", () => {
    // Same instant in, same age out: there is one clock, not two.
    expect(offerBack(NAMED, new Date(NAMED.getTime() + 30 * day)).ageDays).toBe(30);
  });
});

describe("three states, three sentences, and none of them cancels the visit", () => {
  const svc = "weekly mow";
  const states: AddonStatus[] = ["requested", "crew_declined", "owner_declined"];

  it("says something different for each", () => {
    const lines = states.map((s) =>
      ownerStateSentence({ status: s, serviceName: svc, price: "$44.80", crewReason: "no chipper on the truck" }).line);
    expect(new Set(lines).size).toBe(3);
    expect(new Set(states.map((s) => ownerStateSentence({ status: s, serviceName: svc }).pill)).size).toBe(3);
  });

  it("every one of them says the booked visit goes ahead", () => {
    for (const s of states) {
      const said = ownerStateSentence({ status: s, serviceName: svc, price: "$44.80" }).line;
      expect(said, `the ${s} sentence does not promise the ${svc} still happens`)
        .toMatch(/goes ahead as booked/);
    }
    // And so does the one they are being asked to decide.
    expect(ownerStateSentence({ status: "quoted", serviceName: svc, price: "$44.80" }).line)
      .toMatch(/still goes ahead exactly as booked/);
  });

  it("the crew's own words come back when they would not quote, and nothing is invented when they said none", () => {
    expect(ownerStateSentence({ status: "crew_declined", serviceName: svc, crewReason: "no chipper on the truck" }).line)
      .toContain("no chipper on the truck");
    const silent = ownerStateSentence({ status: "crew_declined", serviceName: svc, crewReason: "   " }).line;
    expect(silent).not.toMatch(/:/);
    expect(silent).toMatch(/isn't taking this one on\./);
  });

  it("an unquoted or declined extra is never called an error", () => {
    // THE ALARM CLASS IS `red`. The first version of this asserted `!== "err"`
    // — a string that is not in the tone union, is not a pill class anywhere
    // in globals.css, and could therefore never fail. A fence has to be around
    // something: `red` is the tone the product actually draws for danger
    // (.ll-pill.red, globals.css), and none of these may use it.
    const drawn: string[] = ["warn", "teal", "ok", "slate"];
    for (const s of [...states, "quoted", "accepted", "withdrawn", "crew_left"] as AddonStatus[]) {
      const v = ownerStateSentence({ status: s, serviceName: svc });
      expect(v.tone, `${s} is drawn as an alarm`).not.toBe("red");
      expect(drawn, `${s} uses a tone the pill vocabulary does not have`).toContain(v.tone);
      expect(v.line).not.toMatch(/error|failed|went wrong/i);
    }
    for (const s of ["requested", "quoted", "crew_declined", "accepted", "owner_declined", "withdrawn", "crew_left"] as AddonStatus[]) {
      expect(crewStateSentence({ status: s }).tone).not.toBe("red");
    }
  });

  it("a crew's reason is quoted as a finished sentence, not run into the next one", () => {
    // `...on: "no chipper on the truck" Nothing was added` — no full stop
    // after the quote, on the half of the branch that ships most often.
    const said = ownerStateSentence({
      status: "crew_declined", serviceName: svc, crewReason: "no chipper on the truck",
    }).line;
    expect(said).toContain('"no chipper on the truck". Nothing was added');
  });

  it("an extra taken off because the crew left says it came OFF the bill", () => {
    const v = ownerStateSentence({ status: "crew_left", serviceName: svc, price: "$44.80" });
    expect(v.tone).toBe("slate");
    expect(v.line).toContain("$44.80");
    expect(v.line).toMatch(/won't be charged for it/);
    expect(v.line).toMatch(/goes ahead as booked/);
    // And it is not confusable with either decline.
    expect(v.line).not.toBe(ownerStateSentence({ status: "owner_declined", serviceName: svc, price: "$44.80" }).line);
    expect(v.pill).not.toBe(ownerStateSentence({ status: "owner_declined", serviceName: svc }).pill);
  });

  it("nothing charged is said out loud wherever nothing was charged", () => {
    for (const s of ["crew_declined", "owner_declined"] as AddonStatus[]) {
      expect(ownerStateSentence({ status: s, serviceName: svc, price: "$44.80" }).line)
        .toMatch(/nothing was charged/i);
    }
  });
});

describe("the crew is told both numbers, every time either is shown", () => {
  it("says the quote and the take-home together", () => {
    const said = crewStateSentence({ status: "accepted", quote: "$40.00", payout: "$35.20" }).line;
    expect(said).toContain("$40.00");
    expect(said).toContain("$35.20");
  });

  it("never shows a figure it cannot pair", () => {
    const said = crewStateSentence({ status: "quoted", quote: null, payout: null }).line;
    expect(said).not.toMatch(/\$/);
  });

  it("tells them the booked job is unaffected while they decide", () => {
    expect(crewStateSentence({ status: "requested" }).line).toMatch(/booked job goes ahead/);
    expect(crewStateSentence({ status: "owner_declined" }).line).toMatch(/booked job goes ahead/);
  });
});

describe("what the standard service includes — the honest answer", () => {
  it("says plainly that we do not hold one", () => {
    const s = standardScopeLine({ serviceName: "Weekly mow", photographed: ["Overall", "Deck"], control: "box" });
    expect(s.headline).toBe("We don't hold a written list of what your Weekly mow covers.");
    // It must not imply a scope it cannot produce.
    expect(s.detail).not.toMatch(/includes the following|covers:/i);
    // And what it DOES show is named as evidence, not as the work.
    expect(s.detail).toMatch(/photograph/);
    expect(s.detail).toMatch(/evidence rather than a list of the work/);
    expect(s.photographed).toEqual(["Overall", "Deck"]);
  });

  it("names a control ONLY when the caller says it draws one", () => {
    // The first version of this asserted that the detail matched /box below/
    // — a string matching itself, which passed with the branch deleted. The
    // real defect it was supposed to cover is that the box renders only when
    // `canAsk`, and the notice rendered always: over a finished visit and one
    // with no crew, "ask your crew in the box below" named nothing on screen.
    expect(standardScopeLine({ serviceName: "Mow", control: "box" }).detail).toMatch(/box below/);
    const none = standardScopeLine({ serviceName: "Mow", control: "none" }).detail;
    expect(none).not.toMatch(/box below/);
    expect(none).not.toMatch(/ask your crew/i);
    // The approvals card has no box on the page in any state, so it names the
    // visit — and it draws a link to it.
    expect(standardScopeLine({ serviceName: "Mow", control: "visit" }).detail).toMatch(/Open the visit/);
    // Defaulting to "none" is the safe direction: a caller that forgets to say
    // what it draws instructs nothing.
    expect(standardScopeLine({ serviceName: "Mow" }).detail).not.toMatch(/box below/);
  });

  it("does not put an article in front of a service name", () => {
    // `a ${svc}` produced "a Lawn mowing & trim" and "a Housekeeping" — the
    // two services this feature was written for.
    for (const name of ["Lawn mowing & trim", "Housekeeping", "Weekly mow"]) {
      expect(standardScopeLine({ serviceName: name }).headline).toBe(
        `We don't hold a written list of what your ${name} covers.`,
      );
    }
  });

  it("does not pretend to have a shot list when the service has none", () => {
    const s = standardScopeLine({ serviceName: "Mow", photographed: [] });
    expect(s.photographed).toEqual([]);
    expect(s.detail).toMatch(/can't even show you what they photograph/);
  });
});
