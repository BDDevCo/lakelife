/**
 * CAN THIS PARK TAKE RENT ONLINE — THE WHOLE QUESTION, IN ONE PLACE.
 *
 * There have been two conditions here and there needed to be three.
 *
 *   1. `parks.accepts_online_rent` — the owner's WISH. Switched on at The
 *      Haven since the park was configured.
 *   2. `paymentsAreLive()` — LAKELIFE_PAYMENTS_LIVE, ONE DEPLOYMENT-WIDE
 *      BOOLEAN meaning "LakeLife has a processor at all". Unset today.
 *   3. **And the one that was missing: can THIS park's owner actually receive
 *      the money, into their own account?**
 *
 * Condition 3 did not exist because nothing recorded the answer. Verified
 * against production on 15 Oct 2026: no registry table, no merchant column on
 * `parks` or `vendors`, and The Haven switched on to take rent online with no
 * record anywhere of who receives it.
 *
 * Under Architecture A that gap is not cosmetic. Rent belongs to the park
 * owner and settles into the park owner's OWN existing bank account, which
 * means the charge has to be made on behalf of the owner's merchant. With no
 * merchant on file the only one that exists is LakeLife's — so the day the
 * global flag is set, a resident's rent would settle to us. That is the pooled
 * model we deliberately rejected, arriving by omission rather than by
 * decision, on somebody else's money.
 *
 * `a-switch-is-a-wish-a-processor-is-a-rail` fixed conditions 1 and 2 against
 * each other. This is the same defect one level up: a global switch standing
 * in for a per-park capability.
 *
 * ============ TWO AUDIENCES, TWO SENTENCES ============
 *
 * A resident must never read "your landlord has not finished onboarding with
 * our payment processor." That is true, useless to her, and nobody's business
 * but the park's. She gets one sentence: this park is not taking online rent
 * yet, here is what to do instead. The OWNER gets the real reason and the next
 * action, because he is the only person who can end it.
 */

import { paymentsAreLive } from "@/lib/charge-gate";
import type { createServiceClient } from "@/lib/supabase/server";

export type RentBlock =
  /** No processor is connected to LakeLife at all. */
  | "no_processor"
  /** The owner has not switched online rent on. */
  | "park_switch_off"
  /** Nobody has started setting the owner up to receive money. */
  | "owner_not_onboarded"
  /** Sent to the processor, not approved yet. */
  | "owner_pending"
  /** The processor turned them down, or the account was closed. */
  | "owner_closed"
  /** Live, but approved for nothing that can collect rent. */
  | "owner_cannot_collect"
  /** WE DO NOT KNOW. Never treated as a yes. */
  | "read_failed";

/** The shape of the one live processor account, as a doorway needs it. */
export interface MerchantFacts {
  status: "draft" | "submitted" | "active" | "rejected" | "disabled";
  canAcceptAch: boolean;
  canAcceptCard: boolean;
  settlementLast4: string | null;
}

export interface RentCapability {
  /** The only thing a money doorway should branch on. */
  canTakeOnlineRent: boolean;
  byAch: boolean;
  byCard: boolean;
  block: RentBlock | null;
  /** Shown to a resident. Never names the owner's paperwork. */
  saidToResident: string;
  /** Shown to the park owner. Names the reason and the next act. */
  saidToOwner: string;
}

const CAN: RentCapability = {
  canTakeOnlineRent: true, byAch: true, byCard: true, block: null,
  saidToResident: "", saidToOwner: "",
};

/**
 * Decide it, from facts a caller has already read.
 *
 * ORDER MATTERS, and it runs from the thing furthest from the owner's control
 * to the thing nearest: a park owner told "switch online rent on" when the
 * real problem is that LakeLife has no processor would switch it on and find
 * nothing changed.
 *
 * `merchant === undefined` means NOBODY LOOKED — a caller that could not read
 * the registry. It is `read_failed`, never "not onboarded": a dropped
 * connection must not read as a park that never applied, and it must never
 * read as a yes.
 */
