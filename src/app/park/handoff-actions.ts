"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { html } from "@/lib/html-safe";
import { mustRead } from "@/lib/must-read";
import { likeLiteral } from "@/lib/sql-like";
import { assertMyPark } from "./data";
import { dayInWords } from "./park-helpers";
import {
  cleanInviteEmail, handoffEmailLines, inviteBlockMessage, type InviteBlock,
} from "./handoff-helpers";

/**
 * HANDING THE PARK TO A SECOND PERSON.
 *
 * The one door. Before this, `park_members` had exactly one writer in the
 * product — `createPark`, hard-coding role "owner" — so there was no way to
 * put a second person on a park at all. See handoff-helpers.ts for the
 * verification, and 0193 for the table.
 *
 * ONLY THE OWNER INVITES. A manager who could invite another manager could
 * hand out access to the owner's rent roll, which is not a thing a day-to-day
 * helper gets to do. Every action here asserts the OWNER role, not merely
 * membership — and says which it refused on.
 */

export interface HandoffResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

const DENIED = "You don't manage that park.";
const OWNER_ONLY = "Only the park owner can change who helps run it.";

/** Membership AND the owner role, in one place so no action here forgets. */
async function assertOwner(parkId: string): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: DENIED };
  if (membership.role !== "owner") return { ok: false, error: OWNER_ONLY };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: DENIED };
  return { ok: true, userId: user.id };
}

/**
 * IS THIS ADDRESS ONE WE CAN INVITE?
 *
 * Deliberately NOT lib/invite-guard's `checkInviteEmail`, which exists for the
 * crew doors and refuses an address that already has an account. Here an
 * existing account is the NORMAL case: the person he hands a park to may well
 * already be a LakeLife homeowner, and telling him to find them a second email
 * would be the software inventing a problem.
 *
 * What it refuses instead is the set of addresses where a membership would
 * mean something other than what he intended. Every read failure is
 * `read_failed`, never "free" — a dropped connection must not be how somebody
 * gets authority over nineteen households' payment history.
 */
async function inviteBlockFor(
  parkId: string, email: string, invitedBy: string,
): Promise<InviteBlock & { name?: string | null }> {
  const admin = createServiceClient();

  // CASE-INSENSITIVE, because `users.email` is synced from Supabase auth and
  // this repo cannot promise its case. `likeLiteral` escapes the LIKE
  // metacharacters first — without it `_` matches any single character, which
  // is how one crew invitation once matched a different address entirely.
  const userRes = await admin
    .from("users").select("id, name, role").ilike("email", likeLiteral(email)).maybeSingle();
  if (userRes.error) {
    console.error("[handoff] whether that email has an account:", userRes.error.message);
    return { kind: "read_failed" };
  }
  const existing = userRes.data as { id: string; name: string | null; role: string } | null;

  if (existing) {
    if (existing.id === invitedBy) return { kind: "is_you" };
    if (existing.role === "vendor") return { kind: "is_a_crew", name: existing.name };
    if (existing.role === "ops") return { kind: "is_ops", name: existing.name };

    const memberRes = await admin
      .from("park_members").select("role")
      .eq("park_id", parkId).eq("user_id", existing.id).maybeSingle();
    if (memberRes.error) {
      console.error("[handoff] whether they already run this park:", memberRes.error.message);
      return { kind: "read_failed" };
    }
    const member = memberRes.data as { role: string } | null;
    if (member) {
      return { kind: "already_on_this_park", role: member.role, name: existing.name };
    }
  }

  // AN OPEN INVITATION ALREADY OUT TO THEM. Checked here so the refusal is a
  // sentence rather than 0193's unique index surfacing as a constraint name —
  // the index still holds, and the insert below reads a 23505 as this case.
  const openRes = await admin
    .from("park_member_invites").select("id")
    .eq("park_id", parkId).eq("email", email)
    .is("accepted_at", null).is("revoked_at", null)
    .maybeSingle();
  if (openRes.error) {
    console.error("[handoff] whether they are already invited:", openRes.error.message);
    return { kind: "read_failed" };
  }
  if (openRes.data) return { kind: "already_invited" };

  return { kind: "ok", name: existing?.name ?? null };
}

/**
 * Invite somebody to help run the park.
 *
 * The invitation is a ROW FIRST and an email second: if the send fails he
 * still has an invitation he can see, withdraw and resend, rather than a
 * silent nothing. The reverse order — email, then row — is how somebody ends
 * up holding a link that matches no record.
 */
