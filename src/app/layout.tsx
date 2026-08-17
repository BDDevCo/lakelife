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
  // The prototype's own <title>, which this had drifted from. It is also the
  // line that does the most work in a search result, where the reader is a
  // stranger and gets one sentence.
  title: "LakeLife — Your lake house, ready when you are",
  description:
    "You're not there most of the time. Pick your services and your dates — we send the crew and you get the photos. Seasonal opening & closing, piers, lifts, boats, mowing and housekeeping on Big Long, Pretty & Big Turkey Lakes.",
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
