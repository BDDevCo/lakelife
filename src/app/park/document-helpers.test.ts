import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deliveryState, deliverySummary, planFiling, saysOnlyCourier,
  DELIVERY_STATE_LABEL, DOCUMENT_KIND_LABEL, CHANNEL_LABEL, FORBIDDEN_WORDS,
  MAX_DOC_BYTES, type DeliveryRow,
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
    const ui = code("../../components/ParkDocuments.tsx");
    for (const w of ["signed", "agreed", "accepted", "Signature"]) {
      expect({ w, present: ui.includes(w) }).toEqual({ w, present: false });
    }
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
});
