import type { NextConfig } from "next";
import { TOKEN_PATH_SOURCES, TOKEN_PATH_HEADERS } from "./src/lib/token-paths";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Crews upload phone photos through server actions — allow real photo sizes.
      bodySizeLimit: "12mb",
    },
  },

  async headers() {
    // BELT AND BRACES WITH robots.ts, because the two do different jobs.
    // robots.txt asks a crawler not to FETCH; X-Robots-Tag tells it not to
    // INDEX what it fetched anyway. The second one matters here because a
    // token URL does not have to be crawled to be found — it leaks by
    // referrer, by link preview, by being pasted somewhere public — and a
    // crawler that arrives by one of those routes never consulted robots.txt
    // for it.
    //
    // DERIVED, NOT RETYPED, AND NO LONGER ONE ALTERNATION. This was a single
    // `/:path(use|d|…)/:rest*` rule, and two things went wrong with that. It
    // spelled the set out by hand once, which is how /doc — a URL that 302s to
    // somebody's lease — shipped crawlable and un-noindexed. And once the set
    // came from src/lib/token-paths.ts, the alternation still could not carry a
    // NESTED path, so src/app/api/ics/[token] could not have been fixed by
    // adding a name to the list: a `/` inside that capture matches nothing.
    // One rule per path, and the list and the headers both live in
    // src/lib/token-paths.ts.
    const headers = Object.entries(TOKEN_PATH_HEADERS).map(([key, value]) => ({ key, value }));
    return TOKEN_PATH_SOURCES.map((source) => ({ source, headers }));
  },
};

export default nextConfig;
