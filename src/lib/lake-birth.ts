import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { slugify } from "@/lib/lake-pages";
import { normalizeLakeName } from "@/lib/lake-name";

/**
 * Demand-born lakes (owner directive, 2026-07-23): a customer whose lake
 * isn't listed, or a crew expanding their service area, CREATES the lake —
 * ops gets an FYI, never an approval gate. Every surface downstream (ops
 * calendar chips, landing copy, /lakes pages, sitemap, dispatch, cold-start
 * booking ladder) is already dynamic, so a new row IS a new market.
 */

export interface LakeBirthResult {
  ok: boolean;
  error?: string;
  lakeId?: string;
  lakeName?: string;
  created?: boolean; // false = matched an existing lake (dedup)
}

/**
 * Find an existing lake by normalized name/slug, or birth a new one.
 * Dedup is slug-based (the same normalization the public pages use), so
 * "big long", "Big Long", and "Big Long Lake" all resolve to one row.
 * A NEW lake copies season dates from an existing lake (same Indiana
 * climate) as a FAIL-SAFE default — null dates would disable the
 * water-work season gate — and is flagged season_confirmed=false with an
 * ops FYI so the dates get trued up. No approval step anywhere.
 */
export async function findOrCreateLake(
  rawName: string,
  source: "customer" | "crew",
): Promise<LakeBirthResult> {
  const admin = createServiceClient();
  const name = normalizeLakeName(rawName);
  if (!name) return { ok: false, error: "Give the lake a real name — like \"Little Turkey\" or \"Adams Lake\"." };
  const slug = slugify(name);
  const slugNoLake = slugify(name.replace(/\s*Lake\s*$/i, ""));

  // Dedup: match on either slug form or a case-insensitive name hit.
  const { data: existing } = await admin
    .from("lakes")
    .select("id, name, slug")
    .or(`slug.eq.${slug},slug.eq.${slugNoLake},name.ilike.${name}`)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return { ok: true, lakeId: existing.id as string, lakeName: existing.name as string, created: false };
  }

  // Season defaults from the newest confirmed lake — fail-safe gate dates.
  const { data: donor } = await admin
    .from("lakes")
    .select("ice_out_actual, hard_freeze_est, pull_deadline")
    .not("name", "ilike", "zz-%")
    .eq("season_confirmed", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: born, error: insErr } = await admin
    .from("lakes")
    .insert({
      name,
      slug,
      source,
      season_confirmed: false,
      ice_out_actual: donor?.ice_out_actual ?? null,
      hard_freeze_est: donor?.hard_freeze_est ?? null,
      pull_deadline: donor?.pull_deadline ?? null,
    })
    .select("id, name")
    .single();
  if (insErr || !born) {
    // A concurrent birth of the same lake loses to the unique slug — hand
    // back the winner instead of an error.
    if (insErr && /duplicate|unique/i.test(insErr.message)) {
      const { data: winner } = await admin.from("lakes").select("id, name").eq("slug", slug).maybeSingle();
      if (winner) return { ok: true, lakeId: winner.id as string, lakeName: winner.name as string, created: false };
    }
    return { ok: false, error: insErr?.message ?? "Couldn't add that lake just now." };
  }

  // ops FYI rides the nightly digest — no per-birth SMS needed.

  return { ok: true, lakeId: born.id as string, lakeName: born.name as string, created: true };
}
