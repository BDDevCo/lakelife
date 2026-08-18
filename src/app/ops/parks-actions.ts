"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { likeLiteral } from "@/lib/sql-like";
import { assertOps } from "./data";
import { readFailedMessage } from "@/lib/must-read";

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
  const ownerRes = await admin
    .from("users").select("id, email").eq("id", input.ownerUserId).maybeSingle();
  // "They need an account first" sends ops off to create an account that already
  // exists — the id came from findUserByEmail one screen earlier. A failed read
  // is the same `data: null` and knows nothing about who does or doesn't exist.
  if (ownerRes.error) return { ok: false, error: readFailedMessage("the owner's account", ownerRes.error) };
  const owner = ownerRes.data;
  if (!owner) return { ok: false, error: "No user with that id — they need an account first." };

  const lakeRes = await admin
    .from("lakes").select("id, name").eq("id", input.lakeId)
    .eq("is_fixture", false) // 0124 — this writes parks.lake_id
    .maybeSingle();
  if (lakeRes.error) return { ok: false, error: readFailedMessage("that lake", lakeRes.error) };
  const lake = lakeRes.data;
  if (!lake) return { ok: false, error: "That lake isn't on the list." };

  // A slug is claimed even before publishing, because the public page is the
  // one thing that cannot be renamed later without breaking a printed flyer.
  const base = slugify(name);
  let slug = base;
  for (let n = 2; n <= 20; n++) {
    const takenRes = await admin.from("parks").select("id").eq("slug", slug).maybeSingle();
    // A failed read here reads as "that slug is free" and the loop breaks with
    // it — so the insert below either collides on the unique index and reports a
    // raw Postgres error, or (worse) succeeds and hands two parks the same
    // printed address. The slug is the one thing that cannot be changed later.
    if (takenRes.error) {
      return { ok: false, error: readFailedMessage("which web addresses are already taken", takenRes.error) };
    }
    if (!takenRes.data) break;
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
  // Escaped: this result is what ops binds a park to. An address with an `_`
  // in it would match a DIFFERENT account, and the label on screen shows the
  // matched email — so the wrong person could be made a park owner by somebody
  // reading the confirmation too quickly. users.email is auth's, so case stays
  // insensitive; only the wildcards go.
  const res = await admin
    .from("users").select("id, email, name, role").ilike("email", likeLiteral(clean)).maybeSingle();
  // "No account for X — they need to sign up first" is a fact about the user
  // table, and it is the sentence ops acts on: they go and ask a park owner who
  // already has an account to sign up again. A failed read must not say it.
  if (res.error) return { ok: false, error: readFailedMessage("that account", res.error) };
  const data = res.data;
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
  const res = await admin.from("lakes").select("id, name").eq("is_fixture", false).order("name");
  // Returns a bare array, so there is nowhere here to put a sentence — but an
  // empty list makes the form's own "Pick the lake it sits on" impossible to
  // satisfy, which looks like a product with no lakes rather than a failed read.
  // It logs, and `createPark` above refuses honestly if ops somehow gets past it.
  if (res.error) console.error("[read failed] the lakes a park can sit on:", res.error);
  return (res.data ?? []).map((l) => ({ id: l.id as string, name: l.name as string }));
}

/**
 * THE LAUNCH SWITCH NEEDED A SWITCH.
 *
 * `parks.active` has been the launch switch since 0052 and the ops board has
 * shown it as a Live/Dark pill ever since — but nothing in `src` ever wrote
 * `true` to it. The create above hard-codes `active: false`, and that was the
 * only writer. The one live park got switched on by hand in SQL, which is the
 * [[the-column-with-no-writer]] shape wearing a slightly different hat: not a
 * column nobody reads, a state nobody can leave.
 *
 * That mattered the moment there was a reason to go dark again. The Haven's
 * page was public four months before Brendon owns it, and taking it down
 * without this action would have left him in a state only a migration could
 * undo.
 *
 * OPS-ONLY, and deliberately NOT on the owner's side. It is the same boundary
 * the board already draws: the owner runs the park and every housing decision
 * in it, ops runs whether the park has a marketing page on lakelife.ai. This
 * writes no tenancy, touches no rent, and hides no money from anybody — the
 * owner's portal, the rent ledger and the ops board all read a dark park
 * exactly as they read a live one (0052's RLS says so in as many words).
 */
export async function setParkActive(
  parkId: string,
  active: boolean,
): Promise<{ ok: boolean; error?: string; signal?: string }> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };

  const admin = createServiceClient();
  const parkRes = await admin
    .from("parks").select("id, name, slug, active").eq("id", parkId).maybeSingle();
  // The park is right there on the board ops clicked from. "No park with that
  // id" on a failed read is the console contradicting its own screen.
  if (parkRes.error) return { ok: false, error: readFailedMessage("that park", parkRes.error) };
  const park = parkRes.data;
  if (!park) return { ok: false, error: "No park with that id." };
  if (Boolean(park.active) === active) {
    return { ok: true, signal: active ? "Already live." : "Already dark." };
  }

  const { error } = await admin.from("parks").update({ active }).eq("id", parkId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/ops");
  revalidatePath("/parks");
  if (park.slug) revalidatePath(`/parks/${park.slug}`);

  // Says what changed for the PUBLIC, because that is the only thing that did.
  return {
    ok: true,
    signal: active
      ? `${park.name as string} is live at /parks/${park.slug as string}.`
      : `${park.name as string} is dark — its page is a 404 to the world. Your portal is unchanged.`,
  };
}
