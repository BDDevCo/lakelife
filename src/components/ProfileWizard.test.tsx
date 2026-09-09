import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ServiceRule } from "@/lib/pricing";

/**
 * A SERVICE NOBODY HAS PRICED MUST NOT APPEAR AS A FREE ONE.
 *
 * `SERVICE_GROUPS` is a hardcoded catalogue, and the wizard's `services` prop
 * arrives filtered to ACTIVE rows. So a name in the catalogue with no matching
 * row rendered a tile whose live price read $0 — tickable, and wrong in the
 * most expensive direction, on the first screen a customer ever sees.
 *
 * The fix makes the catalogue subordinate to the database (rule 8: pricing
 * lives in the DB): a group item only renders if a rule for it exists. Which
 * also means these two services appear by themselves the day they are priced
 * and switched on, with no second deploy and no window where they show wrong.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/profile/actions", () => ({ saveProfile: async () => ({ ok: true }) }));
vi.mock("@/app/profile/email-actions", () => ({ sendWelcomeEmail: async () => ({ ok: true }) }));
vi.mock("@/components/AddressAutocomplete", () => ({ AddressAutocomplete: () => null }));

const { ProfileWizard, canOffer } = await import("./ProfileWizard");

const LAWN: ServiceRule = {
  name: "Lawn mowing & trim",
  pricing_model: "band",
  base: 0,
  unit_rate: 0,
  band_pricing: { small: 65, medium: 85, large: 110 },
};
const WINDOWS_PRICED: ServiceRule = {
  name: "Window washing",
  pricing_model: "per_section",
  base: 60,
  unit_rate: 7,
  band_pricing: { count_field: "panes" },
};
const SNOW_PRICED: ServiceRule = {
  name: "Snow removal — drive & walks",
  pricing_model: "band",
  base: 0,
  unit_rate: 0,
  band_pricing: { band_field: "drive_band", small: 45, medium: 65, large: 95 },
};

const draw = (services: ServiceRule[]) =>
  renderToStaticMarkup(
    <ProfileWizard lakes={["Big Long"]} parks={[]} services={services} initial={{}} />,
  );

describe("the harness is drawing the real wizard", () => {
  it("renders", () => {
    // The wizard opens on step 1 of its own accord and the service picker is
    // step 2, which a static render cannot reach — so the picker is proven
    // through `canOffer` below rather than by pretending to click Next.
    const html = draw([LAWN]);
    expect(html.length, "the wizard rendered nothing").toBeGreaterThan(500);
    expect(html).toContain("Your place");
  });

  it("shows no price at all on the first screen", () => {
    expect(draw([LAWN])).not.toMatch(/\$0(\.00)?\b/);
  });
});

describe("an unpriced service is not offered", () => {
  it("is refused while the row is inactive", () => {
    // Today's live state: both rows exist, inactive and unpriced, so the setup
    // page's `.eq("active", true)` never hands them over.
    expect(canOffer([LAWN], "Window washing"),
      "a service nobody has priced would be offered to a customer").toBe(false);
    expect(canOffer([LAWN], "Snow removal — drive & walks")).toBe(false);
  });

  it("is offered the moment it is priced, with no code change", () => {
    // The same catalogue, the same component. Only the database moved.
    expect(canOffer([LAWN, WINDOWS_PRICED, SNOW_PRICED], "Window washing")).toBe(true);
    expect(canOffer([LAWN, WINDOWS_PRICED, SNOW_PRICED], "Snow removal — drive & walks")).toBe(true);
  });

  it("still offers the services that were always there", () => {
    // The other half of the mutation: a rule that refuses everything passes
    // the test above and empties the picker.
    expect(canOffer([LAWN], "Lawn mowing & trim")).toBe(true);
  });

  it("is the rule the picker actually uses, not a copy of it", () => {
    const src = readFileSync(fileURLToPath(new URL("./ProfileWizard.tsx", import.meta.url)), "utf8");
    expect(src, "the picker stopped calling canOffer, so this file proves nothing")
      .toMatch(/group\.items\.filter\(\(svc\) => canOffer\(services, svc\.name\)\)/);
  });
});
