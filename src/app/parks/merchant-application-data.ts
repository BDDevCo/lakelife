import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "@/app/park/data";
import {
  APPLICATION_FIELDS, STORED_FIELD_IDS, deriveApplication,
  type Derived, type ParkFacts,
} from "@/lib/merchant-application";

/**
 * EVERYTHING THE MERCHANT APPLICATION SCREEN NEEDS, IN ONE READ.
 *
 * His directive: the application should be part of onboarding or the file
 * dump, we extract what we can from what they have already given us, ask only
 * for what is outstanding, and then it is one tap.
 *
 * So this loader's whole job is to answer "what do we already know?" — and to
 * be honest when the answer is "we could not look".
 */

export interface ApplicationView {
  parkId: string;
  parkName: string | null;
  provider: string;
  /** The row's id, when an application has been started. */
  accountId: string | null;
  status: string | null;
  submittedAt: string | null;
  /** What is stored on the row today. */
  stored: Record<string, unknown>;
  /** What we worked out, with where each piece came from. */
  derived: Record<string, Derived>;
  /**
   * TRUE when a read failed, so every count and suggestion on the screen is
   * suspect. A failed read is not an empty park — and on THIS screen an empty
   * park means "we have nothing to prefill", which would send him off typing
   * things we already know.
   */
  couldNotRead: boolean;
}

/** The provider we are boarding park owners with, chosen 28 Oct 2026. */
export const PROVIDER = "us_card_solutions";
export const PROVIDER_LABEL = "US Card Solutions";

export async function getMerchantApplication(parkId: string): Promise<ApplicationView | null> {
  const membership = await assertMyPark(parkId);
  if (!membership || membership.role !== "owner") return null;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const admin = createServiceClient();

  const [parkRes, lotsRes, acctRes, meRes] = await Promise.all([
    admin.from("parks").select("name, address").eq("id", parkId).maybeSingle(),
    // Every ACTIVE lot with its most recent rate. The rent roll is the only
    // thing in this product that knows what residents actually pay, and the
    // two volume questions are the ones applicants guess at.
    admin.from("park_lots").select("id, active").eq("park_id", parkId).eq("active", true),
    admin.from("processor_accounts")
      .select(`id, status, submitted_at, ${STORED_FIELD_IDS.join(", ")}`)
      .eq("park_id", parkId).eq("provider", PROVIDER)
      .not("status", "in", "(disabled,rejected)")
      .maybeSingle(),
    user ? admin.from("users").select("name, email, phone").eq("id", user.id).maybeSingle() : null,
  ]);

  let couldNotRead = false;
  const note = (what: string, e: unknown) => {
    couldNotRead = true;
    console.error(`[merchant application] could not read ${what}:`, e);
  };
  if (parkRes.error) note("the park", parkRes.error);
  if (lotsRes.error) note("the lots", lotsRes.error);
  if (acctRes.error) note("the application", acctRes.error);
  if (meRes?.error) note("your contact details", meRes.error);

  // The rates, for the lots we could read. Deliberately a second query rather
  // than a join: `lot_rates` keeps every rate ever set and we want the latest
  // per lot, which is clearer here than in one statement.
  let ratedLots = 0;
  let monthlyRentTotal: number | null = null;
  const lotIds = (lotsRes.data ?? []).map((l) => l.id as string);
  if (lotIds.length > 0) {
    const rates = await admin
      .from("lot_rates")
      .select("park_lot_id, amount, created_at")
      .in("park_lot_id", lotIds)
      .order("created_at", { ascending: false });
    if (rates.error) {
      note("the rent roll", rates.error);
    } else {
      const latest = new Map<string, number>();
      for (const r of rates.data ?? []) {
        const id = r.park_lot_id as string;
        if (!latest.has(id)) latest.set(id, Number(r.amount ?? 0));
      }
      ratedLots = latest.size;
      monthlyRentTotal = [...latest.values()].reduce((a, b) => a + b, 0);
    }
  } else if (!lotsRes.error) {
    // A park with no active lots is a real state, not a failed read — it just
    // has no rent roll to work from yet.
    ratedLots = 0;
    monthlyRentTotal = null;
  }

  const park = parkRes.data as { name?: string; address?: string } | null;
  const me = meRes?.data as { name?: string; email?: string; phone?: string } | null;

  const facts: ParkFacts = {
    name: park?.name ?? null,
    address: park?.address ?? null,
    ratedLots,
    // Never propose a volume off a rent roll we could not fully read.
    monthlyRentTotal: couldNotRead ? null : monthlyRentTotal,
    ownerName: me?.name ?? null,
    ownerEmail: me?.email ?? null,
    ownerPhone: me?.phone ?? null,
  };

  const row = acctRes.data as Record<string, unknown> | null;
  const stored: Record<string, unknown> = {};
  for (const id of STORED_FIELD_IDS) {
    const v = row?.[id];
    if (v !== null && v !== undefined) stored[id] = v;
  }

  return {
    parkId,
    parkName: facts.name,
    provider: PROVIDER_LABEL,
    accountId: (row?.id as string) ?? null,
    status: (row?.status as string) ?? null,
    submittedAt: (row?.submitted_at as string) ?? null,
    stored,
    derived: deriveApplication(facts),
    couldNotRead,
  };
}

/**
 * What the form should show in each box: what he has already saved, else what
 * we worked out, else nothing.
 *
 * STORED BEATS DERIVED, always. Once he has typed something, a later
 * derivation must never quietly overwrite it — that is the same shape as a
 * default that asserts a fact, one step further on.
 */
export function startingValues(view: ApplicationView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of APPLICATION_FIELDS) {
    if (f.writeOnly) continue;            // never prefilled, never stored
    if (f.id in view.stored) { out[f.id] = view.stored[f.id]; continue; }
    const d = view.derived[f.id];
    if (d && d.value !== null) out[f.id] = d.value;
  }
  return out;
}
