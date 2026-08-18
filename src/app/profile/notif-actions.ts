"use server";

import { createClient } from "@/lib/supabase/server";
import { NOTIF_DEFS } from "@/lib/notifications";
import { channelsFor } from "@/lib/notif-prefs";

/** Current on/off state for each notification type (defaults merged with saved overrides). */
export async function loadNotifStates(): Promise<Record<string, boolean>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const states: Record<string, boolean> = {};
  for (const n of NOTIF_DEFS) states[n.type] = n.defaultOn;
  if (!user) return states;

  // Only the MACHINE channels. Rows written by the older version of `setNotif`
  // below carried the display label ("Text + email") in `channel`, which no
  // send path can ever match — reading them here would show a state that
  // nothing acts on.
  const res = await supabase
    .from("notification_prefs")
    .select("type, channel, enabled")
    .eq("user_id", user.id)
    .in("channel", ["sms", "email"]);
  // DEGRADED, NOT SILENT. This is a "use server" export, so it must not throw,
  // and `Record<string, boolean>` has nowhere to put a failure — the toggles
  // would show `defaultOn` for somebody who turned one off. The log line is
  // the only signal, so it has to be here; give this an error slot before any
  // screen renders it.
  if (res.error) {
    console.error("[read failed, degraded] your notification settings:", res.error.code ?? "", res.error.message ?? res.error);
    return states;
  }
  const data = res.data;
  // A type is OFF only if every channel it uses is off — the simple toggle on
  // this screen speaks for all of them.
  const seen = new Map<string, boolean>();
  for (const row of data ?? []) {
    const t = row.type as string;
    seen.set(t, (seen.get(t) ?? false) || row.enabled === true);
  }
  for (const [t, on] of seen) states[t] = on;
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

  // THE CHANNEL COLUMN HOLDS 'sms' OR 'email', NEVER A LABEL.
  //
  // This used to write `channel: def.channel` — the human display string, so
  // rows landed as channel = "Text + email". Nothing could ever read them:
  // not the send gate, which queries 'sms'/'email', and not the other
  // settings screen, which writes the machine values. Two half-wired front
  // doors storing incompatible shapes, with the toggle appearing to work.
  const rows = channelsFor(def).map((channel) => ({
    user_id: user.id, type, channel, enabled,
  }));
  if (rows.length === 0) return { ok: false };

  const { error } = await supabase
    .from("notification_prefs")
    .upsert(rows, { onConflict: "user_id,type,channel" });
  return { ok: !error };
}
