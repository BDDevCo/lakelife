import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE WIZARD IS A LAKE-HOUSE FORM, AND A PARK'S GROUNDS IS A PROPERTY.
 *
 * `enableParkServices` mints the park a real `properties` row — that is the
 * whole mechanism by which a park can buy anything. It therefore appears in his
 * property switcher and on /profile, alongside his lake house, and /profile
 * offers "Edit in guided setup" for it like any other place.
 *
 * Guided setup was written for somebody's cottage. Two things it does are
 * destructive when the property is a park's grounds, and one of them is
 * destructive for a lake house too.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE — IT WIPES THE MAP PIN, on any property, every time.
 *
 * `getFullProfile`'s select does not fetch lat/lng, `FullProfile` has no such
 * key, so setup/page.tsx's `initial` cannot carry them, ProfileWizard defaults
 * `initial.lat ?? null`, and saveProfile writes `lat: input.lat ?? null`.
 * A full round trip that reads nothing and writes NULL.
 *
 * Re-picking the address from the Google dropdown is the only thing that puts
 * coordinates back — and typing the address by hand deliberately sends
 * `{lat: null, lng: null, placeId: null}` ("keeps us from claiming a pin we
 * were never given"), so the obvious act restores nothing.
 *
 * Production holds three real pins, all set on 29 Aug when Maps was finally
 * switched on: his lake house, The Haven's grounds, and Lot 11. Readers are
 * the crew's map to the job, distance on the open-jobs board, dispatch
 * ranking, and the distance-priced booking guard. It is the field the mow and
 * snow crews need to find the park.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO — IT CAN EMPTY THE PARK'S MENU, permanently.
 *
 * `wanted_services` is a homeowner's "what do I care about" filter:
 * book/page.tsx shows `applicable.filter(s => wanted.includes(s.name))` when it
 * is non-empty. The wizard writes it from SERVICE_GROUPS — ten hardcoded
 * lake-house names, none of which is a park service.
 *
 * A park's grounds menu is the four park_only rows plus whatever park_bookable
 * opens. So picking "Lawn mowing & trim" — the obvious tick for a park — leaves
 * an intersection of NOTHING: The Haven's $100 mow and January's snow both
 * vanish from /book. He cannot undo it, because the wizard refuses to advance
 * with an empty selection and its list never contains a park service name.
 *
 * The grounds row holds `wanted_services = []` today, so the menu works. But
 * /profile prints "None chosen yet — pick your services" as a link straight
 * into that wizard, which is an invitation to do exactly this.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");
/** Comments describe intent — and this file's own fixes quote the old code. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the scanner is looking at the right things", () => {
  it("guided setup still writes the whole property row", () => {
    const src = code("app/profile/actions.ts");
    expect(src, "saveProfile is gone — this file measures nothing").toMatch(/propertyFields/);
    expect(src).toMatch(/gate_code_encrypted/);
  });

  it("and the wizard still offers a hardcoded lake-house list", () => {
    // If this ever becomes DB-driven the second half of this file changes
    // shape, and somebody should notice rather than delete a passing test.
    const wiz = code("components/ProfileWizard.tsx");
    expect(wiz).toMatch(/SERVICE_GROUPS/);
    expect(wiz, "the list no longer names lake-house work").toMatch(/Lawn mowing & trim/);
    expect(wiz, "a park service appeared in the lake-house wizard — read this file's header")
      .not.toMatch(/Park grounds mowing/);
  });
});

describe("editing a property never silently unpins it from the map", () => {
  it("the profile read fetches the coordinates at all", () => {
    const select = code("app/profile/data.ts").match(/\.select\("id, address,[^"]*gate_code_encrypted[^"]*"\)/)?.[0] ?? "";
    expect(select, "getFullProfile's property select is gone — the scan is stale").not.toBe("");
    expect(
      select,
      "lat/lng are not read, so the wizard cannot send them back and saveProfile " +
        "writes NULL over a real pin on every guided-setup save.",
    ).toMatch(/lat/);
    expect(select).toMatch(/lng/);
  });

  it("and hands them to the wizard, or reading them changed nothing", () => {
    const setup = code("app/profile/setup/page.tsx");
    const initial = setup.match(/const initial =[\s\S]*?: \{\};/)?.[0] ?? "";
    expect(initial, "the `initial` block is gone — the scan is stale").not.toBe("");
    expect(initial, "`initial` never carries lat, so the wizard defaults it to null")
      .toMatch(/lat:/);
    expect(initial).toMatch(/lng:/);
  });

  it("and the action keeps the stored pin when the address has not changed", () => {
    // THE GUARD, not just the round trip. Every other caller of saveProfile
    // gets it too, and a caller that forgets to send coordinates can no longer
    // quietly erase them.
    const src = code("app/profile/actions.ts");
    expect(
      src,
      "saveProfile still writes `lat: input.lat ?? null` unconditionally",
    ).not.toMatch(/lat: input\.lat \?\? null/);
    expect(src, "nothing reads the pin already on the row").toMatch(/keepPin|existingLat/);
  });

  it("but a NEW address with no coordinates does clear it, rather than mispinning", () => {
    // Typing an address by hand sends {lat:null, lng:null, placeId:null} on
    // purpose. Keeping the old pin under a new address would put the crew at
    // the previous house — worse than no pin, which book/actions.ts already
    // has an honest sentence for.
    const src = code("app/profile/actions.ts");
    expect(src, "the pin is kept without checking the address is the same one")
      .toMatch(/sameAddress|addressUnchanged/);
  });
});

describe("a park's grounds menu cannot be filtered away by a lake-house form", () => {
  it("the wanted-services filter does not apply to a park's grounds", () => {
    const src = code("app/book/page.tsx");
    const block = src.match(/const wanted =[\s\S]*?;\n/)?.[0] ?? "";
    expect(block, "the wanted-services filter is gone — the scan is stale").not.toBe("");
    expect(
      block,
      "wanted_services is written from ten hardcoded lake-house names, none of " +
        "which is a park service — so any selection at all empties the park's menu.",
    ).toMatch(/isGrounds/);
    // BOTH ENDS. A flag named in the filter but derived from nothing is the
    // same silence as no filter change at all.
    expect(src, "isGrounds is never derived from the park flag")
      .toMatch(/const isGrounds = profile\.groundsForParkId != null/);
  });

  it("the profile the filter reads still knows it is a park's grounds", () => {
    // The flag has to survive to book/page.tsx or the fence above is decoration.
    expect(code("app/profile/data.ts")).toMatch(/groundsForParkId/);
  });
});
