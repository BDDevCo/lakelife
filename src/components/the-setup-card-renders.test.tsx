import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingSetup } from "@/app/vendor/setup-data";

/**
 * THE CARD A CREW ACTUALLY OPENS.
 *
 * Everything else about this flow is pinned by reading source — which is the
 * right tool for "does ops write the proposal table and nothing else", and the
 * wrong one for "does the crew see their own rate". A grep for a sentence in a
 * .tsx file passes just as happily when the branch holding it never renders.
 *
 * So this renders the real component with a realistic proposal and reads what
 * comes out.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { err: () => {} }) }));
vi.mock("@/app/vendor/setup-actions", () => ({
  confirmMySetup: async () => ({ ok: true }),
  declineMySetup: async () => ({ ok: true }),
}));

const { CrewSetupConfirm } = await import("./CrewSetupConfirm");

/** Josh, as Brendon would have taken him down: the Haven pier, $50 a section. */
const JOSH: PendingSetup = {
  id: "prop-1",
  attribution: "Brendon set this up from your call on September 24, 2026.",
  note: "does the Haven pier every spring",
  phoneE164: "+12605550134",
  lakeIds: ["lake-pretty"],
  workDays: ["Mon", "Tue", "Wed"],
  dailyCapacity: 3,
  rates: [{
    serviceId: "svc-pier",
    name: "Pier install / removal",
    form: {
      model: "per_section",
      unitNoun: "pier section",
      crewPriced: true,
      feeNote: "LakeLife adds 12% for the customer and takes 12% out of your side.",
      fields: [
        { key: "base", kind: "base", label: "Base charge (optional)", value: null, payout: null },
        { key: "unit_rate", kind: "unit", label: "Your rate per pier section", value: 50, payout: 44 },
      ],
    },
  }],
};

const LAKES = [
  { id: "lake-pretty", name: "Pretty Lake" },
  { id: "lake-long", name: "Big Long Lake" },
];

const html = renderToStaticMarkup(<CrewSetupConfirm setup={JOSH} lakes={LAKES} />);

describe("the card a crew opens after a call with ops", () => {
  it("says who set it up and when, in words", () => {
    expect(html).toContain("Brendon set this up from your call on September 24, 2026.");
  });

  it("says plainly that none of it counts yet", () => {
    // An unattributed, unqualified pre-fill is indistinguishable from a
    // setting the system arrived at — the shape that wrote nineteen leases
    // nobody had signed.
    expect(html).toMatch(/Nothing here counts until you say so/);
  });

  it("shows their own rate, in their own units", () => {
    expect(html).toContain("Pier install / removal");
    expect(html).toContain("Your rate per pier section");
    expect(html).toContain('value="50"');
    // And what LakeLife takes, because they are agreeing to a number.
    expect(html).toContain("takes 12% out of your side");
  });

  it("says we set no prices", () => {
    expect(html).toMatch(/we never set a crew&#x27;s prices|we never set a crew's prices/);
  });

  it("ticks the lake they work and leaves the other open", () => {
    const pretty = html.indexOf("Pretty Lake");
    const long = html.indexOf("Big Long Lake");
    expect(pretty).toBeGreaterThan(-1);
    expect(long).toBeGreaterThan(-1);
    // aria-pressed is the honest signal, and it must differ between the two.
    expect(html.slice(Math.max(0, pretty - 220), pretty)).toContain('aria-pressed="true"');
    expect(html.slice(Math.max(0, long - 220), long)).toContain('aria-pressed="false"');
  });

  it("names the number without claiming we can text it", () => {
    expect(html).toContain("(260) 555-0134");   // theirs, in their own shape
    expect(html).not.toContain("+12605550134"); // never the machine form
    expect(html).toMatch(/can&#x27;t text it until you do|can't text it until you do/);
  });

  it("reads back their note", () => {
    expect(html).toContain("does the Haven pier every spring");
  });

  it("lists the five things only they can do, beside the button", () => {
    // A crew who confirms this card and closes the tab is still not live.
    for (const t of ["insurance certificate", "W-9", "bank account", "crew terms", "Verify your mobile"]) {
      expect(html, `the card no longer names "${t}"`).toContain(t);
    }
  });

  it("offers a way out that is not a rejection of anything", () => {
    expect(html).toMatch(/fill it in myself/i);
  });

  it("offers the confirm button as live, since there is something to confirm", () => {
    const at = html.indexOf("Yes, that&#x27;s right");
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, at - 160), at)).not.toContain("disabled");
  });

  it("will not let an empty card be confirmed", () => {
    // Confirming nothing would settle the proposal and take the card away,
    // leaving a crew who believes they are set up with nothing set up.
    const bare = renderToStaticMarkup(
      <CrewSetupConfirm
        setup={{ ...JOSH, lakeIds: [], workDays: [], dailyCapacity: null, rates: [] }}
        lakes={LAKES}
      />,
    );
    const at = bare.indexOf("Yes, that&#x27;s right");
    expect(at).toBeGreaterThan(-1);
    expect(bare.slice(Math.max(0, at - 160), at)).toContain("disabled");
    expect(bare).toMatch(/Pick at least one lake/);
  });
});
