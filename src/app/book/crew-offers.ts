import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import {
  canEverDo,
  decideDispatch,
  isEligible,
  worksThatWeekday,
  type CrewCandidate,
  type DispatchDecision,
  type DispatchInput,
} from "@/lib/dispatch";
import { customerPrice as feeCustomerPrice } from "@/lib/platform-fee";
import { getPlatformSettings } from "@/lib/settings";
import { crewSetsThePrice, type ParkRates } from "@/lib/park-rates";
import { loadParkRatesChecked } from "@/app/park/rate-data";
import { deriveStanding, type CrewStanding } from "@/lib/crew-standing";
import { OWNER_FIXTURE_EMBED, OWNER_FIXTURE_FILTER } from "@/lib/lake-pages";
import { anyIsACrew } from "@/lib/crew-account";
import { buildCandidates, loadPricingProfileById } from "./dispatch";

/**
 * THE OFFERS BUILDER — every crew who could take this job, and nothing else.
 *
 * Brendon, 23 September 2026: "the owner needing the service should still see
 * all the options, if any, for the crews available and their pricing" and
 * "...what days and the crew rating....then they make the decision."
 *
 * ================= THE RLS LINE IS THE WHOLE RISK =================
 *
 * A homeowner has NO read on `vendors` or `vendor_rates`, and MUST NOT GAIN
 * ONE. Widening either would let a crew who opens a homeowner account read
 * every competitor's rate card — and "vendors never see each other's numbers,
 * customers never see a crew's cost" is the guarantee the owner is selling. It
 * survives the death of CLAUDE.md rule 1 (there is no margin to hide any more)
 * because it was never really about margin.
 *
 * So this file is SERVER-ONLY, reads with the service role the way every other
 * dispatch loader does, and returns a hand-built row per crew:
 *
 *      display name · the customer's price · the days they work · standing ·
 *      whether this is the crew the viewer brought
 *
 * NEVER the crew's own quote, never the fee split, never another crew's card,
 * never a lat/long, never a vendor's email. Every field below is one a crew
 * would print on a flyer — except the price, which is the customer's own.
 *
 * ================= NOT A SECOND COPY OF ANY GATE =================
 *
 * Eligibility is asked through `isEligible` on candidates from
 * `buildCandidates` — the same pool, the same fixture fence, the same
 * insurance / lake / work-day / capacity / custody rules the router itself
 * uses. A crew who cannot lawfully take the job is not an option, and the
 * reason a list came back empty is asked of `decideDispatch` rather than
 * re-derived here. A hand-copy of those rules would agree today and drift.
 */

/** ONE CREW, AS THE BUYER SEES THEM. Everything here is safe to put on a wire. */
export interface CrewOffer {
  vendorId: string;
  /** The crew's business name. Never their contact details. */
  company: string;
  /** What THIS customer pays, all in — the crew's quote plus the customer fee. */
  customerPrice: number;
  /** The days they work, e.g. ['Mon','Tue']. His "what days". */
  workDays: string[];
  /** TRUE for the crew this property brought (properties.preferred_vendor).
   *  A badge and a sort. Never a filter — see decideDispatch (0178). */
  yours: boolean;
  /** ONLY PRESENT WHEN THE DIAL IS ON. Undefined is not "unknown standing", it
   *  is "this platform does not publish standing", and the screen draws none.
   *  An offers payload carrying a standing nothing draws is data leaving the
   *  server for no reason — the same instinct that keeps a crew's card off the
   *  wire. */
  standing?: CrewStanding;
}

