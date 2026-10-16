"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "@/app/park/data";
import { assertOps } from "@/app/ops/data";

/**
 * GETTING A PARK SET UP TO RECEIVE ITS OWN RENT.
 *
 * 0196 built the registry that records who money settles to, and the
 * capability that refuses to charge without one. It shipped with **no
 * writer** — so every park read as "nobody has been set up to receive it",
 * permanently, and there was no door anywhere to change that. A gate that can
 * never open is worse than no gate: the old state was wrong and fixable, that
 * one was correct and stuck.
 *
 * ============ WHO MAY DO WHAT, AND WHY IT SPLITS ============
 *
 * THE OWNER MAY ASK. Starting the setup is his decision about his own park,
 * and it costs nothing: a `draft` row saying this park wants to collect rent
 * into its own account.
 *
 * ONLY OPS MAY SAY IT IS LIVE. Marking a merchant active is what opens the
 * money gate, and the facts behind it — the processor's merchant id, which
 * rails they approved, which account settles — are things only the processor
 * tells us. A park owner who could write those would be granting himself the
 * ability to take residents' money with nothing verified behind it, which is
 * exactly what 0196's REVOKE stops at the database. The action layer has to
 * draw the same line or the REVOKE is the only thing holding it.
 *
 * ============ WHY THERE IS NO API CALL HERE YET ============
 *
 * Creating the merchant with the processor is one HTTP call, and its shape —
 * the field names, the onboarding flow, whether it is redirect-free — is
 * exactly what the processor roadmap's Step 1 asks and nobody has answered.
 * Inventing it would be inventing the integration. So the state machine is
 * real and local, and the submission is recorded by whoever actually does it.
 * For the first park that is a person with the processor's dashboard open,
 * which is the honest shape of a pilot.
 */

export interface ProcessorResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

const DENIED = "You don't manage that park.";
const OWNER_ONLY = "Only the park owner can set up how the park gets paid.";

/** Membership AND the owner role, so no action here forgets one. */
async function assertParkOwner(parkId: string): Promise<
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
 * The owner asks to be set up to receive rent.
 *
 * Creates the `draft`. It grants nothing — `rentCapability` reads a draft as
 * "still with the processor", which is a refusal — and it is not a formality:
 * it is what puts this park on the ops console's list of parks waiting to be
 * set up. Without that the request would be a row nobody reads.
 */
export async function startProcessorSetup(
  parkId: string, provider = "finix",
): Promise<ProcessorResult> {
  const auth = await assertParkOwner(parkId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createServiceClient();

  // ALREADY ASKED? 0196's partial unique index refuses a second live row, and
  // a bare insert's 23505 reads as `data: null` — "try again" for a path that
  // cannot succeed. Say which case it is instead.
  const open = await admin
    .from("processor_accounts")
    .select("id, status")
    .eq("park_id", parkId)
    .eq("provider", provider)
    .not("status", "in", "(disabled,rejected)")
    .maybeSingle();
  if (open.error) {
    console.error("[processor] whether this park already asked:", open.error.message);
    return { ok: false, error: "We couldn't check your payment setup just now — nothing has changed." };
  }
  if (open.data) {
    const status = (open.data as { status: string }).status;
    return {
      ok: false,
      error: status === "active"
        ? "This park is already set up to receive rent."
        : "You've already asked — we're setting this up and will tell you when it's live.",
    };
  }

  const { error } = await admin
    .from("processor_accounts")
    .insert({ park_id: parkId, provider });
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "You've already asked — we're setting this up." };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/park/setup");
  revalidatePath("/ops");
  return {
    ok: true,
    signal:
      "Asked. We'll set you up to receive rent in the account you already " +
      "use, and tell you when residents can pay in the app.",
  };
}

/**
 * OPS records what the processor gave back.
 *
 * Two steps on purpose, matching what actually happens: a merchant id exists
 * once an application has been sent, and the capabilities exist once it is
 * approved. 0196 refuses an id before submission and refuses an `active` row
 * without an id, a day and a destination, so neither half can be guessed.
 */
export async function recordProcessorSubmission(
  accountId: string, merchantId: string,
): Promise<ProcessorResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };
  const id = merchantId.trim();
  if (!id) return { ok: false, error: "What merchant id did the processor give?" };

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("processor_accounts")
    .update({
      status: "submitted",
      provider_merchant_id: id,
      submitted_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) {
    // 0196 refuses a backwards move and an id change at the trigger; this
    // says which of those it was rather than surfacing a constraint name.
    return { ok: false, error: "That setup isn't waiting to be sent — reload to see where it got to." };
  }

  revalidatePath("/ops");
  return { ok: true, signal: `Recorded. Waiting on the processor to approve ${id}.` };
}

