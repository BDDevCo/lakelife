import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
const sendSms = vi.fn(async (_to: string, _body: string) => ({ ok: true }));
vi.mock("@/lib/sms", () => ({ sendSms }));

const { triageInboundMessage, populationForOwner } = await import("@/lib/message-triage");

/** Minimal stand-in for the service client, shaped like the two call chains
 *  message-triage actually uses. */
function fakeAdmin(opts: {
  opsPhones?: string[];
  parkMember?: boolean;
  parkRenter?: boolean;
  throwOn?: "users" | "park";
} = {}) {
  return {
    from(table: string) {
      if (table === "users") {
        if (opts.throwOn === "users") throw new Error("db down");
        return {
          select: () => ({
            eq: () => ({
              not: () => ({
                limit: async () => ({
                  data: (opts.opsPhones ?? []).map((phone) => ({ phone })),
                }),
              }),
            }),
          }),
        };
      }
      if (opts.throwOn === "park") throw new Error("db down");
      const hit =
        (table === "park_members" && opts.parkMember) ||
        (table === "park_renters" && opts.parkRenter);
      return {
        select: () => ({ eq: () => ({ limit: async () => ({ data: hit ? [{ id: "x" }] : [] }) }) }),
      };
    },
  };
}

beforeEach(() => sendSms.mockClear());

// ---------------------------------------------------------------------------
describe("an emergency pages a human out of band", () => {
  it("texts ops with the customer's OWN WORDS and where they are", async () => {
    const res = await triageInboundMessage(
      fakeAdmin({ opsPhones: ["+15551110000", "+15552220000"] }),
      "I smell gas by the trailer",
      "park_tenant",
      { where: "Lot 14" },
    );

    expect(res.verdict.outcome).toBe("emergency");
    expect(res.paged).toBe(true);
    expect(res.columns.paged_at).not.toBeNull();
    expect(sendSms).toHaveBeenCalledTimes(2);

    const body = String(sendSms.mock.calls[0][1]);
    expect(body).toMatch(/URGENT/);
    expect(body).toContain("Lot 14");
    // The words are what let an on-call decide from the driveway.
    expect(body).toContain("I smell gas by the trailer");
  });

  it("marks the row emergency with a NULL paged_at when nobody could be reached", async () => {
    const res = await triageInboundMessage(
      fakeAdmin({ opsPhones: [] }), "there is sewage coming up in the yard", "park_tenant", {},
    );
    expect(res.columns.fence_outcome).toBe("emergency");
    expect(res.columns.paged_at).toBeNull(); // the monitorable failure
    expect(res.paged).toBe(false);
  });

  it("a database explosion never throws and never loses the emergency verdict", async () => {
    const res = await triageInboundMessage(
      fakeAdmin({ throwOn: "users" }), "the outlet is sparking", "lake_customer", {},
    );
    expect(res.columns.fence_outcome).toBe("emergency");
    expect(res.columns.paged_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("only an emergency pages — protecting the page protects the person", () => {
  it.each([
    ["can I get a ramp? I use a wheelchair", "never_ai"],
    ["I want a refund", "hold"],
    ["no hot water since friday", "hold"],
    ["its really pouring out, can we push the mow", "allow"],
  ])("%s does not text anyone", async (body, expected) => {
    const res = await triageInboundMessage(fakeAdmin({ opsPhones: ["+15551110000"] }), body, "park_tenant", {});
    expect(res.columns.fence_outcome).toBe(expected);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("a held message still carries its reason to the ops board", async () => {
    const res = await triageInboundMessage(fakeAdmin(), "can I get a ramp? I use a wheelchair", "park_tenant", {});
    expect(res.columns.fence_reason).toMatch(/accommodation/i);
  });

  it("an allowed message stores no reason and pages nobody", async () => {
    const res = await triageInboundMessage(fakeAdmin(), "what time is the crew coming", "lake_customer", {});
    expect(res.columns).toEqual({ fence_outcome: "allow", fence_reason: null, paged_at: null });
  });
});

// ---------------------------------------------------------------------------
describe("populationForOwner fails closed", () => {
  it("a park member is a park owner", async () => {
    expect(await populationForOwner(fakeAdmin({ parkMember: true }), "u1")).toBe("park_owner");
  });
  it("ANY renter trace disqualifies the loose lane", async () => {
    // The trap: a park applicant with no membership row lands on /book, and a
    // naive check would stamp them lake_customer — the one channel where
    // housing rules are off and auto-send is on.
    expect(await populationForOwner(fakeAdmin({ parkRenter: true }), "u1")).toBe("park_tenant");
  });
  it("no park trace at all is a lake customer", async () => {
    expect(await populationForOwner(fakeAdmin(), "u1")).toBe("lake_customer");
  });
  it("a lookup failure is UNKNOWN, never lake_customer", async () => {
    expect(await populationForOwner(fakeAdmin({ throwOn: "park" }), "u1")).toBe("unknown");
  });
});