export interface CrewOffersResult {
  ok: boolean;
  /** Only set when we could not even ask — never used to describe an empty bench. */
  error?: string;
  serviceName?: string;
  /** FALSE on a menu-priced service: there is nothing to choose between, the
   *  price is LakeLife's and identical whoever comes. The screen says so. */
  crewPriced?: boolean;
  /** The date these offers are for, YYYY-MM-DD. */
  dateISO?: string;
  offers?: CrewOffer[];
  /** Why the list is empty, in the buyer's words. Null when it isn't. */
  emptyReason?: string | null;
  /** The heading over that sentence. Keyed on the SAME verdict, because
   *  "No crew for that day yet" over "nobody on your lake does this work"
   *  contradicts the paragraph under it. */
  emptyHeading?: string;
  /** TRUE only when a different date could actually change the answer. Four of
   *  the verdicts are date-independent — telling that buyer to pick another day
   *  is advice that can never come true, and dispatch.ts says at length what
   *  that costs. */
  emptyDateHelps?: boolean;
  /** The crew this property brought, when they are NOT on the list — they are
   *  in the pool but cannot take this day. Named so the person who introduced
   *  them isn't left wondering where they went. Only ever the viewer's OWN
   *  crew: never a word about why anybody else is absent. */
  yourCrewUnavailable?: string | null;
  /** Whether standing is published at all, so the screen can say what it is
   *  sorting on without guessing. */
  standingShown?: boolean;
  /** Set when standing IS published but we could not read the work history.
   *  A failed read is not an empty one: rather than print "New to LakeLife"
   *  over a crew with twelve finished jobs, no crew shows standing and this
   *  says why. */
  standingUnavailable?: boolean;
}

/**
 * WHY THERE IS NOBODY TO CHOOSE FROM, said to the person choosing.
 *
 * Keyed on the SAME reason codes `decideDispatch` produces, so a new code
 * cannot be added without a reader here. The sentences differ from
 * `NO_FIT_LABEL` on purpose: that map speaks to ops about a queue
 * ("recruiting is the unblock"), this one speaks to a customer about their own
 * Saturday. Neither invents a cause — every branch below is a verdict the
 * engine actually returned.
 *
 * NOTHING HERE SAYS "that day just filled up" UNLESS THAT IS WHAT HAPPENED,
 * and nothing here blames the buyer for an empty crew bench. `all_full_or_blocked`
 * is the engine's catch-all, so it is refined once more before it is allowed to
 * assert a full calendar — see `weekdayEmptyState`.
 *
 * EACH VERDICT CARRIES ITS OWN HEADING AND ITS OWN ADVICE. The screen used to
 * head every one of these "No crew for that day yet" and end every one of them
 * with "pick another day": four of the nine causes are date-independent, so
 * that advice could never come true, and one of them denied the body sentence
 * printed directly above it.
 */
interface EmptyState {
  /** The heading. It must not deny the body underneath it. */
  heading: string;
  /** The sentence, in the buyer's words. */
  body: string;
  /** Whether picking a different day could change this answer. */
  dateHelps: boolean;
}

const EMPTY_REASON: Record<NonNullable<DispatchDecision["reasonNoFit"]>, EmptyState> = {
  no_crew_for_service: {
    heading: "No crew does this work yet",
    body: "No crew has signed up for this work yet. Ask for it anyway and we'll come back to you the moment one does — that request is how we know where to go looking.",
    dateHelps: false,
  },
  no_crew_on_lake: {
    heading: "No crew on your lake yet",
    body: "Crews do this work, just not on your lake yet. Ask for it anyway — a request on a lake is the thing that brings a crew to it.",
    dateHelps: false,
  },
  no_full_coverage_crew: {
    heading: "No one crew covers this whole visit",
    body: "No one crew covers every part of this visit yet. Ask for it anyway and we'll keep looking.",
    dateHelps: false,
  },
  no_routable_crew: {
    heading: "Nobody's cleared to be sent yet",
    body: "A crew here does this work, but none of them is cleared to be sent yet — that's paperwork on our side, not your date. Ask for it anyway and we'll chase it.",
    dateHelps: false,
  },
  all_full_or_blocked: {
    heading: "That day is taken",
    body: "Every crew who could take this is already full on that day. Try another date — the list changes daily.",
    dateHelps: true,
  },
  no_qualifying_rate: {
    heading: "Nobody has priced this yet",
    body: "No crew has priced this work yet, so there's nothing to quote you. Ask for it anyway and we'll come back with a price.",
    dateHelps: false,
  },
  below_floor: {
    heading: "No crew available",
    body: "No crew is available for this at the moment. Ask for it anyway and we'll come back to you.",
    dateHelps: false,
  },
  no_custody_crew: {
    heading: "Nobody's cleared to store a boat yet",
    body: "No crew here is cleared to store a boat yet. Ask for it anyway — we'll tell you the moment one is.",
    dateHelps: false,
  },
  chosen_crew_unavailable: {
    heading: "That crew can't take that day",
    body: "That crew can no longer take this day. Pick another crew below, or another date.",
    dateHelps: true,
  },
};

