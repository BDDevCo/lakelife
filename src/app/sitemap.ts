import type { MetadataRoute } from "next";
import { createServiceClient } from "@/lib/supabase/server";

/** Sitemap (§8 SEO): the public front door + every lake landing page. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.lakelife.ai";
  const entries: MetadataRoute.Sitemap = [
    { url: site, changeFrequency: "weekly", priority: 1 },
    { url: `${site}/lakes`, changeFrequency: "weekly", priority: 0.9 },
    // The legal set is crawlable on purpose: A2P campaign vetting looks for a
    // public privacy policy and messaging-terms page, and "it exists but is
    // only linked from a modal" is how that check fails.
    { url: `${site}/privacy`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${site}/sms`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${site}/terms`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${site}/referral-terms`, changeFrequency: "monthly", priority: 0.4 },
  ];
  try {
    const admin = createServiceClient();
    // 0124: fixtures are excluded by the column. This is the surface that
    // matters most — a crawled URL outlives the fixture that created it.
    const res = await admin.from("lakes").select("slug").eq("is_fixture", false);
    // A FAILED READ IS NOT AN EMPTY LAKES TABLE. It was indistinguishable from
    // one here, and the catch below was written for a DIFFERENT failure — an
    // env-less build — so a database error silently shipped a sitemap claiming
    // LakeLife has three URLs. Deliberately still emitting the static entries
    // rather than throwing: this file is prerendered at build time, and a
    // sitemap that 500s a deploy is worse than one a crawler re-reads in an
    // hour. What changes is that the truncation is no longer invisible.
    if (res.error) {
      console.error("[read failed] the lake list for the sitemap:", res.error.code ?? "", res.error.message ?? res.error);
    }
    for (const l of res.data ?? []) {
      if (l.slug) entries.push({ url: `${site}/lakes/${l.slug}`, changeFrequency: "daily", priority: 0.8 });
    }
  } catch {
    /* env-less builds still emit the static entries */
  }
  return entries;
}
