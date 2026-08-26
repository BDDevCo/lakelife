import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deliveryState, deliverySummary, planFiling, saysOnlyCourier,
  DELIVERY_STATE_LABEL, DOCUMENT_KIND_LABEL, CHANNEL_LABEL, FORBIDDEN_WORDS,
  MAX_DOC_BYTES, VERSIONED_KINDS, DOCUMENT_KINDS, type DeliveryRow,
} from "./document-helpers";

/**
 * COURIER, NOT WITNESS.
 *
 * The decision this whole feature implements: LakeLife hosts no signature it
 * is not a party to. A lease is between the park and the household; LakeLife
 * administers the billing under it. So the product keeps the FILE and a record
 * of DELIVERY, and never a record of assent.
 *
 * The single most likely future change here is somebody adding "signed"
 * because a screen would look tidier with a green tick, and the entire legal
 * posture turns on it not being there. These tests exist to make that change
 * fail loudly rather than ship.
 */

const row = (o: Partial<DeliveryRow> = {}): DeliveryRow => ({
  parkRenterId: "r1", displayName: "Amberg, Roy",
  channel: null, sentAt: null, openedAt: null, ...o,
});

describe("what state a delivery is in", () => {
  it("is NOT SENT until somebody was given it", () => {
    expect(deliveryState(row())).toBe("not_sent");
    // A channel with no date is not a delivery — it is a half-written row.
    expect(deliveryState(row({ channel: "hand" }))).toBe("not_sent");
  });

  it("stops at HANDED for a channel that cannot report back", () => {
    // The park handed it over and cannot know what happened next. Calling that
    // "sent" invites a reader to wonder why it was never opened.
    expect(deliveryState(row({ channel: "hand", sentAt: "2027-01-01" }))).toBe("handed");
    expect(deliveryState(row({ channel: "post", sentAt: "2027-01-01" }))).toBe("handed");
  });

  it("distinguishes emailed from opened", () => {
    expect(deliveryState(row({ channel: "email", sentAt: "2027-01-01" }))).toBe("sent");
    expect(deliveryState(row({ channel: "email", sentAt: "2027-01-01", openedAt: "2027-01-02" })))
      .toBe("opened");
  });

  it("has a label for every state, and none of them says agreed", () => {
    for (const label of Object.values(DELIVERY_STATE_LABEL)) {
      expect({ label, courier: saysOnlyCourier(label) }).toEqual({ label, courier: true });
    }
  });
});

describe("the line at the top of a document", () => {
  it("says nobody is on a lot rather than dividing by zero", () => {
    expect(deliverySummary([], 0)).toBe(
      "Nobody is on a lot yet, so there is nobody to give this to.",
    );
  });

  it("says plainly when a filed document has gone to nobody", () => {
    const rows = [row({ parkRenterId: "a" }), row({ parkRenterId: "b" })];
    expect(deliverySummary(rows, 2)).toBe(
      "Filed, and nobody has been given it yet — all 2 still to go.",
    );
  });

  it("counts, and NAMES the ones nobody has given it to", () => {
    // "2 not sent" sends him to another screen. The names are the answer.
    const rows = [
      row({ parkRenterId: "a", displayName: "Amberg", channel: "hand", sentAt: "2027-01-01" }),
      row({ parkRenterId: "b", displayName: "Boyle" }),
      row({ parkRenterId: "c", displayName: "Crane" }),
    ];
    const s = deliverySummary(rows, 3);
    expect(s).toContain("Given to 1 of 3");
    expect(s).toContain("not yet: Boyle, Crane");
  });

  it("falls back to a count when there are too many to name", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ parkRenterId: String(i), displayName: `H${i}` }));
    rows[0] = row({ parkRenterId: "0", displayName: "H0", channel: "hand", sentAt: "2027-01-01" });
    expect(deliverySummary(rows, 9)).toContain("8 still to go");
  });

  it("quotes 'opened' only against the copies that could have been opened", () => {
    // Counting handed-over copies in that denominator would make the park look
    // ignored by people who took the document out of his hand.
    const rows = [
      row({ parkRenterId: "a", displayName: "A", channel: "hand", sentAt: "2027-01-01" }),
      row({ parkRenterId: "b", displayName: "B", channel: "email", sentAt: "2027-01-01", openedAt: "2027-01-02" }),
      row({ parkRenterId: "c", displayName: "C", channel: "email", sentAt: "2027-01-01" }),
    ];
    const s = deliverySummary(rows, 3);
    expect(s).toContain("Given to 3 of 3");
    expect(s).toContain("1 of the 2 emailed opened");
    expect(s).not.toContain("of 3 opened");
  });

  it("says so when every emailed copy has been opened", () => {
    const rows = [
      row({ parkRenterId: "a", displayName: "A", channel: "email", sentAt: "2027-01-01", openedAt: "2027-01-02" }),
    ];
    expect(deliverySummary(rows, 1)).toContain("all 1 emailed copy has been opened");
  });

  it("NEVER says agreed, signed or accepted — whatever the shape of the data", () => {
    // The rule, applied to every sentence this function can produce. A
    // rewording that reaches for "19 of 21 accepted" fails here.
    const shapes: [DeliveryRow[], number][] = [
      [[], 0],
      [[row()], 1],
      [[row({ channel: "hand", sentAt: "x" })], 1],
      [[row({ channel: "email", sentAt: "x" })], 1],
      [[row({ channel: "email", sentAt: "x", openedAt: "y" })], 1],
      [[row({ parkRenterId: "a", channel: "post", sentAt: "x" }), row({ parkRenterId: "b" })], 2],
    ];
    for (const [rows, n] of shapes) {
      const s = deliverySummary(rows, n);
      expect({ s, courier: saysOnlyCourier(s) }).toEqual({ s, courier: true });
    }
  });
});

