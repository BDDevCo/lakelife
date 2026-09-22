import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  readinessFor, readinessProgress, readinessComplete, firstUndone, showReadinessOnToday,
  readinessHeadline, firstRunCard, firstRunTaskKey, readinessFactsFrom,
  NO_LAKE_LINE, NO_PIN_LINE, NO_LAKE_OR_PIN_LINE,
  type ReadinessFacts, type ContactFacts, type ReadinessKey, type ReadinessPreRead,
} from "./readiness";

/**
 * EVERY ROW, BOTH WAYS, PER COLUMN.
 *
 * A readiness row is earned by the column it names, so each test flips one
 * fact off and expects the not-done sentence, its next step and its door —
 * then leaves it on and expects the done sentence. Nothing here is a real
 * park: the fixture is Cedar Hollow, 21 lots, invented.
 */

const TODAY = "2026-09-16";

const BASE: ReadinessFacts = {
  parkName: "Cedar Hollow",
  today: TODAY,
  lots: 21,
  liveLots: 21,
  activeLots: 21,
  liveLotsWithRate: 21,
  monthlyRoll: 5200,
  occupiedLiveLots: 18,
  reservedLiveLots: 0,
  householdsMissingContact: 0,
  cutoverOn: "2027-01-01",
  rentDueDay: 1,
  maxAgreementMonths: 6,
  activeFees: 2,
  lakeName: "Big Long Lake",
  hasMapPin: true,
  termsAccepted: true,
  published: true,
  viewerIsOwner: true,
  noticesHeldOn: null,
  onlineRentOn: true,
  processorLive: true,
};

const NOBODY: ContactFacts = { invitesSent: 0, documentsDelivered: 0, remindersSent: 0, slipsIssued: 0, chargesRaised: 0, paymentsRecorded: 0 };

/** A screen's source with its comments stripped, for pinning a quoted control to the button it names. */
const sourceOf = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const row = (f: Partial<ReadinessFacts>, key: ReadinessKey) => {
  const r = readinessFor({ ...BASE, ...f }).find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
};

describe("the rows come in setup order, and the optional ones are the five dials whose forms say blank is fine", () => {
  it("pins the keys", () => {
    expect(readinessFor(BASE).map((r) => r.key)).toEqual([
      "lots", "rates", "households", "cutover", "rent_due", "cap", "fees", "map", "terms", "published", "notices", "online",
    ]);
  });
  it("pins which are optional (households only once published)", () => {
    const optional = readinessFor(BASE).filter((r) => r.optional).map((r) => r.key);
    expect(optional).toEqual(["households", "cutover", "cap", "fees", "notices", "online"]);
    const unpublished = readinessFor({ ...BASE, published: false }).filter((r) => r.optional).map((r) => r.key);
    expect(unpublished).toEqual(["cutover", "cap", "fees", "notices", "online"]);
  });
  it("everything done: 6 of 6 required on a published park, 7 of 7 unpublished", () => {
    expect(readinessProgress(readinessFor(BASE))).toEqual({ done: 6, required: 6 });
    expect(readinessProgress(readinessFor({ ...BASE, published: false }))).toEqual({ done: 6, required: 7 });
  });
});

describe("lots — park_lots", () => {
  it("21 on file", () => {
    const r = row({}, "lots");
    expect(r).toMatchObject({ done: true, optional: false, label: "21 lots on file", next: null, href: "/park/lots" });
  });
  it("names the ones not live and the ones switched off", () => {
    expect(row({ liveLots: 19 }, "lots").label).toBe("21 lots on file — 19 live");
    expect(row({ activeLots: 20 }, "lots").label).toBe("21 lots on file — 1 switched off");
    expect(row({ liveLots: 19, activeLots: 0 }, "lots").label).toBe("21 lots on file — 19 live — 21 switched off");
    expect(row({ lots: 1, liveLots: 1, activeLots: 1 }, "lots").label).toBe("1 lot on file");
  });
  it("none yet: the two buttons the zero-lot screen actually opens on", () => {
    const r = row({ lots: 0, liveLots: 0, activeLots: 0 }, "lots");
    expect(r).toMatchObject({
      done: false, optional: false, label: "No lots yet",
      next: "Add your lots — 'Add these lots' numbers a whole row, or 'Save lot' adds one — under Lots & rates",
      href: "/park/lots",
    });
    // Not the header button or the collapsed row button — both are hidden
    // when there are no lots (editing starts as "new", BulkAdd opens).
    expect(r.next).not.toMatch(/'Add a lot'|'Add my first lot'|'Add a row of lots'|numbered range/);
  });
});

