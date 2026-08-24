import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyStanding, type AgreementLine } from "@/app/agreements/data";
import type { AcceptanceKind } from "@/lib/acceptances";

/**
 * THE RECORD KEPT FOR A DISPUTE, SHOWN TO THE PERSON IT IS ABOUT.
 *
 * 0139 has snapshotted the exact words of every acceptance since it shipped and
 * nothing read them back — `document_text` was written by one function and
 * consumed by none. Snapshotting the words instead of a version string was done
 * so somebody could be shown, later, precisely what was on their screen, and
 * that only happens if there is a screen.
 *
 * The same was true of `park_renters.sms_consent_text`: 0133 stored the exact
 * sentence at the moment of the tap, and its own audit noted the column had no
 * reader anywhere in the tree.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the scanner", () => {
  it("reads the files it thinks it reads", () => {
    expect(code("../app/agreements/data.ts")).toContain("myAgreements");
    expect(code("../components/MyAgreements.tsx")).toContain("MyAgreements");
  });
});

describe("the columns that had no reader now have one", () => {
  const data = code("../app/agreements/data.ts");

  it("reads the acceptance ledger through its own helper", () => {
    expect(data).toContain("acceptancesFor(");
    // Not a second query shape of its own — one reader, one place.
    expect(data).not.toMatch(/from\("acceptances"\)/);
  });

  it("carries the snapshotted words all the way to the view", () => {
    expect(data).toMatch(/text:\s*r\.text/);
    expect(code("../components/MyAgreements.tsx")).toContain("line.text");
  });

  it("reads the SMS consent sentence 0133 stored for exactly this", () => {
    expect(data).toContain("sms_consent_text");
    expect(code("../components/MyAgreements.tsx")).toContain("c.sentence");
  });

  it("takes identity from the session, never from a parameter", () => {
    expect(data).toContain("supabase.auth.getUser()");
    expect(data).toMatch(/export async function myAgreements\(\): Promise/);
  });

  it("does not swallow a failed read into an empty list", () => {
    // "You have never agreed to anything" is a strong thing to tell somebody
    // who has, on the one screen that exists to be trusted about what is on
    // file.
    expect(data).toContain("mustRead(");
  });
});

describe("the honest states", () => {
  const view = code("../components/MyAgreements.tsx");

  it("says so when the wording was never captured", () => {
    // The four rows migrated from the old two columns. Rendering them as if
    // the text were merely collapsed would be the lie `provenance` prevents.
    expect(view).toContain("wordsWereKept");
    expect(src("../components/MyAgreements.tsx")).toMatch(
      /not the wording|before we started keeping the words/,
    );
  });

  it("keeps a withdrawn agreement on the page", () => {
    // The acceptance is not deleted when somebody walks away from it, and
    // hiding it here would undo the whole append-only design.
    expect(view).toMatch(/act === "withdrawn"/);
    expect(src("../components/MyAgreements.tsx")).toMatch(/Withdrawn/);
  });

  it("does not filter anything out of the list", () => {
    // Any .filter() here is a row somebody agreed to that they cannot see.
    const render = view.slice(view.indexOf("export function MyAgreements"));
    expect(render).not.toMatch(/\.filter\(/);
  });

  it("the quiet state says what it looked for", () => {
    const empty = src("../components/MyAgreements.tsx");
    expect(empty).toMatch(/Nothing on file yet/);
    expect(empty).toMatch(/We looked for/);
  });

  it("shows the words verbatim rather than a summary", () => {
    expect(view).toContain("<pre");
    expect(view).toMatch(/whiteSpace: "pre-wrap"/);
  });

  it("writes dates a person reads", () => {
    // "21 August 2026", never 2026-08-21 — the house rule.
    expect(view).toContain("prettyDay");
    expect(view).toMatch(/toLocaleDateString/);
  });
});

describe("every role can find it", () => {
  const LINKS: Array<[string, string]> = [
    ["homeowner", "../app/profile/page.tsx"],
    ["crew", "../app/vendor/page.tsx"],
    ["park owner", "../app/park/setup/page.tsx"],
    ["renter", "../components/RenterHome.tsx"],
  ];

  for (const [role, rel] of LINKS) {
    it(`the ${role} has a way in`, () => {
      expect(code(rel)).toContain('href="/agreements"');
    });
  }

  it("and the route they are pointed at exists", () => {
    const files = readdirSync(
      fileURLToPath(new URL("../app/agreements", import.meta.url)),
    );
    expect(files).toContain("page.tsx");
    expect(files).toContain("data.ts");
  });

  it("the page is role-agnostic — it never branches on who is looking", () => {
    // One screen for four roles; a branch here is four wordings of the same
    // rows waiting to drift apart.
    const page = code("../app/agreements/page.tsx");
    for (const role of ["vendor", "park_member", "renter", "homeowner", "role"]) {
      expect(page).not.toContain(role);
    }
  });
});

describe("every row states where it stands", () => {
  const data = code("../app/agreements/data.ts");
  const view = code("../components/MyAgreements.tsx");

  /**
   * RUN THE RULE, do not scan for it.
   *
   * Every assertion here used to be a string search of data.ts — does it
   * contain "seenAccepted", does it contain a for-loop. Nothing evaluated the
   * logic, so inverting the version comparison, swapping the in_force and
   * replaced labels, or deleting a `continue` all left the suite green. That
   * is how the missing-badge defect shipped in the first place.
   */
  const row = (
    kind: AcceptanceKind,
    version: string | null,
    act: "accepted" | "withdrawn",
    occurredAt: string,
  ): AgreementLine => ({
    id: `${kind}-${version}-${act}-${occurredAt}`,
    kind, label: kind, version, occurredAt, act,
    text: "words", wordsWereKept: true, standing: "out_of_date",
  });

  /** Newest first, exactly as acceptancesFor returns them. */
  const standings = (rows: AgreementLine[], v = "tos-v3") =>
    applyStanding(rows, v).map((r) => r.standing);

  it("a single current acceptance is in force", () => {
    expect(standings([row("tos", "tos-v3", "accepted", "2026-08-03")]))
      .toEqual(["in_force"]);
  });

  it("an older version with no newer acceptance is OUT OF DATE, not replaced", () => {
    // The state that predicts something: they will meet the agree screen.
    expect(standings([row("tos", "tos-v1", "accepted", "2026-08-01")]))
      .toEqual(["out_of_date"]);
  });

  it("accepting again REPLACES the older row", () => {
    expect(standings([
      row("tos", "tos-v3", "accepted", "2026-08-03"),
      row("tos", "tos-v1", "accepted", "2026-08-01"),
    ])).toEqual(["in_force", "replaced"]);
  });

  it("a withdrawal is withdrawn, and does not claim the live slot", () => {
    expect(standings([
      row("tos", "tos-v3", "withdrawn", "2026-08-04"),
      row("tos", "tos-v3", "accepted", "2026-08-03"),
    ])).toEqual(["withdrawn", "in_force"]);
  });

  it("the full round trip: accept, accept, withdraw, accept", () => {
    expect(standings([
      row("tos", "tos-v3", "accepted", "2026-08-05"),
      row("tos", "tos-v3", "withdrawn", "2026-08-04"),
      row("tos", "tos-v3", "accepted", "2026-08-03"),
      row("tos", "tos-v1", "accepted", "2026-08-01"),
    ])).toEqual(["in_force", "withdrawn", "replaced", "replaced"]);
  });

  it("kinds are independent — a park rulebook does not replace the terms", () => {
    expect(standings([
      row("park_rules", "2026-spring", "accepted", "2026-08-05"),
      row("tos", "tos-v3", "accepted", "2026-08-03"),
    ])).toEqual(["in_force", "in_force"]);
  });

  it("a document whose version we do NOT control is never out of date", () => {
    // A park's rulebook carries no version scheme of ours. Comparing it to
    // TOS_VERSION would mark every acceptance of one out of date forever.
    expect(standings([row("park_rules", "whatever-the-park-called-it", "accepted", "2026-08-05")]))
      .toEqual(["in_force"]);
    expect(standings([row("park_rules", null, "accepted", "2026-08-05")]))
      .toEqual(["in_force"]);
  });

  it("catches an inverted version comparison", () => {
    // The exact mutation the old scanner could not see: if the comparison were
    // flipped, a current acceptance would read out_of_date.
    const current = standings([row("tos", "tos-v3", "accepted", "2026-08-03")]);
    const stale = standings([row("tos", "tos-v1", "accepted", "2026-08-03")]);
    expect(current).not.toEqual(stale);
  });

  it("renders a badge on every row rather than only the live one", () => {
    expect(view).toContain("{standing.label}");
    expect(view).not.toMatch(/\{line\.isCurrent &&/);
  });

  it("has a word for all four states", () => {
    for (const st of ["in_force", "replaced", "out_of_date", "withdrawn"]) {
      expect(view).toContain(st);
    }
  });

  it("tells an out-of-date reader what is about to happen to them", () => {
    expect(src("../components/MyAgreements.tsx")).toMatch(
      /ask you to read the new ones next time/,
    );
  });

  it("the loader uses the same pure rule this file just exercised", () => {
    expect(data).toContain("applyStanding(lines)");
  });
});
