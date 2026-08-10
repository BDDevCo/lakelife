/**
 * THE REVENUE-STREAM TEMPLATE.
 *
 * A park is not one business. The Haven alone runs six: pads people live on,
 * boat slips, a home the park owns and rents by the month, four homes it will
 * rent by the night, boat storage in a pole barn, and the utility costs it
 * passes back. Another park runs two of those and something we have not
 * thought of.
 *
 * So the product must not assume a shape. This file is the CATALOGUE an owner
 * chooses from during setup, and — more usefully — the honest readiness check
 * for each choice: you have turned this on, here is what is still missing
 * before it earns a penny.
 *
 * THE DESIGN RULE HERE: a stream being ON is an INTENTION, and it is stored.
 * Readiness is DERIVED from the park's actual data and never stored, because a
 * stored "ready" flag goes stale the moment somebody deletes a lot. Intention
 * is a fact about the owner; readiness is a fact about the park.
 */

export type RevenueStream =
  | "long_term_lots"
  | "short_term_homes"
  | "park_owned_rentals"
  | "boat_slips"
  | "storage"
  | "cost_recovery"
  | "fees";

export const REVENUE_STREAMS: RevenueStream[] = [
  "long_term_lots",
  "park_owned_rentals",
  "short_term_homes",
  "boat_slips",
  "storage",
  "cost_recovery",
  "fees",
];

export interface StreamSpec {
  label: string;
  /** One line, in the owner's language, not ours. */
  what: string;
  /** What it looks like at a park that runs it well. */
  example: string;
}

export const STREAM_SPEC: Record<RevenueStream, StreamSpec> = {
  long_term_lots: {
    label: "Lots people live on",
    what: "Pads and sites rented by the month to people who bring their own home.",
    example: "19 pads at $400 a month",
  },
  park_owned_rentals: {
    label: "Homes you own and rent",
    what: "A home the park owns, rented by the month. You maintain it, so the rent is for the home, not the pad.",
    example: "A double-wide at $1,400 a month",
  },
  short_term_homes: {
    label: "Homes you rent by the night",
    what: "Park-owned homes booked like a holiday let. Priced by the night and cleaned between guests.",
    example: "4 homes averaging $28,000 a year each",
  },
  boat_slips: {
    label: "Boat slips",
    what: "Dock space rented out. Usually seasonal — set the season on the slip so it can't be booked in January.",
    example: "20 slips at $100 a month, April to October",
  },
  storage: {
    label: "Storage",
    what: "Boat, trailer and vehicle storage — a barn, a yard, or numbered spaces.",
    example: "A 24×24 pole barn, or 30 outdoor spaces",
  },
  cost_recovery: {
    label: "Passing on costs",
    what: "Water, sewer, trash, lighting and grounds, split across occupied lots. Never more than you paid.",
    example: "$380 water split 20 ways — $19 each",
  },
  fees: {
    label: "Fees and extras",
    what: "Pets, golf carts, extra vehicles, guest parking, laundry, renters insurance.",
    example: "$25 a month per pet, $15 per golf cart",
  },
};

/** What the park actually has, for deciding readiness. */
export interface ParkFacts {
  longTermLots: number;
  shortTermLots: number;
  slipLots: number;
  storageLots: number;
  parkOwnedHomes: number;
  /** Lots that exist but are planned or being renovated. */
  notYetLive: number;
  /** Lots carrying at least one rate. */
  lotsWithRates: number;
  costsRecorded: number;
  feesConfigured: number;
}

export interface StreamStatus {
  stream: RevenueStream;
  on: boolean;
  /** True when it could actually take money today. */
  ready: boolean;
  /** What is missing, in the order he should do it. Empty when ready. */
  missing: string[];
  /** Real inventory backing this stream right now. */
  count: number;
  /** Set up but not yet live — worth saying rather than reading as zero. */
  coming: number;
}

/**
 * Is this stream ready to earn?
 *
 * Deliberately generous about ORDER and strict about SUBSTANCE: it never says
 * "ready" for a stream with no inventory or no price, because a park owner who
 * thinks slips are switched on and has not priced them will find out from a
 * customer.
 */
export function streamStatus(
  stream: RevenueStream,
  on: boolean,
  facts: ParkFacts,
): StreamStatus {
  const missing: string[] = [];
  let count = 0;
  let coming = 0;

  switch (stream) {
    case "long_term_lots":
      count = facts.longTermLots;
      if (count === 0) missing.push("Add your lots");
      else if (facts.lotsWithRates === 0) missing.push("Set what a lot rents for");
      break;

    case "park_owned_rentals":
      count = facts.parkOwnedHomes;
      if (count === 0) missing.push("Mark the lot whose home you own");
      break;

    case "short_term_homes":
      count = facts.shortTermLots;
      coming = facts.notYetLive;
      if (count === 0 && coming === 0) missing.push("Add the homes — mark them 'planned' if you haven't bought them yet");
      else if (count === 0) missing.push("They're not live yet");
      break;

    case "boat_slips":
      count = facts.slipLots;
      if (count === 0) missing.push("Add your slips");
      break;

    case "storage":
      count = facts.storageLots;
      if (count === 0) missing.push("Add your storage spaces");
      break;

    case "cost_recovery":
      count = facts.costsRecorded;
      if (facts.longTermLots === 0) missing.push("Add your lots first — there's nobody to split a bill across");
      else if (count === 0) missing.push("Enter a bill");
      break;

    case "fees":
      count = facts.feesConfigured;
      if (count === 0) missing.push("Nothing here yet — fees aren't built");
      break;
  }

  return {
    stream,
    on,
    // A stream nobody turned on is not "unready", it is simply off. Reporting
    // missing steps for something he never chose is noise.
    ready: on && missing.length === 0,
    missing: on ? missing : [],
    count,
    coming,
  };
}

export function allStreamStatuses(
  on: readonly string[],
  facts: ParkFacts,
): StreamStatus[] {
  const set = new Set(on);
  return REVENUE_STREAMS.map((s) => streamStatus(s, set.has(s), facts));
}

/** Only the ones he switched on and still owes work on. */
export function streamsNeedingWork(statuses: readonly StreamStatus[]): StreamStatus[] {
  return statuses.filter((s) => s.on && !s.ready);
}

/**
 * The one line for the top of setup.
 *
 * Counts what is EARNING, not what is ticked — a park owner with six streams
 * switched on and two of them working should read "2 of 6 earning", because
 * that is the true state and the other four are the to-do list.
 */
export function setupSummary(statuses: readonly StreamStatus[]): string {
  const on = statuses.filter((s) => s.on);
  if (on.length === 0) return "Pick what your park earns from.";
  const ready = on.filter((s) => s.ready).length;
  if (ready === on.length) return `All ${ready} of your income streams are set up.`;
  return `${ready} of ${on.length} income streams ready — the rest still need something.`;
}
