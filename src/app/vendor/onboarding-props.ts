import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, softRead } from "@/lib/must-read";
import type { CrewService } from "@/components/VendorOnboarding";
import { hasRealRate } from "@/app/vendor/rates-helpers";
import type { PricingParams } from "@/lib/pricing";
import { getPendingSetup, type PendingSetup } from "./setup-data";

/**
 * EVERYTHING THE ONBOARDING CHECKLIST NEEDS, LOADED IN ONE PLACE.
 *
 * FIVE DOORWAYS RENDER THE SAME CHECKLIST. /vendor, /vendor/schedule,
 * /vendor/open, /vendor/import and /vendor/earnings each fall back to
 * <VendorOnboarding> whenever the crew is not `active` yet, and each of them
 * had its own hand-rolled copy of the two reads it needs. That is the shape
 * this codebase has paid for before: a rule written into one doorway of five
 * is not a rule, and the first of the five to learn something new (which lakes
 * have a park on them; whether this crew has priced anything) would have been
 * the only one to say it.
 *
 * So the loader is the single home, and every page calls it.
 *
 * WHAT THROWS AND WHAT DEGRADES, deliberately split:
 *
 *   The service list and the lake list are the checklist. Without them the
 *   crew is looking at empty chips they cannot tick, so a failed read THROWS
 *   and the page's error boundary says so — which is what both pages already
 *   did with `mustRead`.
 *
 *   The unpriced list and the bank fact are SENTENCES ON a card. A dropped
 *   connection there must not take the whole checklist down — but it must not
 *   render as "everything is priced" or "no bank on file" either, because both
 *   of those are reassuring, actionable and wrong. They come back with a
 *   `null` that the component is required to word differently.
 */
export interface OnboardingProps {
  activeServices: CrewService[];
  lakes: { id: string; name: string }[];
  /**
   * Work this crew has ticked and never priced, catalogue order.
   * `null` means WE COULD NOT CHECK — never "nothing is unpriced".
   */
  unpriced: string[] | null;
  /**
   * Park names keyed by the lake they sit on, for the lake step's copy. A
   * lake with no park is simply absent — the label is derived, never written
   * down, so park #2 on Big Turkey needs no code change to be named.
   * `null` means the parks read failed and no lake may claim to have none.
   */
  parksByLake: Record<string, string[]> | null;
  /**
   * Whether this crew has told us where the money should land.
   * `null` means we could not check.
   */
  bankOnFile: boolean | null;
  /**
   * A setup somebody at LakeLife took down on the phone, waiting for THIS crew
   * to confirm it (0181). `null` when there is none — the ordinary six-card
   * wizard, which is what nearly every crew will see.
   *
   * IT LIVES IN THIS LOADER FOR THE REASON THE LOADER EXISTS. Five doorways
   * render the checklist; a crew who lands on /vendor/open rather than /vendor
   * must see the same card, or the setup they were promised on the phone is
   * simply absent depending on which link they tapped.
   *
   * IT THROWS RATHER THAN DEGRADING, unlike `unpriced` and `bankOnFile`. Those
   * are sentences on a card; this is the difference between a crew confirming
   * what they were told is waiting and a crew typing it all in again believing
   * we lost it. A failed read has no business making that call quietly.
   */
  pendingSetup: PendingSetup | null;
}

/**
 * @param vendorId the crew's vendors.id — the unpriced list is theirs.
 * @param userId   their auth user id — payout_accounts is keyed by user, not vendor.
 */
