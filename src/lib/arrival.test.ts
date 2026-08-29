import { describe, it, expect } from "vitest";
import {
  summariseCorrection, correctionMessage, correctionCard, humanDuration,
  noAnswerOutcome, noAnswerExplainer, completionBlock,
  declineMeans, scopeNoteFor,
  type TimedRule,
} from "./arrival";
import type { PricingProfile } from "./pricing";

const P = (o: Partial<PricingProfile> = {}): PricingProfile => ({
  sqft: 2400, beds: 3, baths: 2, pier_sections: 8, boat_lifts: 1, toy_lifts: 0,
  jet_skis: 0, pwc_lifts: 0, lawn_band: "medium", boats: [], toys: [], ...o,
});

// The real seeded rules.
const PIER: TimedRule = {
  name: "Pier install / removal", pricing_model: "per_section",
  base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" },
  est_minutes: 180, needs_interior_access: false,
  duration_bands: { rungs: [
    { max: 5, minutes: 120 }, { max: 9, minutes: 180 },
    { max: 13, minutes: 255 }, { max: null, minutes: 330 },
  ] },
};
const LAWN: TimedRule = {
  name: "Lawn mowing & trim", pricing_model: "band",
  base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 },
  est_minutes: 45, needs_interior_access: false,
  duration_bands: { by_band: { small: 30, medium: 50, large: 90 } },
};
const CLEAN: TimedRule = {
  name: "Housekeeping", pricing_model: "per_sqft_band",
  base: 0, unit_rate: 0,
  band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] },
  est_minutes: 90, needs_interior_access: true,
  duration_bands: { rungs: [
    { max: 1800, minutes: 75 }, { max: 2800, minutes: 105 }, { max: null, minutes: 150 },
  ] },
};

describe("twelve sections, not eight", () => {
  it("states the correction in BOTH currencies — money and the crew's day", () => {
    const s = summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 12 });
    expect(s.priceBefore).toBe(604);
    expect(s.priceAfter).toBe(796);
    expect(s.priceDelta).toBe(192);
    expect(s.minutesBefore).toBe(180);
    expect(s.minutesAfter).toBe(255);
    expect(s.minutesDelta).toBe(75);
  });

  it("names the field the way a person says it, not the way a column does", () => {
    const s = summariseCorrection(PIER, P(), { pier_sections: 12 });
    expect(s.lines).toEqual([
      { field: "pier_sections", label: "pier sections", from: "8", to: "12" },
    ]);
  });

  it("spells out a lawn band instead of showing the raw word", () => {
    const s = summariseCorrection(LAWN, P({ lawn_band: "medium" }), { lawn_band: "large" });
    expect(s.lines[0].from).toBe("medium (¼–½ acre)");
    expect(s.lines[0].to).toBe("large (over ½ acre)");
    expect(s.priceDelta).toBe(25);
    expect(s.minutesDelta).toBe(40);
  });

  it("a crew confirming the profile is right changes nothing", () => {
    const s = summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 8 });
    expect(s.noChange).toBe(true);
    expect(s.priceDelta).toBe(0);
    expect(s.minutesDelta).toBe(0);
  });

  it("handles a correction DOWNWARD — the profile can be too generous", () => {
    // A crew who finds four sections where eight were claimed is telling the
    // truth too, and the owner should pay less for it.
    const s = summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 4 });
    expect(s.priceDelta).toBe(-192);
    expect(s.minutesDelta).toBe(-60);
  });

  it("takes more than one correction at a time", () => {
    const s = summariseCorrection(PIER, P(), { pier_sections: 12, boat_lifts: 2 });
    expect(s.lines.map((l) => l.field)).toEqual(["pier_sections", "boat_lifts"]);
  });

  it("ignores a field the crew didn't touch", () => {
    const s = summariseCorrection(PIER, P(), {});
    expect(s.noChange).toBe(true);
  });
});

describe("the sentence on the homeowner's phone", () => {
  it("leads with what was FOUND, not with the money", () => {
    const s = summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 12 });
    const msg = correctionMessage(s, { serviceName: "Pier install / removal", crewName: "Miller Marine" });
    // The fact comes before the number — being asked to confirm something
    // about your own property reads very differently from an upsell.
    expect(msg.indexOf("pier sections 8 → 12")).toBeLessThan(msg.indexOf("$796"));
    expect(msg).toContain("Miller Marine is at your place");
    expect(msg).toContain("$796.00 instead of $604.00");
    expect(msg).toContain("up $192.00");
    expect(msg).toContain("waiting on your yes before they start");
  });

  it("tells them how much longer the crew will be there", () => {
    const s = summariseCorrection(PIER, P(), { pier_sections: 12 });
    const msg = correctionMessage(s, { serviceName: "Pier install / removal", crewName: null });
    expect(msg).toContain("an hour and a quarter longer");
    expect(msg).toContain("Your crew is at your place");
  });

  it("says plainly when the price does not move", () => {
    // toy_lifts is not in the pier rule, so nothing reprices.
    const s = summariseCorrection(PIER, P({ toy_lifts: 0 }), { toy_lifts: 2 });
    const msg = correctionMessage(s, { serviceName: "Pier install / removal" });
    expect(msg).toContain("The price doesn't change.");
  });

  it("says a correction downward reads as DOWN, not as a hidden increase", () => {
    const s = summariseCorrection(PIER, P(), { pier_sections: 4 });
    const msg = correctionMessage(s, { serviceName: "Pier install / removal" });
    expect(msg).toContain("down $192.00");
    expect(msg).toContain("less than planned");
  });
});

