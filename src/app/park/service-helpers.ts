/**
 * PURE HELPERS FOR THE PARK'S OWN SERVICE DESK.
 *
 * Separated from the actions so the rules that decide "can he turn this on"
 * and "what does the grounds property look like" are testable without a
 * database — the same split every other park slice uses.
 */

import { NO_LAKE_LINE } from "./readiness";

/** Who may switch park services on. Not every member — this spends money. */
export function canEnableParkServices(role: string | null | undefined): boolean {
  // A manager runs the park day to day; committing the park to a paid service
  // relationship is the owner's. Same line `setParkLive` draws.
  return role === "owner";
}

export interface ParkReadiness {
  parkName: string | null;
  lakeId: string | null;
  address: string | null;
  liveLots: number;
  memberRole: string | null;
  /** users.role — a park owner who also mows can get flipped to 'vendor'. */
  accountRole: string | null;
  hasCard: boolean;
}

/**
 * WHY HE CANNOT TURN IT ON YET, in the order he should fix them.
 *
 * Every one of these is a real refusal somewhere downstream — a lake is needed
 * to price a season, an address is needed for a crew to find the place, a live
 * lot is what the price is computed from, and `createBooking` refuses without
 * a card. Saying so here means he never presses a button that fails later with
 * a sentence written for a lake homeowner.
 */
export function buildParkBlockers(r: ParkReadiness): string[] {
  const out: string[] = [];
  if (!canEnableParkServices(r.memberRole)) {
    out.push("Only the park's owner can turn on services — you're listed as a manager.");
  }
  if (!r.lakeId) {
    // THE SHARED SENTENCE, not "Set it in Park setup": parks.lake_id is written
    // by ops alone (NewPark) and no owner screen has a lake control. The publish
    // gate and the readiness row already say so in these words; this was the
    // third doorway still sending him to a field that isn't there.
    out.push(NO_LAKE_LINE);
  }
  if (!r.address?.trim()) {
    out.push("The park has no street address, so a crew can't be sent to it. Set it in Park setup.");
  }
  if (r.liveLots <= 0) {
    out.push("There are no live lots, and grounds work is priced off the lot count.");
  }
  // A park owner who also mows can be flipped to 'vendor' by claiming a crew
  // invite, and /book reads services with the SESSION client — so his menu
  // would come back silently empty rather than refused.
  if (r.accountRole && r.accountRole !== "owner" && r.accountRole !== "ops") {
    out.push(
      `Your LakeLife account is set up as a ${r.accountRole}, not a customer. ` +
      "Booking needs a customer account — tell us and we'll sort it.",
    );
  }
  if (!r.hasCard) {
    // NAMES WHERE TO GO, like the two Park-setup blockers above it. Without the
    // destination this was the one item he could not clear: ParkNav has no
    // account tab, TopBar's "My portal" redirects straight back to /park, and
    // /profile used to hide the card form behind "do you own a lake house?".
    // The blocker he had to clear to buy any work for his own park had no door
    // anywhere in the app.
    out.push(
      "There's no card on file. Work is charged after it's done, but a card has " +
      "to be there first. Add one on your account page.",
    );
  }
  return out;
}

/**
 * The grounds property row.
 *
 * NO `place_id`: 0006 puts a GLOBAL partial unique index on it, and 0107's
 * trigger refuses a grounds property that carries one. NO sqft/beds/baths:
 * they drive housekeeping and winterization, which are not on a park's menu,
 * and inventing 2,400 sqft for a field of grass would be a number somebody
 * later trusts.
 */
export function buildGroundsPropertyRow(input: {
  ownerId: string;
  parkId: string;
  parkName: string;
  lakeId: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
}): Record<string, unknown> {
  return {
    owner_id: input.ownerId,
    lake_id: input.lakeId,
    address: input.address,
    // 0085's self-declared park flag. Here it is declared by the park owner
    // about HIS OWN park, which is the one case where it cannot enrol anybody
    // else in being visible.
    park_id: input.parkId,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    nickname: `${input.parkName} — grounds`,
  };
}

/** "21 live lots · $602 a visit" — the arithmetic, before he commits to it. */
export function priceLine(lots: number, price: number): string {
  const lotWord = lots === 1 ? "lot" : "lots";
  return `${lots} live ${lotWord} · $${price.toFixed(2)} a visit`;
}

// ------------------------------------------------- a home the park owns ----

export interface OwnedHomeInput {
  /** How a mobile home is actually described: "28 by 60". */
  widthFt: string;
  lengthFt: string;
  beds: string;
  baths: string;
}

export interface OwnedHomeResult {
  ok: boolean;
  error?: string;
  /**
   * `beds`/`baths` are NULL when he did not say. Nothing prices on them today —
   * only `sqft` (housekeeping) and `lawn_band` (mowing) reach the engine — so a
   * blank is recorded as "not known" rather than as zero. A home with 0
   * bedrooms is a false fact, and false facts are the thing this codebase keeps
   * having to dig back out.
   */
  row?: { sqft: number; beds: number | null; baths: number | null };
}

/**
 * HOW BIG IS IT — and this is not optional, for one specific reason.
 *
 * Housekeeping is `per_sqft_band`, and `priceService` picks the first tier
 * whose `max` exceeds the property's sqft. A property with sqft 0 therefore
 * prices at the SMALLEST band — $80 — which is also what a real 1,680 sq ft
 * double-wide prices at. The wrong answer and the right answer are the same
 * number, so nothing on any screen could ever reveal the mistake.
 *
 * Asked as width x length because that is how a mobile home is described on
 * every title and in every listing. Nobody knows their square footage; everyone
 * knows they have a 28 by 60.
 */
