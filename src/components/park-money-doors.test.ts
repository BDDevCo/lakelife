import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE OFFICE'S MONEY SCREENS, SCANNED AS SOURCE.
 *
 * ParkRent, ParkStatements and ParkHeldMoney are client components wrapping
 * server actions, and the parts that matter here — a payment form's method
 * list, a paragraph shown after a preview, a button shown per statement row —
 * sit behind state a static render never reaches. So the code is read, with
 * comments stripped, and every scan first proves it found the thing it is
 * about to judge.
 */
const code = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The `value`s of a file's `const METHODS = [...]` literal, in order. */
function methodValues(src: string, file: string): string[] {
  const block = src.match(/const METHODS = \[([\s\S]*?)\] as const;/)?.[1];
  expect(block, `${file}: no METHODS literal — this scan is measuring nothing`).toBeTruthy();
  return [...block!.matchAll(/value: "([a-z]+)"/g)].map((m) => m[1]);
}

describe("hand-keyed money is the same four ways on every office door", () => {
  const rent = code("./ParkRent.tsx");
  const claim = code("./ClaimForm.tsx");
  const ipaid = code("./IPaidForm.tsx");
  const held = code("./ParkHeldMoney.tsx");
  // The amenities screen is the third office door that keys a method. It
  // offered "Card" since it was written (14 Aug 2026); the action inserted no
  // processor reference, so the database refused every one and the office
  // read the constraint's name.
  const amenities = code("./ParkAmenities.tsx");

  it("the rent screen's payment form offers exactly what the claim form offers", () => {
    // Same values, same order. "Bank transfer" is `transfer` on both — the
    // rent screen used to file it as `ach`, which the database treats as
    // processor money it will never let him reverse.
    expect(methodValues(rent, "ParkRent")).toEqual(methodValues(claim, "ClaimForm"));
    expect(methodValues(rent, "ParkRent")).toEqual(["check", "cash", "transfer", "other"]);
  });

  it("never offers a processor rail by hand", () => {
    expect(amenities, "ParkAmenities' picker is gone — this scan is measuring nothing").toMatch(/aria-label="How they paid"/);
    for (const [name, src] of [["ParkRent", rent], ["ClaimForm", claim], ["IPaidForm", ipaid], ["ParkHeldMoney", held], ["ParkAmenities", amenities]] as const) {
      expect(src, `${name} offers card`).not.toMatch(/value[=:]\s*"card"/);
      expect(src, `${name} offers ach`).not.toMatch(/value[=:]\s*"ach"/);
    }
  });

  it("calls 'Bank transfer' the same thing on every door", () => {
    for (const [name, src] of [["ParkRent", rent], ["ClaimForm", claim], ["IPaidForm", ipaid]] as const) {
      expect(src, name).toMatch(/value: "transfer", label: "Bank transfer"/);
    }
    expect(held).toMatch(/<option value="transfer">Bank transfer<\/option>/);
    expect(amenities).toMatch(/<option value="transfer">Bank transfer<\/option>/);
  });

  it("the amenities history row prints the receipt's word for the method, not the column's value", () => {
    // Same row, two names: the picker said "Bank transfer" and the payment
    // under it printed "$150.00 transfer". METHOD_WORD is the resident's
    // receipt word, one import away.
    expect(amenities).toMatch(/import \{ METHOD_WORD \} from "@\/app\/park\/receipt-helpers"/);
    expect(amenities).toMatch(/\{money\(p\.amount\)\} \{METHOD_WORD\[p\.method\] \?\? p\.method\}/);
    expect(amenities).not.toMatch(/\{money\(p\.amount\)\} \{p\.method\}/);
  });
});

