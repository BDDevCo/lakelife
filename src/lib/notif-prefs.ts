import { NOTIF_DEFS, type NotifDef } from "./notifications";

/** Machine channels stored in notification_prefs.channel ('sms' | 'email'). */
export type Channel = "sms" | "email";

export const CHANNEL_LABEL: Record<Channel, string> = { sms: "SMS", email: "Email" };

/** A row as stored in notification_prefs (channel is 'sms' | 'email'). */
export interface SavedPref {
  type: string;
  channel: string;
  enabled: boolean;
}

/** type -> per-channel enabled map. */
export type NotifPrefState = Record<string, Partial<Record<Channel, boolean>>>;

/**
 * Which channels a notification type can be delivered on, derived from its
 * human display label ("Text + email" -> sms+email, "Text" -> sms, "Email" -> email).
 */
export function channelsFor(def: NotifDef): Channel[] {
  const c = def.channel.toLowerCase();
  const out: Channel[] = [];
  if (c.includes("text")) out.push("sms");
  if (c.includes("email")) out.push("email");
  return out;
}

/**
 * Pure default-merging: build the per-type, per-channel on/off state by
 * starting from each def's default and overlaying saved rows.
 *
 * Rules:
 *  - Missing row  => default enabled (def.defaultOn).
 *  - Locked types => always on, and saved rows can never turn them off.
 *  - Saved rows for unknown types or unsupported channels are ignored.
 */
export function mergeNotifPrefs(
  saved: SavedPref[],
  defs: NotifDef[] = NOTIF_DEFS,
): NotifPrefState {
  const map: NotifPrefState = {};
  for (const def of defs) {
    const row: Partial<Record<Channel, boolean>> = {};
    for (const ch of channelsFor(def)) {
      row[ch] = def.locked ? true : def.defaultOn;
    }
    map[def.type] = row;
  }

  const byType = new Map(defs.map((d) => [d.type, d]));
  for (const s of saved) {
    const def = byType.get(s.type);
    if (!def || def.locked) continue; // unknown type or locked -> ignore
    const ch = s.channel as Channel;
    if (ch in (map[s.type] ?? {})) {
      map[s.type][ch] = s.enabled;
    }
  }
  return map;
}
