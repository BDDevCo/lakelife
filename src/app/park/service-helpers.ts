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
