import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * MONEY THAT COULD LEAVE WITHOUT ANYBODY DECIDING IT SHOULD.
 *
 * Three findings from the season simulation, all on the park amenity — the
 * boat the park rents out. They share a shape: a screen showed the CURRENT
 * state and treated money as something that stops mattering when the day is
 * over.
 *
 *  1. A guest could use the boat all day and then give the day back. The
 *     cancel had no date condition at all — only status='booked' — and the
 *     owner's view reads .neq("status","cancelled"), so the booking and the
 *     amount quoted against it left his screen together.
 *
 *  2. Uncollected money vanished at midnight. The owner's list filtered
 *     `h.to > today`, so a day on the water that was never paid for was gone
 *     by breakfast, from the only surface that mentioned it.
 *
 *  3. An amenity payment could never be taken back. collectAmenityMoney writes
 *     kind:'amenity' with NO charge_id; the statement lists payments by
 *     charge_id and Held money lists kind='rent', so it appeared on neither.
 *     $150 typed against the wrong day was permanent on every screen.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("a day she has used is not hers to give back", () => {
  it("cancelDayByToken refuses a day that has started", () => {
    const s = src("./amenity-guest-server.ts");
    const at = s.indexOf("export async function cancelDayByToken");
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 3000);
    // It must read the day before deciding, and compare against lake-local today.
    expect(body).toMatch(/select\("id, during"\)/);
    expect(body).toMatch(/todayLakeDate\(\)/);
    expect(body).toMatch(/when\.start <= today/);
    // And it must not simply fail silently — she gets told where to go.
    expect(body).toMatch(/ring the office/);
  });

  it("tomorrow is still one tap — the feature still works", () => {
    // The guard must be on days that have STARTED, not on cancelling at all.
    const s = src("./amenity-guest-server.ts");
    expect(s).toMatch(/Given back\. Somebody else can have it now\./);
  });
});

describe("uncollected money outlives its date", () => {
  it("the owner's list keeps a past day that still owes", () => {
    const s = src("../components/ParkAmenities.tsx");
    expect(s, "a bare `h.to > today` is how the money disappeared").toMatch(
      /h\.to > today \|\| \(h\.quotedAmount \?\? 0\) - h\.collected > 0\.005/,
    );
  });

  it("and says so, rather than mixing it silently into the list", () => {
    const s = src("../components/ParkAmenities.tsx");
    expect(s).toMatch(/owedFromPast/);
    expect(s).toMatch(/been and gone with money still owed/);
  });

  it("the empty state stops claiming only the future was checked", () => {
    const s = src("../components/ParkAmenities.tsx");
    expect(s).toMatch(/Nothing booked from today on, and nothing owed from before\./);
  });
});

describe("an amenity payment can be taken back", () => {
  it("the payments themselves reach the screen, not just their sum", () => {
    const s = src("../app/park/amenity-actions.ts");
    expect(s).toMatch(/payments: Array<\{ id: string; amount: number; method: string; on: string \}>/);
    expect(s).toMatch(/paymentsByBooking/);
    // The read has to carry the id, or nothing can be reversed.
    expect(s).toMatch(/select\("id, amenity_booking_id, amount, method, received_on, reversed_at"\)/);
  });

  it("a reversed payment is still excluded from what was collected", () => {
    // The pre-existing rule: a bounced payment is not money.
    const s = src("../app/park/amenity-actions.ts");
    expect(s).toMatch(/if \(p\.reversed_at\) continue;/);
  });

  it("the control exists, and asks why", () => {
    const s = src("../components/ParkAmenities.tsx");
    expect(s).toMatch(/reversePayment\(parkId, p\.id, why\)/);
    expect(s).toMatch(/Take it back/);
    // reversePayment refuses an empty reason; the screen must not send one.
    expect(s).toMatch(/if \(why == null \|\| !why\.trim\(\)\) return;/);
  });
});

/**
 * FOUR MORE FROM THE SAME SIMULATION, ALL ON THE SAME FEATURE.
 *
 * Each one is a screen telling somebody something that isn't true: that her
 * booking failed, that she owes an amount nobody adds up, that she has a boat
 * called something it isn't, and that she paid in a way she didn't.
 */
describe("re-tapping a day she already has", () => {
  it("is answered as done, not as a refusal", () => {
    const s = src("./amenity-guest-server.ts");
    const at = s.indexOf("export async function bookDayByToken");
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 3000);
    // The `mine` branch has to come BEFORE the generic closed-day refusal, or
    // it never runs — that ordering is the whole fix.
    const mineAt = body.indexOf("state.mine");
    const refuseAt = body.indexOf("return { ok: false, error: state.why }");
    expect(mineAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeGreaterThan(-1);
    expect(mineAt).toBeLessThan(refuseAt);
    expect(body).toMatch(/is already yours on/);
  });

  it("a day somebody ELSE has is still refused", () => {
    const s = src("./amenity-guest-server.ts");
    expect(s).toMatch(/return \{ ok: false, error: state\.why \}/);
  });
});

describe("what she owes at the office window", () => {
  it("the guest page sums her days instead of leaving her to", () => {
    const s = src("../app/use/[token]/route.ts");
    expect(s).toMatch(/view\.mine\.reduce/);
    expect(s).toMatch(/to pay at the office/);
  });

  it("days included with the stay are not counted as money", () => {
    // A null amount means "included", and adding it as zero would be harmless
    // arithmetic and a misleading sentence — "0 to pay" on a free day.
    const s = src("../app/use/[token]/route.ts");
    expect(s).toMatch(/m\.amount \?\? 0/);
    expect(s).toMatch(/included with your stay/);
  });
});