describe("durations a person can read at 7:45am", () => {
  it("keeps small numbers exact and rounds big ones into words", () => {
    expect(humanDuration(20)).toBe("20 minutes");
    expect(humanDuration(60)).toBe("an hour");
    expect(humanDuration(75)).toBe("an hour and a quarter");
    expect(humanDuration(90)).toBe("an hour and a half");
    expect(humanDuration(120)).toBe("2 hours");
    expect(humanDuration(165)).toBe("2 hours and three quarters");
  });

  it("reads a negative change as a magnitude — the direction is said in words", () => {
    expect(humanDuration(-75)).toBe("an hour and a quarter");
  });
});

describe("THE DRIVEWAY RULE — nobody is answering", () => {
  // 0150 made needs_release a REQUIRED field of AccessRule, so every caller —
  // these tests included — has to say what it is. That is the point: an
  // optional flag is a guard whose input nobody passes.
  const access = (over: Partial<{ needs_interior_access: boolean | null; needs_release: boolean | null }> = {}) =>
    ({ needs_interior_access: false, needs_release: false, ...over });

  it("outdoor work goes ahead at the scope booked", () => {
    expect(noAnswerOutcome({ ...PIER, needs_release: false })).toBe("proceed_as_booked");
    expect(noAnswerOutcome({ ...LAWN, needs_release: false })).toBe("proceed_as_booked");
  });

  it("work that needs to get inside becomes a no-show", () => {
    expect(noAnswerOutcome({ ...CLEAN, needs_release: false })).toBe("no_show");
  });

  it("work that needs a BOAT RELEASED is also a no-show (0150)", () => {
    // The live defect this fixed: both collection services carried
    // needs_interior_access = false, so the rule said proceed_as_booked and
    // the crew was told to do the work and bill it — for a boat behind
    // somebody else's locked gate.
    expect(noAnswerOutcome(access({ needs_release: true }))).toBe("no_show");
  });

  it("tells the crew what to do rather than making them decide", () => {
    expect(noAnswerExplainer({ ...LAWN, needs_release: false }, "Lawn mowing & trim"))
      .toContain("do the work as booked");
    const inside = noAnswerExplainer({ ...CLEAN, needs_release: false }, "Housekeeping");
    expect(inside).toContain("record a no-show");
    expect(inside).toContain("don't");            // ...mark it complete
    expect(inside).toContain("cancellation policy");
  });

  it("does NOT tell a crew with no boat to knock harder", () => {
    // Same outcome as interior access, different next action. Sending somebody
    // to look for a door at a storage yard is the kind of instruction that
    // gets ignored, and then so is the rest of the sentence.
    const rel = noAnswerExplainer(access({ needs_release: true }), "Boat return & splash");
    expect(rel).toContain("release it");
    expect(rel).toContain("record a no-show");
    expect(rel, "there is no door here").not.toContain("get inside");
  });

  it("a service with both flags unset is treated as outdoor work", () => {
    // Fail toward doing the work. Refusing to mow a lawn because a column was
    // never set would be a worse failure than mowing it.
    expect(noAnswerOutcome({ needs_interior_access: null, needs_release: null })).toBe("proceed_as_booked");
    expect(noAnswerOutcome(access())).toBe("proceed_as_booked");
  });
});

describe("what the crew's Complete button does while a decision is pending", () => {
  it("held work explains itself instead of failing at the database", () => {
    const msg = completionBlock({ held_at: "2026-08-12T11:40:00Z" });
    expect(msg).toContain("Waiting on the owner");
    expect(msg).toContain("text the moment they answer");
  });

  it("a no-show cannot be completed", () => {
    expect(completionBlock({ no_show_at: "2026-08-12T11:40:00Z" })).toContain("no-show");
  });

  it("a no-show outranks a hold — it is the more final fact", () => {
    expect(completionBlock({ held_at: "x", no_show_at: "y" })).toContain("no-show");
  });

  it("an ordinary job is not blocked", () => {
    expect(completionBlock({})).toBeNull();
    expect(completionBlock({ held_at: null, no_show_at: null })).toBeNull();
  });
});

