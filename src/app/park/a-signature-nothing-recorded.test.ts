import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE SECOND SIDE OF A TWO-SIDED RECORD, WHICH HAD A WRITER FOR ONLY ONE OF ITS
 * THREE WORDS.
 *
 * 0077 gave a payment three ways to carry the household's own agreement —
 * 'link', 'counterfoil', 'in_person' — and a CHECK that forces a `via` whenever
 * there is a confirmation. Only 'link' was ever written, by the token door that
 * travels in the emailed receipt. `recordPayment` returns no email at all for a
 * household whose contact preference is paper, which is every household the
 * importer creates: at The Haven that is all eighteen, and seventeen of them
 * pay cash or a cheque.
 *
 * The paper path was designed and prints. ParkReceipt says "print both halves,
 * hand one over and get the other signed. That signature is their
 * confirmation." True about the slip, false about the software — nothing wrote
 * the word, so the slip went in a folder and the row stayed unconfirmed.
 *
 * Verified against production: the only database function naming
 * renter_confirmed_* is 0173's immutability guard, and no view reads them. The
 * only reader in src was confirm-server, the door that writes them, checking it
 * had not already written. So the half of the design the repo describes as "one
 * statement from each side, and the ledger only believes both" was recorded and
 * consulted by nobody.
 *
 * WHAT THIS PINS is the office's attestation: that it can record holding a
 * signed slip, that it can NEVER record the household's own act, that money
 * which went back cannot be signed for, and that a confirmation already
 * standing is left exactly as it was.
 */

const PARK = "park-1";
let payments: Array<Record<string, unknown>> = [];
let readError: unknown = null;
let updateError: { message: string } | null = null;
/** Somebody confirmed it between the read and the write: the row the action
 *  read said null, and the filtered UPDATE then matched nothing. Timing alone
 *  cannot stage this — the action's first await happens before any test code
 *  could mutate the row — so the mock has to be told. */
let landsBetween = false;
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== "park_payments") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              readError ? { data: null, error: readError } : { data: payments[0] ?? null, error: null },
          }),
        }),
        update: (row: Record<string, unknown>) => {
          const chain = {
            eq: () => chain,
            // `.is("renter_confirmed_at", null)` — the filter 0173 also applies.
            is: () => ({
              select: async () => {
                if (updateError) return { data: null, error: updateError };
                const open = payments[0] && payments[0].renter_confirmed_at == null && !landsBetween;
                if (!open) return { data: [], error: null };
                updates.push(row);
                return { data: [{ id: payments[0].id }], error: null };
              },
            }),
          };
          return chain;
        },
      };
    },
  }),
}));

vi.mock("./data", () => ({ assertMyPark: async (id: string) => id === PARK }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { recordRenterSignature } = await import("./receipts-actions");

const payment = (over: Record<string, unknown> = {}) => ({
  id: "pay-1", park_id: PARK, receipt_no: 7,
  renter_confirmed_at: null, renter_confirmed_via: null,
  reversed_at: null, returned_at: null, ...over,
});

beforeEach(() => {
  payments = [payment()];
  readError = null;
  updateError = null;
  landsBetween = false;
  updates.length = 0;
});

describe("recording that a household signed for a payment", () => {
  it("writes BOTH stamps together, because the database refuses one without the other", async () => {
    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toMatch(/second side/i);
    expect(updates).toHaveLength(1);
    // 0173: "a how with no confirmation behind it" is refused, and so is a
    // confirmation with no how — the CHECK in 0077 forces the pair.
    expect(updates[0].renter_confirmed_via).toBe("counterfoil");
    expect(typeof updates[0].renter_confirmed_at).toBe("string");
  });

  it("records an in-person agreement with its own word", async () => {
    const res = await recordRenterSignature(PARK, "pay-1", "in_person");

    expect(res.ok, res.error).toBe(true);
    expect(updates[0].renter_confirmed_via).toBe("in_person");
    expect(res.signal).toMatch(/in person/i);
  });

  it("will NOT let the office write the household's own act", async () => {
    // 'link' is the household pressing the link in their own receipt. If the
    // office could write it, a later reader could no longer tell the park's
    // word about a household from the household's — which is the entire
    // reason 0077 made this a vocabulary instead of a boolean.
    const res = await recordRenterSignature(PARK, "pay-1", "link" as "counterfoil");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/isn't a way the office can record/i);
    expect(updates).toEqual([]);
  });

  it("leaves a confirmation the household already made exactly as it was", async () => {
    payments = [payment({ renter_confirmed_at: "2027-01-05T12:00:00Z", renter_confirmed_via: "link" })];

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    // NOT a failure: a row control is a mis-tap away, and 0173 would refuse
    // the write by name — which the office would read as something being
    // wrong with a payment that is already confirmed.
    expect(res.ok).toBe(true);
    expect(res.signal).toMatch(/confirmed that one themselves/i);
    expect(updates, "the household's own word was overwritten").toEqual([]);
  });

  it("says so plainly when it was already signed for at the window", async () => {
    payments = [payment({ renter_confirmed_at: "2027-01-04T17:00:00Z", renter_confirmed_via: "counterfoil" })];

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok).toBe(true);
    expect(res.signal).toMatch(/already recorded as signed for/i);
    expect(updates).toEqual([]);
  });

  it("refuses to sign for money that was taken back", async () => {
    payments = [payment({ reversed_at: "2027-01-06T10:00:00Z" })];

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/taken back, so there's nothing for them to sign for/i);
    expect(updates).toEqual([]);
  });

  it("refuses to sign for money the bank returned", async () => {
    // A reversal says the payment was never real; a return says it was real
    // and then was not. Either way, putting their name to it would be putting
    // their name to money they do not have.
    payments = [payment({ returned_at: "2027-01-09T10:00:00Z" })];

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/returned by the bank/i);
    expect(updates).toEqual([]);
  });

  it("refuses a payment on another park's ledger", async () => {
    payments = [payment({ park_id: "park-2" })];

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("That payment isn't here.");
    expect(updates).toEqual([]);
  });

  it("refuses somebody who does not manage the park", async () => {
    const res = await recordRenterSignature("park-9", "pay-1", "counterfoil");

    expect(res.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it("refuses rather than writing blind when the read fails", async () => {
    readError = { code: "57P01", message: "terminating connection due to administrator command" };

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok, "a dropped read still wrote a confirmation").toBe(false);
    expect(updates).toEqual([]);
  });

  it("reads a confirmation that landed in between as already recorded", async () => {
    // The row read as unconfirmed and the filtered UPDATE then matched nothing,
    // because the household pressed the link in their receipt in between. A
    // filtered UPDATE that matches nothing is NOT an error, so the rows that
    // came back are what decides — and the office must read this as done, not
    // as a failure on a payment that is now confirmed.
    landsBetween = true;

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok).toBe(true);
    expect(res.signal).toMatch(/already recorded as signed for/i);
    expect(updates, "it wrote anyway").toEqual([]);
  });

  it("names the database's own refusal rather than inventing one", async () => {
    updateError = { message: 'park_payments: the household confirmed that payment on 5th January 2027 — their confirmation is theirs, and it is recorded once' };

    const res = await recordRenterSignature(PARK, "pay-1", "counterfoil");

    expect(res.ok).toBe(false);
    // dbSaid lifts 0173's sentence out, so the office is told what the ledger
    // actually said instead of "try again" on something that never will.
    expect(res.error).toMatch(/their confirmation is theirs/i);
  });
});
