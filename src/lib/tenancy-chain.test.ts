import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainReservationIds } from "./tenancy-chain";

/**
 * A RENEWAL HID EVERY BILL SHE STILL OWED.
 *
 * Confirmed 3/3 and worse than claimed: the owner may write the next agreement
 * up to 45 days early (renewalsDue), and until that agreement's first bill is
 * raised the successor row has ZERO charges — so bill=null, and RenterHome
 * rendered "Nothing to pay right now — your next bill hasn't been sent yet"
 * while her current month sat open under the previous row. No Pay button, no
 * "I already paid" form. The office's Today screen reads by park and kept
 * chasing her. A money screen lying, on the Jan 1 path.
 */
describe("bills follow a resident across a renewal", () => {
  const A = { id: "res-A", renter_id: "file-haven" };
  const B = { id: "res-B", renter_id: "file-haven" };   // the renewal
  const X = { id: "res-X", renter_id: "file-elsewhere" }; // a file at another park

  it("includes the previous agreement's row, not just the newest", () => {
    // The defect: only `stay.id` (B) was read, so A's bills vanished.
    expect(chainReservationIds([B, A], B)).toEqual(["res-B", "res-A"]);
  });

  it("does not pull in a different park's file", () => {
    // A renter file is per park; this is one park's screen.
    expect(chainReservationIds([B, A, X], B)).not.toContain("res-X");
  });

  it("always includes the current row", () => {
    expect(chainReservationIds([], B)).toEqual(["res-B"]);
  });

  it("is what the resident's loader actually queries by", () => {
    const src = readFileSync(fileURLToPath(new URL("../app/parks/my-data.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The charges read was `.eq("reservation_id", stay.id)` — one row.
    expect(src, "park_charges is still read by a single reservation id")
      .not.toMatch(/from\("park_charges"\)[\s\S]{0,200}\.eq\("reservation_id",\s*stay\.id/);
    expect(src).toMatch(/\.in\("reservation_id",\s*chainReservationIds\(/);
  });
});
