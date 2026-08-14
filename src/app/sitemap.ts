import type { MetadataRoute } from "next";
import { createServiceClient } from "@/lib/supabase/server";

/** Sitemap (§8 SEO): the public front door + every lake landing page. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.lakelife.ai";
  const entries: MetadataRoute.Sitemap = [
    { url: site, changeFrequency: "weekly", priority: 1 },
    { url: `${site}/lakes`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${site}/referral-terms`, changeFrequency: "monthly", priority: 0.4 },
  ];
  try {
    const admin = createServiceClient();
    // 0124: fixtures are excluded by the column. This is the surface that
    // matters most — a crawled URL outlives the fixture that created it.
    const { data: lakes } = await admin.from("lakes").select("slug").eq("is_fixture", false);
    for (const l of lakes ?? []) {
      if (l.slug) entries.push({ url: `${site}/lakes/${l.slug}`, changeFrequency: "daily", priority: 0.8 });
    }
  } catch {
    /* env-less builds still emit the static entries */
  }
  return entries;
}
