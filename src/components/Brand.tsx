import Link from "next/link";
import { TopBarAuth } from "@/components/TopBarAuth";

/**
 * THE MARK'S GEOMETRY, NAMED ONCE.
 *
 * The buoy and the waves are now drawn in two places — here, in the DOM, and
 * inside the Open Graph card (src/app/opengraph-image.tsx), which is built by
 * satori and cannot render a React component. Two hand-typed copies of the
 * same curve is how a logo quietly stops matching itself, so the path data and
 * the fills live here and both drawings read them.
 *
 * The numbers are unchanged from the prototype (lakelife.html); this is a
 * rename, not a redraw. The tests pin every path string so a "tidy-up" of one
 * copy cannot silently move the other.
 */
export const LOGO_VIEWBOX = "0 0 34 34";
export const LOGO_SUN = { cx: 17, cy: 13, r: 6.5, fill: "#E9B44C" } as const;
export const LOGO_STROKE_WIDTH = 2.6;
export const LOGO_WAVES = [
  { d: "M3 22 Q9 17 17 22 T31 22", stroke: "#BFE3E8" },
  { d: "M3 28 Q9 23 17 28 T31 28", stroke: "#137A8C" },
] as const;

export const WAVES_VIEWBOX = "0 0 1440 110";
/** Back to front: the darkest layer sits highest, the mist layer meets the page. */
export const WAVES_LAYERS = [
  {
    d: "M0 60 Q180 30 360 60 T720 60 T1080 60 T1440 60 T1800 60 T2160 60 V110 H0 Z",
    fill: "#1E6E7E",
    drift: "ll-wave-a",
  },
  {
    d: "M0 75 Q180 50 360 75 T720 75 T1080 75 T1440 75 T1800 75 T2160 75 V110 H0 Z",
    fill: "#7FB8C4",
    drift: "ll-wave-b",
  },
  {
    d: "M0 90 Q180 68 360 90 T720 90 T1080 90 T1440 90 T1800 90 T2160 90 V110 H0 Z",
    fill: "#F3F8F9",
    drift: "",
  },
] as const;

/** The LakeLife mark — gold buoy sun over two waves. Straight from the prototype. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={LOGO_VIEWBOX}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <circle cx={LOGO_SUN.cx} cy={LOGO_SUN.cy} r={LOGO_SUN.r} fill={LOGO_SUN.fill} />
      {LOGO_WAVES.map((w) => (
        <path
          key={w.d}
          d={w.d}
          fill="none"
          stroke={w.stroke}
          strokeWidth={LOGO_STROKE_WIDTH}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/** The drifting three-layer wave motif that caps the hero. */
export function Waves() {
  return (
    <div className="ll-waves" aria-hidden="true">
      <svg viewBox={WAVES_VIEWBOX} preserveAspectRatio="none">
        {WAVES_LAYERS.map((l) => (
          <g key={l.d} className={l.drift || undefined}>
            <path d={l.d} fill={l.fill} />
          </g>
        ))}
      </svg>
    </div>
  );
}

/**
 * Dark sticky top bar with the logo and tagline.
 *
 * `signedIn` is OPTIONAL and every one of the ~50 call sites that omits it
 * keeps exactly today's behaviour: the auth control resolves on the client.
 * A server page that has already asked the question passes the answer through
 * so the right control lands in the SSR HTML — see TopBarAuth for why that
 * mattered and why a page that cannot know must not guess.
 */
export function TopBar({ signedIn }: { signedIn?: boolean } = {}) {
  return (
    <header className="ll-topbar">
      <div className="ll-topbar-inner">
        <Link href="/" className="ll-logo" aria-label="LakeLife home">
          <Logo />
          <span className="ll-logo-name">
            Lake<em>Life</em>
          </span>
        </Link>
        <span className="ll-tagline">House, boat &amp; toys — every season.</span>
        <div style={{ marginLeft: "auto" }}>
          <TopBarAuth initialSignedIn={signedIn} />
        </div>
      </div>
    </header>
  );
}
