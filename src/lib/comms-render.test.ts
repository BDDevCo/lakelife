import { describe, it, expect } from "vitest";
import { renderCustomerContext, renderCrewContext, type CustomerContext, type CrewContext } from "./comms-render";

const customer: CustomerContext = {
  name: "Pat Shore",
  properties: [{ label: "The Cabin", lake: "Big Long Lake" }],
  jobs: [
    { service: "Lawn mowing & trim", date: "2026-07-28", status: "scheduled", price: 85, where: "The Cabin" },
    { service: "Housekeeping", date: "2026-07-10", status: "paid", price: 95, where: "The Cabin" },
  ],
  autopilotServices: ["Lawn mowing & trim"],
  creditBalance: 12.5,
};

const crew: CrewContext = {
  company: "GreenEdge Lawn Co.",
  services: ["Lawn mowing & trim"],
  lakes: ["Big Long Lake"],
  trucks: [{ name: "Truck 1", capacity: 4, hours: "7–17", active: true }],
  pendingTakeHome: 431.5,
  upcomingJobs: [{ service: "Lawn mowing & trim", date: "2026-07-28" }],
  coiExpiry: "2027-06-30",
  garagekeepersExpiry: null,
};

describe("comms context rendering — rule 1 holds at the string boundary", () => {
  it("customer context carries the customer's own facts", () => {
    const s = renderCustomerContext(customer);
    expect(s).toContain("Pat Shore");
    expect(s).toContain("The Cabin");
    expect(s).toContain("$85");
    expect(s).toContain("Credit balance: $12.50");
  });
  it("customer context NEVER mentions crew economics", () => {
    const s = renderCustomerContext(customer).toLowerCase();
    for (const word of ["margin", "vendor_cost", "take-home", "crew pay", "payout"]) {
      expect(s).not.toContain(word);
    }
  });
  it("crew context carries the crew's own facts including trucks/employees", () => {
    const s = renderCrewContext(crew);
    expect(s).toContain("GreenEdge");
    expect(s).toContain("Truck 1 (4/day, 7–17)");
    expect(s).toContain("$431.50");
  });
  it("crew context NEVER mentions customer prices or margin", () => {
    const s = renderCrewContext(crew).toLowerCase();
    for (const word of ["customer price", "all-in", "margin", "$85", "$95"]) {
      expect(s).not.toContain(word);
    }
  });
});
