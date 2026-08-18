"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { sendEmail } from "@/lib/email";
import { getLedger } from "./ledger-actions";
import {
  planReminders, ownerDigest,
  type RenterContact, type ReminderPlan,
} from "./reminder-helpers";
import type { ParkResult } from "./actions";
import { prettyMonth } from "./ledger-helpers";
import { mustRead, softRead, ReadFailed, readFailedMessage } from "@/lib/must-read";

/**
 * OVERDUE REMINDERS — the send path.
 *
 * SMS IS OFF UNTIL A2P 10DLC REGISTRATION CLEARS, and that is a deliberate,
 * visible refusal rather than a silent skip: the owner sees "we can't reach 4"
 * with the reason, so he knows to post those instead. Flipping it on later is
 * one constant.
 *
 * NOTHING IS SENT WITHOUT HIM ASKING. This is not on a cron. Chasing a
 * household for money is the most consequential message the park sends, and
 * automating it while nobody is watching is how a resident who paid on Tuesday
 * gets a demand on Wednesday.
 */

const DENIED = "You don't manage that park.";

/**
 * FALSE until the carrier registration clears. Not a config toggle by
 * accident — a constant somebody has to change deliberately, with the reason
 * written next to it.
 */
const SMS_ENABLED = false;

async function loadPlan(
  parkId: string,
  month?: string,
): Promise<{ plan: ReminderPlan; parkName: string; month: string } | null> {
  const page = await getLedger(parkId, month);
  if (!page) return null;

  const admin = createServiceClient();
  // The park's name and address are printed INSIDE the demand itself. A failed
  // read falls through to "your park" and drops the office address out of the
  // line telling somebody where to take their money.
  const park = mustRead("your park", await admin
    .from("parks").select("name, address").eq("id", parkId).maybeSingle());

  // Contacts, keyed by CHARGE id so the planner never has to join.
  const charges = mustRead("this month's bills", await admin
    .from("park_charges")
    .select("id, renter_id")
    .eq("park_id", parkId)
    .eq("period_month", page.month));

  const renterIds = [...new Set((charges ?? []).map((c) => c.renter_id as string).filter(Boolean))];
  const renters = mustRead("the names on your roll", renterIds.length
    ? await admin
        .from("park_renters")
        .select("id, display_name, email, mobile_e164, mobile_verified_at, sms_consent_operational_at, contact_pref")
        .in("id", renterIds)
    : { data: [] as Record<string, unknown>[], error: null });

  const byRenter = new Map<string, RenterContact>();
  for (const r of renters ?? []) {
    byRenter.set(r.id as string, {
      renterId: r.id as string,
      displayName: (r.display_name as string) ?? "there",
      email: (r.email as string) ?? null,
      // An UNVERIFIED mobile is not a channel. `phone_on_file_with_park` is
      // deliberately not read here at all — nobody consented to it.
      mobile: r.mobile_verified_at ? ((r.mobile_e164 as string) ?? null) : null,
      smsConsent: r.sms_consent_operational_at != null,
      contactPref: (r.contact_pref as RenterContact["contactPref"]) ?? "paper",
    });
  }

  const contacts = new Map<string, RenterContact>();
  for (const c of charges ?? []) {
    const rc = byRenter.get(c.renter_id as string);
    if (rc) contacts.set(c.id as string, rc);
  }

  // THE GUARD THAT FAILS OPEN. This is the only thing standing between a
  // second click and a second demand: every charge in here has already been
  // chased, and `planReminders` drops it. Read the usual way, a dropped
  // connection resolves to null, `alreadyReminded` becomes an EMPTY SET, and
  // the guard passes for everybody — so the whole park is chased again for
  // money it was already asked for, including the households who paid on
  // Tuesday. An empty set has to mean "nobody has been reminded", never "we
  // couldn't find out".
  const sent = mustRead("who's already been reminded", await admin
    .from("park_reminders")
    .select("charge_id")
    .eq("park_id", parkId)
    .eq("party", "resident")
    .in("outcome", ["sent", "printed"]));

  const parkName = (park?.name as string) ?? "your park";
  const plan = planReminders(page.rows, contacts, page.month, {
    parkName,
    officeLine: park?.address
      ? `Drop it at the office — ${park.address} — or give us a call.`
      : "Drop it at the office or give us a call.",
    smsEnabled: SMS_ENABLED,
    alreadyReminded: new Set((sent ?? []).map((s) => s.charge_id as string)),
  });

  return { plan, parkName, month: page.month };
}

/** What WOULD go out. Nothing is sent, nothing is logged. */
export async function previewReminders(
  parkId: string,
  month?: string,
): Promise<{ ok: boolean; error?: string; plan?: ReminderPlan; month?: string }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  // `loadPlan` reads the ledger, which THROWS on a failed read rather than
  // reporting a month with nobody behind. This is an action awaited by a
  // button, so it catches and answers in that button's shape — "Nothing to
  // work from." would claim we looked and found nobody late.
  let loaded: Awaited<ReturnType<typeof loadPlan>>;
  try {
    loaded = await loadPlan(parkId, month);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("this month's bills", e) };
  }
  if (!loaded) return { ok: false, error: "Nothing to work from." };
  return { ok: true, plan: loaded.plan, month: loaded.month };
}

