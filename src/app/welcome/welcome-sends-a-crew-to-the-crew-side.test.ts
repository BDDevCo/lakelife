import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE FIRST SCREEN A REAL CREW EVER SEES WAS THE HOMEOWNER WIZARD.
 *
 * The invitation email links the bare site with no ?next; AuthModal sends the
 * confirmation to /auth/callback?next=/verify; VerifyPanel finishes with
 * router.push("/welcome"). So a crew invited by ops verifies their phone and
 * lands on a page whose hero says "let's build your property profile so we can
 * price every service exact to your place" — untrue for an account that exists
 * to take jobs — with both gold buttons pointing at /profile/setup.
 *
 * Nobody has seen it because all three production crews are fixtures. The first
 * real crew onboards this autumn, and that chain is the whole commercial
 * blocker: the lakes cannot earn until a real business gets through it.
 *
 * The rule is the page's own, already applied twice above: a front door asks
 * who this is before it tells them what to do next.
 */
const strip = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("/welcome knows a crew when it sees one", () => {
  const src = strip("./page.tsx");

  it("asks, and sends them to the door that claims the invite", () => {
    expect(src).toMatch(/import \{ hasCrewInvite \} from "@\/app\/ops\/crews-invite"/);
    expect(src).toContain('if (await hasCrewInvite()) redirect("/portal");');
  });

  it("asks AFTER the park rule, which /portal orders the same way", () => {
    // claimCrewInvite rewrites users.role to 'vendor' on an email match, which
    // empties a park owner's services menu — /portal runs the park check first
    // for exactly that reason, and this second doorway must not disagree.
    const park = src.indexOf('if (await isParkMember(user.id)) redirect("/park");');
    const crew = src.indexOf("hasCrewInvite()");
    expect(park).toBeGreaterThan(-1);
    expect(crew).toBeGreaterThan(-1);
    expect(park).toBeLessThan(crew);
  });

  it("and AFTER the property rule, so a dual account is not routed for them", () => {
    // Someone who already owns a lake house and was ALSO invited as a crew has
    // said what they are by having a property. Which identity wins on a dual
    // account is a product decision; a routing patch does not get to make it.
    const book = src.indexOf('if (properties.length > 0) redirect("/book");');
    const crew = src.indexOf("hasCrewInvite()");
    expect(book).toBeGreaterThan(-1);
    expect(book).toBeLessThan(crew);
  });

  it("and anyone the read misses still has a door that is not Sign out", () => {
    // An invitation sent to one address and an account opened with another is
    // not matched by any read. The page's only other control destroys the
    // session they just built.
    expect(src).toMatch(/href="\/portal"/);
  });
});

describe("the helper the door asks", () => {
  const src = strip("../ops/crews-invite.ts");
  const fn = src.slice(src.indexOf("export async function hasCrewInvite"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);

  it("exists, and the scan is reading its body", () => {
    expect(src).toMatch(/export async function hasCrewInvite\(\): Promise<boolean>/);
    expect(body.length).toBeGreaterThan(300);
  });

  it("takes no arguments — this file is \"use server\", so exports are endpoints", () => {
    // Both the id and the address come from the session, so the only thing a
    // caller can ever learn is something about themselves. claimCrewInvite in
    // this same file took the invited email as a PARAMETER, and that was how a
    // stranger could attach themselves to a crew's row.
    expect(src).toContain("hasCrewInvite(): Promise<boolean>");
    expect(body).toContain("supabase.auth.getUser()");
  });

  it("matches the invitation with .eq, never a pattern", () => {
    // `_` in an ilike pattern matches any single character, so an invite to
    // crew.mow@outlook.com would match a stranger holding crew_mow@outlook.com.
    expect(body).toContain('.eq("invite_email", email)');
    expect(body).toContain('.is("user_id", null)');
    expect(body).not.toMatch(/ilike/);
  });

  it("throws on a failed read instead of answering 'not a crew'", () => {
    // A dropped connection that answers false renders the property wizard at a
    // crew — the exact bug this helper closes, rebuilt one layer down.
    const reads = body.match(/mustRead\(/g) ?? [];
    expect(reads.length).toBe(2);
  });
});
