import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * "WE'LL COME BACK TO YOU" — AND CLOSING IT SENT NOTHING.
 *
 * The customer's job page said, of an escalated Make-It-Right report: "We're
 * reviewing it and will come back to you — nothing more for you to do." The
 * only exit from `escalated` is `opsResolveEscalated`. Two of its three
 * outcomes — close in the crew's favour, and "refund" when nothing had been
 * captured — wrote the resolution and told nobody. (The third, a refund with
 * real money, already tells the customer from inside `executeRefund`.) And the
 * second is not the rare path: `decideDisputeOutcome` escalates PRECISELY
 * BECAUSE nothing was captured, so on prod today every escalation lands on it.
 *
 * So a homeowner who was promised an answer got a pill that quietly changed
 * from "With our team" to "Closed" the next time they happened to look.
 *
 * BEHAVIOURAL, not a source scan, because the defect is an OMISSION in a
 * function that already imports `notify` and uses it three times. Only running
 * the function proves the fourth call exists on the two paths that lacked it.
 * The fake below is enough of PostgREST to run `opsResolveEscalated` honestly:
 * the filters it actually uses, and an `update()` that mutates the rows so the
 * assertions are against the dispute, not only the return value.
 */
vi.mock("server-only", () => ({}));

type Told = { reached: boolean; bySms: boolean; byEmail: boolean; note?: string };
const notified = vi.fn(async (): Promise<Told> => ({ reached: true, bySms: false, byEmail: true }));
vi.mock("@/lib/notify", () => ({ notify: (...a: unknown[]) => notified(...(a as [])) }));

const refunded = vi.fn(async () => ({ ok: true, refunded: 80, clawback: 0 }));
vi.mock("@/lib/refund-core", () => ({ executeRefund: (...a: unknown[]) => refunded(...(a as [])) }));

