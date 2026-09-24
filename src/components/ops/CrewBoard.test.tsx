import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpsCrew, SetupService } from "@/app/ops/crews-data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/ops/crews-actions", () => ({
  approveCrew: async () => ({ ok: true }), suspendCrew: async () => ({ ok: true }),
  reactivateCrew: async () => ({ ok: true }), setCrewCapacity: async () => ({ ok: true }),
}));
vi.mock("@/app/ops/crews-invite", () => ({
  inviteCrew: async () => ({ ok: true }),
  resendCrewInvite: async () => ({ ok: true }),
}));

const { CrewBoard } = await import("./CrewBoard");

/** One service with the rate boxes ops would fill in, as the loader builds it. */
const SERVICES: SetupService[] = [{
  id: "s-pier", name: "Pier install / removal", parkOnly: false, crewPriced: false,
  form: {
    model: "per_section", unitNoun: "pier section", crewPriced: false, feeNote: null,
    fields: [
      { key: "base", kind: "base", label: "Base charge (optional)", value: null, payout: null },
      { key: "unit_rate", kind: "unit", label: "Your rate per pier section", value: null, payout: null },
    ],
  },
}];
const LAKES = [{ id: "l1", name: "Big Long Lake" }];

const crew = (over: Partial<OpsCrew> = {}): OpsCrew => ({
  id: "v1", company: "Shoreline Docks", status: "active", invite_email: null,
  inviteSentAt: null, inviteError: null,
  contact: { name: "Dale", email: "d@x.co", phone: "+12605550100", unclaimed: false },
  service_types: ["Pier install / removal"], daily_capacity: 5, work_days: ["mon"],
  coi_expiry: "2027-01-01", coiState: "ok",
  coiConfirm: "confirmed" as const,
  coi_named_insured: "Test Crew",
  namedInsuredMismatch: false, hasCoiDoc: true, hasW9Doc: true,
  coiSignedUrl: null, w9SignedUrl: null, score: 80, tier: "priority",
  onTimeRate: 1, completedCount: 10, thumbsUp: 3, thumbsDown: 0,
  lakes: ["Big Long Lake", "Pretty Lake"], pausedLakes: [], isFixture: false, ...over,
});
const render = (c: OpsCrew) =>
  renderToStaticMarkup(<CrewBoard crews={[c]} setupServices={SERVICES} lakes={LAKES} />);

describe("the crews board says where each crew works", () => {
  it("names the lakes they serve", () => {
    const html = render(crew());
    expect(html).toContain("Big Long Lake");
    expect(html).toContain("Pretty Lake");
  });

  it("a crew with no lakes ticked says dispatch can't route them", () => {
    // Silence here is what makes "No crew serves Pretty Lake yet" unanswerable.
    const html = render(crew({ lakes: [] }));
    expect(html).toContain("no lakes ticked");
  });

  it("distinguishes a lake never ticked from one taken away last night", () => {
    const html = render(crew({ lakes: ["Big Long Lake"], pausedLakes: [{ name: "Pretty Lake", liftsOn: "2026-09-11" }] }));
    expect(html).toContain("Pretty Lake paused until");
    expect(html).toContain("Sep 11");
    // And the lake they DO serve is still shown as served, not as paused.
    expect(html).toContain("Big Long Lake");
  });

  it("says nothing about pauses for a crew in good standing", () => {
    expect(render(crew())).not.toContain("paused until");
  });
});

/**
 * THE ROSTER CALLED THREE ACCOUNTS WE INVENTED "ACTIVE CREWS", ONE CARD BELOW
 * THE CARD SAYING THERE ARE NONE.
 *
 * Every production vendor is a fixture. getCrewCoverage fences them and prints
 * "There are no live crews at all — every vendor on the platform is a test
 * account, and dispatch will not route to one" directly above this board,
 * which showed three cards with green `active` pills and a score line and no
 * marker of any kind. getCrews did not even select the column.
 */
