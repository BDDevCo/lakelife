import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acceptedFromLatest, latestAct, textFingerprint, ACCEPTANCE_KINDS } from "@/lib/acceptances";
import { TERMS_SECTIONS, termsPlainText, runText } from "@/lib/terms-content";
import { TOS_VERSION } from "@/lib/tos";

/**
 * THE ACCEPTANCE LEDGER.
 *
 * Acceptance used to be two columns on `users`, overwritten in place: one
 * document per person ever, and none of the words. This proves the three things
 * that replaced it — the words have a single source, the ledger cannot be
 * edited, and "is this in force?" is a rule you can read rather than infer.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

function migrationFor(needle: string): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let latest = "";
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS}/${f}`, "utf8");
    if (sql.includes(needle)) latest = sql;
  }
  return latest;
}

describe("the scanner", () => {
  it("reads the files it thinks it reads", () => {
    expect(code("./acceptances.ts")).toContain("recordAcceptance");
    expect(code("./tos-server.ts")).toContain("ensureTos");
    expect(migrationFor("public.acceptances")).toContain("acceptances_no_edit");
  });

  it("strips comments, so prose can never satisfy a test", () => {
    const stripped = code("./tos-server.ts");
    // The doc block explains the OLD columns at length; the code must not use them.
    expect(src("./tos-server.ts")).toContain("tos_version");
    expect(stripped).not.toContain("tos_version");
  });
});

// ---------------------------------------------------------------------------

describe("the words have one source", () => {
  it("every word on screen is in the recorded text, verbatim", () => {
    const text = termsPlainText();
    for (const section of TERMS_SECTIONS) {
      expect(text).toContain(section.heading);
      for (const run of section.body) {
        // Emphasis is presentation and is dropped; the WORDS must survive.
        expect(text).toContain(runText(run));
      }
    }
  });

  it("is deterministic — the same sections give the same string", () => {
    expect(termsPlainText()).toBe(termsPlainText());
    expect(textFingerprint(termsPlainText())).toBe(textFingerprint(termsPlainText()));
  });

  it("carries the substance, not a summary", () => {
    const text = termsPlainText();
    expect(text).toContain("third-party administrator");
    expect(text).toContain("between the homeowner and the crew");
    expect(text).toContain("insurance on file");
  });

  it("TermsBody renders from that source rather than its own copy", () => {
    const body = code("../components/TermsBody.tsx");
    expect(body).toContain("TERMS_SECTIONS");
    // The old version had the prose inline. If it comes back, the record and
    // the screen can drift, which is the entire failure this prevents.
    expect(body).not.toContain("third-party administrator");
  });

  it("the terms page and the modal both go through TermsBody", () => {
    expect(code("../app/terms/page.tsx")).toContain("TermsBody");
    expect(code("../components/TosAgreeModal.tsx")).toContain("TermsBody");
  });
});

describe("the fingerprint", () => {
  it("is a sha256 hex digest", () => {
    expect(textFingerprint("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a single word changes", () => {
    expect(textFingerprint("we verify insurance")).not.toBe(
      textFingerprint("we verify insurances"),
    );
  });

  it("notices whitespace, because the stored text is exact", () => {
    expect(textFingerprint("a b")).not.toBe(textFingerprint("a  b"));
  });
});

// ---------------------------------------------------------------------------

describe("what counts as agreed, right now", () => {
  const V = "tos-v2";

  it("nobody who has never acted has agreed", () => {
    expect(acceptedFromLatest(null, V)).toBe(false);
  });

  it("an acceptance of the current version is in force", () => {
    expect(acceptedFromLatest({ act: "accepted", version: V }, V)).toBe(true);
  });

  it("an acceptance of an older version is not", () => {
    // This is what bumping TOS_VERSION is FOR — everyone gets re-prompted.
    expect(acceptedFromLatest({ act: "accepted", version: "tos-v1" }, V)).toBe(false);
  });

  it("a withdrawal is the latest word, and it wins", () => {
    expect(acceptedFromLatest({ act: "withdrawn", version: V }, V)).toBe(false);
  });

  it("re-accepting after withdrawing puts it back in force", () => {
    // A REAL SEQUENCE. This assertion used to be character-for-character the
    // one above it: it passed a single row to a function that cannot observe
    // history, so it proved nothing about withdrawal at all. The rule lives in
    // the ordering, so the ordering is what has to be exercised.
    const history = [
      { act: "accepted" as const, version: V, occurredAt: "2026-08-01T10:00:00Z" },
      { act: "withdrawn" as const, version: V, occurredAt: "2026-08-02T10:00:00Z" },
      { act: "accepted" as const, version: V, occurredAt: "2026-08-03T10:00:00Z" },
    ];
    expect(acceptedFromLatest(latestAct(history), V)).toBe(true);
    // and the acceptance that was withdrawn is still sitting in the history
    expect(history).toHaveLength(3);
  });

  it("a withdrawal after an acceptance takes it out of force", () => {
    const history = [
      { act: "accepted" as const, version: V, occurredAt: "2026-08-01T10:00:00Z" },
      { act: "withdrawn" as const, version: V, occurredAt: "2026-08-02T10:00:00Z" },
    ];
    expect(acceptedFromLatest(latestAct(history), V)).toBe(false);
  });

  it("picks the newest act whatever order the rows arrive in", () => {
    // The database orders these; latestAct orders them again. If the ORDER BY
    // were ever dropped, this is what still picks the right row.
    const shuffled = [
      { act: "accepted" as const, version: V, occurredAt: "2026-08-01T10:00:00Z" },
      { act: "accepted" as const, version: V, occurredAt: "2026-08-03T10:00:00Z" },
      { act: "withdrawn" as const, version: V, occurredAt: "2026-08-02T10:00:00Z" },
    ];
    expect(latestAct(shuffled)?.occurredAt).toBe("2026-08-03T10:00:00Z");
    expect(latestAct([])).toBeNull();
  });

  it("hasAccepted asks for the whole history, ordered, and re-picks it", () => {
    const mod = code("./acceptances.ts");
    expect(mod).toMatch(/\.order\("occurred_at", \{ ascending: false \}\)/);
    expect(mod).toContain("latestAct(");
    // A .limit(1) here would make latestAct decorative and put the rule back
    // inside the query where nothing can execute it.
    const fn = mod.slice(mod.indexOf("export async function hasAccepted"));
    expect(fn.slice(0, fn.indexOf("acceptedFromLatest"))).not.toContain(".limit(");
  });

  it("treats a null version as its own answer, not as a wildcard", () => {
    expect(acceptedFromLatest({ act: "accepted", version: null }, V)).toBe(false);
    expect(acceptedFromLatest({ act: "accepted", version: V }, null)).toBe(false);
    expect(acceptedFromLatest({ act: "accepted", version: null }, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the ToS gate now runs on the ledger", () => {
  const tos = code("./tos-server.ts");

  it("nothing anywhere still reads or writes the two old columns", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
          const body = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");
          if (/tos_version|tos_accepted_at/.test(body)) hits.push(p);
        }
      }
    };
    walk(fileURLToPath(new URL("..", import.meta.url)));
    expect(hits).toEqual([]);
  });

  it("records the words, from the same source the screen renders", () => {
    expect(tos).toContain("termsPlainText()");
    expect(tos).toContain("recordAcceptance");
  });

  it("asks the ledger whether they have agreed, and ACTS on the answer", () => {
    // `toContain("hasAccepted")` was satisfied by the import line alone —
    // asking is not obeying, and this repo has been caught by that before.
    // Pin the shape: the answer is what returns "ok".
    expect(tos).toMatch(/if \(await hasAccepted\(\{ userId \}, "tos", TOS_VERSION\)\) return "ok";/);
  });

  it("does not treat an unrecorded acceptance as a recorded one", () => {
    // The caller's next move is the thing the acceptance gates. If the write
    // failed, saying "ok" lets a booking through on an agreement nobody has.
    expect(tos).toMatch(/if \(!res\.ok\) return "failed"/);
  });

  it("and a failed write is DISTINGUISHABLE from never having agreed", () => {
    // Both used to return "needs", which makes the booking screen reopen the
    // agree modal — right the first time, a trap the second: tap "I agree",
    // the insert fails again, the same modal returns, nothing ever says why.
    expect(tos).toContain('"ok" | "needs" | "failed"');
    // and every door that gates on it reports the difference
    for (const rel of [
      "../app/book/actions.ts",
      "../app/book/storage/actions.ts",
      "../app/vendor/onboarding-actions.ts",
    ]) {
      expect(code(rel)).toMatch(/tos === "failed"/);
    }
  });

  it("both acceptance doors go through one writer", () => {
    // The grandfathered-crew card used to write the columns itself, recording
    // an acceptance with none of the words.
    const portal = code("../app/portal/tos-actions.ts");
    expect(portal).toContain("ensureTos");
    expect(portal).not.toMatch(/from\("users"\)/);
  });

  it("the engine is not itself a server action", () => {
    // Checked on the STRIPPED source: the module's own doc block explains at
    // length why it must not be a "use server" file, and a raw-text search
    // matches that explanation instead of the directive.
    const mod = code("./acceptances.ts");
    expect(src("./acceptances.ts").split("\n")[0]).toContain('import "server-only"');
    expect(mod).not.toContain('"use server"');
    expect(mod).toContain('import "server-only"');
  });
});

// ---------------------------------------------------------------------------

describe("the table refuses what it must", () => {
  const sql = migrationFor("public.acceptances");

  it("is append-only by trigger, not by hope", () => {
    expect(sql).toMatch(/before update or delete on public\.acceptances/i);
    expect(sql).toMatch(/raise exception 'acceptances is append-only/i);
  });

  it("has no foreign key on the person, so evidence outlives the account", () => {
    const table = sql.slice(sql.indexOf("create table"), sql.indexOf("comment on table"));
    expect(table).toMatch(/user_id\s+uuid,/);
    expect(table).not.toMatch(/user_id\s+uuid[^,]*references/i);
    expect(table).not.toMatch(/park_renter_id\s+uuid[^,]*references/i);
  });

  it("lets a renter be the subject without a login", () => {
    expect(sql).toContain("park_renter_id");
    expect(sql).toMatch(/\(user_id is not null\) <> \(park_renter_id is not null\)/);
  });

  it("makes a live row carry its words", () => {
    expect(sql).toContain("acceptances_live_rows_carry_their_words");
    expect(sql).toMatch(/document_text is not null/);
    expect(sql).toMatch(/text_sha256 is not null/);
  });

  it("does not let a migrated row pretend to know the words", () => {
    // The pre-ledger columns never stored any text. Filling it with today's
    // terms would assert that four people read wording that may not have
    // existed when they tapped.
    expect(sql).toContain("migrated_pre_ledger");
    expect(sql).toMatch(/migrated rows claim to carry text that was never stored/);
  });

  it("hands anon nothing at all", () => {
    expect(sql).toMatch(/revoke all on public\.acceptances from anon/);
    expect(sql).toMatch(/anon still holds % grants on acceptances/);
  });

  it("lets a person read their own", () => {
    expect(sql).toMatch(/user_id = auth\.uid\(\)/);
  });

  it("proves the backfill lost nobody", () => {
    expect(sql).toMatch(/backfill lost somebody/);
  });
});

describe("the kinds the ledger accepts", () => {
  const sql = migrationFor("public.acceptances");

  it("the TypeScript list and the database check agree", () => {
    // READ THE CONSTRAINT, NOT THE FILE. Searching the whole migration for
    // `'tos'` passes on three unrelated hits — the backfill's SELECT list and
    // its NOT EXISTS clause both contain it — so deleting 'tos' from the CHECK
    // left this green while every ToS acceptance would fail on a fresh build
    // with a 23514.
    const check = sql.slice(
      sql.indexOf("document_kind    text not null"),
      sql.indexOf("document_version text"),
    );
    expect(check).toContain("check (document_kind in");
    for (const kind of ACCEPTANCE_KINDS) {
      expect(check).toContain(`'${kind}'`);
    }
    // And nothing the database allows that the TypeScript cannot produce.
    const allowed = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...allowed].sort()).toEqual([...ACCEPTANCE_KINDS].sort());
  });

  it("that slice really is only the constraint", () => {
    // Guards the guard: if the column declaration is reformatted, the slice
    // could silently widen back to the whole file.
    const check = sql.slice(
      sql.indexOf("document_kind    text not null"),
      sql.indexOf("document_version text"),
    );
    expect(check.length).toBeLessThan(300);
    expect(check).not.toContain("insert into");
  });

  it("covers the documents the four roles actually need", () => {
    expect(ACCEPTANCE_KINDS).toContain("tos");
    expect(ACCEPTANCE_KINDS).toContain("park_rules");
    expect(ACCEPTANCE_KINDS).toContain("park_lease");
  });

  it("the current ToS version is a real, non-empty string", () => {
    expect(TOS_VERSION.trim().length).toBeGreaterThan(0);
  });
});
