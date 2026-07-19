import { describe, it, expect } from "vitest";
import { groupThreads, type FlatMessage } from "./messages-group";

function msg(over: Partial<FlatMessage>): FlatMessage {
  return {
    id: "m",
    property_id: "p1",
    address: "1 Lake Rd",
    lake: "Big Long",
    owner_name: "Pat Owner",
    owner_id: "owner-1",
    from_user: "owner-1",
    body: "hi",
    created_at: "2026-07-01T10:00:00.000Z",
    ...over,
  };
}

describe("groupThreads", () => {
  it("groups messages by property", () => {
    const threads = groupThreads([
      msg({ id: "a", property_id: "p1" }),
      msg({ id: "b", property_id: "p2", owner_id: "owner-2", from_user: "owner-2" }),
      msg({ id: "c", property_id: "p1" }),
    ]);
    expect(threads).toHaveLength(2);
    const p1 = threads.find((t) => t.propertyId === "p1")!;
    expect(p1.messages.map((m) => m.id).sort()).toEqual(["a", "c"]);
  });

  it("labels sender owner vs ops by comparing from_user to owner_id", () => {
    const [t] = groupThreads([
      msg({ id: "a", from_user: "owner-1", created_at: "2026-07-01T10:00:00.000Z" }),
      msg({ id: "b", from_user: "ops-99", created_at: "2026-07-01T11:00:00.000Z" }),
    ]);
    const byId = Object.fromEntries(t.messages.map((m) => [m.id, m.from]));
    expect(byId.a).toBe("owner");
    expect(byId.b).toBe("ops");
  });

  it("orders messages oldest-first within a thread", () => {
    const [t] = groupThreads([
      msg({ id: "late", created_at: "2026-07-03T09:00:00.000Z" }),
      msg({ id: "early", created_at: "2026-07-01T09:00:00.000Z" }),
      msg({ id: "mid", created_at: "2026-07-02T09:00:00.000Z" }),
    ]);
    expect(t.messages.map((m) => m.id)).toEqual(["early", "mid", "late"]);
    expect(t.lastAt).toBe("2026-07-03T09:00:00.000Z");
  });

  it("orders threads by newest activity first", () => {
    const threads = groupThreads([
      msg({ id: "a", property_id: "old", created_at: "2026-07-01T09:00:00.000Z" }),
      msg({ id: "b", property_id: "new", created_at: "2026-07-05T09:00:00.000Z" }),
      msg({ id: "c", property_id: "mid", created_at: "2026-07-03T09:00:00.000Z" }),
    ]);
    expect(threads.map((t) => t.propertyId)).toEqual(["new", "mid", "old"]);
  });

  it("treats a null owner_id as an ops message (never falsely 'owner')", () => {
    const [t] = groupThreads([msg({ owner_id: null, from_user: null })]);
    expect(t.messages[0].from).toBe("ops");
  });

  it("returns an empty array for no messages", () => {
    expect(groupThreads([])).toEqual([]);
  });
});
