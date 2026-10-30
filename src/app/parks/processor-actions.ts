"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "@/app/park/data";
import { assertOps } from "@/app/ops/data";
import { worldActionRefusal } from "@/lib/deployment";
import { notify } from "@/lib/notify";
import {
  APPLICATION_FIELDS, STORED_FIELD_IDS, applicationGaps, taxIdLast4,
} from "@/lib/merchant-application";
import { PROVIDER, PROVIDER_LABEL } from "./merchant-application-data";

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
  parkId: string, provider = PROVIDER,
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

/**
 * OPS CORRECTS WHICH ACCOUNT WE SAY THE MONEY SETTLES TO.
 *
 * ============ THIS CHANGES OUR RECORD, NOT THE DESTINATION ============
 *
 * `settlement_last4` is our copy of a fact the PROCESSOR owns. The money goes
 * wherever they send it, and nothing in this application can move it. So if
 * these four digits are wrong, two different things are true and only one of
 * them is fixed here:
 *
 *   OUR RECORD IS WRONG and the money is fine — somebody keyed it wrong when
 *   the merchant went live. This fixes it.
 *
 *   THE PROCESSOR IS SETTLING TO THE WRONG ACCOUNT. This fixes NOTHING, and
 *   quietly editing our copy would make the one screen that could have raised
 *   the alarm agree with the mistake. The signal says so, because an ops
 *   person who thinks they have redirected the money will stop looking.
 *
 * WHY THERE IS A DOOR AT ALL: 0196 does not freeze the column — checked on
 * production — and until now nothing could write it after activation. A wrong
 * four digits on the one line that tells a park owner where his residents'
 * rent lands is a lie we had no way to correct.
 */
export async function correctSettlementAccount(
  accountId: string, last4: string,
): Promise<ProcessorResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };
  const four = last4.trim();
  if (!/^\d{4}$/.test(four)) {
    return { ok: false, error: "The settlement account's last four digits, as four numbers." };
  }

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("processor_accounts")
    .update({ settlement_last4: four })
    .eq("id", accountId)
    // ONLY A LIVE ONE. A draft has no settlement account yet and a closed one
    // is a record of what used to be true; editing either would be rewriting
    // history rather than correcting a copy.
    .eq("status", "active")
    .select("id, settlement_last4")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) {
    return { ok: false, error: "That setup isn't live, so it has no settlement account to correct." };
  }

  revalidatePath("/ops");
  revalidatePath("/park/setup");
  return {
    ok: true,
    signal:
      `Our record now says the money settles to the account ending ${four}. ` +
      "This changed OUR copy only — if the processor is sending it somewhere " +
      "wrong, that has to be fixed with them.",
  };
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


// ===========================================================================
// THE MERCHANT APPLICATION — save a draft, then one tap sends it
// ===========================================================================

/** Only the ids the application owns, so a patch can never set `status`. */
const WRITABLE = new Set(STORED_FIELD_IDS);

/**
 * Save what he has filled in so far.
 *
 * Creates the row if he has not started one — the application IS the draft, so
 * asking him to click "begin" before typing would be ceremony for its own
 * sake. 0201's trigger clears `application_ready_at` on any field change, so
 * a saved draft is correctly un-ready until it is sent.
 */
export async function saveApplication(
  parkId: string, patch: Record<string, unknown>,
): Promise<ProcessorResult> {
  const auth = await assertParkOwner(parkId);
  if (!auth.ok) return { ok: false, error: auth.error };

  // NEVER TRUST THE SHAPE FROM A CLIENT. Anything not on the application is
  // dropped rather than passed through to the update — `status`,
  // `provider_merchant_id` and `submitted_at` all live on this table.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!WRITABLE.has(k)) continue;
    clean[k] = typeof v === "string" && v.trim() === "" ? null : v;
  }
  if (Object.keys(clean).length === 0) return { ok: true };

  const admin = createServiceClient();
  const open = await admin
    .from("processor_accounts").select("id, submitted_at")
    .eq("park_id", parkId).eq("provider", PROVIDER)
    .not("status", "in", "(disabled,rejected)")
    .maybeSingle();
  if (open.error) {
    console.error("[application] could not read the draft:", open.error.message);
    return { ok: false, error: "We couldn't save that just now — nothing has changed." };
  }
  const draftRow = open.data as { id: string; submitted_at: string | null } | null;

  if (draftRow?.submitted_at) {
    // 0201 refuses this at the database, and the refusal is right: the change
    // would reach nobody. Say so before the write rather than after.
    return {
      ok: false,
      error: `That application has already gone to ${PROVIDER_LABEL}. If something is wrong, tell us and we'll start a fresh one.`,
    };
  }

  const { error } = draftRow
    ? await admin.from("processor_accounts").update(clean).eq("id", draftRow.id)
    : await admin.from("processor_accounts").insert({ park_id: parkId, provider: PROVIDER, ...clean });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/park/setup");
  return { ok: true };
}

