"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { OWNER_FIXTURE_EMBED, OWNER_FIXTURE_FILTER } from "@/lib/lake-pages";
import { getPlatformSettings } from "@/lib/settings";
import {
  summarisePreview,
  previewSentence,
  type CrewWorkRecord,
  type StandingPreview,
} from "@/lib/crew-standing";
import { assertOps } from "./data";

/**
 * THE STANDING DIAL — its WRITER, and the look before he flips it.
 *
 * Brendon, 23 September 2026: "we also dont want to hinder any crews from
 * onboarding and staying on the platform right away, so maybe its a feature we
 * toggle on at a later saturation date."
 *
 * It ships OFF (0178). The READER is `getPlatformSettings` ->
 * `buildCrewOffers`, which does not compute a standing at all while this is 0.
 * This file is the writer, and a dial with no writer is decorative.
 *
 * THE FLIP MUST NOT BE BLIND. He named the risk himself — hindering crews from
 * onboarding AND STAYING — so the control shows what turning it on WOULD print
 * before he turns it on: how many active crews have completed work, how many
 * would read "New to LakeLife", and on which lakes. And the trigger is DATA,
 * not a calendar date: a date can arrive with the bench still thin, and
 * flipping it then does the exact harm he is avoiding.
 */

export interface StandingDialState {
  ok: boolean;
  error?: string;
  /** Is standing shown to buyers today? */
  enabled?: boolean;
  preview?: StandingPreview;
  /** The sentence the card prints above the switch. */
  sentence?: string;
}

/**
 * What the offers screen WOULD say about every active crew, computed the same
 * way the screen itself would compute it — `summarisePreview` over the same
 * `deriveStanding`, so the preview cannot promise something the screen then
 * prints differently.
 *
 * FIXTURES ARE EXCLUDED, joined through their owner exactly as the dispatch
 * pool does (`users.is_fixture`, named FK — `vendors` has two paths to
 * `users`). All three production vendors are fixtures today, so counting them
 * would tell him the bench is three deep when it is empty.
 */
export async function getCrewStandingDial(): Promise<StandingDialState> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const settings = await getPlatformSettings();
  const admin = createServiceClient();

  const crewsRes = await admin
    .from("vendors")
    .select("id, users!vendors_user_id_fkey!inner(is_fixture)")
    .eq("status", "active")
    .eq("users.is_fixture", false);
  // A FAILED READ IS NOT AN EMPTY BENCH. Zero crews here would print "turning
  // this on would show nothing anywhere", which is a green light built out of
  // a dropped query.
  if (crewsRes.error) return { ok: false, error: "We couldn't read the crew list just now." };
  const ids = (crewsRes.data ?? []).map((v) => v.id as string);

  if (ids.length === 0) {
    const preview = summarisePreview([]);
    return { ok: true, enabled: settings.crewStandingPublic >= 1, preview, sentence: previewSentence(preview) };
  }

  const [doneRes, lakesRes] = await Promise.all([
    // THE SAME FENCE AND THE SAME STATUS PAIR AS THE OFFERS SCREEN, because a
    // preview that counts differently from the thing it previews is not a
    // preview. Fixture work is not a crew's record (the fence is on the JOB's
    // owner, not the crew — prod's only completed jobs are fixture work), and
    // `paid` is terminal after `complete`, so counting `complete` alone would
    // make a crew's record shrink as their work is paid out.
    admin
      .from("jobs")
      .select(`vendor_id, properties!inner(lake_id, ${OWNER_FIXTURE_EMBED})`)
      .in("status", ["complete", "paid"])
      .eq(OWNER_FIXTURE_FILTER, false)
      .in("vendor_id", ids),
    admin.from("lakes").select("id, name"),
  ]);
  if (doneRes.error || lakesRes.error) {
    return { ok: false, error: "We couldn't read the crews' finished work just now." };
  }

  const lakeName = new Map((lakesRes.data ?? []).map((l) => [l.id as string, l.name as string]));
  const byVendor = new Map<string, { completedJobs: number; lakeNames: Set<string> }>();
  for (const row of doneRes.data ?? []) {
    const vid = row.vendor_id as string;
    const rec = byVendor.get(vid) ?? { completedJobs: 0, lakeNames: new Set<string>() };
    rec.completedJobs += 1;
    const p = (Array.isArray(row.properties) ? row.properties[0] : row.properties) as { lake_id?: string } | null;
    const nm = p?.lake_id ? lakeName.get(p.lake_id) : null;
    if (nm) rec.lakeNames.add(nm);
    byVendor.set(vid, rec);
  }

  const records: CrewWorkRecord[] = ids.map((id) => {
    const rec = byVendor.get(id);
    return { completedJobs: rec?.completedJobs ?? 0, lakeNames: [...(rec?.lakeNames ?? [])].sort() };
  });
  const preview = summarisePreview(records);
  return { ok: true, enabled: settings.crewStandingPublic >= 1, preview, sentence: previewSentence(preview) };
}

/**
 * THE WRITER. One key, one value, 1 or 0 — no other shape may reach the dial,
 * because the reader clamps to [0, 1] and a 0.5 would be a dial nobody can
 * explain.
 */
export async function setCrewStandingPublic(on: boolean): Promise<{ ok: boolean; error?: string }> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  const admin = createServiceClient();
  const { error } = await admin
    .from("platform_settings")
    .upsert([{ key: "crew_standing_public", value: on ? 1 : 0, updated_at: new Date().toISOString() }]);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
