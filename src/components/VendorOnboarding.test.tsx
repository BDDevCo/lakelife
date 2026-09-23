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
vi.mock("@/app/vendor/bank-actions", () => ({
  setPayoutAccount: async () => ({ ok: true }),
}));
vi.mock("@/app/vendor/onboarding-actions", () => ({
  setServiceTypes: async () => ({ ok: true }),
  setLakes: async () => ({ ok: true }),
  setCapacity: async () => ({ ok: true }),
  setWorkDays: async () => ({ ok: true }),
  setBase: async () => ({ ok: true }),
  goLive: async () => ({ ok: true }),
  uploadDoc: async () => ({ ok: true }),
}));

const { VendorOnboarding, goLiveLine, parkNote } = await import("./VendorOnboarding");

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

const draw = (
  services = SERVICES,
  extra: {
    lakes?: { id: string; name: string }[];
    unpriced?: string[] | null;
    parksByLake?: Record<string, string[]> | null;
    bankOnFile?: boolean | null;
    vendor?: MyVendor;
  } = {},
) =>
  renderToStaticMarkup(
    <VendorOnboarding
      vendor={extra.vendor ?? vendor}
      activeServices={services}
      lakes={extra.lakes ?? []}
      unpriced={extra.unpriced === undefined ? [] : extra.unpriced}
      parksByLake={extra.parksByLake === undefined ? {} : extra.parksByLake}
      bankOnFile={extra.bankOnFile === undefined ? false : extra.bankOnFile}
    />,
  );

/** A crew who has cleared every mechanical gap, so the Go-live card renders. */
const READY = {
  ...(vendor as object),
  company: "Twin Lakes Crew",
  coi_url: "coi.pdf",
  coi_named_insured: "Twin Lakes Crew",
  coi_expiry: "2099-01-01",
  w9_url: "w9.pdf",
  service_types: ["Lawn mowing & trim"],
  service_lakes: ["lake-pretty"],
  daily_capacity: 4,
} as unknown as MyVendor;

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

/**
 * "JOBS START ROUTING" WAS TOLD TO A CREW WHO WILL BE OFFERED NOTHING.
 *
 * Go-live never asks for a rate, and `decideDispatch` refuses a crew with no
 * positive rate while `canClaim` refuses with `no_rate` — so the old sentence
 * was false at the exact moment it was shown to anyone who had not already
 * been to a screen the wizard never mentions.
 *
 * COLLAPSED BOTH WAYS on purpose: a test that only checks the unpriced branch
 * passes against a card that says the same thing to everybody.
 */
describe("the go-live sentence is true when it is shown", () => {
  it("promises nothing about routing when work is unpriced, and names the work", () => {
    const line = goLiveLine(["Lawn mowing & trim", "Snow clearing"]);
    expect(line).toContain("Lawn mowing & trim");
    expect(line).toContain("Snow clearing");
    expect(line).not.toContain("jobs start routing");
    // The unpriced line must name the CONSEQUENCE, not just the errand.
    // "we never offer you work you haven't priced" is the rule actually in
    // force; the earlier wording added "nobody can pick a price they can't
    // see", which describes choose-your-crew — and no service carries
    // `crew_priced` yet, so it was a forecast in the present tense.
    expect(line).toMatch(/never offer you work you haven't priced/);
    expect(line, "a forecast about a mechanism that is switched off")
      .not.toMatch(/pick a price they can't see/);
  });

  it("says something DIFFERENT when everything is priced", () => {
    const priced = goLiveLine([]);
    const unpriced = goLiveLine(["Lawn mowing & trim"]);
    expect(priced).not.toBe(unpriced);
    expect(priced).not.toContain("Lawn mowing & trim");
    // The old promise is gone from both: "jobs start routing to your crew"
    // is not true of work this crew has not priced, and the all-priced branch
    // must not re-import it.
    expect(priced).not.toContain("jobs start routing");
  });

  it("a FAILED CHECK does not render as everything-is-priced", () => {
    const unknown = goLiveLine(null);
    expect(unknown).not.toBe(goLiveLine([]));
    expect(unknown).toMatch(/couldn't check/i);
  });

  it("the rendered card carries the unpriced names and a door to fix it", () => {
    const html = draw(SERVICES, { vendor: READY, unpriced: ["Housekeeping"] });
    expect(html, "the Go-live card did not render at all").toContain("ready to go live");
    expect(html).toContain("Housekeeping");
    expect(html).toContain("/vendor/rates");
  });

  it("and says nothing about rates when there are none outstanding", () => {
    const html = draw(SERVICES, { vendor: READY, unpriced: [] });
    expect(html).toContain("ready to go live");
    expect(html).not.toContain("/vendor/rates");
  });
});

/**
 * WHICH LAKE A CREW TICKS IS A SILENT GATE ON EVERY HAVEN JOB.
 *
 * A plough contractor does not think of himself as working Pretty Lake. The
 * label is DERIVED from the parks rows, so park #2 names itself and a lake
 * with no park says nothing.
 */
describe("the lake step says what a tick actually does", () => {
  const LAKES = [
    { id: "lake-pretty", name: "Pretty Lake" },
    { id: "lake-turkey", name: "Big Turkey Lake" },
  ];

  it("names the park on the lake that has one", () => {
    expect(parkNote("Pretty Lake", "lake-pretty", { "lake-pretty": ["The Haven"] }))
      .toBe("Pretty Lake includes The Haven");
  });

  it("says nothing about a lake with no park", () => {
    expect(parkNote("Big Turkey Lake", "lake-turkey", { "lake-pretty": ["The Haven"] })).toBeNull();
  });

  it("names a SECOND park without a code change", () => {
    const note = parkNote("Big Turkey Lake", "lake-turkey", { "lake-turkey": ["Shady Pines", "Cedar Point Park"] });
    expect(note).toContain("Shady Pines");
    expect(note).toContain("Cedar Point Park");
  });

  it("a failed parks read names no park rather than claiming there are none", () => {
    expect(parkNote("Pretty Lake", "lake-pretty", null)).toBeNull();
  });

  it("the rendered step warns that an untapped lake is silent, and names the park", () => {
    const html = draw(SERVICES, { lakes: LAKES, parksByLake: { "lake-pretty": ["The Haven"] } });
    expect(html).toContain("only send you jobs on the lakes you tick");
    expect(html).toContain("Pretty Lake includes The Haven");
  });

  it("no park sentence at all when no lake has a park", () => {
    const html = draw(SERVICES, { lakes: LAKES, parksByLake: {} });
    expect(html).toContain("only send you jobs on the lakes you tick");
    expect(html).not.toContain("count too");
  });
});

/**
 * NOTHING ASKED A CREW WHERE THE MONEY SHOULD LAND. The batch runner does
 * `if (!acct) continue` — a crew with no bank row is skipped, silently, for
 * as many month-ends as it takes them to open a screen nobody sent them to.
 */
describe("the bank step is met before the first payout", () => {
  it("asks for it, and says what happens if they don't", () => {
    const html = draw(SERVICES, { bankOnFile: false });
    expect(html).toContain("Where should the money land?");
    expect(html).toMatch(/month-end skips a crew/);
  });

  it("does not block go-live — it is not one of the gaps", () => {
    const html = draw(SERVICES, { vendor: READY, bankOnFile: false });
    expect(html, "a missing bank account became a go-live gate").toContain("ready to go live");
  });

  it("an unchecked bank does not render as 'no bank on file'", () => {
    const html = draw(SERVICES, { bankOnFile: null });
    expect(html).toMatch(/check whether we have your bank details/);
    expect(html).not.toMatch(/month-end skips a crew/);
  });
});
