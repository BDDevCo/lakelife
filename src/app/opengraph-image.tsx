import { ImageResponse } from "next/og";
import {
  LOGO_SUN,
  LOGO_STROKE_WIDTH,
  LOGO_VIEWBOX,
  LOGO_WAVES,
  WAVES_LAYERS,
  WAVES_VIEWBOX,
} from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { escapeHtml } from "@/lib/html-safe";
import { createServiceClient } from "@/lib/supabase/server";
import { SERVED_LAKE_MATCH } from "@/lib/lake-visibility";

/**
 * THE LINK PREVIEW.
 *
 * Every share of www.lakelife.ai — a text message, a Facebook post, a Slack
 * paste, a forwarded email — rendered as a bare grey rectangle, because the
 * head carried no og:image at all. This draws one.
 *
 * NO PHOTOGRAPH, WHICH IS WHY IT CAN SHIP TODAY. A card built from a picture
 * of a lake needs a picture of a lake: one that is genuinely ours to use, and
 * one that is honestly of a lake we serve. Neither exists yet and inventing
 * either would be a public claim we cannot stand behind. Everything below is
 * drawn instead from what the product already is — the hero gradient and the
 * wave motif from globals.css and Brand.tsx, the wordmark from the top bar,
 * and the lake names from the database.
 *
 * NO NEW SENTENCE. The only words are the wordmark, the top bar's existing
 * tagline, and the names of the lakes. The landing copy is the owner's pick
 * and this pass does not write any.
 *
 * FONTS. next/og is satori, which cannot use next/font — next/font hands the
 * browser a CSS @font-face and a hashed URL under /_next, neither of which is
 * a font buffer this renderer can measure glyphs with. The two real options
 * were to ship a .woff2 of Bricolage Grotesque in the repo and read it here,
 * or to accept satori's bundled default. This takes the default: the app
 * ships no .woff2 today (public/ holds four PNG icons and five SVGs), and
 * adding a binary font file to the tree is a licensing question for the owner
 * rather than a plumbing change. The card is therefore brand-CORRECT in
 * colour, mark and motif and brand-APPROXIMATE in letterform, which is the
 * right way round: a preview nobody can read is worse than one set in the
 * wrong face. Swapping in the real face later is a `fonts:` array and nothing
 * else.
 */

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
/** Read aloud by a screen reader in place of the card. Both halves are
    sentences the site already ships — the wordmark and the top bar's tagline
    — so nothing here is a new claim. */
export const alt = "LakeLife — House, boat & toys — every season.";

/** The top bar's tagline, verbatim (see TopBar in components/Brand.tsx). */
export const TAGLINE = "House, boat & toys — every season.";

/** The three founding lakes, the same env-less fallback the front door uses. */
export const FALLBACK_LAKES = ["Big Long", "Pretty", "Big Turkey"];

/**
 * "Big Long Lake" → "Big Long". The identical transform src/app/page.tsx
 * applies to the identical column; a test pins that the two regexes are still
 * the same literal, because a card naming lakes differently from the page it
 * previews is a small lie told at scale.
 */
export function stripLakeSuffix(name: string): string {
  return name.replace(/ Lake$/, "");
}

/**
 * The lake names, read the way the front door reads them: the `lakes` table,
 * through the one served-lake predicate (lib/lake-visibility.ts), ordered by
 * name.
 *
 * THIS CARD IS WHY THE PREDICATE IS NOT OPTIONAL. The fence here was
 * `is_fixture = false` alone, which only ever meant "not one of our own
 * scratch rows". A lake a customer named in the set-up wizard passed it, and
 * this image rides into every text, Slack paste and Facebook share of
 * www.lakelife.ai — so a stranger's typo was printed on the brand's own link
 * preview, at the size of a headline, everywhere the site was shared.
 *
 * The SERVICE client, not the cookie-bound one, and deliberately: this route
 * is a cacheable image with no visitor attached, and reaching for `cookies()`
 * would make every link preview a per-request render. sitemap.ts reads the
 * same table the same way for the same reason.
 *
 * A FAILED READ IS NOT AN EMPTY LAKES TABLE. On a failure this degrades to the
 * three founding lakes exactly as page.tsx does — they are real markets, so
 * the card is incomplete rather than untrue — and logs, so the truncation is
 * not invisible.
 */