/**
 * "ALREADY FULL" IS THE CATCH-ALL, AND ON AN EMPTY PLATFORM IT IS A LIE.
 *
 * `all_full_or_blocked` is whatever is left after `isEligible`, which bundles
 * work days, day blocks, the job cap and the minute budget into one verdict.
 * With nothing booked anywhere, a single crew working Mon–Fri makes every
 * Saturday read "every crew who could take this is already full" — "that day
 * just filled up" in different words, which is the one sentence this screen
 * is not allowed to say unless it happened.
 *
 * So before asserting fullness, ask whether anybody works that weekday at all,
 * through the ROUTER'S OWN work-day test rather than a second copy of it.
 */
function weekdayEmptyState(weekday: string): EmptyState {
  // A PERSON READS "Saturdays", NOT "Sats". `workDays` is stored as the
  // three-letter codes the crew's own availability screen uses; a sentence
  // built straight off one is the same shape as a month printed "2026-08".
  const full = FULL_WEEKDAY[weekday] ?? weekday;
  return {
    heading: `No crew works ${full}s yet`,
    body: `None of the crews who could do this work ${full}s. Pick another day and you'll see who's free then — or ask for it anyway and we'll come back to you.`,
    dateHelps: true,
  };
}

const FULL_WEEKDAY: Record<string, string> = {
  Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday",
  Thu: "Thursday", Fri: "Friday", Sat: "Saturday",
};

/** The honest empty state when the engine says a crew COULD go but priced nothing. */
const PRICED_TO_NOTHING: EmptyState = {
  // THE HEADING MUST NOT DENY THE BODY. Crews ARE available that day here —
  // what is missing is something on the property for them to price — so
  // "No crew for that day yet" was false in the same card that explained why.
  heading: "Nothing here to price yet",
  body: "The crews who do this work price your place at nothing — that usually means your property profile is missing the thing this service covers. Update your profile and the real prices appear.",
  dateHelps: false,
};

export interface CrewOffersInput {
  propertyId: string;
  serviceId: string;
  /** The signed-in user, from the door that already proved they may look.
   *  Used for ONE thing: refusing to show crew prices to a crew. */
  viewerUserId?: string | null;
  /** YYYY-MM-DD. Days matter: a crew who doesn't work Tuesdays isn't an option
   *  for a Tuesday, and saying otherwise would sell a visit nobody can do. */
  dateISO: string;
}

/**
 * Build the offers. CALLER MUST HAVE ALREADY PROVED THE VIEWER OWNS
 * `propertyId` — this function reads with the service role and asks no
 * question about who is looking. `app/book/crew-actions.ts` is the only door
 * and it does that check first.
 */
