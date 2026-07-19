"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { NOTIF_DEFS } from "@/lib/notifications";
import {
  channelsFor,
  mergeNotifPrefs,
  type Channel,
  type NotifPrefState,
  type SavedPref,
} from "@/lib/notif-prefs";

export interface PrefResult {
  ok: boolean;
  error?: string;
}

/** Current per-type, per-channel state for the signed-in user (defaults merged with saved rows). */
export async function loadNotifPrefs(): Promise<NotifPrefState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return mergeNotifPrefs([]);

  const { data } = await supabase
    .from("notification_prefs")
    .select("type, channel, enabled")
    .eq("user_id", user.id);

  return mergeNotifPrefs((data ?? []) as SavedPref[]);
}

/**
 * Toggle one (type, channel) preference for the signed-in user.
 * The user_id is taken from the session — NEVER from the client payload — and
 * the write goes through the service client after confirming a signed-in user.
 * Locked types (receipts) can't be changed; unknown types/channels are rejected.
 */
export async function setNotifPref(
  type: string,
  channel: string,
  enabled: boolean,
): Promise<PrefResult> {
  // Validate against the canonical list first — never trust the client's shape.
  const def = NOTIF_DEFS.find((n) => n.type === type);
  if (!def) return { ok: false, error: "Unknown notification." };
  if (def.locked) return { ok: false, error: "Receipts are always on." };
  if (!channelsFor(def).includes(channel as Channel)) {
    return { ok: false, error: "That channel isn't available for this notification." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in." };

  const admin = createServiceClient();
  const { error } = await admin.from("notification_prefs").upsert(
    { user_id: user.id, type, channel, enabled },
    { onConflict: "user_id,type,channel" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