describe("the crews board marks a test account", () => {
  it("says nothing extra about a real crew", () => {
    const html = render(crew());
    expect(html).not.toContain("Test account");
    expect(html).not.toContain("test account");
  });

  it("marks a fixture crew on its own card", () => {
    const html = render(crew({ isFixture: true }));
    expect(html).toContain("Test account — nothing will route to it");
  });

  it("keeps the group count equal to the cards, and names the half that cannot work", () => {
    // Subtracting fixtures from the count would print "0" above a visible
    // card — the same lie, one card smaller. The head names both halves.
    const html = renderToStaticMarkup(
      <CrewBoard
        crews={[crew({ id: "a", isFixture: true }), crew({ id: "b", company: "Real Crew", isFixture: false })]}
        setupServices={SERVICES}
        lakes={LAKES}
      />,
    );
    expect(html).toContain("2");
    expect(html).toContain("1 test account — nothing routes to it");
    expect(html).not.toContain("all test accounts");
  });

  it("says so plainly when the whole group is scratch", () => {
    const html = renderToStaticMarkup(
      <CrewBoard
        crews={[crew({ id: "a", isFixture: true }), crew({ id: "b", isFixture: true })]}
        setupServices={[]}
        lakes={[]}
      />,
    );
    expect(html).toContain("all test accounts — nothing routes to them");
  });
});

/**
 * DAILY CAPACITY WAS EDITABLE ON A SUSPENDED CARD AND NOTHING SAVED IT.
 *
 * The number input renders on every card; "Save capacity" used to render only
 * for an active crew. So ops could drop an over-dispatched crew to 3, press
 * Reactivate — whose whole body is `update({ status: "active" })` — and read
 * "Crew reactivated — back on the board" while the router carried on at the
 * old number. Collapsed both ways: the control must be there AND carry the
 * value, so an absence-only assertion cannot pass against a deleted button.
 */
describe("capacity can be saved on any card that offers the input", () => {
  for (const status of ["active", "suspended", "invited"] as const) {
    it(`offers Save capacity on a ${status} card`, () => {
      const html = render(crew({ status, daily_capacity: 4 }));
      expect(html).toContain("Daily capacity");
      expect(html).toContain("Save capacity");
      // The input is seeded from the crew's stored number, so the button has a
      // real value to carry rather than a placeholder.
      expect(html).toContain('value="4"');
    });
  }
});

describe("the setup form ops fills in while they are on the phone", () => {
  // OPEN BY DEFAULT, which is also what makes it testable here: a folded
  // section renders nothing server-side, and a grep for its copy in the .tsx
  // would pass just as happily against a branch nobody can reach.
  const html = renderToStaticMarkup(
    <CrewBoard crews={[crew({ status: "invited" })]} setupServices={SERVICES} lakes={LAKES} />,
  );

  it("is on screen without hunting for it", () => {
    expect(html).toContain("Which water do they work?");
    expect(html).toContain("Days they work");
    expect(html).toContain("Jobs a day they can take");
  });

  it("says plainly that none of it goes live", () => {
    expect(html).toMatch(/none of it goes live/);
    expect(html).toMatch(/their tap is what makes it theirs|confirm &mdash; their/);
  });

  it("names the four things ops cannot do for them", () => {
    // Not as absent fields the operator has to notice are missing — as a
    // sentence, so nobody goes looking for a bank box.
    expect(html).toMatch(/can&#x27;t enter their bank details/);
    expect(html).toMatch(/accept the terms, upload their insurance or verify their mobile/);
  });

  it("offers the service chips that gate the rate boxes, none ticked", () => {
    // THE RATE BOXES THEMSELVES CANNOT BE REACHED FROM HERE, and saying so is
    // better than a grep that pretends otherwise. They render for the services
    // OPS HAS TICKED — client state this project has no renderer to drive
    // (no jsdom, no testing-library). What is provable server-side is the gate:
    // the chips are offered, and nothing is pre-ticked.
    //
    // The rate markup itself IS covered, by the same `form.fields.map` in
    // components/the-setup-card-renders.test.tsx, which renders a real rate
    // form and reads the boxes back out.
    const at = html.indexOf("Pier install / removal");
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, at - 220), at)).toContain('aria-pressed="false"');
  });

  it("offers every lake, none of them ticked", () => {
    // Nothing is seeded: an empty box asks a question, a filled one answers it.
    const at = html.indexOf("Big Long Lake");
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, at - 220), at)).toContain('aria-pressed="false"');
  });
});
