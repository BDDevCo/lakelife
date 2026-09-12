import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WITH NOTICES HELD, THE INVITE RESULT TOLD HIM EIGHTEEN ADDRESSES "DIDN'T
 * WORK".
 *
 * `sendEmail` refuses every send to a held park's household and says so in a
 * sentence written for him. The invite door threw that sentence away and
 * blamed the address — "${email} didn't work", "that address didn't work" —
 * on 1 January, when the hold is the normal state and every address on the
 * roll is one he typed himself.
 *
 * The real action, against a fake of the three tables and one RPC it touches,
 * with `sendEmail` returning exactly what notice-hold.ts returns.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private cap: number | null = null;
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  limit(n: number) { this.cap = n; return this; }
  update(patch: Row) { this.patch = patch; return this; }
  private rows(): Row[] {
    let out = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.cap != null) out = out.slice(0, this.cap);
    return out;
  }
  private resolve() {
    const hit = this.rows();
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit, error: null });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data[0] ?? null, error: null })); }
  then<A, B>(ok?: ((x: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}

let emailResult: { ok: boolean; error?: string } = { ok: true };
const HOLD = "Notices are on hold for this park — Held on setup — lift it when the roll is loaded and the leases are executed.";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", "lakelife.ai"]]) }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async () => ({ data: "invited", error: null }) }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/email", () => ({ sendEmail: async () => emailResult }));
vi.mock("@/lib/sms", () => ({ sendSms: async () => ({ queued: false, error: "held" }) }));

const { inviteHousehold, inviteEveryone } = await import("./invite-actions");

const PARK = "park-haven";
const LOTS = ["1", "2", "6", "7"];

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  emailResult = { ok: true };
  db.parks = [{ id: PARK, name: "The Haven" }];
  db.park_renters = LOTS.map((n) => ({
    id: `renter-${n}`, park_id: PARK, display_name: `Household ${n}`, email: `lot${n}@example.com`,
    user_id: null, claim_declined_at: null, invite_sent_at: null,
    mobile_e164: null, mobile_verified_at: null, sms_consent_operational_at: null, phone_on_file_with_park: null,
  }));
  db.lot_reservations = LOTS.map((n) => ({
    renter_id: `renter-${n}`, park_lot_id: `lot-${n}`, status: "active", park_lots: { lot_number: n },
  }));
});

describe("one household, notices held", () => {
  it("says the hold, word for word, and does not blame the address", async () => {
    emailResult = { ok: false, error: HOLD };
    const res = await inviteHousehold("renter-7");
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("invite_send_failed");
    expect(res.emailFailed).toBe(HOLD);
    expect(res.message.startsWith(HOLD)).toBe(true);
    expect(res.message).not.toMatch(/didn't work|check the address/i);
    // A slip is the way round a bad address, not the way round his own hold.
    expect(res.message).not.toMatch(/print a slip/i);
  });

  it("still offers the slip when the cause is the transport, labelled as such", async () => {
    emailResult = { ok: false, error: "Resend 503: upstream unavailable" };
    const res = await inviteHousehold("renter-7");
    expect(res.message).toMatch(/^The email didn't go — Resend 503/);
    expect(res.message).toMatch(/print a slip/i);
  });

  it("unwinds the stamp when nothing reached them", async () => {
    emailResult = { ok: false, error: HOLD };
    await inviteHousehold("renter-7");
    const file = db.park_renters.find((r) => r.id === "renter-7")!;
    expect(file.invite_sent_at).toBeNull();
    expect(file.invite_token_hash).toBeNull();
  });
});

describe("everyone at once, notices held", () => {
  it("files every hold-refused household as HELD — never as needing a slip", async () => {
    // The single door refuses to say "print a slip" for the hold he set. This
    // door, same commit, headlined "4 need a slip — 4 couldn't be emailed:
    // notices are on hold" and the screen told him to print four. Same rule,
    // two doors, opposite advice — and this test used to pin the wrong one.
    emailResult = { ok: false, error: HOLD };
    const res = await inviteEveryone(PARK);
    expect(res.sent).toBe(0);
    expect(res.needSlips).toEqual([]);
    expect(res.held.map((h) => h.renterId)).toEqual(["renter-1", "renter-2", "renter-6", "renter-7"]);
    expect(res.held[3]).toEqual({ renterId: "renter-7", displayName: "Household 7", lotNumber: "7" });
    expect(res.message).toBe(
      "0 emailed · 4 held — notices are on hold for this park — " +
      "Held on setup — lift it when the roll is loaded and the leases are executed.",
    );
    expect(res.message).not.toMatch(/slip|didn't work/);
  });

  it("a transport failure is still a slip case, and says so with the sender's reason", async () => {
    emailResult = { ok: false, error: "Resend 503: upstream unavailable" };
    const res = await inviteEveryone(PARK);
    expect(res.held).toEqual([]);
    expect(res.needSlips).toHaveLength(4);
    for (const s of res.needSlips) {
      expect(s.why).toBe("send_failed");
      expect(s.reason).toBe("The email didn't go — Resend 503: upstream unavailable");
    }
    expect(res.message).toBe(
      "0 emailed · 4 need a slip — 4 couldn't be emailed: the email didn't go — Resend 503: upstream unavailable",
    );
  });

  it("keeps 'no email on file' apart from the hold — the one is a slip, the other is not", async () => {
    db.park_renters[0].email = null;
    emailResult = { ok: false, error: HOLD };
    const res = await inviteEveryone(PARK);
    expect(res.needSlips).toEqual([{ renterId: "renter-1", displayName: "Household 1", lotNumber: "1", why: "no_email" }]);
    expect(res.held).toHaveLength(3);
    expect(res.message).toBe(
      "0 emailed · 1 need a slip · 3 held — notices are on hold for this park — " +
      "Held on setup — lift it when the roll is loaded and the leases are executed.",
    );
  });

  it("says nothing about a cause when every send went", async () => {
    const res = await inviteEveryone(PARK);
    expect(res.message).toBe("4 emailed");
    expect(res.held).toEqual([]);
  });
});

describe("the result screen agrees with the door", () => {
  // InviteEveryone.tsx is a client component behind a transition; read as
  // source, comments stripped, and each scan proves it found its subject.
  const screen = readFileSync(fileURLToPath(new URL("../../components/InviteEveryone.tsx", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("prints the slip paragraph only for the slip list, and the hold sentence only for the held list", () => {
    const slipAt = screen.indexOf("need a slip printing");
    expect(slipAt, "the slip paragraph is gone").toBeGreaterThan(0);
    expect(screen.slice(Math.max(0, slipAt - 300), slipAt)).toMatch(/res\.needSlips\.length > 0 && \(/);
    const heldAt = screen.indexOf("Nothing went to these — notices are on hold. Lift the hold in");
    expect(heldAt, "the hold sentence is gone").toBeGreaterThan(0);
    expect(screen.slice(Math.max(0, heldAt - 300), heldAt)).toMatch(/res\.held\.length > 0 && \(/);
    expect(screen.slice(heldAt, heldAt + 400)).toMatch(/Park setup/);
    expect(screen.slice(heldAt, heldAt + 400)).toMatch(/then invite again/);
    expect(screen.slice(heldAt, heldAt + 400)).not.toMatch(/slip/i);
  });

  it("names a door that exists — Park setup is where the hold is lifted", () => {
    const nav = readFileSync(fileURLToPath(new URL("../../components/ParkNav.tsx", import.meta.url)), "utf8");
    expect(nav).toMatch(/href: "\/park\/setup", label: "Park setup"/);
    expect(screen).toMatch(/href="\/park\/setup"/);
  });
});