/**
 * Send them.
 *
 * Per-reminder, errors collected — one bad address must not stop the other
 * nineteen. Every outcome is logged, including the ones that could not go, so
 * "did we tell them?" has an answer for every household rather than for the
 * lucky ones.
 */
export async function sendReminders(
  parkId: string,
  month?: string,
): Promise<ParkResult & { sent?: number; printed?: number; blocked?: number }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  // Same catch as the preview, and the sentence answers the owner's first
  // question out loud: the ledger read failed BEFORE any email was addressed,
  // so nobody has been chased.
  let loaded: Awaited<ReturnType<typeof loadPlan>>;
  try {
    loaded = await loadPlan(parkId, month);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    // `mustRead` has already logged which read it was; this only has to say it
    // in words the owner can act on.
    return {
      ok: false,
      error: "We couldn't load this month's bills just now, so nothing has been sent. Try again in a moment.",
    };
  }
  if (!loaded) return { ok: false, error: "Nothing to work from." };

  const { plan, parkName } = loaded;
  if (plan.totalChased === 0 && plan.blocked.length === 0) {
    return { ok: false, error: "Nobody to remind." };
  }

  const admin = createServiceClient();
  const log: Record<string, unknown>[] = [];
  let sent = 0;

  for (const r of plan.toSend) {
    const contact = await emailFor(admin, r.renterId);
    // "No email address on file." is a fact about their record, and it was
    // being written into a permanent log row at the exact moment we could not
    // read that record. The owner reads this list to decide who to post a
    // notice to; it has to say which of the two happened.
    if (contact.failed) {
      log.push({
        park_id: parkId, charge_id: r.chargeId, party: "resident",
        channel: "email", outcome: "failed",
        reason: "We couldn't look up their contact details, so nothing was sent to them. Try them again.",
      });
      continue;
    }
    if (!contact.email) {
      log.push({
        park_id: parkId, charge_id: r.chargeId, party: "resident",
        channel: "email", outcome: "failed", reason: "No email address on file.",
      });
      continue;
    }
    const res = await sendEmail({
      to: contact.email,
      subject: `${parkName} — $${r.balance.toFixed(2)} outstanding on lot ${r.lotNumber}`,
      text: r.body,
      html: asHtml(r.body),
    });
    if (res?.ok === false) {
      log.push({
        park_id: parkId, charge_id: r.chargeId, party: "resident",
        channel: "email", outcome: "failed",
        reason: "The email didn't go — check the address.", body: r.body,
      });
      continue;
    }
    sent += 1;
    log.push({
      park_id: parkId, charge_id: r.chargeId, party: "resident",
      channel: "email", outcome: "sent", body: r.body,
    });
  }

  // A printed notice counts as told, once the owner has the sheet in hand.
  for (const r of plan.toPrint) {
    log.push({
      park_id: parkId, charge_id: r.chargeId, party: "resident",
      channel: "paper", outcome: "printed", body: r.body,
    });
  }

  // The ones nothing can reach, WITH the reason, so they are visible rather
  // than absent.
  for (const r of plan.blocked) {
    log.push({
      park_id: parkId, charge_id: r.chargeId, party: "resident",
      channel: r.channel, outcome: "blocked",
      reason: r.reason ?? "Couldn't reach them.", body: r.body,
    });
  }

  // ---- and the owner ------------------------------------------------------
  // "All parties" means the person who ISN'T at the screen. Whoever clicked is
  // reading the result right now; mailing them a summary of what they just did
  // is noise. It's the absent owner of a manager-run park who needs this.
  const digest = ownerDigest(plan, parkName, loaded.month);
  let toldOwners = 0;
  // NEITHER OF THESE MAY THROW. By the time we get here the residents have
  // already been emailed and `log` is not yet written; unwinding now would
  // leave the park chased with no record of it, and the next click would chase
  // them all over again. So these degrade — but they degrade OUT LOUD, in the
  // sentence at the bottom, because "no owner was told" and "we couldn't find
  // out who to tell" are not the same thing.
  let ownerLookupFailed = false;
  if (digest) {
    const actor = await currentUserId();
    const [members, membersFailed] = softRead(
      "who else owns this park",
      await admin.from("park_members").select("user_id").eq("park_id", parkId).eq("role", "owner"),
      [] as { user_id: string | null }[],
    );
    ownerLookupFailed ||= membersFailed;
    const others = (members ?? [])
      .map((m) => m.user_id as string)
      .filter((id) => id && id !== actor);

    if (others.length > 0) {
      const [people, peopleFailed] = softRead(
        "the other owners' addresses",
        await admin.from("users").select("id, email").in("id", others),
        [] as { id: string; email: string | null }[],
      );
      ownerLookupFailed ||= peopleFailed;
      const chased = plan.toSend.concat(plan.toPrint);
      for (const p of people ?? []) {
        const addr = (p.email as string) ?? "";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) continue;
        const res = await sendEmail({
          to: addr,
          subject: `${parkName} — ${plan.totalChased} reminded for ${prettyMonth(loaded.month)}`,
          text: digest,
          html: asHtml(digest),
        });
        if (res?.ok !== false) toldOwners += 1;
      }
      // One row per chased charge, so "was the owner told about lot 3?" has an
      // answer per household rather than per batch.
      if (toldOwners > 0) {
        await admin.from("park_reminders").insert(
          chased.map((r) => ({
            park_id: parkId, charge_id: r.chargeId, party: "owner",
            channel: "email", outcome: "sent",
          })),
        );
      }
    }
  }

  // This log IS the already-reminded guard, read back at the top of `loadPlan`.
  // If it doesn't land, the next click chases everybody a second time — so a
  // failure here is said out loud rather than swallowed under "20 emailed".
  let logSaved = true;
  if (log.length > 0) {
    const logRes = await admin.from("park_reminders").insert(log);
    if (logRes.error) {
      console.error(
        "[write failed] the record of these reminders:",
        logRes.error.code ?? "", logRes.error.message ?? logRes.error,
      );
      logSaved = false;
    }
  }

  revalidatePath("/park/rent");
  return {
    ok: true,
    sent,
    printed: plan.toPrint.length,
    blocked: plan.blocked.length,
    signal:
      `${sent} emailed` +
      (plan.toPrint.length ? `, ${plan.toPrint.length} to print` : "") +
      (plan.blocked.length ? `, ${plan.blocked.length} couldn't be reached` : "") +
      (toldOwners > 0 ? `. ${toldOwners === 1 ? "The owner was" : "Owners were"} sent a summary` : "") +
      (ownerLookupFailed ? ". We couldn't check who else to send a summary to, so assume they weren't told" : "") +
      (logSaved ? "" : ". These sends didn't get recorded, so don't send again until that's checked — they'd be chased twice") +
      ".",
  };
}

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * The notice is written as plain text and stays that way — this only escapes it
 * and keeps the line breaks, so the emailed version reads word-for-word like
 * the printed one. Two different wordings of the same demand is how a dispute
 * starts.
 */
