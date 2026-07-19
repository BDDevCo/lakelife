"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { encryptGate } from "@/lib/gate";

export interface WizardInput {
  propertyId?: string | null; // set = edit that property; null/absent = create a new one
  lake: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
  place_id?: string | null;
  sqft: number;
  gate: string;
  beds: number;
  baths: number;
  pier_sections: number;
  ladder: boolean;
  bumpers: boolean;
  boat_lifts: number;
  toy_lifts: number;
  jet_skis: number;
  pwc_lifts: number;
  canopy: boolean;
  lawn_band: "small" | "medium" | "large";
  boats: Array<{ type: string; length_ft: number }>;
  toys: Array<{ name: string }>;
  wanted_services: string[];
}

export interface SaveResult {
  ok: boolean;
  propertyId?: string;
  error?: string;
}

/**
 * Save the guided-setup answers. Creates the owner's property on first run,
 * updates it on later runs, and rewrites the profile, boats and toys. The
 * gate code is encrypted before it touches the database (rule 3). All writes
 * go through the user's own session, so row-level security keeps them scoped
 * to this owner.
 */
export async function saveProfile(input: WizardInput): Promise<SaveResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // Look up the lake id from its name.
  const { data: lake } = await supabase
    .from("lakes")
    .select("id")
    .eq("name", input.lake)
    .maybeSingle();

  const gateEncrypted = input.gate ? encryptGate(input.gate) : null;

  // Edit a specific property when an id is given; otherwise create a new one.
  let propertyId: string | undefined;
  if (input.propertyId) {
    const { data: existing } = await supabase
      .from("properties")
      .select("id")
      .eq("owner_id", user.id)
      .eq("id", input.propertyId)
      .maybeSingle();
    propertyId = existing?.id as string | undefined;
    if (!propertyId) {
      // The property being edited is gone (removed in another tab?). Fail
      // loudly rather than silently creating a duplicate.
      return { ok: false, error: "That property no longer exists — refresh and try again." };
    }
  }

  const propertyFields = {
    owner_id: user.id,
    lake_id: lake?.id ?? null,
    address: input.address || null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    place_id: input.place_id ?? null,
    sqft: input.sqft || null,
    beds: input.beds || null,
    baths: input.baths || null,
    gate_code_encrypted: gateEncrypted,
  };

  // A duplicate Google Place ID means this property already has a profile.
  const DUP_MESSAGE =
    "This property already has a LakeLife profile. If it's yours, contact us and we'll help you get access.";

  if (propertyId) {
    const { error } = await supabase
      .from("properties")
      .update(propertyFields)
      .eq("id", propertyId);
    if (error) {
      if (error.code === "23505") return { ok: false, error: DUP_MESSAGE };
      return { ok: false, error: error.message };
    }
  } else {
    const { data, error } = await supabase
      .from("properties")
      .insert(propertyFields)
      .select("id")
      .single();
    if (error || !data) {
      if (error?.code === "23505") return { ok: false, error: DUP_MESSAGE };
      return { ok: false, error: error?.message ?? "Could not create property." };
    }
    propertyId = data.id as string;
    // Focus the portal on the property they just added.
    const cookieStore = await cookies();
    cookieStore.set("ll_active_property", propertyId, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }

  // Upsert the profile (property_id is the primary key).
  const { error: profErr } = await supabase.from("property_profile").upsert({
    property_id: propertyId,
    pier_sections: input.pier_sections || 0,
    ladder: input.ladder,
    bumpers: input.bumpers,
    boat_lifts: input.boat_lifts || 0,
    canopy: input.canopy,
    toy_lifts: input.toy_lifts || 0,
    jet_skis: input.jet_skis || 0,
    pwc_lifts: input.pwc_lifts || 0,
    lawn_band: input.lawn_band,
    wanted_services: input.wanted_services ?? [],
  });
  if (profErr) return { ok: false, error: profErr.message };

  // Rewrite boats and toys (simplest correct approach for a small list).
  await supabase.from("boats").delete().eq("property_id", propertyId);
  const boats = input.boats.filter((b) => b.length_ft > 0);
  if (boats.length) {
    const { error } = await supabase.from("boats").insert(
      boats.map((b) => ({
        property_id: propertyId,
        type: b.type || "Boat",
        length_ft: b.length_ft,
      })),
    );
    if (error) return { ok: false, error: error.message };
  }

  await supabase.from("toys").delete().eq("property_id", propertyId);
  const toys = input.toys.filter((t) => t.name.trim());
  if (toys.length) {
    const { error } = await supabase.from("toys").insert(
      toys.map((t) => ({ property_id: propertyId, name: t.name.trim() })),
    );
    if (error) return { ok: false, error: error.message };
  }

  return { ok: true, propertyId };
}