export async function loadOnboardingProps(
  vendorId: string | null,
  userId: string | null,
): Promise<OnboardingProps> {
  const admin = createServiceClient();

  const [svcRes, lakeRes, parksRes, ratesRes, vendorRes, acctRes, pendingSetup] = await Promise.all([
    // `park_only` TRAVELS WITH THE NAME. Without it onboarding cannot tell
    // "Lawn mowing & trim" from "Park grounds mowing & trim", which differ by
    // one word and are two different jobs at two different prices.
    admin.from("services").select("id, name, park_only").eq("active", true).order("name"),
    admin.from("lakes").select("id, name").eq("is_fixture", false).order("name"),
    // NOT FILTERED ON `parks.active`. The Haven is inactive today — it has not
    // closed yet — and it is precisely the park whose jobs a crew will be
    // dropped from for not ticking Pretty Lake. Filtering on the launch switch
    // would hide the one park this copy exists for. The fixture fence still
    // holds: a park on a fixture lake has no lake in the list above to attach
    // to, so it can never be named.
    admin.from("parks").select("name, lake_id").not("lake_id", "is", null),
    // THE AMOUNTS TRAVEL WITH THE ID. A rate row can exist and carry nothing
    // but zeros (a blank Save writes exactly that), and dispatch refuses a
    // crew whose rate is not > 0 — so "priced" has to be asked of the numbers.
    vendorId ? admin.from("vendor_rates").select("service_id, base, unit_rate, band_pricing").eq("vendor_id", vendorId) : null,
    vendorId ? admin.from("vendors").select("service_types").eq("id", vendorId).maybeSingle() : null,
    userId ? admin.from("payout_accounts").select("user_id").eq("user_id", userId).maybeSingle() : null,
    getPendingSetup(vendorId),
  ]);

  const svcs = mustRead("the service list", svcRes);
  const lakeRows = mustRead("the lake list", lakeRes);

  const activeServices: CrewService[] = (svcs ?? []).map((s) => ({
    name: s.name as string,
    parkOnly: s.park_only === true,
  }));
  const lakes = (lakeRows ?? []).map((l) => ({ id: l.id as string, name: l.name as string }));

  const [parkRows, parksFailed] = softRead("which lakes have a park on them", parksRes, null);
  let parksByLake: Record<string, string[]> | null = null;
  if (!parksFailed) {
    parksByLake = {};
    for (const p of parkRows ?? []) {
      const lakeId = p.lake_id as string | null;
      const name = (p.name as string | null)?.trim();
      if (!lakeId || !name) continue;
      (parksByLake[lakeId] ??= []).push(name);
    }
  }

  // THE UNPRICED LIST, built the same way getNeedsYou builds it: service_types
  // holds NAMES, vendor_rates holds ids, and the catalogue is what joins them.
  // Ordered as the catalogue orders it so the same crew sees the same list in
  // the same order every time.
  let unpriced: string[] | null = null;
  if (vendorId && ratesRes && vendorRes) {
    const [myRates, ratesFailed] = softRead("the rates you've set", ratesRes, null);
    const [me, meFailed] = softRead("the work you signed up for", vendorRes, null);
    if (!ratesFailed && !meFailed) {
      const idByName = new Map((svcs ?? []).map((s) => [s.name as string, s.id as string]));
      const priced = new Set(
        (myRates ?? [])
          .filter((r) => hasRealRate(r as { base: number | null; unit_rate: number | null; band_pricing: PricingParams | null }))
          .map((r) => r.service_id as string),
      );
      const ticked: string[] = (me?.service_types as string[] | null) ?? [];
      // A name with no live service behind it is a different problem — the
      // service was retired — and dispatch already ignores it.
      unpriced = ticked.filter((name) => {
        const id = idByName.get(name);
        return id != null && !priced.has(id);
      });
    }
  } else if (vendorId == null) {
    // No crew row means nothing has been ticked, so nothing can be unpriced.
    // That is a fact, not a failed read.
    unpriced = [];
  }

  let bankOnFile: boolean | null = null;
  if (userId && acctRes) {
    const [acct, acctFailed] = softRead("your bank details", acctRes, null);
    if (!acctFailed) bankOnFile = !!acct;
  }

  return { activeServices, lakes, unpriced, parksByLake, bankOnFile, pendingSetup };
}
