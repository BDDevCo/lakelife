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

export const metadata: Metadata = {
  // The one sentence a stranger gets in a search result, so it carries the
  // same promise as the hero rather than a mood. NOT the prototype's line any
  // more: "ready when you are" is a feeling, and this has to say what we do.
  title: "LakeLife — Set your lake season once",
  description:
    "Dock and lift in for spring, mowing and cleaning all summer, boat winterized and the dock out before the freeze. Choose the jobs once — we schedule each one, hold the price, and send photos when it's done. Big Long, Pretty & Big Turkey Lakes.",
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
