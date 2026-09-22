import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE-TAP CONFIRM PAGE IS THE ONLY MESSAGE THIS PATH SENDS.
 *
 * It said "You're booked 🌊 … We'll remind you the night before, and your
 * photos go on the job page as soon as the crew finishes" — and it said it
 * either way, because the route threw the dispatch outcome away. When nobody
 * is found the job stays `requested`: no crew is coming, the night-before
 * sweep only ever reads `scheduled` jobs, and there are no photos to promise.
 * On prod today every vendor belongs to a fixture account and both candidate
 * pools fence fixtures out, so that is the branch EVERY confirm lands in.
 *
 * The batch-booking door was already fixed for this exact fact and branches
 * its subject and body on `soloAssigned`. This was the other door. The
 * replacement sentence is deliberately that door's sentence, word for word.
 *
 * The real POST and the real `htmlPage`; only the database, the token lookup
 * and dispatch are stood in for.
 */

type Row = Record<string, unknown>;
interface Call { table: string; op: string; payload?: Row }
let handle: (c: Call) => { data: unknown; error: unknown } = () => ({ data: [], error: null });

class Q {
  private call: Call;
  constructor(table: string) { this.call = { table, op: "select" }; }
  select() { return this; }
  insert(p: Row) { this.call.op = "insert"; this.call.payload = p; return this; }
  update(p: Row) { this.call.op = "update"; this.call.payload = p; return this; }
  eq() { return this; }
  in() { return this; }
  gte() { return this; }
  limit() { return this; }
  maybeSingle() { return this; }
  single() { return this; }
  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(handle(this.call)).then(ok, bad);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/booking", async (orig) => {
  const actual = await orig<typeof import("@/lib/booking")>();
  return { ...actual, todayLakeDate: () => "2027-03-25" };
});

const outcome = { assigned: false as boolean };
vi.mock("@/app/book/dispatch", () => ({
  autoAssignJob: vi.fn(async () => outcome),
}));

/** The token lookup is the only thing stood in for in respond.ts — `htmlPage`
 *  and its escaping are the thing we are reading, so they stay real. */
const tokenEvent = {
  id: "ev-1",
  status: "proposed",
  proposed_date: "2027-04-04",
  enrollment: {
    id: "enr-1",
    active: true,
    property_id: "prop-1",
    service_id: "svc-1",
    locked_price: 604,
    serviceName: "Pier install",
    ownerId: "own-1",
    where: "12 Shoreline Dr",
  },
};
const loaded: { value: unknown } = { value: tokenEvent };
vi.mock("../respond", async (orig) => {
  const actual = await orig<typeof import("../respond")>();
  return { ...actual, loadTokenEvent: vi.fn(async () => loaded.value) };
});

import { GET, POST } from "./route";

const TOKEN = "00000000-0000-4000-8000-000000000000";
const ctx = { params: Promise.resolve({ token: TOKEN }) };
const req = () => new Request(`https://lakelife.ai/a/${TOKEN}/confirm`, { method: "POST" });

/** Nothing else on the books; the proposed→confirmed flip is won; job written. */
function happyPath() {
  handle = (c) => {
    if (c.table === "jobs" && c.op === "insert") return { data: { id: "job-1" }, error: null };
    if (c.table === "jobs") return { data: [], error: null };
    if (c.table === "autopilot_events" && c.payload?.status === "confirmed") {
      return { data: [{ id: "ev-1" }], error: null };
    }
    return { data: null, error: null };
  };
}

beforeEach(() => {
  loaded.value = { ...tokenEvent, status: "proposed" };
  outcome.assigned = false;
  happyPath();
});

describe("the page tells the customer what actually happened", () => {
  it("a crew was found: it says booked, and the two promises it can keep", async () => {
    outcome.assigned = true;
    const body = await (await POST(req(), ctx)).text();
    expect(body).toContain("You&#39;re booked");
    expect(body).toContain("We&#39;ll remind you the night before");
    expect(body).toContain("at your locked price");
  });

  it("no crew was found: it says so, and promises neither the reminder nor the photos", async () => {
    outcome.assigned = false;
    const body = await (await POST(req(), ctx)).text();
    expect(body).toContain("We&#39;ve got it");
    expect(body).toContain("We&#39;re lining up a crew for that day now");
    expect(body).toContain("Nothing is confirmed until then.");
    // The two sentences that could not be true for a job left `requested`.
    expect(body).not.toContain("You&#39;re booked");
    expect(body).not.toContain("remind you the night before");
    expect(body).not.toContain("photos go on the job page");
  });

  it("the two pages are not the same page — collapse the branch and this fails", async () => {
    outcome.assigned = true;
    const assigned = await (await POST(req(), ctx)).text();
    outcome.assigned = false;
    const unassigned = await (await POST(req(), ctx)).text();
    expect(unassigned).not.toBe(assigned);
  });

  it("either way the booking itself happened — the fix is the sentence, not the job", async () => {
    const written: Row[] = [];
    handle = (c) => {
      if (c.table === "jobs" && c.op === "insert") {
        written.push(c.payload ?? {});
        return { data: { id: "job-1" }, error: null };
      }
      if (c.table === "jobs") return { data: [], error: null };
      if (c.table === "autopilot_events" && c.payload?.status === "confirmed") return { data: [{ id: "ev-1" }], error: null };
      return { data: null, error: null };
    };
    await POST(req(), ctx);
    expect(written).toHaveLength(1);
    expect(written[0].customer_price).toBe(604);
    expect(written[0].date).toBe("2027-04-04");
  });
});

describe("re-tapping a link that was already confirmed", () => {
  it("does not promise a reminder it has no way of knowing about", async () => {
    // This branch reads the EVENT, never the job: `loadTokenEvent` selects the
    // proposal and its enrollment and stops there. A proposal confirmed a
    // minute ago whose dispatch found nobody is still sitting at `requested`,
    // and the night-before sweep will never see it. The honest floor is the
    // sentence without the promise — which is what the POST twin already said.
    loaded.value = { ...tokenEvent, status: "confirmed" };
    const body = await (await GET(new Request(`https://lakelife.ai/a/${TOKEN}/confirm`), ctx)).text();
    expect(body).toContain("Already booked");
    expect(body).toContain("is on the books for");
    expect(body).not.toContain("remind you the night before");
  });
});