export async function inviteParkManager(
  parkId: string, input: { email: string; note?: string | null },
): Promise<HandoffResult> {
  const auth = await assertOwner(parkId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const email = cleanInviteEmail(input.email);
  if (!email) return { ok: false, error: "That doesn't look like an email address." };

  const note = (input.note ?? "").trim().slice(0, 500) || null;

  const block = await inviteBlockFor(parkId, email, auth.userId);
  if (block.kind !== "ok") {
    return { ok: false, error: inviteBlockMessage(block, block.name) };
  }

  const admin = createServiceClient();
  const parkRes = await admin.from("parks").select("name").eq("id", parkId).maybeSingle();
  if (parkRes.error || !parkRes.data) {
    return { ok: false, error: "We couldn't read the park just now — nothing has been sent." };
  }
  const parkName = (parkRes.data as { name: string }).name;

  const meRes = await admin.from("users").select("name").eq("id", auth.userId).maybeSingle();
  const invitedByName = (meRes.data as { name: string | null } | null)?.name ?? null;

  // `role` is left to the column's default on purpose: 0193's CHECK allows
  // only 'manager', so naming it here would be a second place to get it wrong
  // and the table would refuse anything else anyway.
  const { data: inserted, error } = await admin
    .from("park_member_invites")
    .insert({ park_id: parkId, email, invited_by: auth.userId, note })
    .select("id")
    .single();
  if (error || !inserted) {
    // A BARE INSERT'S 23505 READS AS `data: null`, and "try again" for a path
    // that cannot succeed is a loop. Name the real case.
    if (error?.code === "23505") {
      return { ok: false, error: inviteBlockMessage({ kind: "already_invited" }) };
    }
    return { ok: false, error: error?.message ?? "Couldn't send that invitation." };
  }

  revalidatePath("/park/people");
  revalidatePath("/park/today");

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const lines = handoffEmailLines({
    parkName, invitedByName, note, joinUrl: site, email,
  });
  const sent = await sendEmail({
    to: email,
    subject: `Help run ${parkName} on LakeLife`,
    html: html`${lines.map((l) => html`<p>${l}</p>`)}`,
    text: lines.join("\n\n"),
    about: { kind: "park manager invitation", parkId },
  });

  if (!sent.ok) {
    // THE INVITATION STANDS. It is in the list, withdrawable and resendable,
    // and saying so is the difference between a failure he can act on and one
    // he has to guess at.
    return {
      ok: true,
      signal:
        `${email} is invited, but the email didn't go out (${sent.error ?? "unknown reason"}). ` +
        `The invitation is in the list below — press Send again, or tell them to sign in with that address.`,
    };
  }

  return { ok: true, signal: `Invitation sent to ${email}.` };
}

/** Send the same invitation again. A new email, the same row. */
export async function resendParkManagerInvite(
  parkId: string, inviteId: string,
): Promise<HandoffResult> {
  const auth = await assertOwner(parkId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createServiceClient();
  // SCOPED TO THE PARK, not just to the id. An id from the browser is not a
  // claim about which park it belongs to.
  const res = await admin
    .from("park_member_invites")
    .select("id, email, note, accepted_at, revoked_at, parks!inner(name)")
    .eq("id", inviteId).eq("park_id", parkId).maybeSingle();
  if (res.error) return { ok: false, error: "We couldn't read that invitation just now." };
  const row = res.data as {
    email: string; note: string | null;
    accepted_at: string | null; revoked_at: string | null;
    parks: { name: string } | { name: string }[];
  } | null;
  if (!row) return { ok: false, error: "That invitation isn't on this park." };
  if (row.accepted_at) return { ok: false, error: "They've already taken that invitation up." };
  if (row.revoked_at) return { ok: false, error: "That invitation was withdrawn — invite them again instead." };

  const park = Array.isArray(row.parks) ? row.parks[0] : row.parks;
  const meRes = await admin.from("users").select("name").eq("id", auth.userId).maybeSingle();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const lines = handoffEmailLines({
    parkName: park?.name ?? "the park",
    invitedByName: (meRes.data as { name: string | null } | null)?.name ?? null,
    note: row.note,
    joinUrl: site,
    email: row.email,
  });
  const sent = await sendEmail({
    to: row.email,
    subject: `Help run ${park?.name ?? "the park"} on LakeLife`,
    html: html`${lines.map((l) => html`<p>${l}</p>`)}`,
    text: lines.join("\n\n"),
    about: { kind: "park manager invitation", parkId },
  });
  if (!sent.ok) return { ok: false, error: sent.error ?? "The email didn't go out." };
  return { ok: true, signal: `Sent again to ${row.email}.` };
}

/** Withdraw an invitation nobody has taken up yet. */
export async function revokeParkManagerInvite(
  parkId: string, inviteId: string,
): Promise<HandoffResult> {
  const auth = await assertOwner(parkId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("park_member_invites")
    .update({ revoked_at: new Date().toISOString(), revoked_by: auth.userId })
    .eq("id", inviteId).eq("park_id", parkId)
    .is("accepted_at", null).is("revoked_at", null)
    .select("email")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  // No row matched: already accepted, already withdrawn, or not this park's.
  // 0193 refuses every one of those at the trigger too; this says which.
  if (!data) {
    return { ok: false, error: "That invitation isn't open any more — reload the page to see where it got to." };
  }
  revalidatePath("/park/people");
  return { ok: true, signal: `Invitation to ${(data as { email: string }).email} withdrawn.` };
}

/**
 * Take somebody off the park.
 *
 * MANAGERS ONLY, and 0193 enforces it a second time: a trigger refuses the
 * deletion of a park's last owner, because `getMyPark` resolves a park ONLY
 * through `park_members` — a park with no owner row is not broken or
 * read-only, it is invisible to every screen in the module.
 */
export async function removeParkManager(
  parkId: string, userId: string,
): Promise<HandoffResult> {
  const auth = await assertOwner(parkId);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (userId === auth.userId) {
    return { ok: false, error: "You can't take yourself off your own park." };
  }

  const admin = createServiceClient();
  const whoRes = await admin
    .from("park_members").select("role, users!inner(name, email)")
    .eq("park_id", parkId).eq("user_id", userId).maybeSingle();
  if (whoRes.error) return { ok: false, error: "We couldn't read that person just now." };
  const who = whoRes.data as {
    role: string; users: { name: string | null; email: string | null } | { name: string | null; email: string | null }[];
  } | null;
  if (!who) return { ok: false, error: "They don't help run this park." };
  if (who.role === "owner") {
    return { ok: false, error: "That's the park owner. Changing who owns a park isn't something this screen does — ask LakeLife." };
  }
  const u = Array.isArray(who.users) ? who.users[0] : who.users;

  const { error } = await admin
    .from("park_members").delete().eq("park_id", parkId).eq("user_id", userId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/park/people");
  revalidatePath("/park/today");
  return {
    ok: true,
    signal: `${u?.name || u?.email || "They"} can no longer open this park. Their account still exists.`,
  };
}

export interface ParkPerson {
  userId: string;
  name: string | null;
  email: string | null;
  role: "owner" | "manager";
  since: string;
  /** True for the signed-in viewer, so the list can say "you". */
  isYou: boolean;
}

export interface ParkInvite {
  id: string;
  email: string;
  note: string | null;
  invitedAt: string;
  invitedAtSaid: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface ParkPeopleView {
  parkId: string;
  parkName: string;
  viewerIsOwner: boolean;
  people: ParkPerson[];
  invites: ParkInvite[];
}

/**
 * Who can open this park, and who has been asked to.
 *
 * A FAILED READ THROWS rather than rendering an empty list. "Nobody else can
 * open this park" is a sentence with a consequence attached — he may be about
 * to go away for a week on the strength of it — so it has to be earned by a
 * read that worked.
 */
export async function getParkPeople(parkId: string): Promise<ParkPeopleView | null> {
  const membership = await assertMyPark(parkId);
  if (!membership) return null;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const admin = createServiceClient();
  const park = mustRead("this park", await admin
    .from("parks").select("name").eq("id", parkId).maybeSingle());
  if (!park) return null;

  const members = mustRead("who can open this park", await admin
    .from("park_members")
    .select("user_id, role, created_at, users!inner(name, email)")
    .eq("park_id", parkId)) ?? [];

  const invites = mustRead("who has been invited to help run this park", await admin
    .from("park_member_invites")
    .select("id, email, note, invited_at, accepted_at, revoked_at")
    .eq("park_id", parkId)
    .order("invited_at", { ascending: false })) ?? [];

  const people: ParkPerson[] = members.map((m) => {
    const u = Array.isArray(m.users) ? m.users[0] : m.users;
    return {
      userId: m.user_id as string,
      name: (u?.name as string | null) ?? null,
      email: (u?.email as string | null) ?? null,
      role: (m.role as "owner" | "manager") ?? "manager",
      since: m.created_at as string,
      isYou: m.user_id === user?.id,
    };
  // The owner first, then by name: the list answers "who is on this park"
  // and the owner is the answer it starts from.
  }).sort((a, b) =>
    a.role === b.role
      ? (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")
      : a.role === "owner" ? -1 : 1);

  return {
    parkId,
    parkName: park.name as string,
    viewerIsOwner: membership.role === "owner",
    people,
    invites: invites.map((i) => ({
      id: i.id as string,
      email: i.email as string,
      note: (i.note as string | null) ?? null,
      invitedAt: i.invited_at as string,
      // A date a person reads. Never 2026-10-13.
      invitedAtSaid: dayInWords(String(i.invited_at).slice(0, 10)),
      acceptedAt: (i.accepted_at as string | null) ?? null,
      revokedAt: (i.revoked_at as string | null) ?? null,
    })),
  };
}

/**
 * TAKE UP AN INVITATION, on first sign-in.
 *
 * Called from /portal and /welcome, the same two doors that claim a crew
 * invitation — and BEFORE `claimCrewInvite` at both, because that one rewrites
 * `users.role` to 'vendor' on an email match and a park manager is not a crew.
 *
 * Returns true when a membership was created, so the caller can route them to
 * the park instead of the lake-house wizard.
 *
 * SAFE TO CALL ON EVERY SIGN-IN. It matches only open invitations for this
 * exact address, and 0193 refuses an acceptance by any account whose email is
 * not the one invited — so a bug here cannot hand somebody else's park over.
 */
export async function claimParkInvite(
  userId: string, email: string | null | undefined,
): Promise<boolean> {
  const addr = (email ?? "").trim().toLowerCase();
  if (!userId || !addr) return false;

  const admin = createServiceClient();
  const res = await admin
    .from("park_member_invites")
    .select("id, park_id, role")
    .eq("email", addr)
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (res.error) {
    // NOT "no invitation". Logged, and the sign-in carries on — the link in
    // their inbox still works on the next attempt, which is the right failure
    // for a read that dropped.
    console.error("[handoff] whether they were invited to a park:", res.error.message);
    return false;
  }
  const open = (res.data ?? []) as { id: string; park_id: string; role: string }[];
  if (open.length === 0) return false;

  let claimed = false;
  for (const inv of open) {
    // THE MEMBERSHIP FIRST. If the stamp below fails, the worst case is an
    // invitation that still reads as open against a membership that exists —
    // visible, and fixed by withdrawing it. The other order would stamp an
    // invitation as taken up by somebody who was never given the park.
    const { error: memberErr } = await admin
      .from("park_members")
      // `role` comes from the invitation, which 0193 allows to be only
      // 'manager'. This path can therefore never mint an owner.
      .insert({ park_id: inv.park_id, user_id: userId, role: inv.role });
    // 23505: they are already on the park. That is not a failure — the
    // invitation should still be closed out.
    if (memberErr && memberErr.code !== "23505") {
      console.error("[handoff] attaching them to the park:", memberErr.message);
      continue;
    }

    const { error: stampErr } = await admin
      .from("park_member_invites")
      .update({ accepted_at: new Date().toISOString(), accepted_user_id: userId })
      .eq("id", inv.id)
      .is("accepted_at", null)
      .is("revoked_at", null);
    if (stampErr) console.error("[handoff] closing out the invitation:", stampErr.message);
    claimed = true;
  }

  if (claimed) {
    revalidatePath("/park/people");
    revalidatePath("/park/today");
  }
  return claimed;
}

/** Does this signed-in account have a park invitation waiting? For routing. */
export async function hasParkInvite(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const addr = (user?.email ?? "").trim().toLowerCase();
  if (!addr) return false;
  const admin = createServiceClient();
  const res = await admin
    .from("park_member_invites").select("id")
    .eq("email", addr).is("accepted_at", null).is("revoked_at", null).limit(1).maybeSingle();
  // A failed read is not "no invitation", but this answer only decides a
  // redirect — and the honest direction is to leave them where they are and
  // let /portal's own claim run.
  if (res.error) console.error("[handoff] whether a park invite is waiting:", res.error.message);
  return res.data != null;
}
