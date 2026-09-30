"use server";

import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { supabaseUrl } from "@/lib/env";
import { readFailedMessage } from "@/lib/must-read";
import { CONTACT_EMAIL } from "@/lib/legal";
import { getActivePropertyId } from "./data";

export interface DeleteResult {
  ok: boolean;
  error?: string;
}

/**
 * Read the minimal marketing contact for the signed-in user and retain it.
 *
 * RETURNS A MESSAGE INSTEAD OF THROWING, because both callers are buttons
 * awaiting `{ ok, error }` — and because what follows either call is a cascade
 * delete that cannot be undone. A failed read here arrives as "no email on
 * file", which takes the `return` below and retains nothing; the account is
 * then wiped and the record we meant to keep is gone with no trace that we
 * ever tried. So the failure has to reach the caller and stop the delete.
 */
async function retainMarketingContact(
  userId: string,
  reason: "property_removed" | "account_deleted",
): Promise<string | null> {
  const supabase = await createClient();
  const meRes = await supabase
    .from("users")
    .select("name, email, phone")
    .eq("id", userId)
    .maybeSingle();
  if (meRes.error) return readFailedMessage("your contact details", meRes.error);
  const me = meRes.data;

  // Lake (if they have a property) — for seasonal segmentation.
  const propertyRes = await supabase
    .from("properties")
    .select("lakes(name)")
    .eq("owner_id", userId)
    .limit(1)
    .maybeSingle();
  if (propertyRes.error) return readFailedMessage("your property", propertyRes.error);
  const property = propertyRes.data;
  const lakesField = property?.lakes as unknown;
  const lakeName = Array.isArray(lakesField)
    ? (lakesField[0] as { name?: string } | undefined)?.name
    : (lakesField as { name?: string } | null | undefined)?.name;

  if (!me?.email) return null; // nothing to retain

  // Write with the service role so retention isn't blocked by RLS. If they had
  // already opted out, leave that flag intact.
  const admin = createServiceClient();
  await admin.from("marketing_contacts").upsert(
    {
      user_id: userId,
      name: me.name ?? null,
      email: me.email,
      phone: me.phone ?? null,
      lake: lakeName ?? null,
      reason,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email" },
  );
  return null;
}

/**
 * Remove ONE property — the one the portal is currently focused on — and all
 * its house data. The login and any OTHER properties stay untouched.
 * Retains a marketing contact first.
 */
export async function removeProperty(propertyId?: string): Promise<DeleteResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // Prefer the exact property the confirmation dialog showed; fall back to the
  // active one. Either way the delete below is scoped to this owner.
  // getActivePropertyId reads the property list, which THROWS on a failed read
  // rather than reporting an empty portfolio — and this is an action, so that
  // has to become a sentence instead of a rejected promise.
  let activeId: string | null;
  try {
    activeId = propertyId ?? (await getActivePropertyId());
  } catch (e) {
    return { ok: false, error: readFailedMessage("your properties", e) };
  }
  if (!activeId) return { ok: false, error: "No property to remove." };

  // Nothing irreversible happens until the contact is safely retained.
  const retainErr = await retainMarketingContact(user.id, "property_removed");
  if (retainErr) return { ok: false, error: retainErr };

  // Deleting the property cascades to profile, boats, toys, photos, jobs, etc.
  // Scoped to the ACTIVE property only — never the whole portfolio.
  const { error } = await supabase
    .from("properties")
    .delete()
    .eq("owner_id", user.id)
    .eq("id", activeId);
  if (error) return { ok: false, error: error.message };

  // Clear the switcher cookie so the portal falls back to another property.
  const cookieStore = await cookies();
  cookieStore.set("ll_active_property", "", { path: "/", maxAge: 0 });
  return { ok: true };
}

