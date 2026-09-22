import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE CONTROL A CRAWLER CAN SEE.
 *
 * Verified live on 22 September 2026, before this change:
 *
 *     curl -s https://www.lakelife.ai/ | grep -c "Get set up"   →   0
 *     curl -s https://www.lakelife.ai/ | grep -c "Sign in"      →   0
 *
 * The top bar shipped as a 64px spacer and stayed one until `auth.getUser()`
 * answered in the browser, so the served HTML offered no way into the product
 * at all. This pins the server render — renderToStaticMarkup runs exactly what
 * the server runs (initial state, no effects) — in all three directions:
 *
 *   told signed out → the sign-up control is in the HTML
 *   told signed in  → the portal control is, and the sign-up control is NOT
 *   told nothing    → the spacer, unchanged, because a page that cannot know
 *                     must not guess
 *
 * Both halves of every branch are required: a test that only asserted the
 * presence of "Get set up" would pass on a component that rendered both
 * controls at once, which is the flash this is meant to prevent.
 */

// Next's Link and router are the app's, not this component's job.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
// The browser client is never constructed during a server render; import it
// as a stub so the module graph loads under node.
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: {} }) }));
vi.mock("@/components/AuthModal", () => ({ AuthModal: () => <div>modal</div> }));

const { TopBar } = await import("./Brand");
const { TopBarAuth } = await import("./TopBarAuth");

beforeEach(() => {
  // hasSupabaseEnv() reads these; with them present the un-hinted bar is in
  // its "still asking" state, which is the state that shipped the spacer.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
});

const SIGNUP = "Get set up";
const SIGNIN = "Sign in";
const PORTAL = "My portal";

describe("the top bar the server sends", () => {
  it("offers a stranger a way in", () => {
    const html = renderToStaticMarkup(<TopBar signedIn={false} />);
    expect(html).toContain(SIGNUP);
    expect(html).toContain(SIGNIN);
    expect(html).not.toContain(PORTAL);
  });

  it("offers a signed-in homeowner their portal, and no sign-up pitch", () => {
    const html = renderToStaticMarkup(<TopBar signedIn={true} />);
    expect(html).toContain(PORTAL);
    expect(html).toContain("Sign out");
    expect(html).not.toContain(SIGNUP);
    // "Sign out" contains no "Sign in"; assert the signed-out pill's class is
    // absent rather than matching on a substring of a word that is present.
    expect(html).not.toContain("ll-navbtn signin");
  });

  it("still draws the spacer for a page that was told nothing", () => {
    // The ~50 call sites that pass no prop must be untouched by this change.
    const html = renderToStaticMarkup(<TopBar />);
    expect(html).not.toContain(SIGNUP);
    expect(html).not.toContain(PORTAL);
    expect(html).toContain("width:64px");
  });

  it("draws the logo and tagline either way, so the bar is not empty", () => {
    for (const bar of [<TopBar key="a" />, <TopBar key="b" signedIn={false} />]) {
      const html = renderToStaticMarkup(bar);
      expect(html).toContain("LakeLife home");
      expect(html).toContain("every season");
    }
  });
});

describe("the component under it, on its own", () => {
  it("treats a `false` hint as an answer, not as an absence", () => {
    // `||` here instead of `??` would throw the commonest answer away and put
    // the spacer back for every signed-out visitor. Pinned because the two
    // operators are one character apart and look identical in review.
    expect(renderToStaticMarkup(<TopBarAuth initialSignedIn={false} />)).toContain(SIGNUP);
  });

  it("falls back to the spacer with no hint and Supabase configured", () => {
    expect(renderToStaticMarkup(<TopBarAuth />)).toContain("width:64px");
  });

  it("knows it is signed out with no hint and no Supabase at all", () => {
    // The pre-existing env shortcut, unchanged: nothing to ask means the
    // answer is known at first render.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(renderToStaticMarkup(<TopBarAuth />)).toContain(SIGNUP);
  });
});