describe("\"no\" is not always a smaller job", () => {

  it("a divisible job: declining means the crew does the booked amount", () => {
    const d = declineMeans({ crew_can_proceed: true }, {
      serviceName: "Pier install / removal", bookedLabel: "8 sections",
    });
    expect(d.outcome).toBe("proceeds_reduced");
    expect(d.label).toBe("No — just do what I booked");
    expect(d.detail).toContain("do the 8 sections and leave the rest");
    expect(d.detail).toContain("charged the original price");
  });

  it("AN IMPOSSIBLE JOB: declining sends the crew away, and says so", () => {
    // The case Brendon caught: a pier REMOVAL at 8 of 12 leaves four sections
    // in the water for the ice. "Do it as booked" would be damage.
    const d = declineMeans({
      crew_can_proceed: false,
      crew_cannot_reason: "Removal — leaving 4 in the water would wreck them over winter",
    }, { serviceName: "Pier install / removal" });
    expect(d.outcome).toBe("stands_down");
    expect(d.label).toContain("can't do it today");
    expect(d.detail).toContain("pack up and leave");
    expect(d.detail).toContain("nothing charged");
    // The crew's own words reach the owner — they are the reason it's impossible.
    expect(d.detail).toContain("leaving 4 in the water would wreck them");
  });

  it("a flag from before this existed is treated as divisible, not as a blocker", () => {
    // Failing the other way would strand crews over a column nobody set.
    expect(declineMeans({}, { serviceName: "Lawn mowing & trim" }).outcome)
      .toBe("proceeds_reduced");
    expect(declineMeans({ crew_can_proceed: null }, { serviceName: "x" }).outcome)
      .toBe("proceeds_reduced");
  });

  it("never says a bare 'Decline' — the button states the consequence", () => {
    for (const f of [{ crew_can_proceed: true }, { crew_can_proceed: false, crew_cannot_reason: "r" }]) {
      const d = declineMeans(f, { serviceName: "s" });
      expect(d.label.toLowerCase()).not.toBe("decline");
      expect(d.label.length).toBeGreaterThan(10);
    }
  });
});

describe("the record when a declined job goes ahead anyway", () => {
  const line = { field: "pier_sections" as const, label: "pier sections", from: "8", to: "12" };

  it("states what was done AND what was found, so the invoice can't overclaim", () => {
    // Without this the crew installs 8, taps Complete, and the invoice reads
    // "Pier install ✓" while the owner looks at a pier ending in open water.
    const n = scopeNoteFor([line], {
      serviceName: "Pier install / removal", decidedOn: "Aug 12",
    });
    expect(n).toContain("owner's decision on Aug 12");
    expect(n).toContain("booked 8, crew found 12");
    expect(n).toContain("NOT done and has not been charged");
  });

  it("handles a decline where nothing had actually changed", () => {
    const n = scopeNoteFor([], { serviceName: "Housekeeping", decidedOn: "Aug 12" });
    expect(n).toContain("done as booked");
  });

  it("lists more than one difference", () => {
    const n = scopeNoteFor([line, { field: "boat_lifts", label: "boat lifts", from: "1", to: "2" }], {
      serviceName: "x", decidedOn: "Aug 12",
    });
    expect(n).toContain("pier sections: booked 8, crew found 12");
    expect(n).toContain("boat lifts: booked 1, crew found 2");
  });
});

describe("correctionCard — the same numbers the notification quoted", () => {
  it("carries the finding, the money and the time", () => {
    // The exact case from the season simulation: 8 → 12 sections.
    const c = correctionCard(summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 12 }))!;
    expect(c.changes).toEqual(["Pier sections 8 → 12"]);
    expect(c.price).toBe("$796.00 instead of $604.00 — up $192.00");
    expect(c.time).toContain("longer on site");
  });

  it("says 'down' and 'less' when the crew found LESS than the profile claimed", () => {
    // The whole string, not a substring: `money` and `humanDuration` both take
    // the absolute value themselves, so a substring check for "-$" could never
    // have failed and was proving nothing.
    const c = correctionCard(summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 4 }))!;
    expect(c.changes).toEqual(["Pier sections 8 → 4"]);
    expect(c.price).toBe("$412.00 instead of $604.00 — down $192.00");
    expect(c.time).toBe("about an hour less on site");
  });

  it("says nothing about money when the money doesn't move", () => {
    // A crew correcting something that carries no price — the card renders
    // "The price doesn't change." rather than a blank where money should be.
    const s = summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 12 });
    const flat = correctionCard({ ...s, priceDelta: 0, priceAfter: s.priceBefore })!;
    expect(flat.price).toBeNull();
  });

  it("is null when the crew confirmed the profile was already right", () => {
    expect(correctionCard(summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 8 }))).toBeNull();
  });

  it("lists every field the crew corrected", () => {
    const c = correctionCard(summariseCorrection(PIER, P(), { pier_sections: 12, boat_lifts: 2 }))!;
    expect(c.changes.length).toBe(2);
  });

  it("agrees with the message the customer already read", () => {
    // Both sides run the same summary, so the card cannot quote a different
    // price from the email that brought them here.
    const s = summariseCorrection(PIER, P({ pier_sections: 8 }), { pier_sections: 12 });
    const msg = correctionMessage(s, { serviceName: "Pier install", crewName: null });
    const c = correctionCard(s)!;
    expect(msg).toContain("$796.00");
    expect(c.price).toContain("$796.00");
    expect(msg).toContain("$604.00");
    expect(c.price).toContain("$604.00");
  });
});