/**
 * OPS marks it live, with what the processor actually approved.
 *
 * EVERY CAPABILITY IS EXPLICIT. They default false in the table because they
 * are the processor's answer; passing them here means somebody read the
 * approval rather than assuming a merchant approved for one rail is approved
 * for all of them.
 */
export async function activateProcessorAccount(
  accountId: string,
  input: {
    canAcceptAch: boolean;
    canAcceptCard: boolean;
    canReceivePayout: boolean;
    settlementLast4: string;
  },
): Promise<ProcessorResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };

  const last4 = input.settlementLast4.trim();
  if (!/^\d{4}$/.test(last4)) {
    return { ok: false, error: "The settlement account's last four digits, as four numbers." };
  }
  if (!input.canAcceptAch && !input.canAcceptCard && !input.canReceivePayout) {
    // 0196 refuses this too. Saying it here makes it a sentence rather than a
    // constraint name, and names why it matters.
    return {
      ok: false,
      error: "A live merchant approved for nothing can't be paid or pay out — record what the processor actually approved.",
    };
  }

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("processor_accounts")
    .update({
      status: "active",
      activated_at: new Date().toISOString(),
      can_accept_ach: input.canAcceptAch,
      can_accept_card: input.canAcceptCard,
      can_receive_payout: input.canReceivePayout,
      settlement_last4: last4,
    })
    .eq("id", accountId)
    .eq("status", "submitted")
    .select("id, park_id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) {
    return { ok: false, error: "That setup isn't waiting to go live — reload to see where it got to." };
  }

  revalidatePath("/ops");
  revalidatePath("/park/setup");
  return {
    ok: true,
    signal:
      `Live. Money settles to the account ending ${last4}` +
      (input.canAcceptAch ? ", and residents can pay by bank transfer." : "."),
  };
}

/** OPS closes one. 0196 makes this one-way — a new account replaces it. */
export async function disableProcessorAccount(
  accountId: string, reason: string,
): Promise<ProcessorResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };
  const why = reason.trim().slice(0, 300);
  if (!why) return { ok: false, error: "Say why, so the record explains itself later." };

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("processor_accounts")
    .update({ status: "disabled", disabled_at: new Date().toISOString(), disabled_reason: why })
    .eq("id", accountId)
    .not("status", "in", "(disabled,rejected)")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That setup is already closed." };

  revalidatePath("/ops");
  revalidatePath("/park/setup");
  return { ok: true, signal: "Closed. Rent can't be collected online until a new setup is live." };
}

export interface ProcessorAccountView {
  id: string;
  provider: string;
  status: "draft" | "submitted" | "active" | "rejected" | "disabled";
  merchantId: string | null;
  canAcceptAch: boolean;
  canAcceptCard: boolean;
  canReceivePayout: boolean;
  settlementLast4: string | null;
  parkId: string | null;
  parkName: string | null;
}

/**
 * The parks waiting to be set up, for the ops console.
 *
 * THIS IS THE READER THAT MAKES THE OWNER'S ASK REAL. A draft nobody ever
 * looks at is a request that silently never happens — the shape that put
 * "a symbol with no caller" in this codebase's vocabulary.
 */
export async function getProcessorQueue(): Promise<ProcessorAccountView[] | null> {
  if (!(await assertOps())) return null;
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("processor_accounts")
    .select("id, provider, status, provider_merchant_id, can_accept_ach, can_accept_card, can_receive_payout, settlement_last4, park_id, parks(name)")
    .not("status", "in", "(disabled,rejected)")
    .order("created_at", { ascending: true });
  if (error) {
    // A FAILED READ IS NOT AN EMPTY QUEUE. An empty list here reads as "no
    // park is waiting", which is the reassuring way to be wrong.
    console.error("[processor] the setup queue:", error.message);
    return null;
  }
  return (data ?? []).map((r) => {
    const park = Array.isArray(r.parks) ? r.parks[0] : r.parks;
    return {
      id: r.id as string,
      provider: r.provider as string,
      status: r.status as ProcessorAccountView["status"],
      merchantId: (r.provider_merchant_id as string | null) ?? null,
      canAcceptAch: r.can_accept_ach === true,
      canAcceptCard: r.can_accept_card === true,
      canReceivePayout: r.can_receive_payout === true,
      settlementLast4: (r.settlement_last4 as string | null) ?? null,
      parkId: (r.park_id as string | null) ?? null,
      parkName: ((park as { name?: string } | null)?.name) ?? null,
    };
  });
}
