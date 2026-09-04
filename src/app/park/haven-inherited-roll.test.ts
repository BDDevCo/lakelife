import { describe, it, expect } from "vitest";

/**
 * WHAT THE HAVEN'S ROLL SAID ON THE DAY IT WAS INHERITED — 25 August 2026.
 *
 * This is a HISTORICAL RECORD, not a description of what the park charges. It
 * is pinned here for two reasons, and both are about things that go wrong
 * quietly.
 *
 * FIRST, IT EXISTS NOWHERE ELSE IN A READABLE FORM. The source is the seller's
 * HANDWRITTEN rent roll in the due-diligence packet — a scan with no
 * extractable text. Somebody transcribed it by eye into `lot_rates` and
 * `park_import_batches` is empty, so the database records nothing about where
 * these twenty amounts came from. If those rows are ever emptied or rewritten,
 * the only remaining copy is a photograph.
 *
 * SECOND, THE RE-RATE IS COMING. The owner intends every lot to move to $400
 * on 1 January 2027, and the bulk rate tool says so in its own words:
 * "There is no undo on a rate card and no error on screen — the first sign is
 * a renter being quoted the wrong rent." Once that runs, what the seller
 * actually charged is gone from the system.
 *
 * The test is the arithmetic, because the arithmetic is what made the
 * transcription trustworthy in the first place: the roll reconciles to the
 * dollar against the figures stated on the due-diligence packet's own summary,
 * $5,200 of lot rent and $6,700 in total. A transcription that ties exactly is
 * a different kind of evidence from one that nearly does.
 *
 * ============ AND IT WAS ALREADY OUT OF DATE — 4 September 2026 ============
 *
 * The transcription is faithful. The DOCUMENT it was taken from was not
 * current, and nothing said so.
 *
 * The seller's September roster and eighteen signed leases give the same
 * eighteen leased lots as $5,625/month, against $4,950 here. Lot 22 dates it:
 * this roll says $250, and Denver Preston's signed lease of 2 November 2025
 * says $300 — so the sheet in the diligence packet predates November 2025 and
 * still carried R. Clark, who sold that home at the end of that year.
 *
 * The $6,700 banner reconciles to today's $5,625 exactly, three ways:
 *
 *     Lot 11 imputed at $1,500, and NOBODY PAYS IT      -1,500
 *     Lot 2, earning $250 then, now vacant                -250
 *     across-the-board increases on the 18 leased lots     +675
 *                                                      --------
 *                                                        -1,075   ($12,900/yr)
 *
 * Lot 11 is the owner's own house. He does not pay himself rent, so a fifth of
 * the stated roll was never income — it is a market rent for a house that
 * comes with the park, and it goes to zero the day he moves out.
 *
 * KEEP THIS FILE ANYWAY. It is still the only readable copy of what the packet
 * said, and it is now also the evidence of the gap. See the memory note
 * `the-haven-roll-from-mike`.
 */

/** Lot number -> monthly rent, as inherited. Lot 6 is vacant and had no card. */
const INHERITED: Record<string, number> = {
  "1": 325, "2": 250, "7": 275, "9": 275, "10": 275,
  "11": 1500,                                  // the park-owned 2019 28x60 house
  "14": 275, "15": 275, "16": 250, "17": 275, "18": 300,
  "19": 275, "20": 300, "21": 300, "22": 250, "23": 250,
  "24": 250, "26": 250, "27": 300, "28": 250,
};

/** Every lot the park has, including the one with no rent on it. */
const LOTS = [
  "1", "2", "6", "7", "9", "10", "11", "14", "15", "16", "17",
  "18", "19", "20", "21", "22", "23", "24", "26", "27", "28",
];

const HOME = "11";
const VACANT = "6";

describe("the roll as inherited", () => {
  it("covers twenty-one lots, numbered as they really are", () => {
    // NOT a contiguous 1-21. Numbers 3, 4, 5, 8, 12, 13 and 25 do not exist,
    // and an earlier version of the park file said they did — which is why the
    // list is written out rather than generated.
    expect(LOTS).toHaveLength(21);
    for (const gone of ["3", "4", "5", "8", "12", "13", "25"]) {
      expect(LOTS).not.toContain(gone);
    }
  });

  it("prices twenty of them, and says which one it does not", () => {
    expect(Object.keys(INHERITED)).toHaveLength(20);
    expect(INHERITED[VACANT]).toBeUndefined();
    expect(LOTS).toContain(VACANT);
  });

  it("ties to $5,200 of lot rent, to the dollar", () => {
    const lotRent = Object.entries(INHERITED)
      .filter(([lot]) => lot !== HOME)
      .reduce((sum, [, rent]) => sum + rent, 0);
    expect(lotRent).toBe(5200);
  });

  it("ties to $6,700 in total, to the dollar", () => {
    const total = Object.values(INHERITED).reduce((sum, rent) => sum + rent, 0);
    expect(total).toBe(6700);
    expect(total - INHERITED[HOME]).toBe(5200);
  });

  it("counts nineteen paying lots plus the house", () => {
    // The park file's own sentence: "21 lots. 19 pay." Those nineteen are the
    // lot rents; the house is a separate tenancy at a separate price.
    const payingLots = Object.keys(INHERITED).filter((lot) => lot !== HOME);
    expect(payingLots).toHaveLength(19);
    expect(INHERITED[HOME]).toBe(1500);
  });

  it("averages about $274 a lot, which is what made the deal look like it did", () => {
    // The park file quotes ~$272 against a ~$420 market. Anything materially
    // different here means the transcription drifted.
    const payingLots = Object.keys(INHERITED).filter((lot) => lot !== HOME);
    const avg = 5200 / payingLots.length;
    expect(Math.round(avg)).toBe(274);
  });

  it("holds no rent outside the range the roll actually used", () => {
    // Lot rents ran $250-$325. A number outside that band is a typo, not a lot.
    for (const [lot, rent] of Object.entries(INHERITED)) {
      if (lot === HOME) continue;
      expect({ lot, inBand: rent >= 250 && rent <= 325 })
        .toEqual({ lot, inBand: true });
    }
  });
});