describe("the words this product may not use here", () => {
  it("catches the ones that would change what the record claims", () => {
    expect(saysOnlyCourier("Sent to 21, opened by 14.")).toBe(true);
    for (const w of ["agreed", "signed", "accepted", "consented", "acknowledged"]) {
      expect({ w, ok: saysOnlyCourier(`19 of 21 ${w}.`) }).toEqual({ w, ok: false });
    }
  });

  it("does not trip over a word that merely contains one", () => {
    // "LakeLife doesn't hold signatures" is the sentence that STATES the
    // posture, and a substring match would forbid saying it out loud.
    expect(saysOnlyCourier("LakeLife doesn't hold signatures.")).toBe(true);
    expect(saysOnlyCourier("A designated agent.")).toBe(true);
  });

  it("keeps the list where a human will find it", () => {
    expect(FORBIDDEN_WORDS).toContain("signed");
    expect(FORBIDDEN_WORDS).toContain("agreed");
  });

  it("passes every fixed label the module ships", () => {
    for (const label of [
      ...Object.values(DOCUMENT_KIND_LABEL),
      ...Object.values(CHANNEL_LABEL),
      ...Object.values(DELIVERY_STATE_LABEL),
    ]) {
      expect({ label, courier: saysOnlyCourier(label) }).toEqual({ label, courier: true });
    }
  });
});

describe("filing a document", () => {
  const good = {
    kind: "park_lease", title: "2027 lot lease", version: "2027",
    contentType: "application/pdf", byteSize: 1024,
  };

  it("accepts a lease", () => {
    const p = planFiling(good);
    expect(p.ok).toBe(true);
    expect(p.row).toEqual({ kind: "park_lease", title: "2027 lot lease", version: "2027" });
  });

  it("refuses a kind it does not know", () => {
    expect(planFiling({ ...good, kind: "invoice" }).ok).toBe(false);
  });

  it("will not invent a version", () => {
    // Defaulting to today's date would put OUR label on HIS document, and the
    // version is what he will say out loud when somebody asks which one.
    expect(planFiling({ ...good, version: "  " }).error)
      .toBe("Give it a version — whatever you call this one.");
  });

  it("refuses a file type that is not a document", () => {
    expect(planFiling({ ...good, contentType: "text/csv" }).ok).toBe(false);
    expect(planFiling({ ...good, contentType: "application/pdf" }).ok).toBe(true);
  });

  it("refuses an empty file and one that is too large", () => {
    expect(planFiling({ ...good, byteSize: 0 }).ok).toBe(false);
    expect(planFiling({ ...good, byteSize: MAX_DOC_BYTES + 1 }).ok).toBe(false);
    expect(planFiling({ ...good, byteSize: MAX_DOC_BYTES }).ok).toBe(true);
  });

  it("trims, so a stray space is not a second version", () => {
    expect(planFiling({ ...good, title: "  2027 lot lease  ", version: " 2027 " }).row)
      .toEqual({ kind: "park_lease", title: "2027 lot lease", version: "2027" });
  });
});

// ---------------------------------------------------------------------------

