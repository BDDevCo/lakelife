import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getActivePropertyId } from "@/app/profile/data";

/**
 * Owner side of the dispatch message board.
 *
 * NOTE on the schema: the `messages` table stores the sender as
 * `from_user uuid references users(id)` — NOT a text 'owner'/'ops' column
 * (see 0001_schema.sql). We store the signed-in user's id on send and derive
 * the owner/ops label at read time by comparing `from_user` to the property's
 * `owner_id`: the owner's own id == owner_id -> "owner"; anyone else (dispatch)
 * -> "ops". No role join needed.
 */

export type Sender = "owner" | "ops";

export interface OwnerMessage {
  id: string;
  body: string;
  created_at: string;
  from: Sender;
}

export interface OwnerThread {
  propertyId: string | null;
  address: string | null;
  messages: OwnerMessage[]; // oldest first
}

/** The active property's thread — only if the signed-in user owns it. */
export async function getMyThread(): Promise<OwnerThread> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { propertyId: null, address: null, messages: [] };

  const propertyId = await getActivePropertyId();
  if (!propertyId) return { propertyId: null, address: null, messages: [] };

  const admin = createServiceClient();
  // Assert ownership from the service client (rule: never trust the UI).
  const { data: prop } = await admin
    .from("properties")
    .select("id, address, owner_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!prop || prop.owner_id !== user.id) {
    return { propertyId: null, address: null, messages: [] };
  }

  const { data: rows } = await admin
    .from("messages")
    .select("id, body, created_at, from_user")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: true });

  const messages: OwnerMessage[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    body: (r.body as string) ?? "",
    created_at: r.created_at as string,
    from: r.from_user === prop.owner_id ? "owner" : "ops",
  }));

  return { propertyId: prop.id as string, address: (prop.address as string) ?? null, messages };
}
