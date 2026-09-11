import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MyVendor } from "@/app/vendor/data";

/**
 * A CREW RECRUITED TO MOW A PARK MUST BE ABLE TO SAY SO.
 *
 * MyServicesEditor's header describes this bug in the PAST tense —
 * "Onboarding drew them as adjacent chips in one flat list" — and it was only
 * ever fixed on the screen a LIVE crew edits. The first door, which is the one
 * a crew recruited for The Haven actually walks through, went on drawing
 * twenty services as one alphabetical grid, with "Lawn mowing & trim" and
 * "Park grounds mowing & trim" three chips apart.
 *
 * `isEligible` and `canClaim` both match on exact membership, so tapping the
 * wrong one makes that crew invisible to every park mow — with no error on
 * either side, until somebody wonders why the job never filled.
 *
 * RENDERED, not scanned. A source scan cannot see a disabled branch: putting
 * the group behind `false &&` leaves every string in the file and the scan
 * green. That mutation passed twice before this file existed.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/components/AddressAutocomplete", () => ({ AddressAutocomplete: () => null }));
vi.mock("@/app/vendor/onboarding-actions", () => ({
  setServiceTypes: async () => ({ ok: true }),
  setLakes: async () => ({ ok: true }),
  setCapacity: async () => ({ ok: true }),
  setWorkDays: async () => ({ ok: true }),
  setBase: async () => ({ ok: true }),
  goLive: async () => ({ ok: true }),
  uploadDoc: async () => ({ ok: true }),
}));

const { VendorOnboarding } = await import("./VendorOnboarding");

const vendor = {
  id: "v1", company: "Twin Lakes Crew", status: "invited",
  coi_url: null, coi_expiry: null, coi_named_insured: null,
  coi_expiry_confirmed_at: null, w9_url: null,
  service_types: [], work_days: [], service_lakes: [], daily_capacity: 0,
} as unknown as MyVendor;

const SERVICES = [
  { name: "Lawn mowing & trim", parkOnly: false },
  { name: "Housekeeping", parkOnly: false },
  { name: "Park grounds mowing & trim", parkOnly: true },
  { name: "Snow clearing — roads & common drives", parkOnly: true },
];

const draw = (services = SERVICES) =>
  renderToStaticMarkup(<VendorOnboarding vendor={vendor} activeServices={services} lakes={[]} />);

describe("the harness draws the real onboarding screen", () => {
  it("renders the work step", () => {
    const html = draw();
    expect(html.length, "onboarding rendered nothing").toBeGreaterThan(500);
    expect(html).toContain("Tap everything your crew handles");
  });
});

describe("park work is told apart from lake-home work", () => {
  it("shows both kinds of work", () => {
    const html = draw();
    expect(html).toContain("Lawn mowing &amp; trim");
    expect(html).toContain("Park grounds mowing &amp; trim");
  });

  it("labels the park group, so a crew who does parks knows which chip is theirs", () => {
    // The heading IS the fix. Without it the two names differ by one word in
    // one alphabetical list.
    const html = draw();
    expect(html, "the park chips are unlabelled again").toContain("Parks");
    expect(html).toContain("priced per lot");
  });

  it("still offers lake-home work when a park has none of its own", () => {
    // The other half of the mutation: a screen that renders only the park
    // group passes the test above and hides the lake-house catalogue.
    const html = draw(SERVICES.filter((s) => !s.parkOnly));
    expect(html).toContain("Lawn mowing &amp; trim");
    expect(html).toContain("Housekeeping");
  });

  it("shows no park heading when there is no park work", () => {
    const html = draw(SERVICES.filter((s) => !s.parkOnly));
    expect(html).not.toContain("priced per lot");
  });
});
