"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getPlatformSettings } from "@/lib/settings";
import { classifyCustomerMessage, WHITELIST } from "@/lib/comms-classify";
import { triageInboundMessage, populationForOwner } from "@/lib/message-triage";
import { draftCustomerReply } from "@/lib/comms-draft";
import { mustRead, mustCount, softRead, readFailedMessage } from "@/lib/must-read";

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Confirm the signed-in user owns this property. Returns their id, `null` when
 * it genuinely isn't theirs, or a `readFailed` marker when we could not look.
 */
async function assertOwnerProperty(propertyId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const res = await admin
    .from("properties")
    .select("id, owner_id")
    .eq("id", propertyId)
    .maybeSingle();
  // A FAILED READ IS NOT SOMEBODY ELSE'S HOUSE. `null` here becomes "That
  // property isn't yours." — told to the owner, about their own lake home,
  // because a read dropped. Kept as a third state so the caller can say what
  // actually happened instead of accusing them.
  if (res.error) return { readFailed: true as const, error: res.error };
  const data = res.data;
  if (!data || data.owner_id !== user.id) return null;
  return { readFailed: false as const, userId: user.id };
}

/**
 * Messaging autonomy Level 1 (Autonomy Ladder, owner directive 2026-07-23).
 * Runs AFTER the owner's message is safely inserted, and never throws past
 * itself — a classifier/draft hiccup must never break the customer's send.
 * Auto-sends only when EVERY gate holds: the dial is on, the message clears
 * the risk screen, confidence is 'high', the intent is on WHITELIST, and the
 * drafted reply is real (never a mock draft). Otherwise it's a no-op and a
 * human sees the message on the ops board, same as today.
 */
async function maybeAutoReply(
  admin: ReturnType<typeof createServiceClient>,
  propertyId: string,
  ownerId: string,
  body: string,
): Promise<void> {
  const settings = await getPlatformSettings();
  if (settings.aiAutoreplyEnabled !== 1) return;

  // Cost/abuse rail: at most 2 auto-replies per property per hour — a
  // rapid-fire thread gets a human, not an AI echo chamber.
  //
  // THIS RAIL USED TO FAIL OPEN. A failed count is `null`, `(null ?? 0) >= 2`
  // is false, and the rail was skipped precisely when the database was
  // unhappy — the one moment a rapid-fire thread could collect unlimited
  // machine replies. mustCount throws instead; sendOwnerMessage catches it and
  // the message simply goes to a human, which is the safe direction.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const recentAi = mustCount("how many auto-replies we have already sent", await admin
    .from("messages").select("id", { count: "exact", head: true })
    .eq("property_id", propertyId).eq("ai", true).gte("created_at", hourAgo));
  if (recentAi >= 2) return;

  // Never two machine turns in a row: if the last board message before this
  // one was an AI reply, the next word belongs to a human — either the
  // customer moving the thread forward or ops stepping in.
  //
  // FAILED OPEN TOO: an unread thread has no second row, `?.ai` is undefined,
  // and the machine answers itself. Not knowing who spoke last means we do not
  // speak.
  const lastRows = mustRead("who spoke last on this thread", await admin
    .from("messages").select("ai")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: false })
    .limit(2));
  if (((lastRows ?? [])[1] as { ai?: boolean } | undefined)?.ai) return;

  const { intent, confidence, risky } = await classifyCustomerMessage(body);
  if (risky || confidence !== "high" || !WHITELIST.includes(intent)) return;

  // The thread IS the context the reply is drafted from. An unread thread
  // drafts an answer to nothing and sends it to a customer under our name.
  const rows = mustRead("this message thread", await admin
    .from("messages")
    .select("from_user, body, created_at")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: true })
    .limit(50));
  const thread = (rows ?? []).slice(-6).map((r) => ({
    from: (r.from_user === ownerId ? "owner" : "ops") as "owner" | "ops",
    body: (r.body as string) ?? "",
  }));

  const draft = await draftCustomerReply(ownerId, thread);
  if (!draft.ok || draft.mock || !draft.text) return; // never auto-send a mock draft

  const opsUser = mustRead("the ops account to send from", await admin
    .from("users")
    .select("id")
    .eq("role", "ops")
    .limit(1)
    .maybeSingle());
  const opsId = opsUser?.id as string | undefined;
  if (!opsId) return;

  await admin.from("messages").insert({
    property_id: propertyId,
    from_user: opsId,
    body: draft.text,
    ai: true,
  });
}

/**
 * Owner sends a message to LakeLife dispatch. The sender is recorded as the
 * owner's own user id (from_user); the read side labels it "owner" because
 * from_user == the property's owner_id.
 */
export async function sendOwnerMessage(propertyId: string, body: string): Promise<SendResult> {
  const ctx = await assertOwnerProperty(propertyId);
  if (ctx?.readFailed) return { ok: false, error: readFailedMessage("your property", ctx.error) };
  if (!ctx) return { ok: false, error: "That property isn't yours." };

  const text = body.trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Type a message first." };

  const admin = createServiceClient();
  const { error } = await admin.from("messages").insert({
    property_id: propertyId,
    from_user: ctx.userId,
    body: text,
  });
  if (error) return { ok: false, error: error.message };

  // TRIAGE RUNS ON EVERY INBOUND MESSAGE, UNCONDITIONALLY — and specifically
  // BEFORE and INDEPENDENT OF the auto-reply path.
  //
  // This ordering is the whole point. maybeAutoReply() begins with
  // `if (settings.aiAutoreplyEnabled !== 1) return;`, so if triage lived
  // inside it, turning autonomy OFF would also turn off the thing that pages a
  // human about a gas leak. The safety net would be wired to the automation
  // switch, and the moment anyone flipped that switch for an unrelated reason
  // the net would come down with it. Deciding not to answer and telling
  // somebody are the same act.
  let allow = false;
  try {
    const population = await populationForOwner(admin, ctx.userId);
    // The page carries WHERE, so an on-call can decide from the driveway
    // instead of opening an app to find out whose place it is.
    // softRead, NOT mustRead, and the reason matters: a throw here would abort
    // the try block BEFORE triageInboundMessage runs, so a failed read of a
    // nickname would suppress the escalation itself — the gas-leak page would
    // not go out because we could not look up the house's name. Degrade the
    // WHERE to null, log it, and let triage do its job.
    const [prop] = softRead(
      "where this message is coming from",
      await admin.from("properties").select("nickname, address").eq("id", propertyId).maybeSingle(),
      null,
    );
    const where = ((prop?.nickname as string | null) || (prop?.address as string | null)) ?? null;

    const triage = await triageInboundMessage(admin, text, population, { where });
    await admin.from("messages")
      .update(triage.columns)
      .eq("property_id", propertyId)
      .eq("from_user", ctx.userId)
      .order("created_at", { ascending: false })
      .limit(1);
    allow = triage.verdict.outcome === "allow";
  } catch {
    // Triage itself failed. The customer's message is already saved, and we
    // do NOT fall through to the auto-reply: not knowing what a message says
    // is not a reason to let a machine answer it.
    allow = false;
  }

  if (allow) {
    try {
      await maybeAutoReply(admin, propertyId, ctx.userId, text);
    } catch {
      // Classifier/draft/DB hiccup — the send already succeeded and the
      // message is on the board with its verdict. A read maybeAutoReply could
      // not make lands here too (it throws rather than treating a failed count
      // as zero): logged by mustRead/mustCount, and a human answers instead.
    }
  }

  return { ok: true };
}
