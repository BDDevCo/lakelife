import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSelection } from "./packages";
import type { PackageView } from "./packages";

/**
 * A PACKAGE THAT PRICES AT NOTHING IS A MISTAKE, NOT AN OFFER.
 *
 * Found walking the season as a seasonal homeowner: /book/storage rendered
 * "You tow it to the shop" with its real name and description under a
 * "From $0" price. Opening it showed "Nothing scheduled this fall", "Nothing
 * scheduled next spring", and an enabled confirm button reading "Book — $0".
 * Tapping it answered "Nothing selected for the fall visit" — true, and
 * unactionable, because there was nothing to select.
 *
 * The cause is an active service_packages row whose package_components rows
 * are missing, or whose services have since been retired. The customer is not
 * the right person to discover that.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const pkg = (components: PackageView["components"]): PackageView => ({
  id: "p1", code: "you_tow", name: "You tow it to the shop",
  description: null, components,
});

describe("an empty package never reaches the menu", () => {
  it("getPackageViews drops packages with no components", () => {
    const s = src("../app/book/storage/data.ts");
    expect(s).toMatch(/return views\.filter\(\(v\) => v\.components\.length > 0\)/);
  });

  it("and tells ops, because it is a configuration mistake somebody must fix", () => {
    // Silently vanishing is right for the customer and wrong for the operator:
    // the package was configured on purpose and is now doing nothing.
    const s = src("../app/book/storage/data.ts");
    expect(s).toMatch(/have no bookable components and were hidden/);
    expect(s).toMatch(/Check package_components/);
  });
});

describe("and cannot be booked even if one reaches the wizard", () => {
  it("the server refuses a package that prices at zero", () => {
    // A stale tab, a back button or a direct post still arrives here, and
    // nothing downstream refused it — so this booked a haul-out, a
    // winterization and a season of storage for nothing.
    const s = src("../app/book/storage/actions.ts");
    expect(s).toMatch(/if \(!\(sel\.total > 0\)\)/);
    expect(s).toMatch(/nothing has been booked/);
  });

  it("the refusal does not blame the customer", () => {
    const s = src("../app/book/storage/actions.ts");
    const at = s.indexOf("if (!(sel.total > 0))");
    const block = s.slice(at, at + 400);
    // "Nothing selected for the fall visit" was the old answer, and it reads as
    // their mistake. It is ours.
    expect(block).toMatch(/We can't price that package/);
  });
});

describe("validateSelection still totals what it is given", () => {
  it("an empty package totals zero — which is what the guards are for", () => {
    expect(validateSelection(pkg([]), []).total).toBe(0);
  });

  it("a real component still prices", () => {
    const one = validateSelection(
      pkg([{
        serviceId: "s1", name: "Haul out", phase: "fall", required: true,
        defaultOn: true, kind: "component", role: null,
        pricingModel: "flat", price: 240, isStorageTier: false,
      }]),
      ["s1"],
    );
    expect(one.total).toBe(240);
    expect(one.ok).toBe(true);
  });
});