describe("nothing in this feature records assent", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const code = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const MIGRATION = "../../../supabase/migrations/0140_the_file_and_who_was_given_it.sql";

  it("the scanner reads the files it thinks it reads", () => {
    expect(read(MIGRATION)).toContain("park_document_deliveries");
    expect(code("../../components/ParkDocuments.tsx")).toContain("ParkDocuments");
  });

  it("the schema has no column that could hold a signature", () => {
    /**
     * COLUMN NAMES, not prose. The first version searched the whole file for
     * "signature" and failed on the table comment that STATES the posture —
     * "holds no signature for it". A scan that forbids saying the rule out
     * loud is not a test of the rule.
     *
     * This reads the column list out of each CREATE TABLE and applies the same
     * pattern the migration's own post-condition applies to
     * information_schema, so the static check and the database check cannot
     * disagree about what they forbid.
     */
    const sql = read(MIGRATION);
    const ASSENT = /(sign|agree|accept|consent|assent|acknowledg)/;
    const tables = ["park_documents", "park_document_deliveries"];
    for (const t of tables) {
      const at = sql.indexOf(`create table if not exists public.${t} (`);
      expect({ t, found: at > 0 }).toEqual({ t, found: true });
      const body = sql.slice(at, sql.indexOf("\n);", at));
      const columns = body
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("--") && !l.startsWith("constraint")
          && !l.startsWith("check") && !l.startsWith("unique"))
        .map((l) => l.split(/\s+/)[0]);
      expect(columns.length).toBeGreaterThan(3);
      for (const c of columns) {
        expect({ t, c, assent: ASSENT.test(c) }).toEqual({ t, c, assent: false });
      }
    }
  });

  it("the migration REFUSES to apply if one ever appears", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/sign\|agree\|accept\|consent\|assent\|acknowledg/);
    expect(sql).toContain("courier here, not a witness");
  });

  it("opened stays unknowable for a channel that cannot know it", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/check \(opened_at is null or channel = 'email'\)/);
  });

  it("the bucket is private, and the migration refuses if it is not", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/'park-docs', 'park-docs', false/);
    expect(sql).toContain("bucket is PUBLIC");
  });

  it("clients are REVOKED, not merely fenced by RLS", () => {
    // A default grant survives RLS being enabled, and this codebase has been
    // bitten by exactly that.
    const sql = read(MIGRATION);
    expect(sql).toMatch(/revoke all on public\.park_documents\s+from anon, authenticated/);
    expect(sql).toMatch(/revoke all on public\.park_document_deliveries from anon, authenticated/);
  });

  it("the screen offers no control that would mark somebody as agreeing", () => {
    /**
     * EVERY WORD IN FORBIDDEN_WORDS, not a hand-copied four. The first version
     * listed signed/agreed/accepted/Signature, so a pill reading "Consent
     * recorded" or a button "Mark as acknowledged" would have shipped green
     * against a test named for forbidding exactly that.
     *
     * ATTRIBUTE NAMES ARE STRIPPED, VALUES ARE NOT. The file input carries
     * `accept=".pdf,image/*"` — an HTML API name, not something a resident
     * reads — and a naive widening fails on correct code, which is how a guard
     * gets weakened again by the next person. Removing `name=` leaves the
     * value, so a visible `placeholder="..."` is still scanned.
     */
    const ui = code("../../components/ParkDocuments.tsx")
      .replace(/\b[a-zA-Z-]+=/g, "");
    const found = FORBIDDEN_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(ui));
    expect(found).toEqual([]);
  });

  it("that scan would still catch a word hidden in a placeholder", () => {
    // Guards the guard: stripping attribute NAMES must not have stripped the
    // text a resident actually reads.
    const stripped = 'placeholder="Mark as agreed"'.replace(/\b[a-zA-Z-]+=/g, "");
    expect(FORBIDDEN_WORDS.some((w) => new RegExp(`\\b${w}\\b`, "i").test(stripped))).toBe(true);
  });

  it("the delivery link asks for nothing and stamps only the FIRST open", () => {
    const route = code("../../app/doc/[token]/route.ts");
    // A re-read must not rewrite the record of when they first read it.
    expect(route).toMatch(/\.is\("opened_at", null\)/);
    expect(route).toMatch(/delivery\.opened_at == null/);
    // And a failed read must not be reported as a bad link.
    expect(route).toContain("503");
  });

  it("the emailed link says it is a delivery, not a request to agree", () => {
    const act = code("./document-actions.ts");
    expect(act).toContain("isn't a party to it");
  });

  it("a delivery is only logged AFTER the email actually went out", () => {
    /**
     * The row used to be written first, and `sent_at` defaults to now() — so a
     * send that FAILED left a complete, timestamped delivery. The screen then
     * read "Emailed — not opened yet", disabled that household's checkbox, and
     * the unique index refused any second attempt. The household never got the
     * lease and the park's only record said they had.
     *
     * Logging late can only UNDERSTATE, which is the direction this record has
     * to fail in.
     */
    const act = code("./document-actions.ts");
    const send = act.indexOf("await sendEmail(");
    const log = act.indexOf('.from("park_document_deliveries").insert(');
    expect(send).toBeGreaterThan(0);
    expect(log).toBeGreaterThan(0);
    expect(send).toBeLessThan(log);
    // And a failed send must abandon the household, not fall through to it.
    expect(act).toMatch(/nothing was logged, so you can try again/);
  });

  it("a notice does not supersede the last notice", () => {
    // Two notices are two documents, not two versions of one. Superseding on
    // kind alone retired November's rent notice when March's water notice was
    // filed — greyed out, marked replaced, no longer deliverable.
    const act = code("./document-actions.ts");
    expect(act).toMatch(/VERSIONED_KINDS\.includes\(plan\.row\.kind\)/);
  });
});