function asHtml(body: string): string {
  const esc = body
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc}</div>`;
}

/**
 * Returns the failure separately from the absence, because the two get written
 * into `park_reminders` as different sentences and the row is permanent. This
 * cannot throw: it runs inside the send loop, after earlier households have
 * already been emailed, and one unreadable renter must not strand the batch
 * half-sent with nothing logged.
 */
async function emailFor(
  admin: ReturnType<typeof createServiceClient>,
  renterId: string | null,
): Promise<{ email: string | null; failed: boolean }> {
  if (!renterId) return { email: null, failed: false };
  const res = await admin
    .from("park_renters").select("email").eq("id", renterId).maybeSingle();
  if (res.error) {
    console.error(
      "[read failed] that household's email:",
      res.error.code ?? "", res.error.message ?? res.error,
    );
    return { email: null, failed: true };
  }
  const email = (res.data?.email as string) ?? null;
  // A string with an @ and a dot after it. Anything less is not an address,
  // and sending to it burns the domain's reputation for nothing.
  return {
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    failed: false,
  };
}

/** The printable sheet — the notices the office hands over. */
export async function printableNotices(
  parkId: string,
  month?: string,
): Promise<{ ok: boolean; notices?: { lotNumber: string; name: string; body: string }[] }> {
  if (!(await assertMyPark(parkId))) return { ok: false };
  // loadPlan throws now, and this is a "use server" export. It has no caller
  // today — but flagged twice across two review passes as the trap it is: wire
  // it to a Print button and a dropped read becomes a blank failure instead of
  // a sentence, on a sheet of paper somebody is about to hand to nineteen
  // households. Closing it now costs four lines.
  let loaded;
  try {
    loaded = await loadPlan(parkId, month);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false };
  }
  if (!loaded) return { ok: false };
  return {
    ok: true,
    notices: loaded.plan.toPrint.map((r) => ({
      lotNumber: r.lotNumber, name: r.name, body: r.body,
    })),
  };
}

/** The owner's own digest — one message about twenty, never twenty. */
export async function ownerReminderDigest(
  parkId: string,
  month?: string,
): Promise<string | null> {
  if (!(await assertMyPark(parkId))) return null;
  // Same trap, and this one returns `string | null` so a ReadFailed cannot even
  // be expressed in its type. Null is the honest answer: no digest, rather than
  // a digest built from a park it could not read.
  let loaded;
  try {
    loaded = await loadPlan(parkId, month);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return null;
  }
  if (!loaded) return null;
  return ownerDigest(loaded.plan, loaded.parkName, loaded.month);
}

export async function todayForPark(): Promise<string> {
  return todayLakeDate();
}
