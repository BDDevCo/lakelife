import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE SLIP SAYS "Lot 14". The form's lot box was trimmed and handed to the
 * database as typed, and `claim_park_file` matches `lot_number` exactly — so
 * a resident typing the lot the way her slip prints it was refused with
 * claim_no_open_lot, logged against nobody.
 *
 * AND THE PARK'S OWN SPELLING IS NOT ALWAYS BARE. The importer stores "14",
 * but `addLots` stores "LOT22", and a lot typed by hand is stored as typed —
 * so a door that only strips the word would turn the stored "LOT22" into a
 * "22" the RPC cannot find. The door now reads the park's lots and sends the
 * park's OWN spelling of the one she means: whole label first, then the same
 * label with the word, "#" and spaces gone. When nothing matches — or the
 * read fails — the stripped form goes through and the RPC's own answer stands.
 *
 * The real action, with the RPC replaced by a spy that records what reached
 * it, and the two tables it reads first replaced by a fake it can be pointed
 * at.
 */
const rpc = vi.fn(async () => ({ data: "claimed", error: null }));

type Row = Record<string, unknown>;
const db: { parks: Row[]; park_lots: Row[]; lotsReadFails: boolean } = {
  parks: [], park_lots: [], lotsReadFails: false,
};
class FakeQ {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  ilike(c: string, v: string) { this.fs.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()); return this; }
  private rows() { return (db[this.t as "parks" | "park_lots"] ?? []).filter((r) => this.fs.every((f) => f(r))); }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    const res = this.t === "park_lots" && db.lotsReadFails
      ? { data: null, error: { message: "boom" } }
      : { data: this.rows(), error: null };
    return Promise.resolve(res).then(ok, bad);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
  createServiceClient: () => ({ from: (t: string) => new FakeQ(t) }),
}));

const { claimMyFile } = await import("./claim-actions");

const HAVEN = { id: "park-haven", slug: "the-haven", name: "The Haven" };
function lots(...labels: string[]) {
  db.park_lots = labels.map((lot_number) => ({ park_id: HAVEN.id, lot_number }));
}

beforeEach(() => {
  rpc.mockClear();
  db.parks = [HAVEN];
  db.lotsReadFails = false;
  lots("1", "2", "14", "14A", "22");
});

/** What the RPC was handed as the lot. */
function lotSent(): string {
  const call = rpc.mock.calls[0] as unknown as [string, { p_lot_number: string }] | undefined;
  if (!call) throw new Error("the RPC was never called");
  return call[1].p_lot_number;
}

async function claim(lotNumber: string) {
  return claimMyFile({ parkSlug: "The Haven", lotNumber, code: "ABCD-EFGH" });
}

describe("the lot as it is printed on the slip", () => {
  it.each([
    ["Lot 14", "14"], ["lot 14", "14"], ["LOT14", "14"], ["Lot #14", "14"], ["Lot. 14", "14"],
    ["Site 14", "14"], ["Space 14", "14"], ["#14", "14"], [" 14 ", "14"], ["14", "14"], ["14A", "14A"],
    ["lot 14a", "14A"], ["Lot 14 A", "14A"],
  ])("%j reaches the database as the park's own %j", async (typed, expected) => {
    const res = await claim(typed);
    expect(res.ok).toBe(true);
    expect(lotSent()).toBe(expected);
  });

  it("does not strip a word that is not a lot word", async () => {
    await claim("Lotus");
    expect(lotSent()).toBe("Lotus");
  });

  it("an empty lot is still refused before the database is asked", async () => {
    for (const typed of ["", "   ", "#"]) {
      const res = await claim(typed);
      expect(res.ok, JSON.stringify(typed)).toBe(false);
      expect(res.outcome, JSON.stringify(typed)).toBe("claim_no_open_lot");
      expect(rpc).not.toHaveBeenCalled();
    }
  });
});

describe("the park's own spelling of the lot is what reaches the database", () => {
  it("a lot addLots stored as LOT22 is found from any spelling of it — including the slip's own 'Lot LOT22'", async () => {
    lots("1", "LOT22", "LOT23");
    for (const typed of ["LOT22", "Lot 22", "22", "lot22", "Lot LOT22", "#22"]) {
      rpc.mockClear();
      await claim(typed);
      expect(lotSent(), typed).toBe("LOT22");
    }
  });

  it("a lot made by hand keeps its own case", async () => {
    lots("14a", "7");
    await claim("Lot 14A");
    expect(lotSent()).toBe("14a");
  });

  it("the whole label wins over the stripped one when a park has both", async () => {
    lots("22", "LOT22");
    await claim("22");
    expect(lotSent()).toBe("22");
    rpc.mockClear();
    await claim("LOT22");
    expect(lotSent()).toBe("LOT22");
    // Neither whole: two lots reduce to the same key, and the door will not
    // pick one — the stripped form goes through and the RPC answers.
    rpc.mockClear();
    await claim("Lot 22");
    expect(lotSent()).toBe("22");
  });

  it("a lot the park does not have goes through stripped, so the RPC's own answer stands", async () => {
    await claim("Lot 99");
    expect(lotSent()).toBe("99");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("a failed read of the lots is not an empty one — the door still tries, stripped", async () => {
    lots("LOT22");
    db.lotsReadFails = true;
    const res = await claim("Lot 22");
    expect(res.ok).toBe(true);
    expect(lotSent()).toBe("22");
  });

  it("a park the door cannot find still reaches the RPC with the stripped lot", async () => {
    db.parks = [];
    await claim("Lot 14");
    expect(lotSent()).toBe("14");
  });
});
