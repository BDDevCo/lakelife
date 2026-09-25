import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { TERMS_SECTIONS, termsPlainText } from "./terms-content";
import { TOS_VERSION } from "./tos";
import { TERMS_DIGESTS } from "./terms-versions";

/**
 * THE TERMS NAME WHO PAYS WHAT — AND NO FIGURE, ON PURPOSE.
 *
 * Until tos-v4-beta the document contained no price and no percentage
 * anywhere; the only occurrence of the word "fee" was a PARK's card fee, which
 * LakeLife receives none of. Four audiences accepted it and three of them can
 * be charged.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: every rate in this product is a tunable
 * row in `platform_settings`, and this document is hashed and immutable per
 * version. A "12%" written into it is false the day the dial moves, with every
 * acceptance still standing against wording nobody would honour. So the terms
 * name the MECHANISM and point at the screen carrying the live number.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TEXT = termsPlainText();
const HEADINGS = TERMS_SECTIONS.map((s) => s.heading);

// ---------------------------------------------------------------------------
describe("no tunable number is written into a hashed document", () => {
  it("carries no percentage and no dollar figure at all", () => {
    // THE WHOLE POINT. platform_fee_customer_pct, platform_fee_crew_pct,
    // cancel_fee_pct, early_payout_fee_pct and
    // park_platform_fee_per_lot_monthly are all rows ops can change from a
    // screen. Naming one here freezes it into a document that cannot change
    // with it.
    expect(TEXT, "a percent sign reached the terms").not.toMatch(/%/);
    expect(TEXT, "a dollar figure reached the terms").not.toMatch(/\$/);
    // "W-9" is the only digit that belongs; nothing else numeric may appear.
    const digits = TEXT.replace(/W-9/g, "").match(/\d/g) ?? [];
    expect(digits, `unexpected digits in the terms: ${digits.join("")}`).toEqual([]);
  });

  it("points at where the live number actually is, for each side", () => {
    // A mechanism with no pointer is just vagueness. The crew's percentage
    // really is on their rates page (rates-helpers feeNote), and the
    // customer's total really is shown before they accept.
    // NOT "on your rates page" — v4 said that and it pointed somewhere empty.
    // The fee reaches a crew through add-ons, where it is shown on the job
    // screen beside the box; their rates page shows nothing, because its fee
    // note is gated on `service.crew_priced` and no service is.
    expect(TEXT).toMatch(/the percentage is shown to you before you set it/);
    expect(TEXT, "v4's wrong pointer came back").not.toMatch(/on your rates page/);
    expect(TEXT).toMatch(/shown to you on screen before you agree to it/);
    expect(TEXT).toMatch(/shown you the total before you accept it|you are shown the total before you accept it/);
  });
});

// ---------------------------------------------------------------------------
describe("every audience that can be charged has a section", () => {
  it("has one for the crew, which it never had before v4", () => {
    // Crews have accepted this document since v0 and it never described their
    // relationship — the same gap v1-beta closed for parks and renters.
    expect(HEADINGS).toContain("If you work as a crew");
  });

  it("keeps the park and renter headings other tests pin", () => {
    expect(HEADINGS).toContain("If you run a park");
    expect(HEADINGS).toContain("If you rent a lot");
  });

  it("names what LakeLife is paid, for each side that pays it", () => {
    // HOMEOWNER: paid out of the one price, nothing added at the door.
    expect(TEXT).toMatch(/LakeLife is paid out of it/);
    expect(TEXT).toMatch(/nothing is added at the door/);
    // CREW: a share comes out of a price they name themselves.
    expect(TEXT).toMatch(/LakeLife’s share comes out of that figure/);
    // PARK: an administration fee, at the rate in that park's own agreement.
    expect(TEXT).toMatch(/administration fee by the park itself/);
    expect(TEXT).toMatch(/at the rate in that park’s own agreement/);
    // RESIDENT: nothing at all.
    expect(TEXT).toMatch(/You never pay LakeLife anything/);
  });

  it("says the park fee never reaches a resident, on BOTH sides of it", () => {
    // 0182 makes this structurally impossible — no renter, lot or reservation
    // column exists on either table. The document should say so where each
    // party reads, not once.
    expect(TEXT).toMatch(/never charged to a resident/);
    expect(TEXT).toMatch(/what LakeLife is paid comes from the park, never from you/);
  });
});

// ---------------------------------------------------------------------------
describe("it does not describe anything that charges nobody", () => {
  for (const [what, pattern] of [
    ["the same-day rush price (no processor)", /rush|same.day/i],
    ["the storage per-diem (nothing bookable until spring 2027)", /per.?diem|overstay/i],
    ["referral rewards (money out, not a fee)", /referral|refer a/i],
    ["the margin floor (a routing filter nobody is billed)", /margin floor/i],
    ["a dollar figure for the park fee", /per lot/i],
  ] as const) {
    it(`does not mention ${what}`, () => {
      expect(TEXT, `the terms describe ${what}`).not.toMatch(pattern);
    });
  }

  it("does not promise a payout rail that does not exist", () => {
    // There is no banking rail: both batches end 'queued' and wait for a human
    // to download an ACH file. acceptance-paths.test.ts pins these too.
    expect(TEXT).not.toMatch(/deposited (in)?to your (bank )?account/i);
    expect(TEXT).not.toMatch(/we transfer|we pay out to you|funds are sent/i);
  });

  it("does not cite a numbered section, because there are none", () => {
    // The document in force is unnumbered sections. §7.6 exists only in an
    // unaccepted counsel draft — and refund-core.ts already cites it as binding.
    expect(TEXT).not.toMatch(/§|\bSection \d/);
  });
});

// ---------------------------------------------------------------------------
describe("the clauses the code had outgrown", () => {
  it("no longer says payment releases only after the work is done, flatly", () => {
    // A trip fee payout inserts with status 'released' for a visit on which no
    // service work happened, so the unqualified clause was false.
    expect(TEXT).toMatch(/payment for a job released only after the work is done/);
    expect(TEXT).toMatch(/may be paid for that separately/);
  });

  it("keeps 'one all-in price', which crew pricing does NOT break", () => {
    // Crew pricing still produces a single number to the customer and nothing
    // itemises it — the fee never reaches the browser. What would falsify it is
    // a terms sentence naming a percentage added on top, which is exactly why
    // there is no percentage in here.
    expect(TEXT).toContain("one all-in price");
  });

  it("does not claim a crew is paid their rate 'in full'", () => {
    // False on the fill-in and gap branches, which run on the LIVE menu path:
    // fillInRate returns standardRate x (1 - 0.15) and that reduced figure is
    // what the crew is paid on an offer they accept.
    // SCOPED TO THE RATE CLAIM. "A tip is yours in full" is a different
    // sentence and it is TRUE — tipSplit returns { toCrew: amount,
    // toLakeLife: 0 }, literally. A blanket ban on "in full" would have
    // deleted the one place the phrase is earned.
    expect(TEXT).not.toMatch(/paid the rate you set[^.]*in full/);
    expect(TEXT).not.toMatch(/your rate[^.]*in full/);
    expect(TEXT).toMatch(/or the reduced amount shown on an offer you chose to accept/);
    // And the place it IS earned stays.
    expect(TEXT).toMatch(/A tip is yours in full/);
  });

  it("does not say a share of a cancellation fee reaches the crew", () => {
    // The crew share is gated on the fee being COLLECTED, and nothing can
    // collect. Telling a homeowner their fee compensates the crew, on a path
    // where no crew can be paid, is the sentence to avoid.
    expect(TEXT).not.toMatch(/part of it goes to the crew|shared with the crew/i);
  });
});

// ---------------------------------------------------------------------------
describe("the version moved with the words", () => {
  it("is tos-v5-beta, registered, and matching the current text", () => {
    expect(TOS_VERSION).toBe("tos-v5-beta");
    expect(TERMS_DIGESTS[TOS_VERSION]).toBeTruthy();
  });

  it("did not rewrite what somebody already agreed to", () => {
    // Editing an old entry is rewriting history for every acceptance under it.
    expect(TERMS_DIGESTS["tos-v1-beta"]).toBe("5c1b225decf51f83a8cadb4844c9476fec290861f6a5818ab4dad15d8f075701");
    expect(TERMS_DIGESTS["tos-v2-beta"]).toBe("6ba022c24bb106f0a23132468013b5faea7f2beb88659b1fc1e1a32aaf2b7011");
    expect(TERMS_DIGESTS["tos-v3-beta"]).toBe("e0770eca1c919c83ed9b23a9d02fca7b293c5441ed25415e5d94e8ce714817f6");
    expect(TERMS_DIGESTS["tos-v4-beta"]).toBe("d8abf441ab5cb8330f3665650d364d4773b7e82287e11bbaa47d6d2539b64363");
  });
});

// ---------------------------------------------------------------------------
describe("the screens that would now contradict the terms", () => {
  it("the ops dial no longer says no agreement names this fee", () => {
    // TRUE until the park section began naming it; false from the same commit.
    const dial = strip(read("components/ops/ParkPlatformFeeDial.tsx"));
    expect(dial).not.toMatch(/No agreement in force names this fee/);
    expect(dial).toMatch(/this park&apos;s own agreement/);
  });

  it("the crew's acceptance gate no longer promises all the money", () => {
    // It is read in the same viewport as "I agree" and is NOT in the hashed
    // text, so no digest test catches it.
    const gate = strip(read("app/vendor/layout.tsx"));
    expect(gate).not.toMatch(/so is the money for it/);
    expect(gate).toMatch(/what LakeLife is paid/);
  });

  it("the crew IS actually shown the percentage where they name a price", () => {
    // The terms promise disclosure before they set the number. The only live
    // door is the add-on panel, and it prints the percentage live as they type.
    // If that ever stops, the document is making a promise nothing keeps.
    const panel = strip(read("components/CrewAddonPanel.tsx"));
    expect(panel).toMatch(/platform fee/);
    expect(panel).toMatch(/crewPct/);
    expect(panel, "the take-home is no longer shown beside the box").toMatch(/takeHome/);
  });

  it("the crew picker no longer says the price is not ours", () => {
    // Every figure in that list is quote x (1 + fee) — partly ours.
    const picker = strip(read("components/CrewPicker.tsx"));
    expect(picker).not.toMatch(/the price is theirs,\s*not ours/);
    expect(picker).toMatch(/with our share already in it/);
  });

  it("the invoice card no longer denies an add-on while showing its money", () => {
    // 0180 does `jobs.customer_price += job_addons.customer_price`.
    const page = strip(read("app/requests/[id]/page.tsx"));
    expect(page).toMatch(/allInLine\(job\.money\.extras\)/);
    expect(page).not.toMatch(/:\s*"One all-in price — crew, materials, and LakeLife\. No add-ons/);
  });
});

// ---------------------------------------------------------------------------
describe("the all-in line tells the truth about extras", () => {
  // The helper is small and pure; import it via the page would pull server
  // code, so the three answers are asserted through the page source and the
  // behaviour is pinned here by construction.
  it("has three answers, and the failed-read one makes no claim", () => {
    const page = read("app/requests/[id]/page.tsx");
    const fn = page.slice(page.indexOf("function allInLine"), page.indexOf("export default async function JobDetailPage"));
    expect(fn).toMatch(/extras == null/);
    // null → no claim about add-ons at all.
    const nullArm = fn.slice(fn.indexOf("extras == null"), fn.indexOf("extras.count === 0"));
    expect(nullArm).not.toMatch(/No add-ons/);
    // zero → the original promise, which is true there.
    expect(fn).toMatch(/extras\.count === 0[\s\S]*?No add-ons, no surprises/);
    // some → names them and their money.
    expect(fn).toMatch(/Includes \$\{what\}/);
  });
});

// ---------------------------------------------------------------------------
describe("the scanners bite", () => {
  it("is reading the real document, not an empty string", () => {
    expect(TEXT.length).toBeGreaterThan(2000);
    expect(HEADINGS.length).toBeGreaterThanOrEqual(7);
    expect(sourceFiles(SRC).length).toBeGreaterThan(200);
  });

  it("would catch a percentage if one were written in", () => {
    expect("we take 12% of it").toMatch(/%/);
    expect(TEXT).not.toMatch(/%/);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
describe("the referral page promises only what the code does", () => {
  const PAGE = strip(read("app/referral-terms/page.tsx"));

  it("names no tax form, because none is generated anywhere", () => {
    // It said crew referral earnings "appear on the same 1099". Grep the tree
    // for 1099 and you get exactly that promise and a comment saying the
    // opposite. It was also the only tax characterisation in the product, made
    // in marketing copy to somebody deciding whether to hand over their
    // customer book.
    expect(PAGE, "the 1099 promise came back").not.toMatch(/1099/);
  });

  it("does not tell a crew their reward arrives as credit", () => {
    // `grantFor` refuses a credit to ANY user with a vendors row and to a lake
    // association, routing them to the month-end batch — credit is spendable
    // on bookings and a crew does not book.
    expect(PAGE).not.toMatch(/paid\s+the same way, as credits on your own bills/);
    expect(PAGE).toMatch(/If you&apos;re a homeowner, it arrives as credit/);
    expect(PAGE).toMatch(/crew or a lake association, it comes as money in the month-end run/);
  });

  it("still describes the rewards themselves, from the live dials", () => {
    // The fix is precision, not deletion: the percentages on this page are
    // interpolated from platform_settings, which is why they may live here and
    // may not live in the hashed terms.
    expect(PAGE).toMatch(/s\.referralCrewSharePct/);
    expect(PAGE).toMatch(/s\.referralCrossSellPct/);
    expect(PAGE).toMatch(/s\.referralCrewCap/);
  });

  it("the routing rule it describes is the one the code applies", () => {
    const auto = strip(read("lib/automation.ts"));
    const fn = auto.slice(auto.indexOf("const grantFor ="), auto.indexOf("const grantFor =") + 1600);
    expect(fn, "grantFor no longer refuses a crew").toMatch(/if \(isVendor \|\| \(isHoa/);
  });
});
