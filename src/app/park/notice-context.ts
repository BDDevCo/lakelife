import { createServiceClient } from "@/lib/supabase/server";
import { getLedger } from "./ledger-actions";
import { mustRead } from "@/lib/must-read";
import type { RenterContact } from "./reminder-helpers";
import type { LedgerPage } from "./ledger-actions";

/**
 * WHAT EVERY NOTICE TO A HOUSEHOLD NEEDS, LOADED ONCE.
 *
 * Two acts send a household a letter about money: chasing a late bill
 * (reminder-actions) and telling them the bill exists at all
 * (bill-notice-actions, 0192). They want opposite tones and they are logged
 * separately, but they need exactly the same four things — the month's ledger,
 * the park's name and address for the letterhead, and every household's
 * contact row.
 *
 * IT LIVES HERE BECAUSE BOTH CALLERS ARE "use server" FILES, whose exports must
 * all be server actions — so neither can share a plain function with the other.
 * That is a Next.js constraint, and it is also the right shape: the contact
 * rules below are rules, not plumbing, and a second copy of them is how a
 * household with an unverified mobile eventually gets texted.
 *
 * EVERY READ ANSWERS OR THROWS (`mustRead`). A notice run that proceeds on a
 * failed read is a notice run that tells the wrong people, or tells nobody and
 * says it told everybody. Both callers catch ReadFailed and answer in the shape
 * their button expects.
 */
export interface NoticeContext {
  page: LedgerPage;
  parkName: string;
  /** Printed INSIDE the letter — where to take the money, or who to call. */
  officeLine: string;
  /** Keyed by CHARGE id, so no planner has to join. */
  contacts: Map<string, RenterContact>;
  month: string;
}

export async function loadNoticeContext(
  parkId: string,
  month?: string,
): Promise<NoticeContext | null> {
  const page = await getLedger(parkId, month);
  if (!page) return null;

  const admin = createServiceClient();
  // The park's name and address are printed INSIDE the letter. A failed read
  // falls through to "your park" and drops the office address out of the line
  // telling somebody where to take their money.
  const park = mustRead("your park", await admin
    .from("parks").select("name, address").eq("id", parkId).maybeSingle());

  // Contacts, keyed by CHARGE id so no planner has to join.
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

  return {
    page,
    parkName: (park?.name as string) ?? "your park",
    officeLine: park?.address
      ? `Drop it at the office — ${park.address} — or give us a call.`
      : "Drop it at the office or give us a call.",
    contacts,
    month: page.month,
  };
}

/**
 * WHICH BILLS A HOUSEHOLD HAS ALREADY HAD THIS KIND OF LETTER ABOUT.
 *
 * FAILS CLOSED, and this is the only thing standing between a second click and
 * a second letter. Read the usual way, a dropped connection resolves to null,
 * the set becomes EMPTY, and the guard passes for everybody — so the whole park
 * is written to again, including the households who were written to on Tuesday.
 * An empty set has to mean "nobody has had one", never "we couldn't find out",
 * so this throws instead.
 *
 * KEYED ON `kind` (0192). The table's unique index is per act, and so is this:
 * telling somebody their bill exists must never read as having chased them for
 * it, or the demand would never be sent.
 */
export async function alreadyNotified(
  parkId: string,
  kind: "chase" | "raised",
): Promise<Set<string>> {
  const admin = createServiceClient();
  const sent = mustRead(
    kind === "chase" ? "who's already been reminded" : "who's already been told",
    await admin
      .from("park_reminders")
      .select("charge_id")
      .eq("park_id", parkId)
      .eq("party", "resident")
      .eq("kind", kind)
      .in("outcome", ["sent", "printed"]),
  );
  return new Set((sent ?? []).map((s) => s.charge_id as string));
}
