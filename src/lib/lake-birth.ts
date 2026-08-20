import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { slugify } from "@/lib/lake-pages";
import { normalizeLakeName } from "@/lib/lake-name";
import { effectiveSeason, addYearsISO, todayLakeDate } from "@/lib/booking";
import { readFailedMessage } from "@/lib/must-read";

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
 * climate) as a PROVISIONAL default, rolled onto the current season year
 * so the born lake can actually take water bookings, and is flagged
 * season_confirmed=false with an ops FYI so the dates get trued up. No
 * approval step anywhere.
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
  //
  // FIXTURES ARE NOT CANDIDATES (0124). Being deduped into a scratch row is
  // not cosmetic — the id goes on properties.lake_id, which is what the season
  // gates read, what the router clusters by, and what the seasonal pull email
  // names back to the owner. The customer would be joined to a fake market and
  // nothing on their screen would say so.
  //
  // AND A FAILED DEDUP IS NOT "NO MATCH". This read is the only thing standing
  // between a customer and a SECOND row for a lake we already serve: on a
  // dropped connection it answered `null`, the insert below ran, and the lake
  // split in two — two landing pages, two markets, crews on one of them and
  // customers on the other. It also silently disarms the fixture fence above,
  // since a fence that never ran cannot refuse anything. Nothing is written at
  // this point, so refusing costs the caller one retry.
  const existingRes = await admin
    .from("lakes")
    .select("id, name, slug")
    .eq("is_fixture", false)
    .or(`slug.eq.${slug},slug.eq.${slugNoLake},name.ilike.${name}`)
    .limit(1)
    .maybeSingle();
  if (existingRes.error) {
    return { ok: false, error: readFailedMessage("the lakes we already serve", existingRes.error) };
  }
  const existing = existingRes.data;
  if (existing) {
    return { ok: true, lakeId: existing.id as string, lakeName: existing.name as string, created: false };
  }

  // Season defaults from the newest confirmed lake — fail-safe gate dates.
  //
  // A FAILED DONOR READ IS NOT "NO DONOR ON FILE". A genuinely absent donor
  // births a null season, which is fail-closed and visible — ops trues it up
  // off the FYI. A donor we could not READ births the same null season off a
  // lake that HAS dates, so the born row looks trued-up-pending rather than
  // wrong, and the customer who named the lake to get a pier installed finds
  // zero bookable days with nothing on any screen saying why. Nothing is
  // written at this point.
  const donorRes = await admin
    .from("lakes")
    .select("ice_out_actual, hard_freeze_est, pull_deadline")
    .eq("is_fixture", false) // 0124 — never inherit a season from a fixture
    .eq("season_confirmed", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (donorRes.error) {
    return { ok: false, error: readFailedMessage("this lake's season dates", donorRes.error) };
  }
  const donor = donorRes.data;

  // Copy the donor's month/day onto THIS season's year (audit finding 2).
  // Verbatim inheritance handed a lake born in season 2 season 1's absolute
  // dates, so zero of its next 200 days were bookable for water work — the
  // customer who names a lake to get a pier installed was exactly the person
  // who could not book one. Still season_confirmed = false: provisional, and
  // a human trues it up off the nightly ops FYI.
  const eff = effectiveSeason(
    { iceOut: (donor?.ice_out_actual as string | null) ?? null, pullDeadline: (donor?.pull_deadline as string | null) ?? null },
    todayLakeDate(),
  );
  // The freeze estimate rides the SAME roll, so rule 7's pull = freeze − 8
  // still holds on the born row.
  const hardFreeze = addYearsISO((donor?.hard_freeze_est as string | null) ?? null, eff.yearsRolled);

  const { data: born, error: insErr } = await admin
    .from("lakes")
    .insert({
      name,
      slug,
      source,
      season_confirmed: false,
      ice_out_actual: eff.seasonStart,
      hard_freeze_est: hardFreeze,
      pull_deadline: eff.seasonEnd,
    })
    .select("id, name")
    .single();
  if (insErr || !born) {
    // A concurrent birth of the same lake loses to the unique slug — hand
    // back the winner instead of an error.
    if (insErr && /duplicate|unique/i.test(insErr.message)) {
      const winnerRes = await admin
        .from("lakes").select("id, name, is_fixture").eq("slug", slug).maybeSingle();
      // AND THE FIXTURE CHECK BELOW CANNOT RUN ON A FAILED READ. `null` here
      // used to fall through to the raw duplicate-key message from the insert
      // — a Postgres constraint name shown to a customer, about a lake that
      // demonstrably exists. Say what actually happened instead.
      if (winnerRes.error) {
        return { ok: false, error: readFailedMessage("that lake", winnerRes.error) };
      }
      const winner = winnerRes.data;
      // AND THE RETRY HAS TO KNOW TOO (0124). Fencing the dedupe above without
      // fencing this would only move the bug one step down: the fixture stops
      // matching at the top, the insert then collides with the very slug it
      // holds, and this line hands the customer that scratch row anyway — with
      // `created: false`, so the path that was supposed to protect them is the
      // path that delivers them. Refuse instead. A squatted lake name is a
      // human problem and ops can rename the fixture in seconds; silently
      // seating somebody on a fake lake is not recoverable by anybody.
      if (winner?.is_fixture === true) {
        return { ok: false, error: "We can't add that lake just now — email hello@lakelife.ai and we'll sort it out." };
      }
      if (winner) return { ok: true, lakeId: winner.id as string, lakeName: winner.name as string, created: false };
    }
    return { ok: false, error: insErr?.message ?? "Couldn't add that lake just now." };
  }

  // ops FYI rides the nightly digest — no per-birth SMS needed.

  return { ok: true, lakeId: born.id as string, lakeName: born.name as string, created: true };
}