/**
 * WHAT DELETING THIS LOGIN WOULD TAKE WITH IT THAT ISN'T THEIRS.
 *
 * `deleteAccount` removes the auth user and auth.users cascades. Read off
 * pg_constraint on production 30 Sep 2026, not from memory:
 *
 *   park_renters.user_id -> users   ON DELETE SET NULL  <- ALREADY SAFE (0055)
 *   park_members.user_id -> users   ON DELETE CASCADE   <- ORPHANS THE PARK
 *   vendors.user_id      -> users   ON DELETE CASCADE
 *   payouts.vendor_id    -> vendors ON DELETE CASCADE   <- takes the money rows
 *   jobs.vendor_id       -> vendors NO ACTION           <- aborts with a raw 23503
 *
 * The renter half is genuinely built and this does not touch it: a resident
 * deleting their login un-claims the park's file on them, and the lease, the
 * ledger and the deposit stay standing. That was the whole point of 0055.
 *
 * What was never built is the other two. Production holds ONE park and ONE
 * park_members row; that row is the whole of The Haven's reachability, because
 * getMyPark resolves a park only through park_members and no screen anywhere —
 * ops included — can re-attach an owner to a park that already exists.
 *
 * A CREW IS REFUSED WHETHER OR NOT IT CARRIES WORK. Widening past the two
 * cases in the report is deliberate: jobs.vendor_id already makes a crew with
 * work abort, but it aborts by dumping a Postgres error into a toast, and a
 * crew with only a rate card still loses vendor_rates, crew_workers, routes
 * and its payout ledger. One sentence covers all of it.
 *
 * FAILS CLOSED. A read that errors returns a refusal, never an empty blocker
 * list — what sits on the other side of this function cannot be undone, so
 * "we couldn't look" must not arrive as "there is nothing there".
 */
async function deletionBlocker(userId: string): Promise<string | null> {
  const admin = createServiceClient();

  // One string literal, deliberately: a concatenated select widens to `string`
  // and collapses every column to GenericStringError.
  const parkRes = await admin
    .from("park_members")
    .select("park_id, parks(name)")
    .eq("user_id", userId);
  if (parkRes.error) return readFailedMessage("the parks on your account", parkRes.error);
  const memberships = parkRes.data ?? [];
  if (memberships.length > 0) {
    const parksField = (memberships[0] as { parks?: unknown }).parks;
    const parkName = Array.isArray(parksField)
      ? (parksField[0] as { name?: string } | undefined)?.name
      : (parksField as { name?: string } | null | undefined)?.name;
    return (
      `This login runs ${parkName ?? "a park"} on LakeLife. Deleting it would leave ` +
      `the park's lots, leases, rent records and residents standing with nobody able ` +
      `to open them, so it can't be deleted from here. Email ${CONTACT_EMAIL} and ` +
      `we'll move the park to another login first.`
    );
  }

  const vendorRes = await admin
    .from("vendors")
    .select("id, company")
    .eq("user_id", userId);
  if (vendorRes.error) return readFailedMessage("the crew on your account", vendorRes.error);
  const crews = vendorRes.data ?? [];
  if (crews.length > 0) {
    const company = (crews[0] as { company?: string | null }).company;
    return (
      `This login is ${company ?? "a crew"} on LakeLife. Deleting it would take the ` +
      `crew's scheduled work, rate card and payout records with it, so it can't be ` +
      `deleted from here. Email ${CONTACT_EMAIL} and we'll close the crew properly ` +
      `first — anything owed gets settled before the login goes.`
    );
  }

  return null;
}

/**
 * THE SAME QUESTION, FOR THE SCREEN.
 *
 * The action below is the guard; this exists so the control is not offered
 * dead. A park owner who taps a red button, types DELETE and is then told no
 * has been walked to the edge of an irreversible thing for nothing.
 */
export async function accountDeletionBlocker(): Promise<{ blocked: boolean; reason?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { blocked: true, reason: "Please sign in first." };
  const reason = await deletionBlocker(user.id);
  return reason ? { blocked: true, reason } : { blocked: false };
}

/**
 * Fully delete the customer's account: refuses if the login carries a park or
 * a crew, then retains a marketing contact, then removes the auth login (which
 * cascades and wipes all their household data). The client signs out afterward.
 */
export async function deleteAccount(): Promise<DeleteResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // BEFORE THE RETENTION, not after: a refusal should leave nothing behind,
  // and retainMarketingContact writes a marketing_contacts row stamped
  // `account_deleted` for an account that is still open.
  const blocked = await deletionBlocker(user.id);
  if (blocked) return { ok: false, error: blocked };

  // The auth delete below cascades through every table they touch and cannot
  // be undone, so it does not start on the strength of a read that never ran.
  const retainErr = await retainMarketingContact(user.id, "account_deleted");
  if (retainErr) return { ok: false, error: retainErr };

  // Delete the auth user via the admin endpoint (service role). auth.users has
  // ON DELETE CASCADE into public.users -> properties -> children, so all house
  // data goes with it.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const res = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok && res.status !== 200) {
    const body = await res.text();
    return { ok: false, error: `Could not delete account (${res.status}). ${body}` };
  }
  return { ok: true };
}