describe("which kinds have versions at all", () => {
  it("a lease and a rulebook do — a park has one current each", () => {
    expect(VERSIONED_KINDS).toContain("park_lease");
    expect(VERSIONED_KINDS).toContain("park_rules");
    expect(VERSIONED_KINDS).toContain("amenity_rules");
  });

  it("a notice and a one-off do NOT", () => {
    expect(VERSIONED_KINDS).not.toContain("notice");
    expect(VERSIONED_KINDS).not.toContain("other");
  });

  it("names only kinds that exist", () => {
    for (const k of VERSIONED_KINDS) expect(DOCUMENT_KINDS).toContain(k);
  });
});

describe("no migration, ever, gives these tables a column recording assent", () => {
  /**
   * THE STANDING GUARD. 0140's post-condition is a SHIP-TIME assertion — a
   * do-block runs once, in the transaction that applies it, and cannot police
   * `0141_add_signed_at.sql`. Three comments used to describe it as a permanent
   * refusal; they now say what it is, and this is the thing that actually holds.
   *
   * It walks EVERY .sql in the directory, so the migration that has not been
   * written yet is the one it is for.
   */
  const DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

  /** The same alternation 0140 applies to information_schema. */
  const ASSENT = /(sign|agree|accept|consent|assent|acknowledg)/i;
  const TABLES = ["park_documents", "park_document_deliveries"];

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));

  it("reads the whole directory, not one pinned file", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("0140_the_file_and_who_was_given_it.sql");
  });

  /** Column names introduced against either table, across every migration. */
  function columnsIntroduced(): { file: string; column: string }[] {
    const out: { file: string; column: string }[] = [];
    for (const f of files) {
      const sql = readFileSync(`${DIR}/${f}`, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");

      for (const t of TABLES) {
        // create table … ( … )
        const at = sql.indexOf(`create table if not exists public.${t} (`);
        if (at > 0) {
          const body = sql.slice(at, sql.indexOf("\n);", at));
          for (const line of body.split("\n").slice(1)) {
            const l = line.trim();
            if (!l || l.startsWith("constraint") || l.startsWith("check") || l.startsWith("unique")) continue;
            out.push({ file: f, column: l.split(/\s+/)[0] });
          }
        }
        // alter table … add column <name>, and … rename column … to <name>.
        //
        // BOUNDED BY THE SEMICOLON, not by [\s\S]*?. The first version let the
        // gap span the rest of the file, so every `alter table park_documents`
        // re-scanned everything after it — across 140 migrations that took the
        // whole suite from 4.6s to 34s and started timing out unrelated fuzz
        // tests. A statement ends at its semicolon; matching past one would
        // also be wrong, since it could pick up a column from the NEXT
        // statement on a different table.
        for (const m of sql.matchAll(
          new RegExp(`alter table\\s+(?:only\\s+)?public\\.${t}[^;]*?add column(?:\\s+if not exists)?\\s+(\\w+)`, "gi"),
        )) out.push({ file: f, column: m[1] });
        for (const m of sql.matchAll(
          new RegExp(`alter table\\s+(?:only\\s+)?public\\.${t}[^;]*?rename column\\s+\\w+\\s+to\\s+(\\w+)`, "gi"),
        )) out.push({ file: f, column: m[1] });
      }
    }
    return out;
  }

  it("finds the columns it is supposed to be policing", () => {
    // A scanner that matches nothing passes for ever. These are 0140's own.
    const cols = columnsIntroduced().map((c) => c.column);
    expect(cols).toContain("sha256");
    expect(cols).toContain("opened_at");
    expect(cols.length).toBeGreaterThan(15);
  });

  it("finds none that records assent", () => {
    const bad = columnsIntroduced().filter((c) => ASSENT.test(c.column));
    expect(bad).toEqual([]);
  });

  it("uses the same pattern the migration applies to information_schema", () => {
    // If the two drifted, one would forbid what the other allowed.
    const sql = readFileSync(`${DIR}/0140_the_file_and_who_was_given_it.sql`, "utf8");
    expect(sql).toContain(ASSENT.source.replace(/^\(|\)$/g, "").length > 0
      ? "sign|agree|accept|consent|assent|acknowledg"
      : "");
  });
});
