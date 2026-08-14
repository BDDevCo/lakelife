/**
 * PURE HELPERS FOR THE PARK'S OWN SERVICE DESK.
 *
 * Separated from the actions so the rules that decide "can he turn this on"
 * and "what does the grounds property look like" are testable without a
 * database — the same split every other park slice uses.
 */

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
    out.push("This park isn't attached to a lake yet, and a lake decides the season. Set it in Park setup.");
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
    out.push("There's no card on file. Work is charged after it's done, but a card has to be there first.");
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
