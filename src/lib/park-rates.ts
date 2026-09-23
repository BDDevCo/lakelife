
/**
 * WHAT THIS PARK PAYS — the one place park pricing is looked up.
 *
 * 0115 gave every park its own rate table and zeroed the global price on every
 * `park_only` service. That was deliberate: The Haven pays $125 a cut for a mow
 * because of a contract signed in LaGrange County, Indiana, and a park in
 * another market inheriting that number silently is worse than showing no
 * number at all.
 *
 * ============ 28 AUGUST 2026, WIDENED HERE ============
 *
 *   "we have our rate, they will have theirs when they upload their costs or
 *    when a crew is onboarded with their pricing and the park chooses that new
 *    pricing schema. we cannot determine other parks and vendor costs right
 *    now, we can only control ours. they cant be combined."
 *
 * 0115 could only fence `park_only` work, because it fenced it by ZEROING THE
 * GLOBAL ROW — and that trick is unavailable for anything a lake house also
 * buys. 0143 then let a park BOOK general work (`services.park_bookable`) while
 * leaving that half unfenced, so The Haven's 28-section dock fell through to the
 * lake-house retail card: $220 + 28 x $48 = $1,564 a visit, against the $840 an
 * operation Josh actually charges. 1.86x, on the owner's own screen, for work he
 * holds a real quote for.
 *
 * So the fence moved OFF the flag and ONTO the doorway. The rule is now one
 * sentence with nothing to forget:
 *
 *   IF THE CUSTOMER IS A PARK, THE ONLY NUMBER THAT MAY PRICE THE WORK IS THAT
 *   PARK'S OWN ROW. No row, no price.
 *
 * That is why the `rates` argument is `ParkRates | null` and not an optional
 * map. `null` means "this is not a park, leave the retail card alone". A Map —
 * INCLUDING AN EMPTY ONE — means "this is a park", and a park with no row for
 * this service comes back base 0 / unit_rate 0, which prices to $0, which every
 * surface already treats as "not applicable" and refuses to book with an honest
 * sentence pointing at the park's own Services page.
 *
 * An empty Map used to mean "not a park" at one call site (profile/data.ts) and
 * "a park that has set no prices" at four others. Those are opposite answers to
 * the same question, and the type is what stops the next reader guessing.
 *
 * THERE IS STILL NO FALLBACK, in either direction. A park never inherits
 * LakeLife's retail number, another park's number, or a crew's card. A lake
 * house never sees a park's.
 *
 * Read through the service client: 0115 revoked client writes AND reads, so a
 * renter poking at the API cannot enumerate what the park pays its crews. Every
 * caller here has already established the viewer manages this park.
 */

export interface ParkRate {
  base: number;
  unit_rate: number;
  /** Why this number — "Josh, $840 an operation". Shown back to the owner. */
  note?: string | null;
}

export type ParkRates = Map<string, ParkRate>;

/**
 * Which services may a park set its own number on?
 *
 * Both halves of its menu, and exactly its menu: `getPricedServices` selects
 * `park_only.eq.true,park_bookable.eq.true` for a grounds property, so this
 * predicate and that query have to say the same thing or the desk would offer a
 * price box for work the park cannot buy, or hide one for work it can.
 *
 * NOT used to decide whether the overlay applies — `withParkRate` fences on the
 * CUSTOMER being a park, never on a flag, precisely so a caller that forgot to
 * select one of these columns cannot fail open to retail. This is for the one
 * place that asks the question properly: the server action that accepts a price.
 */
export function parkMayPrice(
  service: { park_only?: boolean | null; park_bookable?: boolean | null } | null | undefined,
): boolean {
  return service?.park_only === true || service?.park_bookable === true;
}

/**
 * Overlay a park's numbers onto a service's SHAPE (pricing_model, bands).
 *
 * @param rates `null` when the customer is NOT a park — the service is returned
 *   untouched and LakeLife's retail card prices it. A Map when the customer IS
 *   a park, in which case only that park's own row can put a number on it.
 */
