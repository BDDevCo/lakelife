import type { MetadataRoute } from "next";

/**
 * WHAT A CRAWLER MAY LOOK AT.
 *
 * There was no robots.ts and no public/robots.txt, so the answer was
 * "everything" — including seven token-bearing paths that return 200 to
 * anybody holding the link: /use (a guest booking the park's boat), /d (a
 * dispute, where the token IS the credential), /a, /c, /x, /fix and /paid.
 *
 * THE TOKENS ARE UNGUESSABLE, SO THIS IS NOT AN OPEN DOOR. A crawler cannot
 * reach any of these by guessing. What it CAN do is follow one: a token URL
 * travels by SMS and email, and link previews, referrer headers and pasted
 * URLs all leak them into places that crawl. Once a page like that is indexed
 * it is discoverable by search rather than by holding the link, which is the
 * whole security model gone — and getting a URL de-indexed is far slower than
 * never letting it in.
 *
 * ALLOW-BY-DEFAULT WITH A DISALLOW LIST, not the reverse. The marketing site
 * needs to be found: the front door, /lakes and every lake landing page are
 * the SEO surface the sitemap already declares, and a deny-first rule would
 * silently cost that the first time somebody adds a page and forgets to
 * allow it. The failure directions are not symmetric — an un-indexed
 * marketing page is a missed visitor, an indexed token page is a leak.
 *
 * Signed-in areas (/ops, /vendor, /park, /portal, /profile, /billing,
 * /requests, /messages, /approvals, /settings, /book) are listed too. They
 * already redirect an anonymous visitor, so this is belt-and-braces — it costs
 * one line each and means a future page that forgets its auth check is at
 * least not advertised.
 *
 * robots.txt is a REQUEST, not enforcement. Well-behaved crawlers honour it;
 * nothing stops one that does not. The real guards stay where they are — the
 * token checks, the auth redirects, and RLS.
 */
export default function robots(): MetadataRoute.Robots {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.lakelife.ai";
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          // Token-bearing. The token is the credential; see above.
          "/use/",
          "/d/",
          "/a/",
          "/c/",
          "/x/",
          "/fix/",
          "/paid/",
          // Signed-in areas. Redirect anonymous visitors already.
          "/ops/",
          "/vendor/",
          "/park/",
          "/portal/",
          "/profile/",
          "/billing/",
          "/requests/",
          "/messages/",
          "/approvals/",
          "/settings/",
          "/book/",
          // Auth plumbing — nothing here is a page worth finding.
          "/auth/",
          "/verify",
          "/reset-password",
          "/api/",
        ],
      },
    ],
    sitemap: `${site}/sitemap.xml`,
  };
}
