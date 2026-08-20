import { describe, it, expect } from "vitest";
import {
  sanitizeSearchTerm, isSearchable,
  customerStatusLabel, crewStatusLabel,
  disputeViewForCustomer, disputeViewForCrew,
  photoGateLabel, customerPhotoLabel, emptyPhotoNote,
} from "@/lib/job-view";

describe("sanitizeSearchTerm — a search box is an untrusted input", () => {
  it("strips LIKE wildcards so '50%' can't match the whole book", () => {
    expect(sanitizeSearchTerm("50%")).toBe("50");
    expect(sanitizeSearchTerm("a_b")).toBe("a b");
    expect(sanitizeSearchTerm("back\\slash")).toBe("back slash");
  });

  it("strips the characters that break PostgREST's .or() filter grammar", () => {
    // A comma or paren in the needle would corrupt the whole filter string.
    expect(sanitizeSearchTerm("Smith, John")).toBe("Smith John");
    expect(sanitizeSearchTerm("Doe (summer)")).toBe("Doe summer");
    expect(sanitizeSearchTerm('say "hi"')).toBe("say hi");
    expect(sanitizeSearchTerm("a.b:c*d")).toBe("a b c d");
  });

  it("collapses whitespace and trims, and caps runaway length", () => {
    expect(sanitizeSearchTerm("  lots   of    space  ")).toBe("lots of space");
    expect(sanitizeSearchTerm("x".repeat(200)).length).toBe(80);
  });

  it("leaves an ordinary needle completely alone", () => {
    expect(sanitizeSearchTerm("4521 Lakeview Dr")).toBe("4521 Lakeview Dr");
    expect(sanitizeSearchTerm("GreenEdge")).toBe("GreenEdge");
  });

  it("survives a string that is nothing but hostile characters", () => {
    expect(sanitizeSearchTerm("%,()\"'*:_\\")).toBe("");
    expect(isSearchable("%,()")).toBe(false);
  });

  it("refuses to run a one-character search", () => {
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable("ab")).toBe(true);
    expect(isSearchable("   ")).toBe(false);
  });
});

describe("status labels never leak internal vocabulary", () => {
  it("speaks plainly to a customer", () => {
    expect(customerStatusLabel("requested")).toBe("Finding your crew");
    expect(customerStatusLabel("in_progress")).toBe("Crew is there now");
  });
  it("speaks to the crew about their own work", () => {
    expect(crewStatusLabel("requested")).toBe("Unassigned");
    expect(crewStatusLabel("complete")).toContain("pay released");
  });
  it("passes an unknown status through rather than crashing a page", () => {
    expect(customerStatusLabel("weird_new_status")).toBe("weird_new_status");
    expect(crewStatusLabel("weird_new_status")).toBe("weird_new_status");
  });
});

describe("disputeViewForCustomer — internal state never reaches the customer", () => {
  const ALL = [
    "crew_review", "fixing", "verifying", "talk", "escalated",
    "resolved_fixed", "resolved_verified", "resolved_refunded", "resolved_closed",
  ];

  it("never renders a raw status name in the pill or the line", () => {
    for (const status of ALL) {
      const v = disputeViewForCustomer({ status });
      for (const s of ALL) {
        expect(v.pill).not.toContain(s);
        expect(v.line).not.toContain(s);
      }
      expect(v.pill.length).toBeGreaterThan(0);
      expect(v.line.length).toBeGreaterThan(0);
    }
  });

  it("names the day when a return visit is booked", () => {
    const v = disputeViewForCustomer({ status: "fixing", correctionDate: "2026-07-28" });
    expect(v.line).toContain("Tue, Jul 28");
    expect(v.line).toContain("no charge");
  });

  it("stays honest when the correction date is missing or malformed", () => {
    for (const bad of [null, undefined, "", "not-a-date", "07/28/2026"]) {
      const v = disputeViewForCustomer({ status: "fixing", correctionDate: bad as string | null });
      expect(v.line).toContain("coming back");
      expect(v.line).not.toContain("Invalid");
      expect(v.line).not.toContain("NaN");
    }
  });

  it("holds pay for every open state and releases it for every resolved one", () => {
    for (const status of ["crew_review", "fixing", "verifying", "talk", "escalated"]) {
      expect(disputeViewForCustomer({ status }).payOnHold).toBe(true);
    }
    for (const status of ["resolved_fixed", "resolved_verified", "resolved_refunded", "resolved_closed"]) {
      expect(disputeViewForCustomer({ status }).payOnHold).toBe(false);
    }
  });

  it("asks the customer to act only in the two states that are actually theirs", () => {
    expect(disputeViewForCustomer({ status: "verifying" }).needsCustomer).toBe(true);
    expect(disputeViewForCustomer({ status: "talk" }).needsCustomer).toBe(true);
    for (const status of ["crew_review", "fixing", "escalated", "resolved_fixed"]) {
      expect(disputeViewForCustomer({ status }).needsCustomer).toBe(false);
    }
  });

  it("never promises a refund the policy has not actually sent", () => {
    for (const status of ["crew_review", "fixing", "verifying", "talk", "escalated"]) {
      expect(disputeViewForCustomer({ status }).line.toLowerCase()).not.toContain("refund");
    }
    expect(disputeViewForCustomer({ status: "resolved_refunded" }).line.toLowerCase()).toContain("money back");
  });

  it("falls back safely on a status it has never seen", () => {
    const v = disputeViewForCustomer({ status: "invented_state" });
    expect(v.pill).toBe("Open");
    expect(v.line).not.toContain("invented_state");
  });
});