describe("a quoted control is the button as it reads on that screen", () => {
  // The way ParkNav.test pins pill labels to h1s: read the screen's source
  // with comments stripped, prove the scanner still finds the buttons, then
  // require every phrase a `next` quotes to be on it.
  const lotsSrc = sourceOf("../../components/ParkLots.tsx");
  const layoutSrc = sourceOf("./layout.tsx");

  it("the scanner finds the buttons it is about to quote", () => {
    expect(lotsSrc).toMatch(/Set rates on all \{lotCount\} lots/);
    expect(lotsSrc).toMatch(/>\s*Save rates\s*</);
    expect(lotsSrc).toMatch(/"Rates"/);
    expect(lotsSrc).toMatch(/>\s*Add these lots\s*</);
    expect(lotsSrc).toMatch(/>Save lot</);
    expect(lotsSrc).toMatch(/<h3[^>]*>Add your lots</);
    expect(layoutSrc).toMatch(/cta="I agree — take me to my park"/);
  });

  it("the rates row quotes 'Set rates on all N lots' with N = every lot on file, and only when the button is drawn", () => {
    // ParkLots draws BulkRates only for lots.length > 1, and its N is
    // lots.length — every park_lots row, any lifecycle — so it is f.lots,
    // not f.liveLots: a park with one lot not yet live reads "all 21 lots".
    expect(lotsSrc).toMatch(/lots\.length > 1 && <BulkRates parkId=\{parkId\} lotCount=\{lots\.length\} \/>/);
    expect(row({ lots: 21, liveLots: 20, liveLotsWithRate: 19 }, "rates").next)
      .toBe("'Rates' on a lot, then 'Save rates' — or 'Set rates on all 21 lots'");
    // One lot: the bulk button is not on the screen, so it is not quoted.
    expect(row({ lots: 1, liveLots: 1, activeLots: 1, liveLotsWithRate: 0 }, "rates").next)
      .toBe("'Rates' on the lot, then 'Save rates'");
    expect(row({ lots: 1, liveLots: 1, activeLots: 1, liveLotsWithRate: 0 }, "rates").next).not.toContain("Set rates on all");
    // Never the panel heading that only shows once the button is pressed.
    expect(row({ liveLotsWithRate: 20 }, "rates").next).not.toContain("Set rates on many lots");
    expect(lotsSrc).toMatch(/<h3[^>]*>Set rates on many lots</);
  });

  it("the terms row quotes the TermsGate's button and its route — /agreements has no accept control", () => {
    expect(sourceOf("../agreements/page.tsx")).not.toMatch(/accept/i);
    expect(row({ termsAccepted: false }, "terms")).toMatchObject({ next: "I agree — take me to my park", href: "/park" });
  });
});

describe("rates — lot_rates over the live lots", () => {
  it("every live lot priced, with the monthly roll through money()", () => {
    expect(row({}, "rates")).toMatchObject({
      done: true, label: "Every live lot has a rent — 21 of 21, $5,200.00 a month", next: null, href: "/park/lots",
    });
    expect(row({ monthlyRoll: 0 }, "rates").label).toBe("Every live lot has a rent — 21 of 21");
  });
  it("20 of 21", () => {
    expect(row({ liveLotsWithRate: 20 }, "rates")).toMatchObject({
      done: false, optional: false, label: "20 of 21 live lots have a rent",
      next: "'Rates' on a lot, then 'Save rates' — or 'Set rates on all 21 lots'",
      href: "/park/lots",
    });
  });
  it("no live lots: nothing to price, and no next (the lots row owns it)", () => {
    expect(row({ liveLots: 0, liveLotsWithRate: 0 }, "rates")).toMatchObject({ done: false, label: "No live lots to price yet", next: null });
  });
});