export async function lakeNames(): Promise<string[]> {
  if (!hasSupabaseEnv()) return FALLBACK_LAKES;
  try {
    const admin = createServiceClient();
    const res = await admin
      .from("lakes")
      .select("name")
      .match(SERVED_LAKE_MATCH)
      .order("name");
    if (res.error) {
      console.error(
        "[read failed, degraded] the lake list for the link-preview card:",
        res.error.code ?? "",
        res.error.message ?? res.error,
      );
      return FALLBACK_LAKES;
    }
    const names = (res.data ?? [])
      .map((l) => stripLakeSuffix(String(l.name ?? "")))
      .filter(Boolean);
    return names.length > 0 ? names : FALLBACK_LAKES;
  } catch (e) {
    console.error("[read failed, degraded] the lake list for the link-preview card:", e);
    return FALLBACK_LAKES;
  }
}

/**
 * These SVG strings are built by hand rather than by JSX, so every value
 * interpolated into an attribute is escaped on the way in — through the ONE
 * copy of that rule in lib/html-safe, never a twelfth private chain. The
 * values are Brand.tsx's own constants today, but an escaper that is only
 * correct while nobody edits the geometry is not an escaper.
 */
const esc = escapeHtml;

/** An <svg> string wrapped as a data URI — satori draws SVG through <img>,
    not as JSX children, so the mark has to arrive as a picture. */
const dataUri = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

/** The buoy mark, from the exported geometry — never a second copy of it. */
export function logoDataUri(px: number): string {
  const strokes = LOGO_WAVES.map(
    (w) =>
      `<path d="${esc(w.d)}" fill="none" stroke="${esc(w.stroke)}" stroke-width="${LOGO_STROKE_WIDTH}" stroke-linecap="round"/>`,
  ).join("");
  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${LOGO_VIEWBOX}">` +
      `<circle cx="${LOGO_SUN.cx}" cy="${LOGO_SUN.cy}" r="${LOGO_SUN.r}" fill="${esc(LOGO_SUN.fill)}"/>` +
      strokes +
      `</svg>`,
  );
}

/** The three-layer wave band that caps the hero, stilled — an image cannot
    drift, so the animation classes are simply not drawn. */
export function wavesDataUri(w: number, h: number): string {
  const layers = WAVES_LAYERS.map(
    (l) => `<path d="${esc(l.d)}" fill="${esc(l.fill)}"/>`,
  ).join("");
  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${WAVES_VIEWBOX}" preserveAspectRatio="none">${layers}</svg>`,
  );
}

/**
 * The card's element tree, separated from the renderer so it can be inspected
 * in a test without booting satori. Colours are the literal token values from
 * globals.css: satori resolves no CSS variables, so `var(--deep)` would draw
 * nothing at all here.
 */
export function card(lakes: string[]) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        // Centred, because 1200px is a wide surface and globals.css centres
        // .ll-hero-inner above 760px. Left-aligning here would be a layout the
        // product does not use at this width.
        alignItems: "center",
        position: "relative",
        // --deep → --teal, the hero's own gradient (globals.css .ll-hero).
        background: "linear-gradient(160deg, #0F3648 0%, #137A8C 100%)",
        padding: "0 96px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        <img src={logoDataUri(104)} width={104} height={104} alt="" />
        <div
          style={{
            display: "flex",
            fontSize: 108,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: "#FFFFFF",
          }}
        >
          <span>Lake</span>
          {/* .ll-logo-name em — the buoy gold, --sun */}
          <span style={{ color: "#E9B44C" }}>Life</span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 24,
          fontSize: 40,
          fontWeight: 600,
          // .ll-hero p
          color: "#D7EAEE",
        }}
      >
        {TAGLINE}
      </div>

      <div style={{ display: "flex", marginTop: 40, gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
        {lakes.map((name) => (
          <div
            key={name}
            style={{
              display: "flex",
              // .ll-chip
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 99,
              padding: "12px 28px",
              fontSize: 30,
              fontWeight: 700,
              color: "#FFFFFF",
            }}
          >
            {name}
          </div>
        ))}
      </div>

      {/* The wave motif, bottom-aligned exactly as .ll-waves is. */}
      <div style={{ display: "flex", position: "absolute", bottom: 0, left: 0 }}>
        <img src={wavesDataUri(size.width, 92)} width={size.width} height={92} alt="" />
      </div>
    </div>
  );
}

export default async function OpengraphImage() {
  return new ImageResponse(card(await lakeNames()), { ...size });
}
