import type { MetadataRoute } from "next";
import { createServiceClient } from "@/lib/supabase/server";
import { SERVED_LAKE_MATCH } from "@/lib/lake-visibility";

/** Sitemap (§8 SEO): the public front door + every lake landing page. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.lakelife.ai";
  const entries: MetadataRoute.Sitemap = [
    { url: site, changeFrequency: "weekly", priority: 1 },
    { url: `${site}/lakes`, changeFrequency: "weekly", priority: 0.9 },
    // THE SECOND FRONT DOOR. /for-parks is the park owner's entrance — the
    // whole park side of the product is behind it — and it has been live and
    // returning 200 while appearing in no sitemap and being linked from
    // nowhere a crawler follows. Same weight as /lakes because it is the same
    // kind of page: the top of an audience's funnel, not a leaf.
    { url: `${site}/for-parks`, changeFrequency: "weekly", priority: 0.9 },
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
    // SERVED LAKES ONLY — the one predicate, lib/lake-visibility.ts. This is
    // the surface that matters most: a crawled URL outlives whatever created
    // it, and until now anything a stranger typed into the set-up wizard was
    // declared here as a page LakeLife wants indexed.
    const res = await admin.from("lakes").select("slug").match(SERVED_LAKE_MATCH);
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
