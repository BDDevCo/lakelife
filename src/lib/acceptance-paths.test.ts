import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TERMS_SECTIONS, termsPlainText } from "@/lib/terms-content";

/**
 * ALL FOUR ROLES CAN NOW AGREE TO SOMETHING, AND IT SAYS SOMETHING TO THEM.
 *
 * Homeowners accepted at booking and crews at go-live. A park owner could
 * onboard a park, import nineteen households and raise real bills without ever
 * seeing the terms; a resident could claim their file and pay rent the same
 * way. Neither role was mentioned anywhere in the terms either — so asking
 * them to accept the old document would have produced a record that reads as
 * evidence and is not one, which is the failure this whole area keeps
 * repeating.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the scanner", () => {
  it("reads the files it thinks it reads", () => {
    expect(code("../app/park/layout.tsx")).toContain("ParkLayout");
    expect(code("../app/parks/my/page.tsx")).toContain("MyLotPage");
    expect(code("../components/TermsGate.tsx")).toContain("TermsGate");
  });
});

describe("the terms now describe the two roles being asked", () => {
  const headings = TERMS_SECTIONS.map((s) => s.heading);

  it("has a section for a park owner and one for a renter", () => {
    expect(headings).toContain("If you run a park");
    expect(headings).toContain("If you rent a lot");
  });

  it("tells a park owner the things the code actually enforces", () => {
    const text = termsPlainText();
    expect(text).toContain("never owns the park, the lots, or the homes on them");
    expect(text).toContain("handles no cash");
    expect(text).toContain("does not host the signing");
    expect(text).toMatch(/never screens, scores or rates/);
    expect(text).toMatch(/month that began before the day you took the park over/);
  });

  it("tells a renter who their agreement is actually with", () => {
    const text = termsPlainText();
    expect(text).toContain("with the park, not with LakeLife");
    // The two-sided payment record: nothing the resident says credits the bill.
    expect(text).toMatch(/credited only once the park confirms it collected it/);
    expect(text).toMatch(/only text you if you have said we may/);
  });

  it("claims nothing about moving money, which is not built", () => {
    // The processor is not live. A promise about where rent lands would be a
    // claim with no mechanism — the thing legal-pages.test.ts exists to stop.
    const text = termsPlainText().toLowerCase();
    expect(text).not.toMatch(/deposited (in)?to your (bank )?account/);
    expect(text).not.toMatch(/we transfer|we pay out to you|funds are sent/);
  });
});

describe("the park owner's gate covers every park route", () => {
  const layout = code("../app/park/layout.tsx");

  it("is a LAYOUT, so a bookmarked sub-route cannot walk past it", () => {
    // There are thirteen routes under /park. The crew's gate covers one page
    // because /vendor is where a crew lands; /park/rent is a page a park owner
    // bookmarks, so gating the index would be a guard with twelve ways round.
    const routes = readdirSync(
      fileURLToPath(new URL("../app/park", import.meta.url)),
      { withFileTypes: true, recursive: true },
    ).filter((e) => e.name === "page.tsx");
    expect(routes.length).toBeGreaterThan(5);
    expect(layout).toContain("export default async function ParkLayout");
    expect(layout).toContain("children");
  });

  it("asks the ledger, and lets them through only on the answer", () => {
    expect(layout).toMatch(
      /if \(await hasAccepted\(\{ userId: user\.id \}, "tos", TOS_VERSION\)\) \{\s*return <>\{children\}<\/>;/,
    );
  });

  it("passes non-members straight through rather than showing them terms", () => {
    // Every park page already says "this is the park area" in its own words,
    // and a contract is a worse answer to "you are not a park owner".
    expect(layout).toMatch(/if \(!park\) return <>\{children\}<\/>;/);
    expect(layout).toMatch(/if \(!user\) return <>\{children\}<\/>;/);
  });

  it("takes identity from the session, never from a parameter", () => {
    expect(layout).toContain("supabase.auth.getUser()");
    expect(layout).not.toMatch(/userId\s*[:=]\s*(props|params|searchParams)/);
  });
});

describe("the renter's gate", () => {
  const page = code("../app/parks/my/page.tsx");

  it("asks on the portal, and acts on the answer", () => {
    expect(page).toMatch(
      /if \(user && !\(await hasAccepted\(\{ userId: user\.id \}, "tos", TOS_VERSION\)\)\)/,
    );
    expect(page).toContain("TermsGate");
  });

  it("does not gate somebody who has no tenancy", () => {
    // Nothing to agree about yet, and the "no lot on your account" sentence is
    // the answer they actually need.
    const gate = page.slice(page.indexOf("if (view) {"), page.indexOf("if (!view) {"));
    expect(gate).toContain("hasAccepted");
    expect(page.indexOf("if (view) {")).toBeLessThan(page.indexOf("if (!view) {"));
  });

  it("leaves the no-login doors alone", () => {
    // Gating a token route would put a wall in front of somebody tapping
    // "yes, I paid" from a text message; gating the claim would ask them to
    // agree before they have a file to agree about.
    for (const rel of [
      "../app/parks/claim/page.tsx",
      "../app/parks/welcome/page.tsx",
      "../app/paid/[token]/route.ts",
      "../app/use/[token]/route.ts",
    ]) {
      expect(code(rel)).not.toContain("hasAccepted");
    }
  });
});

describe("one card, three doors", () => {
  const gate = code("../components/TermsGate.tsx");

  it("every door renders the same component", () => {
    for (const rel of [
      "../app/vendor/page.tsx",
      "../app/park/layout.tsx",
      "../app/parks/my/page.tsx",
    ]) {
      expect(code(rel)).toContain("TermsGate");
    }
  });

  it("and none of them writes its own acceptance", () => {
    // One writer, so three doors cannot record three different things.
    for (const rel of [
      "../app/vendor/page.tsx",
      "../app/park/layout.tsx",
      "../app/parks/my/page.tsx",
    ]) {
      expect(code(rel)).not.toContain("recordAcceptance");
      expect(code(rel)).not.toMatch(/from\("acceptances"\)/);
    }
    expect(gate).toContain("acceptTos");
  });

  it("shows the terms rather than a summary of them", () => {
    expect(gate).toContain("<TermsBody />");
  });

  it("tells them the words are kept", () => {
    expect(src("../components/TermsGate.tsx")).toMatch(/keep a copy of exactly these words/);
  });
});
