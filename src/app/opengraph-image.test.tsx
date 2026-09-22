import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE LINK PREVIEW CARD.
 *
 * What is worth pinning here is not that satori draws pixels — it is that the
 * card cannot start telling a different story from the page it previews:
 *
 *   the mark is the SAME mark (the geometry is imported, never retyped),
 *   the lake names are the SAME names (same table, same is_fixture fence,
 *     same " Lake" strip as src/app/page.tsx),
 *   a failed read degrades to the founding three and SAYS SO, rather than
 *     shipping a card with no lakes on it,
 *   and the words are only words the site already ships.
 */

// satori is never booted here; the card's element tree is what is inspected.
vi.mock("next/og", () => ({ ImageResponse: class {} }));
const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from }) }));

const mod = await import("./opengraph-image");
const { card, lakeNames, stripLakeSuffix, logoDataUri, wavesDataUri, FALLBACK_LAKES, TAGLINE, alt, size } = mod;
const brand = await import("@/components/Brand");

const src = (u: string) => u.slice(u.indexOf(",") + 1);
const decode = (u: string) => Buffer.from(src(u), "base64").toString("utf8");

/** One query builder: .select().match().order() resolving to whatever is given.
 *  `.match` is the served-lake predicate arriving as a single call
 *  (lib/lake-visibility.ts); `.eq` is kept so the stub still answers an older
 *  shape rather than throwing a TypeError that would read as a failed read. */
function reads(result: { data?: unknown; error?: unknown }) {
  const chain = {
    select: () => chain,
    match: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  from.mockReturnValue(chain);
}

let warned: unknown[][] = [];
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  warned = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { warned.push(a); });
});
afterEach(() => vi.restoreAllMocks());

describe("the names on the card", () => {
  it("are the lakes the database holds, without their ' Lake' suffix", async () => {
    reads({ data: [{ name: "Big Long Lake" }, { name: "Pretty Lake" }] });
    expect(await lakeNames()).toEqual(["Big Long", "Pretty"]);
  });

  it("do not include a lake the database does not hold", async () => {
    // The other half of the branch above: a real read must REPLACE the
    // fallback, not be quietly unioned with it.
    reads({ data: [{ name: "Shipshewana Lake" }] });
    expect(await lakeNames()).toEqual(["Shipshewana"]);
  });

  it("strip only a trailing ' Lake', never one in the middle of a name", () => {
    expect(stripLakeSuffix("Lake Wawasee")).toBe("Lake Wawasee");
    expect(stripLakeSuffix("Big Turkey Lake")).toBe("Big Turkey");
  });

  it("agree, character for character, with the strip the front door applies", () => {
    // Two copies of a regex is how the card and the page start naming the
    // same lake differently. If page.tsx's transform changes, this fails.
    const page = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
    expect(page, "page.tsx no longer strips ' Lake' the way the card does").toContain("replace(/ Lake$/, \"\")");
  });

  it("fall back to the founding three on a FAILED read, and say so", async () => {
    reads({ error: { code: "57014", message: "canceling statement due to statement timeout" } });
    expect(await lakeNames()).toEqual(FALLBACK_LAKES);
    expect(warned.flat().join(" ")).toContain("read failed");
  });

  it("fall back on a genuinely empty table too, silently", async () => {
    // Empty is not a failure, so nothing is logged — but a card with no lakes
    // on it is not shippable either.
    reads({ data: [] });
    expect(await lakeNames()).toEqual(FALLBACK_LAKES);
    expect(warned).toEqual([]);
  });

  it("never touch the database when there is none configured", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    from.mockReset();
    expect(await lakeNames()).toEqual(FALLBACK_LAKES);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("the card itself", () => {
  const html = () => renderToStaticMarkup(card(["Big Long", "Pretty", "Big Turkey"]));

  it("is the right size for a summary_large_image", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
  });

  it("carries the wordmark with Life in the buoy gold", () => {
    const h = html();
    expect(h).toContain(">Lake<");
    expect(h).toContain(">Life<");
    // --sun, the token value; satori resolves no CSS variables.
    expect(h.toUpperCase()).toContain("#E9B44C");
  });

  it("is painted with the hero's own gradient, not a flat colour", () => {
    // --deep → --teal, globals.css .ll-hero.
    expect(html().toUpperCase()).toContain("LINEAR-GRADIENT(160DEG, #0F3648 0%, #137A8C 100%)");
  });

  it("names every lake it was given, and no lake it was not", () => {
    const h = html();
    for (const n of ["Big Long", "Pretty", "Big Turkey"]) expect(h).toContain(n);
    expect(renderToStaticMarkup(card(["Pretty"]))).not.toContain("Big Turkey");
  });

  it("says nothing the site does not already say", () => {
    // No new marketing sentence ships in this pass. The only prose is the top
    // bar's tagline, and it is the tagline Brand.tsx renders.
    // React escapes the ampersand on the way out; the string in the file is
    // the unescaped one, so compare like with like.
    expect(html()).toContain(TAGLINE.replace("&", "&amp;"));
    expect(readFileSync(fileURLToPath(new URL("../components/Brand.tsx", import.meta.url)), "utf8"))
      .toContain("House, boat &amp; toys — every season.");
  });

  it("has an alt made of those same words", () => {
    expect(alt).toContain("LakeLife");
    expect(alt).toContain(TAGLINE);
  });
});

describe("the mark on the card is the mark on the page", () => {
  it("draws the buoy from the exported geometry", () => {
    const svg = decode(logoDataUri(104));
    expect(svg).toContain(brand.LOGO_VIEWBOX);
    expect(svg).toContain(brand.LOGO_SUN.fill);
    for (const w of brand.LOGO_WAVES) expect(svg).toContain(w.d);
  });

  it("draws the waves from the exported geometry", () => {
    const svg = decode(wavesDataUri(1200, 92));
    expect(svg).toContain(brand.WAVES_VIEWBOX);
    for (const l of brand.WAVES_LAYERS) {
      expect(svg).toContain(l.d);
      expect(svg).toContain(l.fill);
    }
  });

  it("and the DOM components draw from the very same constants", () => {
    // Without this the geometry could be exported, used by the card, and
    // quietly re-typed inside Logo/Waves — three copies instead of one.
    const logo = renderToStaticMarkup(<brand.Logo />);
    for (const w of brand.LOGO_WAVES) expect(logo).toContain(w.d);
    expect(logo).toContain(brand.LOGO_SUN.fill);
    const waves = renderToStaticMarkup(<brand.Waves />);
    for (const l of brand.WAVES_LAYERS) expect(waves).toContain(l.d);
  });

  it("keeps the drift classes real, now that they are data and not markup", () => {
    // They used to sit in a literal className, where a deleted rule would at
    // least be greppable. As values in an array they are invisible to a reader
    // of globals.css, so the stylesheet is asserted here instead.
    const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");
    const drifts = brand.WAVES_LAYERS.map((l) => l.drift).filter(Boolean);
    expect(drifts.length).toBe(2);
    for (const d of drifts) expect(css, `.${d} has no rule in globals.css`).toContain(`.${d} {`);
  });

  it("is reading real geometry, not empty arrays", () => {
    // The loops above all pass vacuously on an empty list.
    expect(brand.LOGO_WAVES.length).toBe(2);
    expect(brand.WAVES_LAYERS.length).toBe(3);
  });
});
