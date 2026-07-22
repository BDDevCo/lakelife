import { describe, it, expect } from "vitest";
import { proposeAutopilotDate, type ProposalInput } from "./autopilot";

const base: ProposalInput = {
  serviceName: "Spring opening",
  isWaterWork: true,
  iceOutISO: "2026-04-01",
  pullDeadlineISO: "2026-10-20",
  lastCompletedISO: null,
  todayISO: "2026-03-01",
};

describe("proposeAutopilotDate — water work seasons", () => {
  it("spring services land ice-out + 14 days", () => {
    expect(proposeAutopilotDate(base)).toBe("2026-04-15");
  });

  it("fall services land pull-deadline − 14 days", () => {
    expect(proposeAutopilotDate({ ...base, serviceName: "Fall winterization", todayISO: "2026-09-01" })).toBe("2026-10-06");
  });

  it("a season already past proposes nothing (no spam)", () => {
    expect(proposeAutopilotDate({ ...base, todayISO: "2026-05-01" })).toBeNull(); // spring gone
    expect(proposeAutopilotDate({ ...base, serviceName: "Fall winterization", todayISO: "2026-10-15" })).toBeNull(); // < 7d lead
  });

  it("both-ways services (pier/lift) pick the NEXT season edge", () => {
    const pier = { ...base, serviceName: "Pier install / removal" };
    expect(proposeAutopilotDate({ ...pier, todayISO: "2026-03-01" })).toBe("2026-04-15"); // spring ahead
    expect(proposeAutopilotDate({ ...pier, todayISO: "2026-06-01" })).toBe("2026-10-06"); // spring past → fall
    expect(proposeAutopilotDate({ ...pier, todayISO: "2026-11-01" })).toBeNull(); // both past
  });

  it("missing lake dates propose nothing for water work", () => {
    expect(proposeAutopilotDate({ ...base, iceOutISO: null, pullDeadlineISO: null })).toBeNull();
  });

  it("respects the lead time (proposal at least 7 days out)", () => {
    // ice-out+14 = Apr 15; today Apr 12 → only 3 days notice → null
    expect(proposeAutopilotDate({ ...base, todayISO: "2026-04-12" })).toBeNull();
  });
});

describe("proposeAutopilotDate — recurring land work", () => {
  const lawn: ProposalInput = { ...base, serviceName: "Lawn mowing & trim", isWaterWork: false, todayISO: "2026-07-01" };

  it("proposes last-completed + interval", () => {
    expect(proposeAutopilotDate({ ...lawn, lastCompletedISO: "2026-06-25" })).toBe("2026-07-25");
  });

  it("never proposes sooner than the lead time", () => {
    // last + 30 = Jul 5, but lead pushes to Jul 8
    expect(proposeAutopilotDate({ ...lawn, lastCompletedISO: "2026-06-05" })).toBe("2026-07-08");
  });

  it("no history: proposes at the lead edge", () => {
    expect(proposeAutopilotDate(lawn)).toBe("2026-07-08");
  });

  it("honors a custom interval", () => {
    expect(proposeAutopilotDate({ ...lawn, lastCompletedISO: "2026-06-25", intervalDays: 14 })).toBe("2026-07-09");
  });
});