vi.mock("@/lib/settings", () => ({
  getPlatformSettings: vi.fn(async () => ({ disputeResponseHours: 24, disputeFixDays: 7, disputeAutoRefundMax: 150 })),
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { disputes: [], jobs: [], invoices: [], payments: [], refunds: [], payouts: [] };

class Q implements PromiseLike<{ data: Row[] | null; error: null }> {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  update(p: Row) { this.patch = p; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.fs.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  private rows(): Row[] { return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))); }
  maybeSingle() {
    const hit = this.rows();
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit[0] ?? null, error: null });
  }
  then<A, B>(
    ok?: ((x: { data: Row[] | null; error: null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const hit = this.rows();
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit, error: null }).then(ok, bad);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { opsResolveEscalated } = await import("./disputes");

const OWNER = { phone: "+12605550100", email: "owner@example.org" };

function seed(status = "escalated") {
  for (const k of Object.keys(db)) db[k] = [];
  db.jobs.push({
    id: "job-1", customer_price: 120, vendor_id: "v1",
    properties: { owner_id: "u-owner", users: { id: "u-owner", ...OWNER } },
    services: { name: "Weekly mow" },
  });
  db.disputes.push({
    id: "d-1", job_id: "job-1", status, customer_note: "missed the back strip",
    customer_token: "c".repeat(32), crew_token: "k".repeat(32), correction_job_id: null,
  });
  db.payouts.push({ job_id: "job-1", kind: "earning", status: "held", batch_id: null });
}

beforeEach(() => {
  notified.mockClear();
  refunded.mockClear();
  seed();
});

const dispute = () => db.disputes[0];
const lastNotice = () => {
  const call = notified.mock.calls.at(-1) as unknown as [string, { phone?: string; email?: string }, { sms: string; subject: string; body?: string }];
  return { what: call[0], to: call[1], msg: call[2] };
};

describe("closing in the crew's favour tells the customer", () => {
  it("resolves the dispute AND sends the outcome to the person who reported it", async () => {
    const res = await opsResolveEscalated("d-1", "close", "ops-1");
    expect(res.ok).toBe(true);
    expect(dispute().status).toBe("resolved_closed");

    expect(notified).toHaveBeenCalledTimes(1);
    const n = lastNotice();
    expect(n.to).toEqual(OWNER);
    expect(n.msg.sms).toContain("Weekly mow");
    expect(n.msg.sms.toLowerCase()).toContain("closed");
    // Closed in the CREW's favour: the message must not soften that into a
    // refund it never sent — and must not claim "billed as normal" either,
    // since this path reads nothing about the bill (it may already have been
    // refunded from the refund screen). Nothing changed; say exactly that.
    expect(n.msg.sms.toLowerCase()).not.toContain("refund");
    expect(n.msg.sms.toLowerCase()).not.toContain("back to your card");
    expect(n.msg.sms.toLowerCase()).not.toContain("billed as normal");
    expect(n.msg.sms.toLowerCase()).toContain("nothing about your bill changes");
    expect(n.msg.subject.length).toBeGreaterThan(0);
  });

  it("reports back to ops whether the customer was reached", async () => {
    const res = await opsResolveEscalated("d-1", "close", "ops-1");
    expect(res.customerTold).toBe(true);

    seed();
    notified.mockResolvedValueOnce({ reached: false, bySms: false, byEmail: false, note: "Couldn't tell them — the email didn't send." });
    const res2 = await opsResolveEscalated("d-1", "close", "ops-1");
    expect(res2.ok).toBe(true); // the decision stood; only the notice failed
    expect(res2.customerTold).toBe(false);
    expect(res2.customerNote).toMatch(/didn't send/);
  });
});

describe("'refund' when nothing was ever captured — the common escalation today", () => {
  it("closes it and tells the customer, without claiming money moved", async () => {
    const res = await opsResolveEscalated("d-1", "refund", "ops-1");
    expect(res.ok).toBe(true);
    expect(res.refunded).toBe(0);
    expect(dispute().status).toBe("resolved_closed");
    expect(refunded).not.toHaveBeenCalled();

    expect(notified).toHaveBeenCalledTimes(1);
    const n = lastNotice();
    expect(n.to).toEqual(OWNER);
    // The one true sentence about the money: nothing had been charged.
    expect(n.msg.sms.toLowerCase()).toMatch(/nothing (had been|was) charged/);
    expect(n.msg.sms.toLowerCase()).not.toContain("refunded");
    expect(n.msg.sms.toLowerCase()).not.toContain("on its way back");
  });
});

describe("a refund that actually moves money is announced once, by the refund itself", () => {
  it("does not send a second notice on top of executeRefund's", async () => {
    db.invoices.push({ id: "inv-1", job_id: "job-1", status: "paid" });
    db.payments.push({ invoice_id: "inv-1", amount: 80, status: "captured" });
    const res = await opsResolveEscalated("d-1", "refund", "ops-1");
    expect(res.ok).toBe(true);
    expect(res.refunded).toBe(80);
    expect(dispute().status).toBe("resolved_refunded");
    expect(refunded).toHaveBeenCalledTimes(1);
    // refund-core.ts already texts+emails "Refund issued — $80.00"; a second
    // "we closed your report" on top would be two facts where there is one.
    expect(notified).not.toHaveBeenCalled();
  });
});

describe("nothing is sent when nothing changed", () => {
  it("a dispute that is no longer escalated is refused, and the customer is not told anything", async () => {
    seed("resolved_verified");
    const res = await opsResolveEscalated("d-1", "close", "ops-1");
    expect(res.ok).toBe(false);
    expect(notified).not.toHaveBeenCalled();
  });
});

/**
 * THE SENTENCE OPS READS AFTER THE TAP. It said "Closed in the crew's favour.
 * Their pay has been released." and nothing about the customer — the person
 * the whole card is about. Now it says whether they were reached, and when
 * they were not, why, so ops can pick up the phone.
 */
// End-to-end through the REAL opsResolveEscalated and the fake rows above —
// the sentence is assembled from what the function returned, and a rebuilt
// copy of that assembly would pass while the real one lied.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/ops/data", () => ({ assertOps: async () => ({ id: "ops-1", name: "B", role: "ops" }) }));
const { resolveEscalationAction } = await import("../app/ops/dispute-actions");

describe("the ops result names the customer", () => {
  const form = (outcome: string) => {
    const f = new FormData();
    f.set("disputeId", "d-1");
    f.set("outcome", outcome);
    return f;
  };

  it("says the customer was told, on both silent paths", async () => {
    const closed = await resolveEscalationAction(null, form("close"));
    expect(closed.ok).toBe(true);
    expect(closed.message).toMatch(/customer has been told/i);

    seed();
    const nothing = await resolveEscalationAction(null, form("refund"));
    expect(nothing.ok).toBe(true);
    expect(nothing.message).toMatch(/nothing to refund/);
    expect(nothing.message).toMatch(/customer has been told/i);
    // Ops pressed "Refund the customer". Nothing here waived the bill, and the
    // nightly reconcile charges it once the dispute is off the job — say so.
    expect(nothing.message).toMatch(/still billed as normal/i);
    expect(nothing.message).toMatch(/didn't waive/i);
  });

  it("does not say 'nothing had been charged' about a bill that was charged and refunded in full", async () => {
    // A big bill escalates over the auto-refund line; ops refunds it from the
    // refund screen first, then taps the escalation. Same $0, different truth.
    db.invoices.push({ id: "inv-1", job_id: "job-1", status: "refunded" });
    db.payments.push({ invoice_id: "inv-1", amount: 500, status: "captured" });
    db.refunds.push({ invoice_id: "inv-1", amount: 500 });
    const r = await resolveEscalationAction(null, form("refund"));
    expect(r.ok).toBe(true);
    expect(refunded).not.toHaveBeenCalled();
    expect(r.message).not.toMatch(/Nothing had been charged/);
    expect(r.message).not.toMatch(/still billed/);
    expect(r.message).toMatch(/already been refunded in full/);
    expect(r.message).toMatch(/customer has been told/i);
    // And the customer heard the same truth.
    expect(notified).toHaveBeenCalledTimes(1);
    const n = lastNotice();
    expect(n.msg.sms).not.toMatch(/Nothing had been charged/);
    expect(n.msg.sms).toMatch(/already been refunded in full/);
  });

  it("says when the customer was NOT reached, and why", async () => {
    notified.mockResolvedValueOnce({ reached: false, bySms: false, byEmail: false, note: "No way to reach them about the outcome of their report — no mobile and no email on file." });
    const closed = await resolveEscalationAction(null, form("close"));
    expect(closed.ok).toBe(true);
    expect(closed.message).not.toMatch(/customer has been told/i);
    expect(closed.message).toMatch(/no mobile and no email on file/);
    // The outcome still shows on their job page — that is the fallback door.
    expect(closed.message).toMatch(/job page/i);
  });

  it("a refund that moved money leaves the telling to the refund", async () => {
    db.invoices.push({ id: "inv-1", job_id: "job-1", status: "paid" });
    db.payments.push({ invoice_id: "inv-1", amount: 80, status: "captured" });
    const r = await resolveEscalationAction(null, form("refund"));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Refunded \$80\.00/);
    // refund-core fires its "Refund issued" notice with `void notify` and
    // throws the result away, so this path cannot verify it reached anyone.
    // The sentence describes the mechanism; it does not claim a delivery.
    expect(r.message).toMatch(/refund notice/i);
    expect(r.message).not.toMatch(/customer has been told/i);
    expect(notified).not.toHaveBeenCalled(); // refund-core sends that one
  });
});

/**
 * AND THE PROMISE ON THE CUSTOMER'S SCREEN MATCHES WHAT NOW HAPPENS. Every
 * exit from `escalated` sends them the outcome, and the same page shows it;
 * the line says both, and names the door that is actually open (email — the
 * text channel has delivered nothing since July).
 */
describe("the escalated line promises only what the close action does", () => {
  it("names the email and the page, not a vague 'we'll come back to you'", async () => {
    const { disputeViewForCustomer } = await import("./job-view");
    const v = disputeViewForCustomer({ status: "escalated" });
    expect(v.pill).toBe("With our team");
    expect(v.line).not.toMatch(/come back to you/);
    expect(v.line).toMatch(/email/i);
    expect(v.line).toMatch(/outcome/i);
    expect(v.line).toMatch(/nothing more for you to do/i);
    // Pinned by job-view.test.ts too: no refund is promised from this state.
    expect(v.line.toLowerCase()).not.toContain("refund");
  });
});

describe("what the review caught after the fix landed", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const disputes = strip(readFileSync(fileURLToPath(new URL("./disputes.ts", import.meta.url)), "utf8"));
  const ops = strip(readFileSync(fileURLToPath(new URL("../app/ops/dispute-actions.ts", import.meta.url)), "utf8"));

  it("a refused close is not reported as 'nothing left to refund'", () => {
    // The $0-refund branch discarded the UPDATE's error, and an empty result
    // — which a failed write ALSO produces — returned ok:true. Ops then read
    // "Closed — the crew's pay has been released" over a dispute still
    // escalated and a payout still held. The 👎 door's shape, again.
    const branch = disputes.slice(disputes.indexOf('resolution: "ops: nothing left to refund"'));
    expect(branch.slice(0, 900)).toMatch(/if \(flipErr\) return \{ ok: false/);
  });

  it("'the crew's pay has been released' is said only when a row moved", () => {
    // releaseHeldPayout returned void and discarded its error; three ops
    // sentences asserted the release on the strength of the CALL.
    expect(disputes).toMatch(/Promise<\{ released: number; error\?: unknown \}>/);
    expect(disputes, "the ops paths do not read the count").toMatch(/payoutReleased: rel\.released/);
    // The phrase may exist exactly once — as one arm of the ternary that
    // reads the count. Every sentence template must reach it through `${pay}`.
    const literal = (ops.match(/the crew's pay has been released/g) ?? []).length;
    expect(literal, "the phrase is hardcoded into a sentence again").toBe(1);
    expect(ops).toMatch(/\(res\.payoutReleased \?\? 0\) > 0/);
    expect(ops).toMatch(/no pay was on hold to release/);
    expect((ops.match(/\$\{pay\}/g) ?? []).length, "a $0 sentence bypasses the conditional").toBe(3);
  });
});