export function withParkRate<T extends { id?: string | null }>(
  service: T,
  rates: ParkRates | null,
): T {
  // NOT A PARK. The retail card is the right answer and this function has no
  // business touching it. This is the lake-house direction of the fence and it
  // is the one that must never be widened.
  if (rates === null) return service;

  const own = service.id ? rates.get(service.id) : undefined;
  // `note` is documentation, not a pricing input — it must not ride along onto
  // the service rule and end up somewhere that reads a stray column.
  return own
    ? { ...service, base: own.base, unit_rate: own.unit_rate }
    // A PARK WITH NO ROW HAS NO PRICE. Zeroed HERE rather than in the services
    // table, because a `park_bookable` service's global row is a lake house's
    // real price and 0115's trick would take it away from them. Same outcome,
    // one customer at a time: $0, refused, and told where to set the number.
    : { ...service, base: 0, unit_rate: 0 };
}

/* ===========================================================================
 * 23 SEPTEMBER 2026 — THE CORRECTION, AND WHOSE IT IS.
 *
 * 0174 shipped a CHECK, `services_park_is_never_crew_priced`, and three code
 * fences under it. All four were built on a sentence the owner had not said.
 * He said this instead:
 *
 *   "well josh would be a contractor uploaded onto lake life that the park then
 *    would be able to see his services offeren on LakeLife, just like any crew
 *    for any home owner or renter in the park needing services."
 *
 * A PARK IS A CUSTOMER. Josh is not a special park arrangement — he is a
 * contractor onboarded onto LakeLife like anybody else, and the park sees his
 * card and books it the way a homeowner or a renter in the park does. A fence
 * saying "a park may never meet a crew's price" contradicts that, and it cost
 * something real: of the four `park_only` services, exactly ONE has a
 * negotiated rate (the mow). Snow clearing, common-area spring cleanup and
 * fall cleanup have none, The Haven has no snow crew at all, and the seller's
 * lawn guy sold his plow. A snow contractor onboarding with their own rate and
 * the park booking it is how that gets solved. The fence forbade exactly that.
 *
 * THE RULE THAT SHOULD HAVE BEEN WRITTEN:
 *
 *   A PARK'S OWN NEGOTIATED RATE BEATS A CREW'S CARD.
 *   WHERE THE PARK HAS NO RATE OF ITS OWN, THE CREW'S CARD IS THE PRICE —
 *   THE SAME AS FOR ANYBODY ELSE.
 *
 * The Haven's mow is safe because it HAS a number (base 20 + $5 a lot, out of
 * Mike's Advantage Lawn Care arrangement), not because a fence stood in front
 * of it. Flip `Park grounds mowing & trim` to crew_priced tomorrow and
 * precedence still answers the park's own number. That is the whole safety
 * argument for dropping the CHECK, and `park-precedence.test.ts` is where the
 * argument is actually made.
 *
 * AND HIS MODEL IS ALSO THE FIX FOR A TRAP THE OLD ONE SET. park_service_rates
 * holds the ALL-IN CUSTOMER PRICE, so to pay Josh his real $840 an operation
 * through the menu path the owner would have to type $1,050 — because the 0.20
 * margin floor caps a crew at $672 against a $840 quote and NO CREW COULD TAKE
 * THE JOB; it would sit on "Finding a crew" forever. ($1,050 x 0.80 = $840.00.
 * The mow's $125 exists for exactly that reason: $125 x 0.80 = $100.) On the
 * crew's card nobody grosses anything up: Josh's card says $840, the park pays
 * $840 x 1.12 = $940.80, Josh receives $739.20, LakeLife keeps $201.60.
 * =========================================================================== */

/**
 * WHICH OF THE FOUR ANSWERS PRICES THIS PIECE OF WORK.
 *
 * Four, not two, because the two "no price" cases are fixed by different
 * people and the screens have to be able to tell them apart:
 *
 *  - `menu`         LakeLife's retail card prices it. Every lake house, on
 *                   every service nobody flagged crew_priced.
 *  - `crew_card`    The crew's own rate card IS the price, plus the platform
 *                   fee at each end. A lake house on a crew_priced service —
 *                   and now a PARK on one, when the park has no rate of its own.
 *  - `park_rate`    This park's own negotiated row governs, and it outranks a
 *                   crew's card. The Haven's mow.
 *  - `park_no_rate` A park, on menu-priced work, with no row of its own. There
 *                   is genuinely no price: no crew is quoting it and LakeLife's
 *                   homeowner number is not this park's. The owner types one.
 */