describe("households — lot_reservations on live lots, contact off park_renters", () => {
  it("nobody filed, on an unpublished park, is a required ☐ with the Who lives here door", () => {
    expect(row({ occupiedLiveLots: 0, published: false }, "households")).toMatchObject({
      done: false, optional: false, label: "Nobody filed on your 21 live lots yet",
      next: "File who lives on each lot — Who lives here", href: "/park/onboard",
    });
    expect(row({ occupiedLiveLots: 0, liveLots: 1, published: false }, "households").label).toBe("Nobody filed on your 1 live lot yet");
  });
  it("with no live lot the Who lives here door says there is nobody to put on one — so no next, and the lots screen", () => {
    // Both states the destination distinguishes, pinned separately.
    expect(row({ lots: 0, liveLots: 0, activeLots: 0, occupiedLiveLots: 0, published: false }, "households")).toMatchObject({
      done: false, optional: false, label: "No lots yet to put anyone on", next: null, href: "/park/lots",
    });
    expect(row({ lots: 21, liveLots: 0, occupiedLiveLots: 0, published: false }, "households")).toMatchObject({
      done: false, optional: false, label: "Nobody filed yet — none of your 21 lots is live", next: null, href: "/park/lots",
    });
    expect(row({ lots: 1, liveLots: 0, occupiedLiveLots: 0, published: false }, "households").label).toBe("Nobody filed yet — none of your 1 lot is live");
    // The other half of the branch: one live lot and nobody on it IS the door.
    expect(row({ lots: 21, liveLots: 1, occupiedLiveLots: 0, published: false }, "households")).toMatchObject({
      next: "File who lives on each lot — Who lives here", href: "/park/onboard",
    });
    // The rates row's own wording for the same state is not repeated here.
    expect(row({ lots: 21, liveLots: 0, occupiedLiveLots: 0 }, "households").label).not.toContain("live lot");
  });
  it("FILED counts before it has STARTED — the December roll is spoken for, not nobody", () => {
    // Every pre-go-live row is dated from the takeover day, so between the
    // roll landing and 1 January all 18 are reserved and none occupied.
    const r = row({ occupiedLiveLots: 0, reservedLiveLots: 18, published: false }, "households");
    expect(r).toMatchObject({
      done: true, optional: false,
      label: "18 of 21 live lots spoken for — their tenancies start later",
      next: null, href: "/park",
    });
    expect(r.href).not.toBe("/park/onboard");
    // Collapsed back to occupied-only, the same facts would read as nobody.
    expect(row({ occupiedLiveLots: 0, reservedLiveLots: 0, published: false }, "households").done).toBe(false);
    // The contact tail survives on this branch — the Jan 1 plan needs email+phone.
    expect(row({ occupiedLiveLots: 0, reservedLiveLots: 18, householdsMissingContact: 18 }, "households")).toMatchObject({
      done: true,
      label: "18 of 21 live lots spoken for — their tenancies start later — 18 still lack an email or a number the office can ring",
      next: "Add their email and phone from their row on the rent roll",
    });
    // Mixed: a renewal or a December signing beside people already living there.
    expect(row({ occupiedLiveLots: 15, reservedLiveLots: 3 }, "households").label)
      .toBe("18 of 21 live lots have a household on them — 3 of those start later");
    expect(row({ occupiedLiveLots: 17, reservedLiveLots: 1 }, "households").label)
      .toBe("18 of 21 live lots have a household on them — 1 of those starts later");
  });
  it("nobody filed on a PUBLISHED park is a vacancy — the same row, optional", () => {
    // Published with three empty lots is not unfinished setup; the
    // occupancy line already names them. Pinned both ways.
    expect(row({ occupiedLiveLots: 0, published: true }, "households")).toMatchObject({ done: false, optional: true });
    expect(row({ occupiedLiveLots: 0, published: false }, "households")).toMatchObject({ done: false, optional: false });
  });
  it("18 of 21 filed", () => {
    expect(row({}, "households")).toMatchObject({
      done: true, label: "18 of 21 live lots have a household on them", next: null, href: "/park",
    });
  });
  it("a DONE row still carries a next when households lack a contact — in the rent-roll form's own words", () => {
    expect(row({ householdsMissingContact: 11 }, "households")).toMatchObject({
      done: true,
      label: "18 of 21 live lots have a household on them — 11 still lack an email or a number the office can ring",
      next: "Add their email and phone from their row on the rent roll",
      href: "/park",
    });
    expect(row({ householdsMissingContact: 1 }, "households").label).toContain("1 still lacks an email");
  });
});

describe("cutover — parks.cutover_date, optional", () => {
  it("future, in words", () => {
    expect(row({}, "cutover")).toMatchObject({ done: true, optional: true, label: "You take over on January 1, 2027", next: null, href: "/park/setup" });
  });
  it("past", () => {
    expect(row({ cutoverOn: "2026-01-01" }, "cutover").label).toBe("You took over on January 1, 2026");
  });
  it("unset: a fact, and a next only if the park changed hands", () => {
    expect(row({ cutoverOn: null }, "cutover")).toMatchObject({
      done: false, optional: true,
      label: "No takeover day set — bills can be raised for any month; fine if the park has always been yours",
      next: "Set 'The day you take over' under 'How this park runs' if the park changed hands",
      href: "/park/setup",
    });
  });
});

describe("rent due day — parks.rent_due_day cannot be unset", () => {
  it("is always done, in ordinal words", () => {
    expect(row({}, "rent_due")).toMatchObject({ done: true, optional: false, label: "Rent is due on the 1st", next: null, href: "/park/setup" });
    expect(row({ rentDueDay: 22 }, "rent_due").label).toBe("Rent is due on the 22nd");
  });
});

describe("cap — parks.max_agreement_months, optional", () => {
  it("set", () => {
    expect(row({}, "cap")).toMatchObject({ done: true, optional: true, label: "Agreements run up to 6 months", next: null, href: "/park/setup" });
    expect(row({ maxAgreementMonths: 1 }, "cap").label).toBe("Agreements run up to 1 month");
  });
  it("unset", () => {
    expect(row({ maxAgreementMonths: null }, "cap")).toMatchObject({
      done: false, optional: true, label: "No cap on how long an agreement can run",
      next: "Set 'Longest one agreement can run' under 'How this park runs' if you want one", href: "/park/setup",
    });
  });
});