describe("renaming the boat renames what she is holding", () => {
  it("saveAmenity relabels the auto-made unit", () => {
    const s = src("../app/park/amenity-actions.ts");
    const at = s.indexOf("export async function saveAmenity");
    const body = s.slice(at, s.indexOf("export async function", at + 10));
    expect(body).toMatch(/from\("park_amenity_units"\)\s*\n?\s*\.update\(\{ label: name \}\)/);
  });

  it("but ONLY the one that still carries the old name", () => {
    // "Kayak A" was named by him. Renaming the amenity must not overwrite it,
    // and matching on the old name is what tells the two apart.
    const s = src("../app/park/amenity-actions.ts");
    const at = s.indexOf("export async function saveAmenity");
    const body = s.slice(at, s.indexOf("export async function", at + 10));
    expect(body).toMatch(/\.eq\("label", wasName\)/);
    // The old name has to be read BEFORE the update, or there is nothing left
    // to compare against.
    expect(body.indexOf("const wasName")).toBeLessThan(body.indexOf('.update(row)'));
  });

  it("a failed relabel does not fail the rename", () => {
    const s = src("../app/park/amenity-actions.ts");
    expect(s).toMatch(/renamed the amenity but not its unit/);
  });
});

describe("how they paid is recorded, not assumed", () => {
  it("the collect button no longer hardcodes cash", () => {
    const s = src("../components/ParkAmenities.tsx");
    expect(s).not.toMatch(/collectAmenityMoney\([^)]*"cash"\)/);
    expect(s).toMatch(/payMethod\[h\.id\] \?\? "cash"/);
  });

  it("offers every method the action accepts", () => {
    const ui = src("../components/ParkAmenities.tsx");
    const action = src("../app/park/amenity-actions.ts");
    const accepted = action.match(/\["cash", "check", "card", "transfer", "other"\]/);
    expect(accepted).not.toBeNull();
    for (const m of ["cash", "check", "card", "transfer", "other"]) {
      expect(ui, `the picker is missing ${m}, which the action accepts`).toContain(`value="${m}"`);
    }
  });
});

describe("what the guest still owes is not what she was quoted", () => {
  it("the guest total nets off what the office already took", () => {
    // The first version of this total summed `amount` alone, so a day she had
    // already paid for at the window still counted toward "to pay at the
    // office" — a bigger number than she owes, which is worse than the missing
    // total it replaced. Money lives in park_payments keyed by
    // amenity_booking_id; the booking's own status never changes when it is
    // paid (0119 allows only booked/cancelled/blackout).
    const route = src("../app/use/[token]/route.ts");
    expect(route).toMatch(/\(m\.amount \?\? 0\) - m\.paid/);
    expect(route).toMatch(/already paid/);
  });

  it("the loader reads what was paid, and refuses to guess it", () => {
    const s = src("./amenity-guest-server.ts");
    expect(s).toMatch(/from\("park_payments"\)/);
    expect(s).toMatch(/mustRead\(\s*\n?\s*"what you've already settled"/);
    expect(s).toMatch(/\.in\("amenity_booking_id", myBookingIds\)/);
  });

  it("a reversed payment is owed again", () => {
    // A bounced cheque coming back must not leave her marked as settled.
    const s = src("./amenity-guest-server.ts");
    expect(s).toMatch(/if \(p\.reversed_at != null\) continue;/);
  });
});

describe("no crew is sent to a screen their role cannot open", () => {
  // VendorNav has no Messages tab, and /messages resolves the thread from the
  // signed-in user's own property and refuses anyone who is not its owner. Two
  // crew-facing strings told them to carry on there anyway.
  it("the crew's dispute replies don't name Messages", () => {
    for (const f of ["../app/d/[token]/talk/route.ts", "../components/VendorJobPanel.tsx"]) {
      expect(src(f), `${f} still sends a crew to Messages`).not.toMatch(/in Messages|Messages in your portal/);
    }
  });

  it("the customer's ones still do — they have that tab", () => {
    // Guard on the carve-out, so a future sweep does not strip the true one.
    expect(src("../app/c/[token]/issue/route.ts")).toMatch(/Messages in your portal/);
  });
});

describe("what actually lifts a held payout", () => {
  it("no crew screen claims that finishing the fix releases it", () => {
    // settleJob returns before the payout block for a correction job, so
    // completing it touches no payout row. The hold lifts on the customer's
    // acceptance, or on the nightly quiet-close.
    for (const f of ["../app/vendor/jobs/[id]/page.tsx", "../app/d/[token]/fix/route.ts"]) {
      const code = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, `${f} still says finishing releases the hold`).not.toMatch(/releases the hold|pay releases once it's done/);
    }
  });

  it("and both name the two things that actually do", () => {
    for (const f of ["../app/vendor/jobs/[id]/page.tsx", "../app/d/[token]/fix/route.ts"]) {
      const s = src(f);
      expect(s, `${f} does not mention the customer accepting`).toMatch(/accept/i);
      expect(s, `${f} does not mention the quiet-close`).toMatch(/three days/i);
    }
  });

  it("three days is what the code actually waits", () => {
    const d = src("./disputes.ts");
    expect(d).toMatch(/const CORRECTION_QUIET_DAYS = 3;/);
  });
});
