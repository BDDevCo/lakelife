import type { NextConfig } from "next";

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
        // The seven paths where the URL IS the credential: /use is a guest
        // booking the park's boat, /d is a dispute where the token authorises
        // acting as the crew or the customer, /a /c /x /fix /paid are one-tap
        // actions on a job. Kept in step with the disallow list in robots.ts.
        source: "/:path(use|d|a|c|x|fix|paid)/:rest*",
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
