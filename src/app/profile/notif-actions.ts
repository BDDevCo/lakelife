"use server";

import { createClient } from "@/lib/supabase/server";
import { NOTIF_DEFS } from "@/lib/notifications";

/** Current on/off state for each notification type (defaults merged with saved overrides). */
export async function loadNotifStates(): Promise<Record<string, boolean>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const states: Record<string, boolean> = {};
  for (const n of NOTIF_DEFS) states[n.type] = n.defaultOn;
  if (!user) return states;

  const { data } = await supabase
    .from("notification_prefs")
    .select("type, enabled")
    .eq("user_id", user.id);
  for (const row of data ?? []) states[row.type] = row.enabled;
  return states;
}

/** Toggle a preference. Locked (receipts) can't be turned off. */
export async function setNotif(type: string, enabled: boolean): Promise<{ ok: boolean }> {
  const def = NOTIF_DEFS.find((n) => n.type === type);
  if (!def || def.locked) return { ok: false };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const { error } = await supabase.from("notification_prefs").upsert(
    { user_id: user.id, type, channel: def.channel, enabled },
    { onConflict: "user_id,type,channel" },
  );
  return { ok: !error };
}