export type PricingPath = "menu" | "crew_card" | "park_rate" | "park_no_rate";

/**
 * THE PRECEDENCE RULE, WRITTEN ONCE.
 *
 * NINE doorways decide who prices a job, not the three the brief named:
 *
 *   createBooking          app/book/actions.ts        books priced, or unpriced
 *   assignJob              app/book/dispatch.ts       writes price, cost, margin
 *   the /book menu         app/profile/data.ts        the tile and its sentence
 *   enrollAutopilot        app/book/autopilot-actions freezes a season's price
 *   approveFlag            app/approvals/actions.ts   reprices both ends
 *   claimJob               app/vendor/open-actions.ts CAN SET customer_price
 *   the open board         app/vendor/open-data.ts    the quote box + the floor
 *   assignJobManual        app/ops/actions.ts         ops hand-costing
 *   computeScarcityOffer   app/requests/offer-data.ts needs a menu price
 *
 * (and `summariseCorrection`, lib/arrival.ts, which is the quote the owner taps
 * Approve under — it has to agree with what approveFlag then bills).
 *
 * Before this, each carried its own copy, spelled FIVE different ways —
 * `!profile.groundsForParkId`, `!isParkGrounds`, `!isGrounds && !s.park_only`,
 * `!grounds`, `!parkRates` — and three of them read the bare flag with no park
 * question at all. A rule in one doorway of nine is not a rule; this codebase
 * has paid for that shape more than once, in money. `park-precedence.test.ts`
 * scans EVERY file in src/ for those spellings, not a hard-coded list of three.
 *
 * @param rates `null` when the customer is NOT a park — the same contract as
 *   `withParkRate`, deliberately, so the two can never be handed different
 *   ideas of who the customer is. A Map, INCLUDING AN EMPTY ONE, means a park.
 *
 * A caller that could not READ the park's rates must never pass an empty Map to
 * get past the types: an unread map says "this park has no rate", which here
 * means "let a crew's card price it", and that is a wrong charge rather than a
 * refusal. `loadParkRatesChecked` exists for exactly that, and every caller
 * here that speaks to a person uses it.
 */
export function pricingPathFor(
  service: { id?: string | null; crew_priced?: boolean | null } | null | undefined,
  rates: ParkRates | null,
): PricingPath {
  const crewPriced = service?.crew_priced === true;
  // NOT A PARK. Unchanged, byte for byte, from before any of this existed.
  if (rates === null) return crewPriced ? "crew_card" : "menu";

  // A PARK'S OWN NUMBER WINS — over a crew's card and over the retail card
  // both. This is the line that keeps the mow at its negotiated price no matter
  // what flag anybody sets on the service tomorrow.
  //
  // A service with no id cannot match a row and falls to the no-rate half
  // below rather than to retail: the failure direction is "no price", never
  // "somebody else's price".
  if (service?.id && rates.has(service.id)) return "park_rate";

  // NO ROW OF ITS OWN. The park is a customer like any other, so a crew-priced
  // service is quoted by the crew who takes it, at the same fee both ends.
  return crewPriced ? "crew_card" : "park_no_rate";
}

/**
 * DOES THE CREW WHO TAKES THIS SET THE PRICE? The one question the three
 * booking doorways actually ask. Kept as its own export so no doorway has to
 * get the path→boolean step right in its own file.
 */
export function crewSetsThePrice(
  service: { id?: string | null; crew_priced?: boolean | null } | null | undefined,
  rates: ParkRates | null,
): boolean {
  return pricingPathFor(service, rates) === "crew_card";
}

/**
 * THE SENTENCE FOR A PARK WITH NO NUMBER — and it is only ever true on the
 * `park_no_rate` path.
 *
 * Said to a park on a CREW-PRICED service it would be a lie: a crew is quoting
 * that one and there is nothing for the owner to type. Said on menu-priced work
 * it is the whole truth, and it points at the screen that fixes it.
 *
 * It never names LakeLife's homeowner figure. That number is mockup arithmetic
 * reverse-engineered from the prototype and seeded with no source note — it is
 * what put $1,564 a visit in front of an owner holding a $840 quote.
 */
export function noPriceForThisPark(serviceName: string): string {
  return `${serviceName} has no price for your park yet. Every park pays its own number for this one, so set what you pay on your park's Services page and it becomes bookable.`;
}