export async function buildCrewOffers(input: CrewOffersInput): Promise<CrewOffersResult> {
  const admin = createServiceClient();

  const [propRes, svcRes] = await Promise.all([
    admin.from("properties").select("id, owner_id, lake_id, lat, lng, preferred_vendor").eq("id", input.propertyId).maybeSingle(),
    admin.from("services").select("id, name, pricing_model, active, crew_priced").eq("id", input.serviceId).maybeSingle(),
  ]);
  // A FAILED READ IS NOT AN EMPTY ONE. An unread property leaves the lake null
  // (no geo gate — every crew on three lakes looks available) and the preferred
  // crew null (their own crew silently loses its badge); an unread service row
  // would read as menu-priced and print a price nobody quoted.
  const prop = mustRead("your property", propRes);
  const svc = mustRead("that service", svcRes);
  if (!prop) return { ok: false, error: "We couldn't find that property." };
  if (!svc || svc.active === false) return { ok: false, error: "That service isn't available right now." };

  // ============ A CREW MUST NOT READ THIS SCREEN (the derivation) ==========
  //
  // The payload is clean field by field — a rival's own quote never leaves the
  // server. It does not have to. `customerPrice` is `round2(q × (1 + c))`, so
  // one division recovers `q`; and the customer fee is recoverable too, by a
  // crew who finds their OWN card in the list and divides by the number they
  // typed. That alone is one figure per (property, service, day), which is the
  // unavoidable price of showing a buyer prices at all.
  //
  // THE CARD ITSELF IS RECOVERABLE, AND THAT IS THE PART THAT IS NOT
  // ACCEPTABLE. `vendor_rates` is global per (vendor, service) — base,
  // unit_rate, bands, no property scoping — and every pricing model is linear
  // in a field the VIEWER OWNS AND CAN EDIT (`per_section` reads
  // property_profile.pier_sections; per_foot reads their boats; the bands read
  // their lawn and square footage). `loadPricingProfileById` re-reads the live
  // profile on every call, and the profile wizard is a re-runnable edit door.
  // So: set sections to 1, read the price; set 2, read it again; subtract.
  // Two page loads recover a competitor's exact base and unit_rate, and
  // because the card is global that is the card that prices every property on
  // the platform.
  //
  // "A crew never sees another crew's rate card" is the guarantee the owner is
  // selling, and it is the one that survives the death of CLAUDE.md rule 1. It
  // cannot be defended while the person looking is a crew AND controls the
  // inputs to the pricing function, so this screen is closed to them. Refused
  // in the BUILDER, not the page, because the builder is what puts the numbers
  // on the wire.
  //
  // Asked of both the viewer and the property's owner: a crew who gets a
  // homeowner account, and a crew who is handed the keys to somebody else's
  // property, are the same read. There are zero crew-owned homeowner accounts
  // today, so this ships before the population that would use it exists.
  const crewCheck = await anyIsACrew(admin, [input.viewerUserId, prop.owner_id as string | null]);
  // A FAILED READ IS NOT "NOT A CREW" — `anyIsACrew` reports the failure
  // separately so it cannot make this guard pass.
  if (crewCheck.failed) {
    return { ok: false, error: "We couldn't check your account just now. Try again in a moment." };
  }
  if (crewCheck.isCrew) {
    return {
      ok: false,
      error:
        "This account is also a crew account, and we don't show one crew what another charges. " +
        "Book from your booking page and we'll line up the crew, or ask us and we'll do it for you.",
    };
  }

  const profile = await loadPricingProfileById(admin, input.propertyId);
  if (!profile) return { ok: false, error: "We couldn't price your property." };

  // WHO PRICES THIS — asked once, through the shared precedence rule, never
  // re-spelled here. A park with its own negotiated row is NOT crew-priced and
  // there is nothing to choose between; a park without one is a customer like
  // any other and meets the crews' cards, exactly like a lake house.
  let parkRates: ParkRates | null = null;
  if (profile.parkId) {
    const checked = await loadParkRatesChecked(profile.parkId);
    // An unread rate table says "this park has no rate", which routes to a
    // crew's card — a wrong price on the screen the customer decides from.
    if (checked.failed) return { ok: false, error: "We couldn't read what your park pays for this. Try again in a moment." };
    parkRates = checked.rates;
  }
  const crewPriced = crewSetsThePrice({ id: svc.id as string, crew_priced: svc.crew_priced as boolean }, parkRates);
  if (!crewPriced) {
    // NOT A FAILURE AND NOT AN EMPTY LIST. On the menu path the price is
    // LakeLife's, it is the same whoever comes, and the router picks — that
    // path is deliberately untouched. Saying so is the honest screen.
    return { ok: true, serviceName: svc.name as string, crewPriced: false, dateISO: input.dateISO, offers: [], emptyReason: null, standingShown: false };
  }

  const settings = await getPlatformSettings();
  const fee = { customerPct: settings.platformFeeCustomerPct, crewPct: settings.platformFeeCrewPct };

  const candidates: CrewCandidate[] = await buildCandidates(admin, {
    serviceId: svc.id as string,
    serviceName: svc.name as string,
    pricingModel: svc.pricing_model as CrewOffersParam,
    dateISO: input.dateISO,
    profile,
  });

  const dispatchInput: DispatchInput = {
    date: input.dateISO,
    weekday: weekdayOf(input.dateISO),
    serviceName: svc.name as string,
    // NOT A PRICE, and never printed. On the crew-priced path there is no menu
    // number; this field only feeds the floor test, which `platformFee` retires.
    menuPrice: 0,
    todayISO: todayLakeDate(),
    marginFloor: settings.marginFloor,
    preferredVendorId: (prop.preferred_vendor as string) ?? null,
    lakeId: (prop.lake_id as string) ?? null,
    jobLat: prop.lat != null ? Number(prop.lat) : null,
    jobLng: prop.lng != null ? Number(prop.lng) : null,
    platformFee: fee,
    crews: candidates,
  };

  // THE SAME GATE THE ROUTER USES, asked of the same pool. Then the same rate
  // rule: a null or non-positive quote is not a price, and a crew without one
  // is not an option — printing $0 to a buyer is the whole bug this screen
  // could otherwise reintroduce.
  const eligible = candidates.filter((c) => isEligible(c, dispatchInput));
  const quoting = eligible.filter((c) => c.crewRate != null && (c.crewRate as number) > 0);

  if (quoting.length === 0) {
    // ASKED OF THE ENGINE, not guessed. If every eligible crew prices this
    // property at nothing, that is its own honest sentence and the fix is the
    // customer's profile — the one branch where we know the cards are fine.
    const empty = ((): EmptyState => {
      if (eligible.some((c) => c.crewRate === 0)) return PRICED_TO_NOTHING;
      const decision = decideDispatch(dispatchInput);
      const code = decision.reasonNoFit ?? "no_crew_for_service";
      // REFINED BEFORE IT ASSERTS FULLNESS, and only this one code is refined:
      // every other verdict already names its own cause. A crew who could
      // otherwise be sent but does not work this weekday is not a full day.
      if (
        code === "all_full_or_blocked" &&
        !candidates.some((c) => canEverDo(c, dispatchInput) && worksThatWeekday(c, dispatchInput))
      ) {
        return weekdayEmptyState(dispatchInput.weekday);
      }
      return EMPTY_REASON[code];
    })();
    return {
      ok: true,
      serviceName: svc.name as string,
      crewPriced: true,
      dateISO: input.dateISO,
      offers: [],
      emptyReason: empty.body,
      emptyHeading: empty.heading,
      emptyDateHelps: empty.dateHelps,
      standingShown: false,
    };
  }

  // ================= STANDING: OFF MEANS NOT COMPUTED =================
  //
  // When the dial is off we do not read a single row of work history and the
  // payload carries no `standing` key at all. That is the point: an offers
  // payload carrying a standing the screen does not draw is data leaving the
  // server for no reason.
  const standingShown = settings.crewStandingPublic >= 1;
  let standingByVendor: Map<string, CrewStanding> | null = null;
  let standingUnavailable = false;
  if (standingShown) {
    const ids = quoting.map((c) => c.vendorId);
    const [doneRes, lakesRes] = await Promise.all([
      // FIXTURE WORK IS NOT A CREW'S RECORD, and the fence is on the JOB, not
      // the crew. The crews in this pool are already fenced through
      // `users.is_fixture`; their JOBS were not, and prod's only three
      // completed jobs are all fixture work on a real, named lake. The moment
      // a real crew is used in the house's scratch-fixture walk, "3 jobs
      // completed on Big Long Lake" would be printed to a buyer about work
      // nobody paid for. Same pair of constants the public lake page uses, so
      // the two counts cannot drift.
      //
      // AND `paid` COUNTS. `paid` is terminal AFTER `complete`; every other
      // finished-work reader in this codebase asks for both, and asking for
      // `complete` alone would make a crew's public standing FALL as their
      // work gets paid out.
      admin
        .from("jobs")
        .select(`vendor_id, properties!inner(lake_id, ${OWNER_FIXTURE_EMBED})`)
        .in("status", ["complete", "paid"])
        .eq(OWNER_FIXTURE_FILTER, false)
        .in("vendor_id", ids),
      admin.from("lakes").select("id, name"),
    ]);
    if (doneRes.error || lakesRes.error) {
      // A FAILED READ IS NOT AN EMPTY ONE. Zero rows here would print "New to
      // LakeLife" over a crew with a dozen finished jobs — a statement about
      // somebody's business made with no fact behind it. Nobody gets a
      // standing, and the screen says why.
      console.error("[read failed] crew work history for standing:", doneRes.error ?? lakesRes.error);
      standingUnavailable = true;
    } else {
      const lakeName = new Map((lakesRes.data ?? []).map((l) => [l.id as string, l.name as string]));
      const counts = new Map<string, { completedJobs: number; lakeNames: Set<string> }>();
      for (const row of doneRes.data ?? []) {
        const vid = row.vendor_id as string;
        const rec = counts.get(vid) ?? { completedJobs: 0, lakeNames: new Set<string>() };
        rec.completedJobs += 1;
        const p = (Array.isArray(row.properties) ? row.properties[0] : row.properties) as { lake_id?: string } | null;
        const nm = p?.lake_id ? lakeName.get(p.lake_id) : null;
        if (nm) rec.lakeNames.add(nm);
        counts.set(vid, rec);
      }
      standingByVendor = new Map(
        ids.map((id) => {
          const rec = counts.get(id);
          return [id, deriveStanding({ completedJobs: rec?.completedJobs ?? 0, lakeNames: [...(rec?.lakeNames ?? [])].sort() })];
        }),
      );
    }
  }

  const preferredId = (prop.preferred_vendor as string) ?? null;
  const offers: CrewOffer[] = quoting.map((c) => {
    const yours = preferredId != null && c.vendorId === preferredId;
    const standing = standingByVendor?.get(c.vendorId);
    return {
      vendorId: c.vendorId,
      // A crew with no company name on file is still a real option; naming
      // them "Crew" is better than dropping them off the buyer's list.
      company: (c.company ?? "").trim() || "Crew",
      customerPrice: feeCustomerPrice(c.crewRate as number, fee),
      workDays: c.workDays ?? [],
      yours,
      ...(standing ? { standing } : {}),
    };
  });

  // THE SORT, AND IT IS SAID ON SCREEN: the crew you brought first (badged),
  // then cheapest first. Standing NEVER sorts — it is a label, and sorting on
  // it is how a newcomer quietly lands at the bottom of every list, which is
  // the exact harm the dial exists to avoid.
  offers.sort((a, b) => (a.yours === b.yours ? a.customerPrice - b.customerPrice : a.yours ? -1 : 1));

  // THE CREW THEY BROUGHT, WHEN THEY ARE NOT ON THE LIST.
  //
  // Rule 3 is that the person who brought a crew sees every option — but the
  // sort line silently flipped from "Your own crew first" to "Cheapest first"
  // and nothing said where their crew had gone. One sentence closes it. Their
  // OWN crew only: why anybody else is absent is none of their business, and
  // no reason is given here beyond "not available that day", which is the only
  // thing this pool can honestly assert.
  const yourCrewUnavailable =
    preferredId != null && !offers.some((o) => o.yours)
      ? (candidates.find((c) => c.vendorId === preferredId)?.company ?? "").trim() || null
      : null;

  return {
    ok: true,
    serviceName: svc.name as string,
    crewPriced: true,
    dateISO: input.dateISO,
    offers,
    emptyReason: null,
    standingShown: standingShown && !standingUnavailable,
    ...(standingUnavailable ? { standingUnavailable: true } : {}),
    ...(yourCrewUnavailable ? { yourCrewUnavailable } : {}),
  };
}

/** services.pricing_model, named so the cast above stays readable. */
type CrewOffersParam = Parameters<typeof buildCandidates>[1]["pricingModel"];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayOf(dateISO: string): string {
  return WEEKDAYS[new Date(dateISO + "T12:00:00").getDay()];
}