describe("fees — park_fees where active, optional", () => {
  it("2 set up", () => {
    expect(row({}, "fees")).toMatchObject({ done: true, optional: true, label: "2 fees set up", next: null, href: "/park/costs" });
    expect(row({ activeFees: 1 }, "fees").label).toBe("1 fee set up");
  });
  it("none — not nagged", () => {
    expect(row({ activeFees: 0 }, "fees")).toMatchObject({
      done: false, optional: true, label: "No fees — fine if you don't charge any",
      next: "'Add a fee' under Costs & fees if you do", href: "/park/costs",
    });
  });
});

describe("map — parks.lake_id / lat / lng, written only by ops", () => {
  it("both set: a fact naming who set it, no door", () => {
    expect(row({}, "map")).toMatchObject({
      done: true, optional: false,
      label: "On Big Long Lake, map pin set — both set by LakeLife; ask us if either is wrong",
      next: null, href: null,
    });
    // Not "when the park was created": the only real park's pin was set later.
    expect(row({}, "map").label).not.toContain("created");
  });
  it("the three missing states print the shared sentences, and never a door", () => {
    expect(row({ lakeName: null }, "map")).toMatchObject({ done: false, label: NO_LAKE_LINE, next: null, href: null });
    expect(row({ hasMapPin: false }, "map")).toMatchObject({ done: false, label: NO_PIN_LINE, next: null, href: null });
    expect(row({ lakeName: null, hasMapPin: false }, "map")).toMatchObject({ done: false, label: NO_LAKE_OR_PIN_LINE, next: null, href: null });
    for (const line of [NO_LAKE_LINE, NO_PIN_LINE, NO_LAKE_OR_PIN_LINE]) {
      expect(line).toMatch(/that's ours to fix; get in touch\.$/);
    }
  });
});

describe("terms — the acceptance ledger, earned not assumed", () => {
  it("both ways", () => {
    expect(row({}, "terms")).toMatchObject({ done: true, label: "You've accepted LakeLife's park terms", next: null, href: "/agreements" });
    // Undone: the TermsGate's button, where the gate stands (the /park
    // layout) — never /agreements, which reads back and cannot accept.
    expect(row({ termsAccepted: false }, "terms")).toMatchObject({
      done: false, optional: false, label: "LakeLife's park terms not accepted yet", next: "I agree — take me to my park", href: "/park",
    });
    expect(row({ termsAccepted: false }, "terms").next).not.toMatch(/read and accept/i);
  });
});

describe("published — parks.active", () => {
  it("published", () => {
    expect(row({}, "published")).toMatchObject({ done: true, label: "Published — your park has its own page", next: null, href: "/park" });
  });
  it("not, as the owner: the button's own words", () => {
    expect(row({ published: false }, "published")).toMatchObject({
      done: false, optional: false, label: "Not published — only you can see it",
      next: "'Publish my park' on the Rent roll, once the lots and rates look right", href: "/park",
    });
  });
  it("not, as a manager: says who does", () => {
    expect(row({ published: false, viewerIsOwner: false }, "published").next).toBe("The park owner publishes it from the Rent roll");
  });
  it("with every lot switched off, mirrors the gate the button applies", () => {
    // setParkLive counts park_lots.active; "'Publish my park' once the lots
    // look right" would send him to a button that refuses.
    expect(row({ published: false, activeLots: 0 }, "published")).toMatchObject({
      done: false,
      next: "Switch at least one lot to 'In service' under Lots & rates — the park can't publish with every lot off",
      href: "/park/lots",
    });
    // With no lots at all the lots row owns it; the publish row keeps its own next.
    expect(row({ published: false, lots: 0, liveLots: 0, activeLots: 0 }, "published").href).toBe("/park");
  });
});

describe("notices — parks.notices_held_at, a fact about the hold and never 'lift it'", () => {
  it("held, dated in words, next null", () => {
    expect(row({ noticesHeldOn: "2026-08-21" }, "notices")).toMatchObject({
      done: false, optional: true,
      label: "Notices on hold since August 21, 2026 — nobody on your roll is written to, including anything you send by hand",
      next: null, href: "/park/setup",
    });
  });
  it("lifted: the hold screen's own words and nothing after them", () => {
    // The row knows the hold column, not the carrier: no promise of delivery.
    expect(row({}, "notices")).toMatchObject({ done: true, optional: true, label: "Notices can go out", next: null, href: "/park/setup" });
  });
});

describe("online rent — the switch AND the processor", () => {
  it("off / on-but-dead / live", () => {
    expect(row({ onlineRentOn: false }, "online")).toMatchObject({ done: false, optional: true, label: "Online rent is off — residents pay you the way they do now", next: null });
    expect(row({ processorLive: false }, "online")).toMatchObject({
      done: false, label: "Online rent is switched on, but no card processor is connected yet — that's ours; until then the pay button stays hidden",
    });
    expect(row({}, "online")).toMatchObject({ done: true, label: "Residents can pay rent in the app", href: "/park/setup" });
  });
});

describe("progress, completion, the first undone row, and whether Today shows the list", () => {
  it("readinessComplete ignores optional rows", () => {
    const allOptionalOff = readinessFor({ ...BASE, cutoverOn: null, maxAgreementMonths: null, activeFees: 0, noticesHeldOn: "2026-08-21", onlineRentOn: false });
    expect(readinessComplete(allOptionalOff)).toBe(true);
    expect(readinessComplete(readinessFor({ ...BASE, termsAccepted: false }))).toBe(false);
  });
  it("firstUndone skips optional rows and rows with no door", () => {
    expect(firstUndone(readinessFor(BASE))).toBeNull();
    // The map row is undone and has no href: the next required row with one wins.
    const r = firstUndone(readinessFor({ ...BASE, lakeName: null, published: false }));
    expect(r?.key).toBe("published");
    // Only the map undone: nothing with a door → null.
    expect(firstUndone(readinessFor({ ...BASE, lakeName: null }))).toBeNull();
    // An optional undone row is skipped in favour of a required one.
    expect(firstUndone(readinessFor({ ...BASE, activeFees: 0, liveLotsWithRate: 20 }))?.key).toBe("rates");
    // With only optional rows undone, the first optional one with a door.
    expect(firstUndone(readinessFor({ ...BASE, activeFees: 0 }))?.key).toBe("fees");
  });
  it("showReadinessOnToday: unpublished OR incomplete, and never a cutover-date gate", () => {
    expect(showReadinessOnToday(BASE, readinessFor(BASE))).toBe(false);
    const un = { ...BASE, published: false };
    expect(showReadinessOnToday(un, readinessFor(un))).toBe(true);
    const inc = { ...BASE, termsAccepted: false };
    expect(showReadinessOnToday(inc, readinessFor(inc))).toBe(true);
    // A future cutover on a complete published park: still hidden here (the
    // loader's beforeGoLive decides the pre-go-live placement, not this).
    expect(showReadinessOnToday({ ...BASE, cutoverOn: "2027-06-01" }, readinessFor(BASE))).toBe(false);
    const noCut = { ...BASE, cutoverOn: null, published: false };
    expect(showReadinessOnToday(noCut, readinessFor(noCut))).toBe(true);
  });
});

describe("the headline", () => {
  it("before go-live: the countdown's own words, then the count the first-run card's list line refers to", () => {
    const f = { ...BASE, today: "2026-12-20", published: false, termsAccepted: false };
    expect(readinessHeadline(f, readinessFor(f))).toEqual({
      headline: "Cedar Hollow — 12 days to go-live.",
      sub: "You go live on January 1, 2027. The first month you bill is January 2027; money handed in before that goes on account. 5 of 7 done.",
    });
    // Never "nothing is collectable": the Take a payment button on the same
    // screen records money on account before the first bill.
    expect(readinessHeadline(f, readinessFor(f)).sub).not.toMatch(/collectable/i);
    // A mid-month go-live bills from the month after — lib/billing-start's rule.
    const mid = { ...BASE, today: "2026-12-01", cutoverOn: "2026-12-15" };
    expect(readinessHeadline(mid, readinessFor(mid)).sub).toContain("The first month you bill is January 2027");
  });
  it("on the day", () => {
    const f = { ...BASE, today: "2027-01-01" };
    expect(readinessHeadline(f, readinessFor(f))).toEqual({
      headline: "Cedar Hollow — today is the day.",
      sub: "Money and occupancy start now. 6 of 6 done.",
    });
  });
  it("no takeover day: progress over the required rows", () => {
    const f = { ...BASE, cutoverOn: null, published: false };
    expect(readinessHeadline(f, readinessFor(f))).toEqual({ headline: "Getting Cedar Hollow ready", sub: "6 of 7 done." });
    const done = { ...BASE, cutoverOn: null };
    expect(readinessHeadline(done, readinessFor(done)).sub).toBe("6 of 6 done. Everything the list checks is in place.");
    const fewer = { ...BASE, cutoverOn: null, published: false, termsAccepted: false, lakeName: null };
    expect(readinessHeadline(fewer, readinessFor(fewer)).sub).toBe("4 of 7 done.");
  });
  it("after the takeover day it is the progress line, not a countdown", () => {
    const f = { ...BASE, cutoverOn: "2026-01-01", published: false };
    expect(readinessHeadline(f, readinessFor(f)).headline).toBe("Getting Cedar Hollow ready");
  });
});

describe("the first-run card", () => {
  const UN = { ...BASE, published: false, noticesHeldOn: "2026-08-21" };
  const card = (f: Partial<ReadinessFacts>, c: Partial<ContactFacts> = {}) => {
    const facts = { ...UN, ...f };
    return firstRunCard(facts, { ...NOBODY, ...c }, readinessFor(facts));
  };
  const SENTENCE = "Nothing is published and nobody has been contacted.";

  it("null once published, once a bill has been raised, or once a payment is recorded — a billing or paid park is not on its first run", () => {
    expect(card({ published: true })).toBeNull();
    expect(card({}, { chargesRaised: 1 })).toBeNull();
    // An on-account cheque before the first bill: receipted by email, no row
    // for it anywhere but park_payments — so that row ends the card.
    expect(card({}, { paymentsRecorded: 1 })).toBeNull();
    expect(card({}, { chargesRaised: 0, paymentsRecorded: 0 })).not.toBeNull();
    expect(card({})).not.toBeNull();
  });

  it("the heading, the park and the CTA label are fixed", () => {
    const c = card({})!;
    expect(c.heading).toBe("Welcome to LakeLife 🌊");
    expect(c.parkLine).toBe("Cedar Hollow");
    expect(c.cta.label).toBe("Let's look at it");
  });

  it("the state line reads the park: no lots / lots but nobody / spoken for / households", () => {
    expect(card({ lots: 0, liveLots: 0, activeLots: 0, occupiedLiveLots: 0 })!.stateLine).toBe("No lots on file yet.");
    expect(card({ occupiedLiveLots: 0 })!.stateLine).toBe("21 lots on file · nobody filed on them yet.");
    expect(card({ lots: 1, liveLots: 1, activeLots: 1, occupiedLiveLots: 0 })!.stateLine).toBe("1 lot on file · nobody filed on them yet.");
    expect(card({})!.stateLine).toBe("21 lots · 18 households living here.");
    expect(card({ occupiedLiveLots: 1 })!.stateLine).toBe("21 lots · 1 household living here.");
    // The roll loaded in December: filed, not started — never "nobody filed".
    const dec = card({ occupiedLiveLots: 0, reservedLiveLots: 18 })!;
    expect(dec.stateLine).toBe("21 lots · 18 spoken for, their tenancies start later.");
    expect(dec.stateLine).not.toContain("nobody filed");
    expect(card({ occupiedLiveLots: 15, reservedLiveLots: 3 })!.stateLine).toBe("21 lots · 15 households living here, 3 more spoken for.");
  });

  it("'Let's look at it' does not send a filed-but-not-started park to Who lives here", () => {
    // That screen would answer "Every live lot already has somebody on it.
    // Nothing left to file." The households row is done, so the CTA falls
    // through to the next undone row — publishing, on the Rent roll.
    const facts = { ...UN, occupiedLiveLots: 0, reservedLiveLots: 21 };
    const rows = readinessFor(facts);
    expect(rows.find((r) => r.key === "households")!.done).toBe(true);
    expect(firstRunCard(facts, NOBODY, rows)!.cta.href).toBe("/park");
    expect(firstRunCard(facts, NOBODY, rows)!.cta.href).not.toBe("/park/onboard");
    // Collapsed to occupied-only: the same park WOULD be sent there.
    const bare = { ...UN, occupiedLiveLots: 0, reservedLiveLots: 0 };
    expect(firstRunCard(bare, NOBODY, readinessFor(bare))!.cta.href).toBe("/park/onboard");
  });

  it("the sentence appears ONLY when held and none of the four witnesses has a row", () => {
    expect(card({})!.contactLine).toBe(`${SENTENCE} It's sitting here waiting for you to say it's right.`);
    // With no lots, 'it' is a roll that does not exist.
    expect(card({ lots: 0, liveLots: 0, activeLots: 0, occupiedLiveLots: 0 })!.contactLine).toBe(`${SENTENCE} Nothing goes out until you say so.`);
    const heldSent = card({}, { invitesSent: 1 })!.contactLine;
    expect(heldSent).toBe("Nothing is published. 1 household has been sent an invite. Notices are on hold now, so nothing more goes out until you lift it.");
    expect(heldSent).not.toContain(SENTENCE);
    const lifted = card({ noticesHeldOn: null })!.contactLine;
    expect(lifted).toBe("Nothing is published. Notices can go out.");
    expect(lifted).not.toContain(SENTENCE);
    expect(lifted).not.toMatch(/reaches/);
    const liftedSent = card({ noticesHeldOn: null }, { invitesSent: 3, documentsDelivered: 1 })!.contactLine;
    expect(liftedSent).toBe("Nothing is published. 3 households have been sent an invite and 1 document has been delivered. Notices can go out.");
    expect(liftedSent).not.toContain(SENTENCE);
    // The third witness — the overdue chase — counts as contact too.
    const reminded = card({}, { remindersSent: 18 })!.contactLine;
    expect(reminded).toBe("Nothing is published. 18 reminders have been sent. Notices are on hold now, so nothing more goes out until you lift it.");
    expect(reminded).not.toContain(SENTENCE);
    expect(card({}, { invitesSent: 1, documentsDelivered: 2, remindersSent: 1 })!.contactLine)
      .toContain("1 household has been sent an invite, 2 documents have been delivered and 1 reminder has been sent.");
    // The fourth witness — a claim slip printed while every email is refused
    // under the hold. "Printed", the reminders witness's own word: the stamp
    // is the mint, nobody records that it changed hands.
    const slipped = card({}, { slipsIssued: 2 })!.contactLine;
    expect(slipped).toBe("Nothing is published. 2 households have had a slip printed. Notices are on hold now, so nothing more goes out until you lift it.");
    expect(slipped).not.toContain(SENTENCE);
    expect(slipped).not.toMatch(/given|handed/);
    expect(card({}, { slipsIssued: 1 })!.contactLine).toContain("1 household has had a slip printed.");
    expect(card({}, { slipsIssued: 0 })!.contactLine).toContain(SENTENCE);
  });

  it("the list line counts what is left — never a duration", () => {
    // Unpublished with everything else done: publishing is the one thing left.
    expect(card({})!.listLine).toBe("One thing left on the list. You can stop anywhere and pick it back up.");
    expect(card({ termsAccepted: false })!.listLine).toBe("2 things left on the list. You can stop anywhere and pick it back up.");
    expect(card({})!.listLine).not.toMatch(/hour/);
  });

  it("'Let's look at it' opens the first undone row's door; publishing alone → the Rent roll", () => {
    expect(card({})!.cta.href).toBe("/park");
    const facts = { ...UN, lots: 0, liveLots: 0, activeLots: 0, liveLotsWithRate: 0, occupiedLiveLots: 0 };
    const rows = readinessFor(facts);
    expect(firstRunCard(facts, NOBODY, rows)!.cta.href).toBe(firstUndone(rows)!.href);
    expect(firstRunCard(facts, NOBODY, rows)!.cta.href).toBe("/park/lots");
  });

  it("offers the roll door only while nobody is filed — lots on file with nobody on them is exactly when it is wanted", () => {
    const DOOR = { label: "or load a rent roll", href: "/park/import" };
    // No lots at all: unchanged.
    expect(card({ lots: 0, liveLots: 0, activeLots: 0, occupiedLiveLots: 0 })!.alt).toEqual(DOOR);
    // Closing week — 21 lots on file, nobody on any of them. The card used to
    // offer one button, to 21 blank rows, while the seller's roll was in hand.
    expect(card({ occupiedLiveLots: 0 })!.alt).toEqual(DOOR);
    expect(card({ occupiedLiveLots: 0 })!.stateLine).toBe("21 lots on file · nobody filed on them yet.");
    // Spoken for is FILED, so the door closes for the December roll too.
    expect(card({ occupiedLiveLots: 0, reservedLiveLots: 18 })!.alt).toBeNull();
    // Households living here: nothing to load.
    expect(card({})!.alt).toBeNull();
  });

  it("the dismissal key is a task state keyed on the park", () => {
    expect(firstRunTaskKey("p1")).toBe("first_run:p1");
  });
});

describe("readinessFactsFrom — the raw rows the loaders hold, made into facts", () => {
  const pre = (over: Partial<ReadinessPreRead> = {}): ReadinessPreRead => ({
    today: TODAY,
    viewerIsOwner: true,
    park: {
      name: "Cedar Hollow", cutover_date: "2027-01-01", rent_due_day: 1, max_agreement_months: null,
      active: false, lake_id: "lake-1", lat: 41.6, lng: -85.3, notices_held_at: "2026-08-22T01:30:00+00:00",
      accepts_online_rent: false,
    },
    lots: [
      { id: "l1", lot_number: "1", lifecycle: "live", active: true },
      { id: "l2", lot_number: "2", lifecycle: "live", active: false },
      { id: "l3", lot_number: "3", lifecycle: "planned", active: true },
    ],
    reservations: [
      { park_lot_id: "l1", renter_id: "r1", during: "[2026-01-01,2027-01-01)", status: "active", term: "monthly" },
      // On a planned lot: not live, so not counted.
      { park_lot_id: "l3", renter_id: "r3", during: "[2026-01-01,2027-01-01)", status: "active", term: "monthly" },
    ],
    renters: [
      { id: "r1", email: "a@example.com", phone_on_file_with_park: null, invite_sent_at: "2026-09-01T12:00:00Z", claim_code_issued_at: null },
      { id: "r3", email: "c@example.com", phone_on_file_with_park: "2605551212", invite_sent_at: null, claim_code_issued_at: "2026-09-02T12:00:00Z" },
    ],
    rates: [
      { park_lot_id: "l1", term: "monthly", amount: "400.00" },
      { park_lot_id: "l3", term: "monthly", amount: "999.00" },
    ],
    chargesRaised: 0,
    extras: { lakeName: "Big Long Lake", activeFees: 1, documentsDelivered: 2, remindersSent: 0, paymentsRecorded: 0, termsAccepted: true, processorLive: false },
    ...over,
  });

  it("counts off the columns, over the live lots only", () => {
    const { facts, contact } = readinessFactsFrom(pre());
    expect(facts).toMatchObject({
      parkName: "Cedar Hollow", lots: 3, liveLots: 2, activeLots: 2,
      liveLotsWithRate: 1, monthlyRoll: 400, occupiedLiveLots: 1, reservedLiveLots: 0,
      householdsMissingContact: 1, cutoverOn: "2027-01-01", rentDueDay: 1, maxAgreementMonths: null,
      activeFees: 1, lakeName: "Big Long Lake", hasMapPin: true, termsAccepted: true, published: false,
      viewerIsOwner: true, onlineRentOn: false, processorLive: false,
    });
    expect(contact).toEqual({ invitesSent: 1, documentsDelivered: 2, remindersSent: 0, slipsIssued: 1, chargesRaised: 0, paymentsRecorded: 0 });
    expect(readinessFactsFrom(pre({ extras: { ...pre().extras, paymentsRecorded: 3 } })).contact.paymentsRecorded).toBe(3);
  });

  it("a roll filed from a future takeover day is reserved, not occupied — and the row, the card and the CTA all know", () => {
    // The Haven's December: 21 live lots, the roll loaded, every row dated
    // from 1 January, no email or phone on file yet, park unpublished, held.
    const lots = Array.from({ length: 3 }, (_, i) => ({ id: `l${i + 1}`, lot_number: String(i + 1), lifecycle: "live", active: true }));
    const reservations = lots.map((l) => ({ park_lot_id: l.id, renter_id: `r${l.id}`, during: "[2027-01-01,2028-01-01)", status: "approved", term: "monthly" }));
    const renters = lots.map((l) => ({ id: `r${l.id}`, email: null, phone_on_file_with_park: null, invite_sent_at: null, claim_code_issued_at: null }));
    const { facts, contact } = readinessFactsFrom(pre({ today: "2026-12-10", lots, reservations, renters, rates: [] }));
    expect(facts).toMatchObject({ liveLots: 3, occupiedLiveLots: 0, reservedLiveLots: 3, householdsMissingContact: 3 });
    const rows = readinessFor(facts);
    expect(rows.find((r) => r.key === "households")).toMatchObject({
      done: true,
      label: "3 of 3 live lots spoken for — their tenancies start later — 3 still lack an email or a number the office can ring",
      next: "Add their email and phone from their row on the rent roll",
      href: "/park",
    });
    const c = firstRunCard(facts, contact, rows)!;
    expect(c.stateLine).toBe("3 lots · 3 spoken for, their tenancies start later.");
    expect(c.cta.href).not.toBe("/park/onboard");
    // The same rows with go-live behind us are occupied — the one occupancy rule.
    const after = readinessFactsFrom(pre({ today: "2027-01-02", lots, reservations, renters, rates: [] })).facts;
    expect(after).toMatchObject({ occupiedLiveLots: 3, reservedLiveLots: 0 });
  });

  it("the hold date is the LAKE date, not the UTC one — 9:30pm in Indiana is still the 21st", () => {
    const { facts } = readinessFactsFrom(pre());
    expect(facts.noticesHeldOn).toBe("2026-08-21");
    expect(readinessFor(facts).find((r) => r.key === "notices")!.label).toContain("since August 21, 2026");
    expect(readinessFactsFrom(pre({ park: { ...pre().park, notices_held_at: null } })).facts.noticesHeldOn).toBeNull();
  });

  it("a missing pin, a lapsed row, and a manager", () => {
    const { facts } = readinessFactsFrom(pre({
      viewerIsOwner: false,
      park: { ...pre().park, lat: null },
      reservations: [{ park_lot_id: "l1", renter_id: "r1", during: "[2026-01-01,2026-08-01)", status: "active", term: "monthly" }],
    }));
    expect(facts.hasMapPin).toBe(false);
    expect(facts.viewerIsOwner).toBe(false);
    // Lapsed paperwork, still lived on — the one occupancy rule.
    expect(facts.occupiedLiveLots).toBe(1);
  });
});
