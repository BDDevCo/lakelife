/**
 * ONE SUCCESSOR ROW, BUILT ONE WAY.
 *
 * A renewal is a new `lot_reservations` row that follows the prior one —
 * never a wider date range. Two doors wrote that row by hand (the owner's
 * "Agreements to write" and the resident's extend link) and neither copied
 * the household's own facts: the due day he granted a mid-month payer, the
 * day they actually moved in, whether the rent was confirmed with them. So
 * on the morning the successor took over, a household on the 15th was
 * chased on the 4th, every "living here since" read as the successor's start,
 * and the owner's renewal copied `origin` from the prior row — which for an
 * inherited household meant the lease they had just signed was filed as
 * grandfathered, and the fee it agreed to never billed.
 *
 * The rules, in one place so the doors cannot disagree:
 *
 *   - due_day, tenancy_began_on and renter_unit_id are the household's own;
 *     they travel. NULL due_day means "follow the park" and travels as NULL.
 *   - amount_source travels only when the rent is unchanged. A successor at
 *     a NEW rent is the owner's knowledge as of now — nobody confirmed the new
 *     number with them yet (the same rule rent-changes.ts applies).
 *   - A consecutive successor shares the prior chain and takes the next seq.
 *     A gap starts a NEW chain — and that means OMITTING the column so the
 *     database mints one. Sending `null` to a NOT NULL column with a default
 *     is a constraint error, not a new chain.
 *   - `origin` is the DOOR's fact, never copied from the prior row. An
 *     agreement the owner wrote is 'office'; the resident's own renewal is
 *     'office' too (it is the park's paper). 'grandfathered' is what a
 *     household inherits from the seller; no successor is ever that.
 */

import { toDaterange } from "@/lib/parks";

export interface PriorLink {
  id: string;
  park_lot_id: string;
  renter_id: string;
  renter_unit_id?: string | null;
  term: string;
  quoted_amount: number | null;
  agreement_chain_id?: string | null;
  agreement_seq?: number | null;
  due_day?: number | null;
  tenancy_began_on?: string | null;
  amount_source?: string | null;
  amount_source_at?: string | null;
}

export interface SuccessorPlan {
  /** Half-open; `end` is checkout morning. */
  start: string;
  end: string;
  status: "approved" | "active";
  /** The rent this successor bills — resolved by the door, never assumed. */
  quotedAmount: number | null;
  origin: "office" | "application";
  continuesChain: boolean;
  nextSeq: number;
  /** Only a NEW chain carries a deposit; the DB refuses one on seq > 1. */
  depositAmount?: number | null;
  /** ISO timestamp for amount_source_at when the rent changed. */
  nowISO: string;
}

export interface SuccessorRow {
  park_lot_id: string;
  renter_id: string;
  renter_unit_id: string | null;
  during: string;
  status: "approved" | "active";
  term: string;
  quoted_amount: number | null;
  origin: "office" | "application";
  agreement_chain_id?: string;
  agreement_seq: number;
  deposit_amount: number | null;
  due_day: number | null;
  tenancy_began_on: string | null;
  amount_source: string;
  amount_source_at: string | null;
}

export function successorRow(prior: PriorLink, plan: SuccessorPlan): SuccessorRow {
  const rentChanged =
    plan.quotedAmount != null &&
    prior.quoted_amount != null &&
    Math.round(plan.quotedAmount * 100) !== Math.round(prior.quoted_amount * 100);

  const row: SuccessorRow = {
    park_lot_id: prior.park_lot_id,
    renter_id: prior.renter_id,
    renter_unit_id: prior.renter_unit_id ?? null,
    during: toDaterange({ start: plan.start, end: plan.end }),
    status: plan.status,
    term: prior.term,
    quoted_amount: plan.quotedAmount,
    origin: plan.origin,
    agreement_seq: plan.nextSeq,
    deposit_amount: plan.continuesChain ? null : (plan.depositAmount ?? null),
    due_day: prior.due_day ?? null,
    tenancy_began_on: prior.tenancy_began_on ?? null,
    amount_source: rentChanged ? "owner_knowledge" : (prior.amount_source ?? "owner_knowledge"),
    amount_source_at: rentChanged ? plan.nowISO : (prior.amount_source_at ?? null),
  };
  if (plan.continuesChain) row.agreement_chain_id = prior.agreement_chain_id ?? prior.id;
  return row;
}
