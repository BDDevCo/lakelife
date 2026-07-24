/**
 * Pure thread-grouping for the ops message board — no server-only, no DB, so it
 * unit-tests cleanly. messages-data.ts imports this and feeds it DB rows.
 *
 * Schema note: `messages.from_user` is a user id (references users.id), not a
 * text 'owner'/'ops'. We derive the label by comparing from_user to the
 * property's owner_id: match -> "owner" (the owner's own message), else "ops".
 */

export type Sender = "owner" | "ops";

export interface OpsMessage {
  id: string;
  body: string;
  created_at: string;
  from: Sender;
  ai: boolean;
}

export interface OpsThread {
  propertyId: string;
  address: string | null;
  lake: string | null;
  ownerName: string | null;
  messages: OpsMessage[]; // oldest first
  lastAt: string; // newest message time — used to sort threads
}

/** Flat, storage-agnostic message record — the input to groupThreads. */
export interface FlatMessage {
  id: string;
  property_id: string;
  address: string | null;
  lake: string | null;
  owner_name: string | null;
  owner_id: string | null;
  from_user: string | null;
  body: string;
  created_at: string;
  /** Optional so existing callers/tests that predate the AI auto-reply
   *  column keep compiling untouched; absent -> not an AI message. */
  ai?: boolean;
}

/**
 * Group flat messages into per-property threads. Messages inside a thread are
 * ordered oldest-first; threads are ordered by newest activity first.
 */
export function groupThreads(rows: FlatMessage[]): OpsThread[] {
  const byProp = new Map<string, OpsThread>();

  for (const r of rows) {
    let t = byProp.get(r.property_id);
    if (!t) {
      t = {
        propertyId: r.property_id,
        address: r.address,
        lake: r.lake,
        ownerName: r.owner_name,
        messages: [],
        lastAt: r.created_at,
      };
      byProp.set(r.property_id, t);
    }
    t.messages.push({
      id: r.id,
      body: r.body,
      created_at: r.created_at,
      from: r.owner_id != null && r.from_user === r.owner_id ? "owner" : "ops",
      ai: Boolean(r.ai),
    });
  }

  for (const t of byProp.values()) {
    t.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    t.lastAt = t.messages[t.messages.length - 1]?.created_at ?? t.lastAt;
  }

  return [...byProp.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
