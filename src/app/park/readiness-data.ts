import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount } from "@/lib/must-read";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { hasAccepted } from "@/lib/acceptances";
import { TOS_VERSION } from "@/lib/tos";
import { paymentsAreLive } from "@/lib/charge-gate";
import {
  readinessFactsFrom,
  type ReadinessFacts, type ContactFacts, type ReadinessExtras,
} from "./readiness";

/**
 * THE READINESS FACTS, READ.
 *
 * Two loaders need them: Today (today-actions getToday), which already holds
 * the park, its lots, who is on them, the households and the bills for its
 * own cards, and the setup page, which holds none of that. So the reads are
 * in two layers — `readinessExtras` is the handful of light reads neither
 * loader had (the lake's name, a fee count, two "was anyone written to"
 * counts, a payment count, the acceptance, the processor), and `getReadinessFacts` is the
 * whole set for the page that starts from nothing. getToday calls the first
 * and builds the rest from what it already read.
 *
 * EVERY READ EITHER ANSWERS OR THROWS. A row on this list is a fact about a
 * column; a dropped read rendered as "not done" would tell an owner to go and
 * add the twenty-one lots he is looking at. mustRead throws to the page
 * boundary instead. Reads are sequential and inline for that reason — each
 * `.from(` sits inside its mustRead/mustCount — and the source scan in
 * readiness-data.test.ts pins that shape.
 *
 * Not "use server": nothing here is a public endpoint. Every read is
 * service-role scoped by park_id, after assertMyPark in the public loader.
 */

export async function readinessExtras(
  parkId: string,
  lakeId: string | null,
  renterIds: readonly string[],
): Promise<ReadinessExtras> {
  const admin = createServiceClient();

  let lakeName: string | null = null;
  if (lakeId) {
    const lake = mustRead(
      "your park's lake",
      await admin.from("lakes").select("name").eq("id", lakeId).maybeSingle(),
    );
    lakeName = (lake?.name as string | null) ?? null;
  }

  const activeFees = mustCount(
    "your fees",
    await admin.from("park_fees").select("id", { count: "exact", head: true })
      .eq("park_id", parkId).eq("active", true),
  );

  // WHO HAS BEEN WRITTEN TO — the two logs a send actually leaves, besides
  // the two stamps on the household's own file (invite_sent_at and
  // claim_code_issued_at, read with the renters). Deliveries key on the
  // household, not the park, so the park's households are the scope.
  const documentsDelivered = renterIds.length
    ? mustCount(
        "what's been delivered to your households",
        await admin.from("park_document_deliveries").select("id", { count: "exact", head: true })
          .in("park_renter_id", [...renterIds]),
      )
    : 0;
  const remindersSent = mustCount(
    "the reminders sent to your households",
    await admin.from("park_reminders").select("id", { count: "exact", head: true })
      .eq("park_id", parkId).eq("party", "resident").in("outcome", ["sent", "printed"]),
  );

  // MONEY TAKEN — every park_payments row, reversed and returned ones too. An
  // on-account payment needs no bill and emails a receipt that leaves no row
  // of its own, so the first-run card is gated on this beside the bills.
  const paymentsRecorded = mustCount(
    "the money you've recorded",
    await admin.from("park_payments").select("id", { count: "exact", head: true }).eq("park_id", parkId),
  );

  // The terms row is EARNED from the acceptance ledger, even though the
  // /park layout guarantees it on screen. hasAccepted throws on a failed read.
  const { data: { user } } = await (await createClient()).auth.getUser();
  const termsAccepted = user ? await hasAccepted({ userId: user.id }, "tos", TOS_VERSION) : false;

  return {
    lakeName,
    activeFees,
    documentsDelivered,
    remindersSent,
    paymentsRecorded,
    termsAccepted,
    // The deployment's fact, read here so readiness.ts stays free of env.
    processorLive: paymentsAreLive(),
  };
}

/**
 * The whole set, for the setup page. Null only when assertMyPark refuses.
 */
export async function getReadinessFacts(
  parkId: string,
): Promise<{ facts: ReadinessFacts; contact: ContactFacts } | null> {
  const membership = await assertMyPark(parkId);
  if (!membership) return null;

  const admin = createServiceClient();
  const today = todayLakeDate();

  const park = mustRead(
    "your park",
    await admin
      .from("parks")
      .select("name, cutover_date, rent_due_day, max_agreement_months, active, lake_id, lat, lng, notices_held_at, accepts_online_rent")
      .eq("id", parkId)
      .maybeSingle(),
  );

  const lots = mustRead(
    "your lots",
    await admin.from("park_lots").select("id, lot_number, lifecycle, active").eq("park_id", parkId),
  );
  const liveIds = (lots ?? [])
    .filter((l) => (l.lifecycle as string) === "live")
    .map((l) => l.id as string);

  // The ended rows come too: the lapsed test (lotOccupancy) needs them to
  // tell a household closed out of its successor from a lapsed holdover.
  const reservations = liveIds.length
    ? mustRead(
        "who's on your lots",
        await admin.from("lot_reservations")
          .select("park_lot_id, renter_id, during, status, term")
          .in("park_lot_id", liveIds)
          .in("status", ["approved", "active", "ended"]),
      )
    : [];

  const rates = liveIds.length
    ? mustRead(
        "your rate cards",
        await admin.from("lot_rates").select("park_lot_id, term, amount").in("park_lot_id", liveIds),
      )
    : [];

  const renters = mustRead(
    "the households",
    await admin.from("park_renters").select("id, email, phone_on_file_with_park, invite_sent_at, claim_code_issued_at").eq("park_id", parkId),
  );

  // Any bill ever raised: the fact that ends the first-run card.
  const chargesRaised = mustCount(
    "the bills you've raised",
    await admin.from("park_charges").select("id", { count: "exact", head: true }).eq("park_id", parkId),
  );

  const extras = await readinessExtras(
    parkId,
    (park?.lake_id as string | null) ?? null,
    (renters ?? []).map((r) => r.id as string),
  );

  return readinessFactsFrom({
    today,
    viewerIsOwner: membership.role === "owner",
    park: park ?? null,
    lots: lots ?? [],
    reservations: reservations ?? [],
    renters: renters ?? [],
    rates: rates ?? [],
    chargesRaised,
    extras,
  });
}