describe("the rent screen names each skip by its own cause", () => {
  const rent = code("./ParkRent.tsx");

  it("no longer reads the two-bucket plan", () => {
    expect(rent).not.toMatch(/skippedNoTotal/);
  });

  it("shows the 'no rent set' paragraph ONLY for the no-rent bucket", () => {
    const at = rent.indexOf("no rent set.");
    expect(at, "the no-rent paragraph is gone").toBeGreaterThan(0);
    // The guard immediately above it is the noRent bucket, not "any skip".
    const before = rent.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/plan\.noRent\.length > 0 && \(/);
    expect(before).not.toMatch(/plan\.expired/);
  });

  it("links the roll after the 'filed as paid yearly' sentence — the same way its neighbour links Today", () => {
    // The expired paragraph linked /park/today; this one printed "from Edit
    // on the roll" as bare text. Same card, one cause got a door and the
    // other a name. The link sits AFTER the helper's sentence so the run's
    // refusal and the screen stay one string.
    const at = rent.indexOf("plan.notMonthly.length > 0 && (");
    expect(at, "the notMonthly paragraph is gone").toBeGreaterThan(0);
    const para = rent.slice(at, rent.indexOf("plan.noRent.length > 0 && (", at));
    expect(para).toMatch(/\{notMonthlySentence\(plan\.notMonthly\)\}/);
    expect(para).toMatch(/<a href="\/park">Open the rent roll<\/a>/);
    // Only when the sentence named the roll: a per-stay home has nothing to
    // change there — and "per stay" is the helper's ONE predicate, not a
    // second spelling of nightly/weekly here.
    expect(para).toMatch(/plan\.notMonthly\.some\(\(l\) => !perStayTerm\(l\.term\)\)/);
    expect(para).not.toMatch(/"nightly"|"weekly"/);
    // And the roll IS the door at /park.
    expect(code("./ParkNav.tsx")).toMatch(/\{ href: "\/park", label: "Rent roll" \}/);
  });

  it("tells him where the renew button is when agreements have run out", () => {
    const at = rent.indexOf("plan.expired.length > 0 && (");
    expect(at).toBeGreaterThan(0);
    const para = rent.slice(at, at + 900);
    expect(para).toMatch(/have run out|has run out/);
    expect(para).toMatch(/href="\/park\/today"/);
    expect(para).toMatch(/Agreements to write/);
    expect(para).toMatch(/Nobody moved out/);
  });

  it("names a tenancy the monthly run cannot bill, from the one sentence helper", () => {
    expect(rent).toMatch(/plan\.notMonthly\.length > 0 && \(/);
    expect(rent).toMatch(/notMonthlySentence\(plan\.notMonthly\)/);
  });

  it("still disables the run when there is nothing to raise", () => {
    expect(rent).toMatch(/disabled=\{busy \|\| plan\.toBill\.length === 0\}/);
  });
});

describe("'Refund to card' is not offered without a processor", () => {
  const st = code("./ParkStatements.tsx");

  it("takes the fact from the server, false by default", () => {
    // paymentsAreLive() reads a server env var; a client component cannot.
    expect(st).toMatch(/paymentsLive = false/);
    expect(st).not.toMatch(/paymentsAreLive\(/);
  });

  it("and the page that mounts it PASSES the fact — a prop with no writer is a default forever", () => {
    // The default is what is true today. The day LAKELIFE_PAYMENTS_LIVE is
    // switched on, a caller that never passed the prop keeps hiding the only
    // refund control for card/ach rows and keeps saying the processor isn't
    // connected. This is the only caller.
    const page = code("../app/park/statements/page.tsx");
    expect(page).toMatch(/import \{ paymentsAreLive \} from "@\/lib\/charge-gate"/);
    expect(page).toMatch(/<ParkStatements [^>]*paymentsLive=\{paymentsAreLive\(\)\}/);
  });

  it("gates the button on it, and says why when it is hidden", () => {
    const btn = st.indexOf("Refund to card");
    expect(btn).toBeGreaterThan(0);
    const guard = st.slice(Math.max(0, btn - 400), btn);
    expect(guard).toMatch(/&& paymentsLive && \(/);
    expect(st).toMatch(/!paymentsLive && \(/);
    expect(st).toMatch(/refund needs the processor/);
  });

  it("collapses both ways: the same row would render the button with the flag on", () => {
    // Pin the branch rather than its absence: one guard renders on true, the
    // other on false, on the same method condition.
    const on = st.match(/\(r\.method === "card" \|\| r\.method === "ach"\) && paymentsLive && \(/g) ?? [];
    const off = st.match(/\(r\.method === "card" \|\| r\.method === "ach"\) && !paymentsLive && \(/g) ?? [];
    expect(on).toHaveLength(1);
    expect(off).toHaveLength(1);
  });
});
