import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Manrope } from "next/font/google";
import "./globals.css";
import { ToastHost } from "@/components/Toast";

// Display / headings font — matches the prototype
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

// Body font — matches the prototype
const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-body",
  display: "swap",
});

/**
 * ONE ORIGIN, WRITTEN ONCE.
 *
 * The same expression sitemap.ts and robots.ts already use, and deliberately
 * not lib/env's siteUrl(), whose fallback is http://localhost:3000 — a
 * canonical tag pointing at localhost is worse than no canonical tag at all.
 * Live proof the fallback is the one that renders: www.lakelife.ai/robots.txt
 * and /sitemap.xml both emit https://www.lakelife.ai today.
 */
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.lakelife.ai";

/**
 * THE TWO PUBLIC SENTENCES. Declared once and reused by the tab title, the
 * link preview and the card, because the failure mode of a page that owns
 * three copies of its own description is that two of them go stale. NOTHING
 * NEW IS WRITTEN HERE — the landing copy is the owner's pick and is not this
 * pass's to change; these are the strings the page already ships.
 */
const TITLE = "Your LakeLife, Automated";
const DESCRIPTION =
  "House, lawn, dock, lift, boat and toys. Choose what you need once. LakeLife automates scheduling and payments, keeps pricing clear, and provides photo proof when each job is complete—season after season. Big Long, Pretty & Big Turkey Lakes.";

export const metadata: Metadata = {
  // NO `title.template`. Every page in the tree that sets a title already ends
  // in the brand — "Privacy policy | LakeLife", "My lot — LakeLife", "Lakes we
  // serve … | LakeLife", and generateMetadata's lake and park titles do too —
  // so "%s | LakeLife" would ship "Privacy policy | LakeLife | LakeLife" on all
  // thirteen of them, and a bare "LakeLife | LakeLife" on the unknown-lake
  // fallback. The template is the right shape only once those titles drop
  // their own suffix, which is a copy change and therefore the owner's.
  //
  // Kept in step with the hero — the brand name already sits inside the
  // headline, so it is not repeated in front of it.
  title: TITLE,
  description: DESCRIPTION,
  // Every relative URL below (and in any child's metadata) is resolved against
  // this. Without it Next emits no absolute og:url or og:image at all, which
  // is why the live head carries neither.
  metadataBase: new URL(SITE),
  // ONE URL FOR ONE PAGE. Referrals land on /?ref=xxxx (RefCatcher reads it
  // into a cookie and the query string then does nothing), and every share of
  // a referral link was a separate URL for a crawler to weigh. Root-only: a
  // canonical here is inherited by every page that does not set its own, and
  // "/" is the truthful answer for the one page this file's title describes.
  // Child routes that need their own canonical set it in their own metadata.
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "LakeLife",
    locale: "en_US",
    url: "/",
    title: TITLE,
    description: DESCRIPTION,
    // NO `images` KEY ON PURPOSE. src/app/opengraph-image.tsx is a file
    // convention, and file-based metadata outranks this object — Next emits
    // og:image, its width, height, type and alt from that file's own exports,
    // at whatever hashed URL it gives the route. Naming a URL here would be a
    // second copy of a path only Next knows, and the two disagree the first
    // time it changes. The same reasoning covers twitter:image below.
  },
  twitter: {
    // The card TYPE is not something a file convention can infer; without it
    // a link on X renders as a small thumbnail instead of the 1200x630 card
    // the image is drawn for.
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "LakeLife",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A2430",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${bricolage.variable} ${manrope.variable}`}>
        {children}
        <ToastHost />
      </body>
    </html>
  );
}
