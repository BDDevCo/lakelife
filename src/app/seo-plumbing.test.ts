import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE PLUMBING UNDER THE FRONT DOOR.
 *
 * None of this is copy. It is the set of facts a crawler, a link-preview
 * fetcher and a search engine read instead of the page — and on 22 September
 * 2026 the live head carried none of them:
 *
 *     curl -s https://www.lakelife.ai/ | grep -c '<link rel="canonical"'  →  0
 *     curl -s https://www.lakelife.ai/ | grep -o 'og:[a-z:]*'             →  (nothing)
 *     curl -s https://www.lakelife.ai/sitemap.xml | grep -c for-parks     →  0
 *     curl -s -o /dev/null -w '%{http_code}' .../for-parks                →  200
 *
 * A page that has been live and returning 200 while appearing in no sitemap
 * is the cheapest kind of invisible.
 */

vi.mock("next/font/google", () => ({
  Bricolage_Grotesque: () => ({ variable: "--font-display" }),
  Manrope: () => ({ variable: "--font-body" }),
}));
vi.mock("@/components/Toast", () => ({ ToastHost: () => null }));

const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from }) }));

const { metadata } = await import("./layout");
const sitemap = (await import("./sitemap")).default;
const robots = (await import("./robots")).default;
const { TOKEN_PATHS } = await import("@/lib/token-paths");

const url = (u: unknown) => String(u);

beforeEach(() => {
  const chain = { select: () => chain, eq: () => Promise.resolve({ data: [{ slug: "big-long-lake" }], error: null }) };
  from.mockReturnValue(chain);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the head a crawler reads", () => {
  it("names one origin, so every relative URL below it resolves", () => {
    expect(url(metadata.metadataBase)).toContain("lakelife.ai");
  });

  it("collapses the referral variants onto one canonical URL", () => {
    // RefCatcher turns /?ref=xxxx into a cookie and the query string then does
    // nothing — but without this every shared referral link is a separate URL
    // for a crawler to weigh against the real one.
    expect(metadata.alternates?.canonical).toBe("/");
  });

  it("carries an Open Graph block, and a Twitter card type", () => {
    expect(metadata.openGraph).toBeTruthy();
    expect((metadata.openGraph as { type?: string }).type).toBe("website");
    expect((metadata.openGraph as { siteName?: string }).siteName).toBe("LakeLife");
    expect((metadata.openGraph as { locale?: string }).locale).toBe("en_US");
    expect((metadata.twitter as { card?: string }).card).toBe("summary_large_image");
  });

  it("says the same thing in all three places, because it is the same string", () => {
    // Not "these two happen to match today" — the page, the preview and the
    // card are literally one declaration each. A test that compared two typed
    // copies would pass right up until somebody edited one of them.
    const title = metadata.title;
    const desc = metadata.description;
    expect((metadata.openGraph as { title?: string }).title).toBe(title);
    expect((metadata.openGraph as { description?: string }).description).toBe(desc);
    expect((metadata.twitter as { title?: string }).title).toBe(title);
    expect((metadata.twitter as { description?: string }).description).toBe(desc);
  });

  it("ships the page's existing words and no new ones", () => {
    // THIS PASS WRITES NO MARKETING SENTENCE. The title and description are
    // the ones already live; if either changes, this fails and somebody has
    // to have meant it.
    expect(metadata.title).toBe("Your LakeLife, Automated");
    expect(String(metadata.description)).toContain("photo proof when each job is complete—season after season");
  });

  it("does not stamp a brand suffix onto titles that already carry one", () => {
    // Every page in the tree that sets a title ends in "| LakeLife" or
    // "— LakeLife", so a title.template of "%s | LakeLife" would ship
    // "Privacy policy | LakeLife | LakeLife". Skipped on purpose; this pins
    // the reason so re-adding it means first dropping the suffixes.
    expect(metadata.title).not.toHaveProperty("template");
  });

  it("keeps the PWA plumbing it already had", () => {
    expect(metadata.manifest).toBe("/manifest.webmanifest");
    expect(metadata.appleWebApp).toBeTruthy();
  });
});

describe("every page title in the tree still ends in the brand", () => {
  it("which is exactly why the template is skipped", () => {
    // Read from the files, not typed here: a new page that titles itself
    // without the suffix is the signal that the template becomes worth having.
    const files = [
      "privacy/page.tsx", "sms/page.tsx", "terms/page.tsx", "referral-terms/page.tsx",
      "lakes/page.tsx", "agreements/page.tsx", "parks/my/page.tsx", "parks/claim/page.tsx",
    ];
    const off: string[] = [];
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
      const m = src.match(/title:\s*"([^"]+)"/);
      if (!m) continue;
      seen++;
      if (!/(\||—)\s*LakeLife"?$/.test(m[1])) off.push(`${f}: ${m[1]}`);
    }
    expect(seen, "the scanner found no titles to judge").toBeGreaterThanOrEqual(6);
    expect(off, "a page title no longer carries the brand — reconsider title.template").toEqual([]);
  });
});

describe("the sitemap", () => {
  it("lists the park owner's front door", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.some((u) => u.endsWith("/for-parks"))).toBe(true);
  });

  it("gives it the same weight as the other top-of-funnel door", async () => {
    const entries = await sitemap();
    const parks = entries.find((e) => e.url.endsWith("/for-parks"));
    const lakes = entries.find((e) => e.url.endsWith("/lakes"));
    expect(parks?.priority).toBe(lakes?.priority);
    expect(parks?.changeFrequency).toBe(lakes?.changeFrequency);
  });

  it("still lists everything it listed before", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    for (const p of ["", "/lakes", "/privacy", "/sms", "/terms", "/referral-terms"]) {
      expect(urls.some((u) => u.endsWith(p) || u.endsWith(`lakelife.ai${p}`))).toBe(true);
    }
    expect(urls.some((u) => u.endsWith("/lakes/big-long-lake"))).toBe(true);
  });

  it("never lists a token path", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    for (const t of TOKEN_PATHS) expect(urls.some((u) => u.includes(`/${t}/`))).toBe(false);
  });
});

describe("robots still says what it said", () => {
  const rules = () => {
    const r = robots().rules;
    return Array.isArray(r) ? r[0] : r;
  };

  it("allows every page the sitemap declares", async () => {
    const dis = (rules().disallow ?? []) as string[];
    const urls = (await sitemap()).map((e) => new URL(e.url).pathname);
    const blocked = urls.filter((p) => dis.some((d) => p.startsWith(d.replace(/\/$/, "/")) || p === d));
    expect(blocked, "the sitemap declares a URL robots.txt forbids").toEqual([]);
    // Non-vacuous: the sitemap must actually have had paths to check.
    expect(urls.length).toBeGreaterThanOrEqual(8);
  });

  it("still forbids every token path, all eight of them", () => {
    const dis = (rules().disallow ?? []) as string[];
    for (const t of TOKEN_PATHS) expect(dis).toContain(`/${t}/`);
    expect(TOKEN_PATHS.length).toBe(8);
  });

  it("would forbid /for-parks if it were a token path — it is not", () => {
    // The other half: this check can fail, so its passing means something.
    const dis = (rules().disallow ?? []) as string[];
    expect(dis).not.toContain("/for-parks");
    expect(dis).not.toContain("/for-parks/");
  });
});

describe("the front door hands the top bar the answer it already has", () => {
  it("passes signedIn to TopBar", () => {
    // The prop is what puts a sign-up control into the served HTML; without
    // this line the component change ships and nothing on the live page moves.
    const src = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(src).toMatch(/<TopBar\s+signedIn=\{signedIn\}\s*\/>/);
  });
});
