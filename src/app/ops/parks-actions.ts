"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { assertOps } from "./data";

/**
 * CREATING A PARK — the thing nothing in the product could do.
 *
 * The park module ships twelve owner screens, a rent ledger, an importer, a
 * nightly and a public page. Every one of them starts from a `park_members`
 * lookup and returns "park owners only" when it finds nothing, and there was
 * no INSERT on `parks` or on `park_members` anywhere in `src` — verified by
 * grep across the whole tree. Production has zero park rows.
 *
 * So on 15 December there was no park to open, the nightly would iterate an
 * empty list, and not one of those screens could be reached even once. This is
 * the smallest missing piece in the module and it blocks all the others.
 *
 * OPS-ONLY, DELIBERATELY. Creating a park hands somebody a rent ledger for
 * nineteen households; it is not self-serve. The owner is attached here, in
 * the same call, because a park with no members is exactly the unreachable
 * state this action exists to prevent.
 */

export interface ParkCreateResult {
  ok: boolean;
  error?: string;
  parkId?: string;
  signal?: string;
}

export interface NewParkInput {
  name: string;
  address: string;
  /** The lake it sits on. Not optional — see the comment on the check below. */
  lakeId: string;
  lat: number | null;
  lng: number | null;
  /** Who owns it. An existing user id — ops looks them up by email first. */
  ownerUserId: string;
  /** 'mh' | 'rv' | 'mixed' — the DB check constraint allows exactly these. */
  parkType?: ParkType;
}

/**
 * The three the database actually accepts (`parks_park_type_check`).
 *
 * Spelled out as a type because the first draft of this action defaulted to
 * "mobile_home", which is the obvious English word and is NOT one of them —
 * every single call would have failed on a raw 23514. A proof against
 * production caught it before the form was ever opened.
 */
export type ParkType = "mh" | "rv" | "mixed";

/** "The Haven" -> "the-haven". Stable, lowercase, no trailing dashes. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function createPark(input: NewParkInput): Promise<ParkCreateResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };

  const name = (input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  const address = (input.address ?? "").trim().slice(0, 200);
  if (!name) return { ok: false, error: "The park needs a name." };
  if (!address) return { ok: false, error: "The park needs an address — the crews have to find it." };
  if (!input.lakeId) return { ok: false, error: "Pick the lake it sits on." };
  if (!input.ownerUserId) return { ok: false, error: "Say who owns it." };

  const admin = createServiceClient();

  // The owner must already exist. Creating a park for a user id that isn't
  // there would leave the park unreachable in a NEW way — which is the bug
  // this action was written to end.
  const { data: owner } = await admin
    .from("users").select("id, email").eq("id", input.ownerUserId).maybeSingle();
  if (!owner) return { ok: false, error: "No user with that id — they need an account first." };

  const { data: lake } = await admin
    .from("lakes").select("id, name").eq("id", input.lakeId)
    .eq("is_fixture", false) // 0124 — this writes parks.lake_id
    .maybeSingle();
  if (!lake) return { ok: false, error: "That lake isn't on the list." };

  // A slug is claimed even before publishing, because the public page is the
  // one thing that cannot be renamed later without breaking a printed flyer.
  const base = slugify(name);
  let slug = base;
  for (let n = 2; n <= 20; n++) {
    const { data: taken } = await admin.from("parks").select("id").eq("slug", slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${n}`;
  }

  const { data: park, error } = await admin
    .from("parks")
    .insert({
      name,
      address,
      slug,
      lake_id: input.lakeId,
      // FIRST WRITER these three columns have ever had. `lake_id`, `lat` and
      // `lng` were declared in 0052 and written by nothing, which is how a
      // park ends up invisible to the crew geo-gate while looking complete on
      // its own settings screen.
      lat: Number.isFinite(input.lat) ? input.lat : null,
      lng: Number.isFinite(input.lng) ? input.lng : null,
      park_type: input.parkType ?? "mh",
      // Not live. A park is published deliberately, by its owner, once it has
      // lots — `setParkLive` is the gate and it stays the gate.
      active: false,
    })
    .select("id, name, slug")
    .single();
  if (error || !park) {
    return { ok: false, error: error?.message ?? "Couldn't create the park." };
  }

  const { error: memberErr } = await admin
    .from("park_members")
    .insert({ park_id: park.id, user_id: input.ownerUserId, role: "owner" });
  if (memberErr) {
    // A park with no members is unreachable by every screen in the module.
    // Rather than leave one behind, unwind — the park is seconds old and has
    // nothing hanging off it yet.
    await admin.from("parks").delete().eq("id", park.id);
    return { ok: false, error: `Couldn't attach the owner (${memberErr.message}) — nothing was created.` };
  }

  revalidatePath("/ops");
  return {
    ok: true,
    parkId: park.id as string,
    signal: `${park.name} created on ${lake.name}. ${owner.email ?? "The owner"} can open it at /park.`,
  };
}

/** Find a user to make the owner. Email is what ops actually has to hand. */
export async function findUserByEmail(
  email: string,
): Promise<{ ok: boolean; error?: string; id?: string; label?: string }> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };
  const clean = (email ?? "").trim().toLowerCase();
  if (!clean) return { ok: false, error: "Type an email." };

  const admin = createServiceClient();
  const { data } = await admin
    .from("users").select("id, email, name, role").ilike("email", clean).maybeSingle();
  if (!data) return { ok: false, error: `No account for ${clean} — they need to sign up first.` };
  return {
    ok: true,
    id: data.id as string,
    label: `${(data.name as string) ?? "—"} · ${data.email as string} · ${data.role as string}`,
  };
}

/** The lakes a park can sit on, for the create form. */
export async function listLakes(): Promise<Array<{ id: string; name: string }>> {
  if (!(await assertOps())) return [];
  const admin = createServiceClient();
  // 0124 — the form must never offer what the create above would refuse.
  const { data } = await admin.from("lakes").select("id, name").eq("is_fixture", false).order("name");
  return (data ?? []).map((l) => ({ id: l.id as string, name: l.name as string }));
}
