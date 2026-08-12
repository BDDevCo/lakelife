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

/**
 * THE PART OF THE SEND GATE THAT NEEDS NO DATABASE.
 *
 * Split out so it can be tested without one — the gate itself is a query, and
 * a rule nobody can test is how six switches ended up wired to nothing.
 *
 *   "allow"   — send regardless of any stored preference
 *   "deny"    — never send on this channel for this type
 *   "consult" — go and look at what they chose
 */
export function staticGate(type: string, channel: Channel): "allow" | "deny" | "consult" {
  const def = NOTIF_DEFS.find((d) => d.type === type);
  // An unknown type has no switch to consult; sending is the status quo.
  if (!def) return "allow";
  // Not a channel this type is ever delivered on.
  if (!channelsFor(def).includes(channel)) return "deny";
  // Receipts and the like — a record of money, not a preference.
  if (def.locked) return "allow";
  return "consult";
}

/** What to do when they have never touched the settings screen. */
export function defaultFor(type: string): boolean {
  return NOTIF_DEFS.find((d) => d.type === type)?.defaultOn ?? true;
}
