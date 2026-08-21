import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE RULES SHE ACTUALLY READ.
 *
 * `amenity_bookings.acknowledged_at` said a guest ticked the park's rules. The
 * rules were never stored — they live on `park_amenities.rules`, which the
 * owner edits whenever he likes, so every past acknowledgement silently
 * re-pointed at wording nobody was shown. The same row already snapshots
 * `quoted_amount` for exactly this reason.
 *
 * It matters more than a usual snapshot because these are NOT LakeLife's
 * rules. Holding a timestamp that asserts "she agreed", while being unable to
 * produce what she agreed to, is a record that reads as evidence and is not —
 * about a third party's terms.
 */

const root = join(__dirname, "..", "..");
const MIGRATIONS = join(root, "supabase", "migrations");

const code = (p: string) =>
  readFileSync(join(root, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const GUEST = "src/lib/amenity-guest-server.ts";

/** The newest migration that touches the column wins. */
function migrationFor(needle: string): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let latest = "";
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (sql.includes(needle)) latest = sql;
  }
  return latest;
}

describe("the scanner", () => {
  it("reads the guest booking module", () => {
    expect(code(GUEST)).toContain("bookDayByToken");
  });
  it("finds the migration that adds the column", () => {
    expect(migrationFor("amenity_bookings_ack_has_words")).toContain("rules_text");
  });
});

describe("the words are snapshotted beside the timestamp", () => {
  const src = code(GUEST);

  it("the booking stores the rules text", () => {
    expect(src).toContain("rules_text: offer.rules ?? null");
  });

  it("it snapshots what THIS request rendered, not a fresh read", () => {
    // bookDayByToken and the guest page both come from loadGuestView, so
    // offer.rules is by construction the text that was on her screen. A second
    // read of park_amenities could return words she never saw.
    expect(src).toContain("offer.rules");
    const insert = src.slice(src.indexOf('from("amenity_bookings").insert('));
    const body = insert.slice(0, insert.indexOf("});"));
    expect(body).not.toMatch(/park_amenities/);
  });

  it("does not claim she acknowledged rules that did not exist", () => {
    // The guest page prints the rules only `if (o.rules)`. With none, she saw
    // a bare button, and stamping the acknowledgement asserts she agreed to
    // nothing at all.
    expect(src).toContain("acknowledged_at: offer.rules ? new Date().toISOString() : null");
  });

  it("the guest page renders the same field it snapshots", () => {
    const page = readFileSync(join(root, "src/app/use/[token]/route.ts"), "utf8");
    expect(page).toContain("o.rules");
  });
});

describe("the database refuses the mismatched pair", () => {
  const sql = migrationFor("amenity_bookings_ack_has_words");

  it("ties acknowledged_at and rules_text together", () => {
    expect(sql).toMatch(
      /check\s*\(\(acknowledged_at is null\) = \(rules_text is null\)\)/i,
    );
  });

  it("does not try to prove itself with an insert a trigger would refuse first", () => {
    // The obvious probe — insert an acknowledged row with no words — is
    // satisfied by `amenity_booking_fits` raising on the fake unit id, so it
    // would pass on a database where the constraint was never added.
    expect(sql).not.toMatch(/insert into public\.amenity_bookings/i);
    expect(sql).toContain("pg_get_constraintdef");
  });
});

describe("the paths where nobody ticked anything", () => {
  const owner = code("src/app/park/amenity-actions.ts");

  it("an owner booking on a resident's behalf acknowledges nothing", () => {
    // She tapped no button, so there is nothing to record. Two inserts live
    // here — a blackout and an on-behalf booking — and neither may stamp it.
    expect(owner).not.toContain("acknowledged_at");
  });
});