export function rentCapability(opts: {
  /** parks.accepts_online_rent */
  parkSwitchOn: boolean;
  /** The one live processor account for this park, or null if there is none. */
  merchant: MerchantFacts | null | undefined;
  /** Defaults to the deployment flag; passed in only by tests. */
  processorConnected?: boolean;
}): RentCapability {
  const connected = opts.processorConnected ?? paymentsAreLive();

  const no = (
    block: RentBlock, saidToResident: string, saidToOwner: string,
  ): RentCapability => ({
    canTakeOnlineRent: false, byAch: false, byCard: false,
    block, saidToResident, saidToOwner,
  });

  // The resident's sentence is the same for every one of these, deliberately.
  // Which of our arrangements is unfinished is not information she can use.
  const toResident =
    "This park isn't taking rent online yet. Pay the office the way you do " +
    "now, and tell us here once you have, so your ledger stays right.";

  if (!connected) {
    return no("no_processor", toResident,
      "No payment processor is connected to LakeLife yet, so no park can take " +
      "rent online — including yours. Nothing is wrong with your setup.");
  }

  if (!opts.parkSwitchOn) {
    return no("park_switch_off", toResident,
      "Online rent is switched off for this park. Turn it on in Park setup, " +
      "under how rent comes in.");
  }

  if (opts.merchant === undefined) {
    // A FAILED READ IS NOT AN ANSWER. Refusing is the safe direction: the
    // worst case is a resident paying the office for one month.
    return no("read_failed",
      "We couldn't check whether this park is taking rent online just now. " +
      "Pay the office the way you do now and try here again later.",
      "We couldn't read your payment setup just now, so online rent is paused " +
      "rather than guessed at. Try again in a moment.");
  }

  if (opts.merchant === null) {
    return no("owner_not_onboarded", toResident,
      "Before this park can take rent online, you need to be set up to " +
      "receive it — a few minutes, and the money goes to the bank account you " +
      "already use. Start that in Park setup.");
  }

  const m = opts.merchant;

  if (m.status === "rejected" || m.status === "disabled") {
    return no("owner_closed", toResident,
      "Your payment setup was closed, so rent can't be collected online. " +
      "Get in touch and we'll start a new one.");
  }

  if (m.status === "draft" || m.status === "submitted") {
    return no("owner_pending", toResident,
      m.status === "draft"
        ? "Your payment setup was started but never finished. Pick it up in " +
          "Park setup — nothing happens until it is done."
        : "Your payment setup is with the processor. Rent can be collected " +
          "online as soon as they approve it; nothing is needed from you.");
  }

  // Active, but approved for nothing that collects rent. A merchant approved
  // only for payouts can be paid BY us and still cannot be paid by a resident.
  if (!m.canAcceptAch && !m.canAcceptCard) {
    return no("owner_cannot_collect", toResident,
      "Your payment setup is live but isn't approved to collect rent yet. " +
      "Get in touch and we'll chase the processor.");
  }

  return {
    ...CAN,
    byAch: m.canAcceptAch,
    byCard: m.canAcceptCard,
    saidToOwner: m.settlementLast4
      ? `Rent collected online goes to your account ending ${m.settlementLast4}.`
      : "Rent collected online goes to your own bank account.",
  };
}

/**
 * The one live account out of whatever the registry returned.
 *
 * 0196 keeps one live row per (provider, park) with a partial unique index, so
 * there is at most one — but a caller holding an array should not be the place
 * that decides which. Closed rows are skipped rather than ranked: a disabled
 * account is not a weaker yes, it is a no.
 */
export function liveMerchant(
  rows: readonly MerchantFacts[] | null | undefined,
): MerchantFacts | null | undefined {
  if (rows == null) return undefined;
  return rows.find((r) => r.status !== "disabled" && r.status !== "rejected") ?? null;
}

/**
 * Read the registry and decide, for one park.
 *
 * ONE DOORWAY'S WORTH OF WORK, SHARED. `payRent`, the resident's screen, the
 * owner's setup screen and the readiness checklist all have to reach the same
 * verdict — and the rule living in one of four doorways is the shape this
 * codebase keeps paying for. The read failing yields `undefined`, which
 * `rentCapability` turns into a refusal rather than a guess.
 */
export async function loadRentCapability(
  // The real client's type, rather than a structural stand-in: a hand-written
  // shape made TypeScript instantiate the Supabase generics to an excessive
  // depth at the my-data call site.
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  parkSwitchOn: boolean,
): Promise<RentCapability> {
  const res = await admin
    .from("processor_accounts")
    .select("status, can_accept_ach, can_accept_card, settlement_last4")
    .eq("park_id", parkId);

  if (res.error) {
    console.error("[rent] whether this park can collect online:", res.error.message);
    return rentCapability({ parkSwitchOn, merchant: undefined });
  }

  const rows = ((res.data ?? []) as Record<string, unknown>[]).map((r) => ({
    status: r.status as MerchantFacts["status"],
    canAcceptAch: r.can_accept_ach === true,
    canAcceptCard: r.can_accept_card === true,
    settlementLast4: (r.settlement_last4 as string | null) ?? null,
  }));

  return rentCapability({ parkSwitchOn, merchant: liveMerchant(rows) });
}
