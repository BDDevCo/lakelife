import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { groupThreads, type FlatMessage, type OpsThread } from "./messages-group";

/**
 * Ops side of the dispatch message board — every property's thread in one place.
 * The pure grouping logic (and its types) lives in ./messages-group so it can be
 * unit-tested without a database. Re-exported here for convenience.
 */
export type { Sender, OpsMessage, OpsThread, FlatMessage } from "./messages-group";
export { groupThreads } from "./messages-group";

type Embed<T> = T | T[] | null;
const first = <T>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

interface ThreadRaw {
  id: string;
  body: string | null;
  created_at: string;
  from_user: string | null;
  ai: boolean | null;
  property_id: string;
  properties: Embed<{
    address: string | null;
    owner_id: string | null;
    lakes: Embed<{ name: string | null }>;
    users: Embed<{ name: string | null }>;
  }>;
}

/** All threads for the ops console. Ops-only (assertOps), service-role read. */
export async function getMessageThreads(): Promise<OpsThread[]> {
  const ops = await assertOps();
  if (!ops) return [];

  const admin = createServiceClient();
  const { data } = await admin
    .from("messages")
    .select(
      "id, body, created_at, from_user, ai, property_id, " +
        "properties(address, owner_id, lakes(name), users(name))",
    )
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as unknown as ThreadRaw[];
  const flat: FlatMessage[] = rows.map((r) => {
    const prop = first(r.properties) as
      | { address?: string | null; owner_id?: string | null; lakes?: unknown; users?: unknown }
      | null;
    const lake = first(prop?.lakes as Embed<{ name: string | null }>) as { name?: string } | null;
    const owner = first(prop?.users as Embed<{ name: string | null }>) as { name?: string } | null;
    return {
      id: r.id,
      property_id: r.property_id,
      address: prop?.address ?? null,
      lake: lake?.name ?? null,
      owner_name: owner?.name ?? null,
      owner_id: prop?.owner_id ?? null,
      from_user: r.from_user,
      body: (r.body as string) ?? "",
      created_at: r.created_at,
      ai: Boolean(r.ai),
    };
  });

  return groupThreads(flat);
}
