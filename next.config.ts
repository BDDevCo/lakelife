import type { NextConfig } from "next";
import { TOKEN_PATH_PATTERN } from "./src/lib/token-paths";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Crews upload phone photos through server actions — allow real photo sizes.
      bodySizeLimit: "12mb",
    },
  },

  async headers() {
    return [
      {
        // BELT AND BRACES WITH robots.ts, because the two do different jobs.
        // robots.txt asks a crawler not to FETCH; X-Robots-Tag tells it not to
        // INDEX what it fetched anyway. The second one matters here because a
        // token URL does not have to be crawled to be found — it leaks by
        // referrer, by link preview, by being pasted somewhere public — and a
        // crawler that arrives by one of those routes never consulted
        // robots.txt for it.
        //
        // DERIVED, NOT RETYPED. This matcher and the disallow list in
        // robots.ts both used to spell the set out, and both called it closed —
        // so when /doc was added, a URL that 302s to somebody's lease was
        // crawlable and un-noindexed, and the crawl itself would have stamped
        // "Opened" in the park's delivery log. src/lib/token-paths.ts holds it
        // once, and a test fails when a src/app/<x>/[token] route is missing
        // from it.
        source: TOKEN_PATH_PATTERN,
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          // Do not hand the token to whatever the page links out to. Map links
          // and the like would otherwise receive the full URL as a referrer.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
