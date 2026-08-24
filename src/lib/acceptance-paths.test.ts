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
    // CONDITIONAL, because the guard is. `firstBillablePeriod` returns null
    // when cutover_date is NULL and every month is then billable — which is
    // what the park dial already says. v1 promised this unconditionally.
    expect(text).toMatch(/Once you tell us the day you took the park over, it will not bill for any month that began before it/);
  });

  it("tells a renter who their agreement is actually with", () => {
    const text = termsPlainText();
    expect(text).toContain("with the park, not with LakeLife");
    // The two-sided payment record: nothing the resident says credits the bill.
    expect(text).toMatch(/credited only once the park confirms it collected it/);
    expect(text).toMatch(/only text you if you have said we may/);
  });

  it("claims no capability that does not exist", () => {
    // v1 said LakeLife "stores the documents and records that they were sent".
    // There is no park document storage and no delivery log — that sentence
    // was a design note written into a legal document as though it had been
    // built, sitting behind an unskippable gate.
    const text = termsPlainText();
    expect(text).not.toMatch(/stores the documents/);
    expect(text).not.toMatch(/records that they were sent/);
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
      "../app/vendor/layout.tsx",
      "../app/park/layout.tsx",
      "../app/parks/my/page.tsx",
    ]) {
      expect(code(rel)).toContain("TermsGate");
    }
  });

  it("a role with many routes gates them ALL, from a layout", () => {
    // THE BUG THIS PINS. The crew's gate lived in /vendor/page.tsx and covered
    // one route out of eight, with VendorNav rendered directly above it linking
    // to the other seven — so a crew tapped "Open jobs" and walked straight
    // past the terms. A guard with seven ways around it is not a guard.
    for (const role of ["vendor", "park"]) {
      const dir = fileURLToPath(new URL(`../app/${role}`, import.meta.url));
      const pages = readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.name === "page.tsx");
      expect(pages.length).toBeGreaterThan(1);
      const layout = code(`../app/${role}/layout.tsx`);
      expect(layout).toContain("hasAccepted");
      expect(layout).toContain("children");
    }
  });

  it("the gate does not render the nav that would walk around it", () => {
    // The old crew card rendered VendorNav above itself. A tab strip somebody
    // cannot use yet is an invitation to try.
    const vendorLayout = code("../app/vendor/layout.tsx");
    const gateBranch = vendorLayout.slice(vendorLayout.indexOf("<TermsGate") - 400);
    expect(gateBranch).not.toContain("<VendorNav");
    expect(vendorLayout).not.toContain("VendorNav");
  });

  it("a crew still onboarding is not gated here", () => {
    // They accept at go-live via activateVendor -> ensureTos. Gating them would
    // block the checklist that is the only route to the acceptance.
    const layout = code("../app/vendor/layout.tsx");
    expect(layout).toMatch(/status !== "active"\) return <>\{children\}<\/>;/);
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
    // The single writer is one level down now: the gate renders
    // AcceptTermsButton, which calls acceptTos, which calls ensureTos. The
    // invariant is unchanged — follow the chain rather than assert on the
    // link that happened to be there when this was written.
    expect(gate).toContain("AcceptTermsButton");
    expect(code("../components/AcceptTermsButton.tsx")).toContain("acceptTos()");
    expect(code("../app/portal/tos-actions.ts")).toContain("ensureTos(");
  });

  it("the button reports a failed write instead of silently re-rendering", () => {
    // As a bare form action this returned void: a failed write left somebody
    // who had just tapped "I agree" looking at the same card with no message,
    // unable to tell success from a broken button.
    const btn = code("../components/AcceptTermsButton.tsx");
    expect(btn).toMatch(/if \(!res\.ok\)/);
    expect(btn).toContain("setError(");
    expect(btn).toMatch(/role="alert"/);
    // and it only navigates when the write actually succeeded
    const onOk = btn.slice(btn.indexOf("if (!res.ok)"));
    expect(onOk).toContain("router.push(");
  });

  it("the action returns a sentence rather than redirecting", () => {
    const act = code("../app/portal/tos-actions.ts");
    expect(act).toMatch(/Promise<AcceptResult>/);
    // A redirect cannot carry a reason, which is why it stopped doing one.
    expect(act).not.toContain("redirect(");
  });

  it("shows the terms rather than a summary of them", () => {
    expect(gate).toContain("<TermsBody />");
  });

  it("tells them the words are kept", () => {
    expect(src("../components/TermsGate.tsx")).toMatch(/keep a copy of exactly these words/);
  });
});