/**
 * ONE TAP: send the application.
 *
 * `taxId` arrives HERE and is never stored. We keep four digits so a screen
 * can tell two entities apart; the rest goes to the processor. That is the
 * same posture 0197 took for a resident's bank account, and 0201's
 * post-condition fails the migration if a column here is even NAMED like one.
 *
 * THE GAPS ARE RE-CHECKED ON THE SERVER. The screen hides the tap until the
 * form is complete, but a hidden button is not a guard — and a half-filled
 * application comes back rejected, which under 0196 means opening a whole new
 * account rather than fixing a field.
 */
export async function submitApplication(
  parkId: string, patch: Record<string, unknown>, taxId: string,
): Promise<ProcessorResult> {
  const auth = await assertParkOwner(parkId);
  if (!auth.ok) return { ok: false, error: auth.error };

  // A branch deploy must not send a park owner's identity documents to a
  // third party. Preview holds live credentials and shares this database.
  const refusal = worldActionRefusal("send");
  if (refusal) return { ok: false, error: refusal };

  const last4 = taxIdLast4(taxId);
  if (!last4) {
    return { ok: false, error: "That EIN or SSN doesn't look right — it should be nine digits." };
  }

  const admin = createServiceClient();
  const open = await admin
    .from("processor_accounts")
    // A dynamic select string defeats supabase-js's type inference, so the
    // row is read wide and narrowed here rather than typed at the call.
    .select("*")
    .eq("park_id", parkId).eq("provider", PROVIDER)
    .not("status", "in", "(disabled,rejected)")
    .maybeSingle();
  if (open.error) {
    console.error("[application] could not read before sending:", open.error.message);
    return { ok: false, error: "We couldn't send it just now — nothing was sent and nothing has changed." };
  }
  const row = open.data as (Record<string, unknown> & { id: string; submitted_at: string | null }) | null;
  if (row?.submitted_at) {
    return { ok: false, error: `This application has already gone to ${PROVIDER_LABEL}.` };
  }

  // What the row will hold once this patch lands, which is what the processor
  // will actually receive.
  const merged: Record<string, unknown> = { ...(row ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (WRITABLE.has(k)) merged[k] = typeof v === "string" && v.trim() === "" ? null : v;
  }
  const gaps = applicationGaps({ ...merged, tax_id: taxId }, APPLICATION_FIELDS);
  if (gaps.length > 0) {
    return {
      ok: false,
      error: `Not quite ready — ${gaps.length === 1 ? "this is" : "these are"} still missing: ${gaps.join(", ")}.`,
    };
  }

  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {};
  for (const id of STORED_FIELD_IDS) payload[id] = merged[id] ?? null;
  payload.tax_id_last4 = last4;
  // ONE UPDATE, and the single statement is load-bearing. 0201's trigger
  // clears `application_ready_at` whenever an application field changes —
  // UNLESS that same statement is the one setting it. Splitting this into
  // "save the fields" then "mark it ready" would have the first wipe what the
  // second needs, and the CHECK would then refuse `submitted_at`.
  payload.application_ready_at = now;
  payload.status = "submitted";
  payload.submitted_at = now;

  const { error } = row
    ? await admin.from("processor_accounts").update(payload).eq("id", row.id)
    : await admin.from("processor_accounts").insert({ park_id: parkId, provider: PROVIDER, ...payload });
  if (error) {
    console.error("[application] the send failed:", error.message);
    return { ok: false, error: "We couldn't send it just now — nothing was sent. Try again in a moment." };
  }

  // ========================= THE API CALL IS NOT HERE =======================
  // US Card Solutions' boarding API is not written yet, and it cannot be: they
  // are an ISO/agent reselling another platform, so the endpoint, the field
  // names and the auth all belong to whichever processor they put us on, and
  // that is still an open question (docs/the-money-architecture-as-decided.md
  // §4). Guessing it would be an integration written against a contract that
  // does not exist, in the one direction where being wrong means a park
  // owner's identity documents go somewhere unintended.
  //
  // So the application is RECORDED and ops is told it needs sending by hand.
  // The screen says exactly that. When the spec arrives this is where the call
  // goes, and the row above is already the payload.
  try {
    const ops = await admin.from("users").select("email, phone").eq("role", "ops");
    for (const o of ops.data ?? []) {
      await notify(
        `ops that a park's merchant application is ready to send to ${PROVIDER_LABEL}`,
        { email: (o.email as string) ?? null, phone: (o.phone as string) ?? null },
        {
          subject: `A merchant application is ready for ${PROVIDER_LABEL}`,
          body:
            `A park owner has completed their merchant application and tapped send.\n\n` +
            `It is recorded in full and is waiting to go to ${PROVIDER_LABEL}. ` +
            `Their EIN is NOT stored — ask the owner for it when you submit.\n\n` +
            `Open /ops to see it.`,
          sms: `LakeLife: a park's merchant application is ready to send to ${PROVIDER_LABEL}. 🌊`,
        },
      );
    }
  } catch { /* the application is recorded; an unsent nudge must not undo it */ }

  revalidatePath("/park/setup");
  return {
    ok: true,
    signal: `Sent. ${PROVIDER_LABEL} decides from here — we'll tell you either way.`,
  };
}