describe("disputeViewForCrew — the crew's version is about their pay", () => {
  it("tells an open dispute's crew their pay is on hold", () => {
    expect(disputeViewForCrew({ status: "crew_review" }).line).toContain("on hold");
    expect(disputeViewForCrew({ status: "escalated" }).line).toContain("on hold");
  });
  it("confirms release once settled", () => {
    expect(disputeViewForCrew({ status: "resolved_fixed" }).line).toContain("released");
  });
  it("NEVER shows the crew a customer refund amount — rule 1", () => {
    const v = disputeViewForCrew({ status: "resolved_refunded" });
    expect(v.line).toContain("adjusted");
    expect(v.line).not.toMatch(/\$\d/);
  });
  it("names the return-visit day for the crew too", () => {
    expect(disputeViewForCrew({ status: "fixing", correctionDate: "2026-07-28" }).line).toContain("Tue, Jul 28");
  });
});

describe("photoGateLabel — rule 2 in words", () => {
  it("counts down the photos still required", () => {
    expect(photoGateLabel(1, 3)).toBe("1 / 3 photos — 2 more before you can mark this done");
  });
  it("clears the crew at the minimum and above", () => {
    expect(photoGateLabel(3, 3)).toContain("clear to finish");
    expect(photoGateLabel(9, 3)).toContain("clear to finish");
  });
  it("handles a service with no photo minimum without nonsense", () => {
    expect(photoGateLabel(2, 0)).toBe("2 photos on file");
    expect(photoGateLabel(1, 0)).toBe("1 photo on file");
  });
});

describe("customerPhotoLabel — the number the 👍/👎 is a judgement about", () => {
  it("says nothing about a minimum when the service has none", () => {
    expect(customerPhotoLabel(3, 0, true)).toBe("3 photos from your crew, taken on site.");
    expect(customerPhotoLabel(1, 0, true)).toBe("1 photo from your crew, taken on site.");
  });

  it("names the bar once the job is finished", () => {
    expect(customerPhotoLabel(4, 4, true)).toBe("4 photos from your crew — all 4 required.");
  });

  it("says which of them were required when the crew sent extras", () => {
    expect(customerPhotoLabel(6, 4, true)).toBe("6 photos from your crew — 4 were required.");
  });

  it("a short count mid-job reads as progress, not as a crew cutting corners", () => {
    // Crews upload as they work. Two-of-four at 10am is normal.
    expect(customerPhotoLabel(2, 4, false)).toBe("2 photos so far — 4 are required before your crew can finish.");
  });

  it("gets the singular right in every branch", () => {
    expect(customerPhotoLabel(1, 4, false)).toContain("1 photo so far");
    expect(customerPhotoLabel(1, 1, true)).toBe("1 photo from your crew — all 1 required.");
  });
});

describe("emptyPhotoNote — an empty gallery means different things at different times", () => {
  it("never tells a customer to wait on a job the crew has already finished", () => {
    for (const status of ["complete", "paid"]) {
      expect(emptyPhotoNote(status, 4)).not.toContain("the moment your crew finishes");
      expect(emptyPhotoNote(status, 0)).not.toContain("the moment your crew finishes");
    }
  });

  it("still says 'yet' while the work is ahead of them", () => {
    for (const status of ["requested", "scheduled", "in_progress"]) {
      expect(emptyPhotoNote(status, 4)).toBe("No photos yet — they land here the moment your crew finishes.");
    }
  });

  it("owns the problem when the gate required photos and none are showing", () => {
    // The job could not have reached complete without them, so rows exist and
    // this is ours to fix — not a crew who documented nothing.
    const note = emptyPhotoNote("complete", 4);
    expect(note).toContain("4 were required");
    expect(note).toContain("Tell us");
  });

  it("says plainly when the service never called for any", () => {
    expect(emptyPhotoNote("paid", 0)).toBe("This service doesn't call for photos, so your crew didn't take any.");
  });

  it("a cancelled visit is its own answer", () => {
    expect(emptyPhotoNote("cancelled", 4)).toBe("No photos — this one was cancelled.");
  });
});
