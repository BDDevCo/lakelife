"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "@/app/park/data";
import { sendEmail } from "@/lib/email";
import {
  mintInviteToken, inviteTokenHash, inviteUrl, inviteCopy,
  inviteIssueSays, inviteClaimSays, inviteWorked, officeCanReissue,
} from "@/lib/park-invite";

/**
 * THE OTHER END OF A SLIP OF PAPER.
 *
 * Same destination as the printed code, different door: a household with an
 * address on file gets one email with a link, and the office never touches a
 * printer for them. Households with no address still get a slip — that path is
 * unchanged and remains the only one that works for somebody we cannot reach.
 *
 * USER-SCOPED CLIENT, NOT THE SERVICE ROLE. Both database functions read
 * `auth.uid()`; `claim_park_file_by_invite` also reads `auth.email()` and
 * refuses unless it matches the address the invite went to. Calling either
 * with the service role hands it a null identity and refuses every time —
 * which is the same reasoning as the claim-code path, for the same reason.
 */

export interface InviteResult {
  ok: boolean;
  message: string;
  outcome: string;
  reissuable?: boolean;
}

/** Where the link points. Behind a proxy the Host header is what the browser saw. */
async function originFromRequest(): Promise<string> {
  const h = await headers();
  const envOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (envOrigin) return envOrigin;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "lakelife.ai";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Invite one household.
 *
 * ORDER MATTERS AND IT IS DELIBERATE: the database is asked FIRST, and only a
 * successful mint leads to a send. Sending first and recording afterwards is
 * how a household gets two emails and a token that no longer opens anything.
 * A send that fails leaves an unused token behind, which costs nothing — the
 * office can try again tomorrow, or print a slip today.
 */
export async function inviteHousehold(renterId: string): Promise<InviteResult> {
  const supabase = await createClient();

  // The address and the details for the letter. Service-role read of ONE file,
  // then every write goes through the user-scoped RPC that checks membership.
  const admin = createServiceClient();
  const { data: file } = await admin
    .from("park_renters")
    .select("id, park_id, display_name, email, user_id, claim_declined_at")
    .eq("id", renterId)
    .maybeSingle();
  if (!file) return { ok: false, outcome: "invite_no_file", message: inviteIssueSays("invite_no_file") };

  // MEMBERSHIP BEFORE ANYTHING IS READ ALOUD. `issue_park_invite` checks this
  // too and is the real gate, but the sentences below describe a household —
  // whether they have an email, what their lot is — and a stranger passing
  // renter ids should not learn that by reading our refusals.
  if (!(await assertMyPark(file.park_id as string))) {
    return { ok: false, outcome: "invite_not_your_park", message: inviteIssueSays("invite_not_your_park") };
  }

  const email = (file.email as string | null)?.trim();
  if (!email) {
    return {
      ok: false,
      outcome: "invite_no_email",
      // Not a failure — a fact about what we hold, with the way forward in it.
      message: "No email on file for them — print a slip instead.",
    };
  }

  const [{ data: park }, { data: stay }] = await Promise.all([
    admin.from("parks").select("name").eq("id", file.park_id as string).maybeSingle(),
    admin
      .from("lot_reservations")
      .select("park_lot_id, park_lots(lot_number)")
      .eq("renter_id", renterId)
      .in("status", ["approved", "active"])
      .limit(1)
      .maybeSingle(),
  ]);

  const lotNumber =
    ((stay?.park_lots as { lot_number?: string } | null)?.lot_number as string) ?? "—";

  const token = mintInviteToken();
  const { data, error } = await supabase.rpc("issue_park_invite", {
    p_renter_id: renterId,
    p_token_hash: inviteTokenHash(token),
    p_email: email,
    p_days: 30,
  });
  if (error) {
    console.error("[invite] issue rpc failed", error.message);
    return { ok: false, outcome: "rpc_error", message: "Couldn't create that invite just now." };
  }

  const outcome = String(data ?? "");
  if (!inviteWorked(outcome)) {
    return { ok: false, outcome, message: inviteIssueSays(outcome) };
  }

  const copy = inviteCopy({
    parkName: (park?.name as string) ?? "Your park",
    lotNumber,
    displayName: (file.display_name as string) ?? "",
    url: inviteUrl(await originFromRequest(), token),
  });

  // `sendEmail` carries the recipient gate, so a scratch address is refused in
  // here rather than delivered. A REFUSED SEND MUST NOT READ AS SENT — that was
  // the bug in the crew invites, where `void sendEmail(...)` turned a refusal
  // into "50 invited".
  const sent = await sendEmail({ to: email, subject: copy.subject, html: copy.html, text: copy.text });
  if (!sent.ok) {
    // UNDO THE STAMP. The mint happened first so a send could never be
    // recorded twice — but leaving it set after a REFUSED send is worse than
    // the problem it solved: the roll shows "Emailed" for somebody who was
    // never written to, and the bulk action skips them from then on as already
    // invited. Found on screen: the recipient gate refused an address and the
    // household came back marked emailed, with a live token, having received
    // nothing.
    //
    // Membership was asserted above, so this is scoped and safe.
    await admin
      .from("park_renters")
      .update({
        invite_token_hash: null,
        invite_sent_at: null,
        invite_expires_at: null,
        invite_email: null,
      })
      .eq("id", renterId);

    return {
      ok: false,
      outcome: "invite_send_failed",
      message: `We couldn't email ${email}. Print a slip for them instead.`,
    };
  }

  revalidatePath("/park");
  return { ok: true, outcome, message: `Emailed ${email}.` };
}

export interface BulkInviteResult {
  ok: boolean;
  sent: number;
  /**
   * Named, because these are the ones he must now do on paper — and each says
   * WHY. "No address on file" is a gap to fill when he next sees them; "we
   * couldn't send it" is a bad address to correct. Reporting both as the same
   * sentence sends him looking for the wrong thing.
   */
  needSlips: {
    renterId: string;
    displayName: string;
    lotNumber: string;
    why: "no_email" | "send_failed";
  }[];
  skipped: number;
  message: string;
}

/**
 * Invite everyone who can be reached, and NAME everyone who can't.
 *
 * The count is the easy half. The list is the useful half: "12 emailed" tells
 * him nothing about the seven households still sitting there, and a park where
 * seven people are quietly never contacted is exactly the failure the printed
 * slip existed to prevent.
 *
 * ALREADY-INVITED HOUSEHOLDS ARE SKIPPED, not re-sent. "One invite, then
 * silence" is the rule; pressing this button twice must not mean two emails.
 */
export async function inviteEveryone(parkId: string): Promise<BulkInviteResult> {
  const admin = createServiceClient();

  if (!(await assertMyPark(parkId))) {
    return { ok: false, sent: 0, needSlips: [], skipped: 0, message: "You don't manage that park." };
  }

  const { data: rows } = await admin
    .from("park_renters")
    .select("id, display_name, email, user_id, claim_declined_at, invite_sent_at")
    .eq("park_id", parkId);

  const candidates = (rows ?? []).filter(
    (r) => r.user_id == null && r.claim_declined_at == null,
  );

  // Lot numbers, so the "needs a slip" list is something he can walk with.
  const lotByRenter = new Map<string, string>();
  if (candidates.length > 0) {
    const { data: stays } = await admin
      .from("lot_reservations")
      .select("renter_id, park_lots(lot_number)")
      .in("renter_id", candidates.map((r) => r.id as string))
      .in("status", ["approved", "active"]);
    for (const s of stays ?? []) {
      const n = (s.park_lots as { lot_number?: string } | null)?.lot_number;
      if (n) lotByRenter.set(s.renter_id as string, n);
    }
  }

  let sent = 0;
  let skipped = 0;
  const needSlips: BulkInviteResult["needSlips"] = [];

  for (const r of candidates) {
    const label = {
      renterId: r.id as string,
      displayName: (r.display_name as string) ?? "—",
      lotNumber: lotByRenter.get(r.id as string) ?? "—",
    } as const;
    if (r.invite_sent_at != null) { skipped++; continue; }
    if (!((r.email as string | null)?.trim())) {
      needSlips.push({ ...label, why: "no_email" });
      continue;
    }

    const res = await inviteHousehold(r.id as string);
    if (res.ok) sent++;
    // A send that failed still needs reaching — it belongs on the paper list
    // rather than in a silence.
    else needSlips.push({ ...label, why: "send_failed" });
  }

  revalidatePath("/park");
  const parts = [`${sent} emailed`];
  if (needSlips.length) parts.push(`${needSlips.length} need a slip`);
  if (skipped) parts.push(`${skipped} already invited`);
  return { ok: true, sent, needSlips, skipped, message: parts.join(" · ") };
}

/** The resident follows the link. */
export async function claimByInvite(token: string): Promise<InviteResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("claim_park_file_by_invite", { p_token: token });
  if (error) {
    console.error("[invite] claim rpc failed", error.message);
    return { ok: false, outcome: "rpc_error", message: "We couldn't reach your records just now. Try again in a minute." };
  }
  const outcome = String(data ?? "");
  const ok = outcome === "claimed";
  if (ok) {
    revalidatePath("/parks/my");
    revalidatePath("/portal");
  }
  return { ok, outcome, message: inviteClaimSays(outcome), reissuable: !ok && officeCanReissue(outcome) };
}
