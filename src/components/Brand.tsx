import Link from "next/link";
import { TopBarAuth } from "@/components/TopBarAuth";

/** The LakeLife mark — gold buoy sun over two waves. Straight from the prototype. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 34 34"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <circle cx="17" cy="13" r="6.5" fill="#E9B44C" />
      <path
        d="M3 22 Q9 17 17 22 T31 22"
        fill="none"
        stroke="#BFE3E8"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M3 28 Q9 23 17 28 T31 28"
        fill="none"
        stroke="#137A8C"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The drifting three-layer wave motif that caps the hero. */
export function Waves() {
  return (
    <div className="ll-waves" aria-hidden="true">
      <svg viewBox="0 0 1440 110" preserveAspectRatio="none">
        <g className="ll-wave-a">
          <path
            d="M0 60 Q180 30 360 60 T720 60 T1080 60 T1440 60 T1800 60 T2160 60 V110 H0 Z"
            fill="#1E6E7E"
          />
        </g>
        <g className="ll-wave-b">
          <path
            d="M0 75 Q180 50 360 75 T720 75 T1080 75 T1440 75 T1800 75 T2160 75 V110 H0 Z"
            fill="#7FB8C4"
          />
        </g>
        <g>
          <path
            d="M0 90 Q180 68 360 90 T720 90 T1080 90 T1440 90 T1800 90 T2160 90 V110 H0 Z"
            fill="#F3F8F9"
          />
        </g>
      </svg>
    </div>
  );
}

/** Dark sticky top bar with the logo and tagline. */
export function TopBar() {
  return (
    <header className="ll-topbar">
      <div className="ll-topbar-inner">
        <Link href="/" className="ll-logo" aria-label="LakeLife home">
          <Logo />
          <span className="ll-logo-name">
            Lake<em>Life</em>
          </span>
        </Link>
        <span className="ll-tagline">Your lake house, ready when you are.</span>
        <div style={{ marginLeft: "auto" }}>
          <TopBarAuth />
        </div>
      </div>
    </header>
  );
}
