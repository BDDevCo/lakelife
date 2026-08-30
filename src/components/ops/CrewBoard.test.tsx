import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpsCrew } from "@/app/ops/crews-data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/ops/crews-actions", () => ({
  approveCrew: async () => ({ ok: true }), suspendCrew: async () => ({ ok: true }),
  reactivateCrew: async () => ({ ok: true }), setCrewCapacity: async () => ({ ok: true }),
}));
vi.mock("@/app/ops/crews-invite", () => ({ inviteCrew: async () => ({ ok: true }) }));

const { CrewBoard } = await import("./CrewBoard");

const crew = (over: Partial<OpsCrew> = {}): OpsCrew => ({
  id: "v1", company: "Shoreline Docks", status: "active", invite_email: null,
  contact: { name: "Dale", email: "d@x.co", phone: "+12605550100", unclaimed: false },
  service_types: ["Pier install / removal"], daily_capacity: 5, work_days: ["mon"],
  coi_expiry: "2027-01-01", coiState: "ok",
  coiConfirm: "confirmed" as const,
  coi_named_insured: "Test Crew",
  namedInsuredMismatch: false, hasCoiDoc: true, hasW9Doc: true,
  coiSignedUrl: null, w9SignedUrl: null, score: 80, tier: "priority",
  onTimeRate: 1, completedCount: 10, thumbsUp: 3, thumbsDown: 0,
  lakes: ["Big Long Lake", "Pretty Lake"], pausedLakes: [], ...over,
});
const render = (c: OpsCrew) =>
  renderToStaticMarkup(<CrewBoard crews={[c]} activeServiceNames={["Pier install / removal"]} />);

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
