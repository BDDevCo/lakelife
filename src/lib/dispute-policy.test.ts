import { describe, it, expect } from "vitest";
import {
  customerMayAnswer,
  DISPUTE_ACCEPTABLE_STATUSES,
  DISPUTE_ESCALATABLE_STATUSES,
} from "@/lib/dispute-policy";

describe("customerMayAnswer — the crew's right-to-cure is enforced in policy, not in JSX", () => {
  it("NEVER lets a customer escalate before the crew has had its turn", () => {
    // This is the whole ladder: a 👎 opens the dispute in crew_review and the
    // crew gets first move. Escalating from there would refund the customer
    // and claw back pay from a crew that never got to respond.
    expect(customerMayAnswer("crew_review", "still")).toBe(false);
    // Nor after they've committed to a free return visit but before it happens.
    expect(customerMayAnswer("fixing", "still")).toBe(false);
  });

  it("lets a customer escalate once the crew HAS responded", () => {
    expect(customerMayAnswer("verifying", "still")).toBe(true);
    expect(customerMayAnswer("talk", "still")).toBe(true);
  });

  it("lets a customer accept at any point in the open ladder", () => {
    for (const s of ["crew_review", "fixing", "verifying", "talk"]) {
      expect(customerMayAnswer(s, "resolved")).toBe(true);
    }
  });

  it("refuses both answers on an already-resolved or escalated dispute", () => {
    for (const s of ["escalated", "resolved_fixed", "resolved_verified", "resolved_refunded", "resolved_closed"]) {
      expect(customerMayAnswer(s, "still")).toBe(false);
      expect(customerMayAnswer(s, "resolved")).toBe(false);
    }
  });

  it("refuses an unknown status rather than defaulting open", () => {
    expect(customerMayAnswer("", "still")).toBe(false);
    expect(customerMayAnswer("invented", "resolved")).toBe(false);
  });

  it("the escalatable set is a strict subset of the acceptable set", () => {
    for (const s of DISPUTE_ESCALATABLE_STATUSES) {
      expect(DISPUTE_ACCEPTABLE_STATUSES).toContain(s);
    }
    expect(DISPUTE_ESCALATABLE_STATUSES.length).toBeLessThan(DISPUTE_ACCEPTABLE_STATUSES.length);
  });
});
