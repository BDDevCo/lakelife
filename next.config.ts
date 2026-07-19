import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Crews upload phone photos through server actions — allow real photo sizes.
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