export function buildOwnedHomeRow(input: OwnedHomeInput): OwnedHomeResult {
  const num = (raw: string) => Number((raw ?? "").trim().replace(/[,\s]/g, ""));

  const w = num(input.widthFt);
  const l = num(input.lengthFt);
  if (!Number.isFinite(w) || !Number.isFinite(l) || w <= 0 || l <= 0) {
    return { ok: false, error: "How wide and how long is it? A single-wide is about 14 by 70." };
  }
  if (w > 60 || l > 100) {
    return { ok: false, error: "Those look like inches — give it in feet, like 28 by 60." };
  }

  // BEDS AND BATHS ARE OPTIONAL, and the size is not. Nothing prices on them:
  // housekeeping reads sqft and mowing reads lawn_band, and that is the whole
  // list. Left blank they stay NULL — "we didn't ask" — instead of being
  // written as 0, which would be a false fact about somebody's house recorded
  // by a form he skipped.
  const optCount = (raw: string, label: string):
    { ok: true; value: number | null } | { ok: false; error: string } => {
    const s = (raw ?? "").trim();
    if (!s) return { ok: true, value: null };
    const n = num(s);
    if (!Number.isFinite(n) || n < 0 || n > 12) {
      return { ok: false, error: `${label} doesn't look right — leave it blank if you're not sure.` };
    }
    return { ok: true, value: n };
  };

  const beds = optCount(input.beds, "That bedroom count");
  if (!beds.ok) return { ok: false, error: beds.error };
  const baths = optCount(input.baths, "That bathroom count");
  if (!baths.ok) return { ok: false, error: baths.error };

  return {
    ok: true,
    row: {
      sqft: Math.round(w * l),
      beds: beds.value == null ? null : Math.round(beds.value),
      // A half bath is a half; nothing finer is a thing anybody says.
      baths: baths.value == null ? null : Math.round(baths.value * 2) / 2,
    },
  };
}

/** "Lot 11, The Haven, 1 Haven Rd, Angola IN" — what a crew types into a map. */
export function ownedHomeAddress(lotNumber: string, parkName: string, parkAddress: string): string {
  return `Lot ${lotNumber}, ${parkName}, ${parkAddress}`;
}


/**
 * WHAT DOES THIS PARK'S UNIT RATE MULTIPLY BY — and what is it called?
 *
 * THIS REPLACED A NARROWER PREDICATE, `usesPerLotRate`, which asked only "does
 * this price move with the LOT COUNT?" — true for the mow and the two
 * cleanups, false for snow (priced `flat`, unit_rate never read). That was the
 * right question while a park could only buy `park_only` work, and the rate
 * editor drew a per-lot box for every service until it was asked.
 *
 * It is the wrong question now. A park may price anything on its own menu, and
 * that menu includes work counted in something other than lots — The Haven's
 * 28-section dock, a boat lift, a PWC lift. `usesPerLotRate` answered FALSE for
 * the dock (per_section counting `pier_sections`), so wired here it would have
 * told the owner "Pier install / removal is priced once per visit, not per lot
 * — put the whole amount in the per-visit box", a lie about a service priced
 * per section, and would have stored Josh's $30 a section as a $30 flat fee.
 *
 * So the old predicate was REMOVED rather than left beside this one (23 Sep
 * 2026): the overlay pass replaced its last production caller and left it
 * exported, tested and asked by nobody — a symbol with no caller, which reads
 * as a live rule to the next person who finds it.
 *
 * So this returns the COUNTER the engine will read, in the engine's own terms,
 * with a word for it. `null` means the model never looks at unit_rate at all —
 * `flat` (snow), `band`, `per_sqft_band` — and the per-unit box must not be
 * drawn or accepted.
 *
 * The nouns are for copy only. The ARITHMETIC is never taken from this table:
 * the desk asks `priceService` itself how many of the thing there are, so a new
 * pricing model cannot make the preview wrong, only the label generic.
 */
const UNIT_NOUNS: Record<string, string> = {
  lots: "lot",
  pier_sections: "pier section",
  boat_lifts: "boat lift",
  pwc_lifts: "PWC lift",
};

export interface ParkRateUnit {
  /** The pricing profile field priceService multiplies by. */
  countField: string;
  /** Singular noun for the owner: "pier section". */
  noun: string;
}

export function parkRateUnit(
  pricingModel: string | null | undefined,
  bandPricing: Record<string, unknown> | null | undefined,
): ParkRateUnit | null {
  if (pricingModel === "per_section") {
    // The SAME default priceService applies — `cfg.count_field ?? "pier_sections"`.
    // Two copies of that default is two rules; this one exists to name the
    // field, so it must name the one the engine will actually read.
    const field = (bandPricing?.count_field as string | undefined) ?? "pier_sections";
    return { countField: field, noun: UNIT_NOUNS[field] ?? "unit" };
  }
  if (pricingModel === "per_foot" || pricingModel === "seasonal_plus_perdiem") {
    // priceService: `base + unit_rate × boatFeet(p)`. No park buys one of these
    // today; naming it costs nothing and stops the day one does being the day
    // a park owner is told his boat work is priced per visit.
    return { countField: "boat_feet", noun: "foot of boat" };
  }
  // flat · band · per_sqft_band — unit_rate is never read. A number typed here
  // would show on the card, read as part of the price, and be worth nothing at
  // booking.
  return null;
}
