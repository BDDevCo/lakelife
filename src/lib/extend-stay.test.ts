import { describe, it, expect } from "vitest";
import {
  extendedRange, extensionPrice, remindDecision, canExtend, refusalText,
  lotWord, renewalRentWords,
  LEAD_DAYS, MAX_SILENT_ROLLS,
  type ExtendRefusal,
} from "@/lib/extend-stay";
import { parseDaterange, toDaterange, type DateRange, type Term } from "@/lib/parks";

const r = (start: string, end: string): DateRange => ({ start, end });
const RATES = [
  { term: "nightly" as Term, amount: 55 },
  { term: "weekly" as Term, amount: 315 },
  { term: "monthly" as Term, amount: 340 },
];

describe("extendedRange — one more period, contiguous with the last", () => {
  it("adds exactly one period of the term", () => {
    expect(extendedRange(r("2026-07-01", "2026-07-08"), "weekly")).toEqual(r("2026-07-01", "2026-07-15"));
    expect(extendedRange(r("2026-07-01", "2026-07-02"), "nightly")).toEqual(r("2026-07-01", "2026-07-03"));
    expect(extendedRange(r("2026-07-01", "2026-07-31"), "monthly")).toEqual(r("2026-07-01", "2026-08-30"));
  });

  it("keeps the ORIGINAL start — it widens the stay, it does not start a new one", () => {
    // Starting a second range would leave a gap or an overlap with itself, and
    // the exclusion constraint would refuse the renter their own lot.
    expect(extendedRange(r("2019-05-01", "2020-04-30"), "annual").start).toBe("2019-05-01");
  });

  it("crosses a month, a year and a leap day without drifting", () => {
    expect(extendedRange(r("2028-02-01", "2028-02-28"), "nightly").end).toBe("2028-02-29");
    expect(extendedRange(r("2026-12-01", "2026-12-31"), "nightly").end).toBe("2027-01-01");
  });

  it("always produces a range Postgres round-trips", () => {
    for (const term of ["nightly", "weekly", "monthly", "seasonal", "annual"] as Term[]) {
      const next = extendedRange(r("2026-03-01", "2026-03-15"), term);
      expect(parseDaterange(toDaterange(next))).toEqual(next);
    }
  });
});

describe("extensionPrice — the park's card, never a number we invented", () => {
  it("quotes the same term the stay is on", () => {
    expect(extensionPrice(RATES, "weekly")).toBe(315);
  });
  it("is null when the park stopped selling that term", () => {
    expect(extensionPrice(RATES, "annual")).toBeNull();
    expect(extensionPrice([{ term: "weekly", amount: 0 }], "weekly")).toBeNull();
  });
});

describe("remindDecision — ask before they pack, and only once", () => {
  const base = {
    range: r("2026-07-01", "2026-07-08"), term: "weekly" as Term,
    status: "active", alreadySent: false,
  };

  it("sends when the checkout is inside the lead window", () => {
    // weekly leads by 2 days; checkout is the 8th
    expect(remindDecision({ ...base, todayISO: "2026-07-06" })).toBe("send");
    expect(remindDecision({ ...base, todayISO: "2026-07-07" })).toBe("send");
  });

  it("stays quiet while it is still too early", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-03" })).toBe("too_early");
  });

  it("a MISSED night is caught the next night — the ask is not lost forever", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-08" })).toBe("send");
  });

  it("gives up once the stay is over rather than texting about the past", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-09" })).toBe("too_late");
  });

  it("EXACTLY ONCE — a guest texted three nights running stops reading our texts", () => {
    // Which matters because the one they stop reading is the freeze warning.
    expect(remindDecision({ ...base, todayISO: "2026-07-07", alreadySent: true })).toBe("already_sent");
  });

  it("a long tenancy is asked far earlier than a nightly guest", () => {
    expect(LEAD_DAYS.nightly).toBeLessThan(LEAD_DAYS.monthly);
    const monthly = { range: r("2026-01-01", "2026-12-31"), term: "monthly" as Term, status: "active", alreadySent: false };
    expect(remindDecision({ ...monthly, todayISO: "2026-12-20" })).toBe("send");
    expect(remindDecision({ ...monthly, todayISO: "2026-11-01" })).toBe("too_early");
  });

  it("never chases an application, a decline or a cancellation", () => {
    for (const status of ["applied", "declined", "cancelled", "ended"]) {
      expect(remindDecision({ ...base, todayISO: "2026-07-07", status })).toBe("not_extendable");
    }
  });

  it("stops rolling silently after enough turns, so a forgotten tenancy surfaces", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-07", extendedCount: MAX_SILENT_ROLLS }))
      .toBe("not_extendable");
  });

  it("an unparseable range is never chased", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-07", range: null })).toBe("not_extendable");
  });
});

describe("canExtend — the tap we can actually honour", () => {
  const base = {
    range: r("2026-07-01", "2026-07-08"), term: "weekly" as Term,
    status: "active", todayISO: "2026-07-06", otherHeld: [] as DateRange[], rates: RATES,
  };

  it("extends a clear lot and quotes the park's rate", () => {
    const res = canExtend(base);
    expect(res.ok).toBe(true);
    expect(res.range).toEqual(r("2026-07-01", "2026-07-15"));
    expect(res.price).toBe(315);
  });

  it("REFUSES when someone else already holds the days after theirs", () => {
    const res = canExtend({ ...base, otherHeld: [r("2026-07-10", "2026-07-20")] });
    expect(res.refusal).toBe("lot_taken");
    // And says nothing about who took it or until when — somebody else's business.
    const text = refusalText("lot_taken");
    expect(text).not.toMatch(/\d/);
    expect(text).toMatch(/another one/i);
  });

  it("allows a BACK-TO-BACK neighbour — changeover day is not a conflict", () => {
    // Their extension ends the 15th; the next stay starts the 15th.
    expect(canExtend({ ...base, otherHeld: [r("2026-07-15", "2026-07-22")] }).ok).toBe(true);
  });

  it("refuses when the park no longer sells that term", () => {
    expect(canExtend({ ...base, rates: [{ term: "nightly", amount: 55 }] }).refusal).toBe("no_rate");
    expect(canExtend({ ...base, rates: [] }).refusal).toBe("no_rate");
  });

  it("refuses a stay that already finished, and one that was never live", () => {
    expect(canExtend({ ...base, todayISO: "2026-08-01" }).refusal).toBe("already_ended");
    expect(canExtend({ ...base, status: "applied" }).refusal).toBe("not_extendable");
  });

  it("every refusal has a sentence a stressed person can act on", () => {
    // Typed against the union: a seventh ExtendRefusal fails typecheck here
    // until it has a sentence — a literal list would let it slip past.
    const all: Record<ExtendRefusal, true> = {
      not_found: true, not_extendable: true, lot_taken: true, no_rate: true, already_ended: true, already_renewed: true,
      inherited: true, length_not_offered: true, length_missing: true, season_closed: true,
    };
    for (const k of Object.keys(all) as ExtendRefusal[]) {
      const t = refusalText(k);
      expect(t.length).toBeGreaterThan(30);
      // Never blames the renter.
      expect(t).not.toMatch(/you (didn't|failed|should have)/i);
    }
  });

  it("a month-to-month roll is just an extension, and stays clear of itself", () => {
    // The correctness half: Donna's tenancy rolls a year forward and the
    // exclusion constraint sees one contiguous range, not two overlapping ones.
    const res = canExtend({
      range: r("2026-08-09", "2027-08-09"), term: "monthly", status: "active",
      todayISO: "2027-07-28", otherHeld: [], rates: RATES,
    });
    expect(res.ok).toBe(true);
    expect(res.range!.start).toBe("2026-08-09");
    expect(res.range!.end).toBe("2027-09-08");
  });
});

// ---------------------------------------------------------------------------
// A PARK THAT CAPS AGREEMENT LENGTH renews instead of extending. The Haven
// caps agreements at three months; staying on is a NEW one, starting the day
// the last ends — which is what carries the deposit forward — for THE LENGTH
// THE HOUSEHOLD CHOSE (the owner's decision: one, three or six months), never
// the cap.
// ---------------------------------------------------------------------------
describe("renewal at a capped park", () => {
  const base = {
    range: { start: "2026-12-15", end: "2027-03-15" },
    term: "monthly" as const,
    status: "active",
    todayISO: "2027-03-01",
    otherHeld: [],
    rates: [{ term: "monthly" as const, amount: 400 }],
    // The house style, as the caller resolves it; the tests below pick.
    renewMonths: 3,
  };

  it("produces the SUCCESSOR's range, not a wider one", () => {
    const r = canExtend({ ...base, capMonths: 3 });
    expect(r.ok).toBe(true);
    expect(r.isRenewal).toBe(true);
    // Starts where the last one ended — that is what "consecutive" means.
    expect(r.range).toEqual({ start: "2027-03-15", end: "2027-06-15" });
  });

  it("runs for the length CHOSEN — one month at a cap of three is one month", () => {
    // The cap used to be the length, so every tap at The Haven wrote three.
    const one = canExtend({ ...base, capMonths: 3, renewMonths: 1 });
    expect(one.ok).toBe(true);
    expect(one.range).toEqual({ start: "2027-03-15", end: "2027-04-15" });
    const six = canExtend({ ...base, capMonths: 6, renewMonths: 6 });
    expect(six.range).toEqual({ start: "2027-03-15", end: "2027-09-15" });
    // extendedRange reads the length, and nothing else, on a renewal.
    expect(extendedRange(base.range, "monthly", 1)).toEqual({ start: "2027-03-15", end: "2027-04-15" });
    expect(extendedRange({ start: "2027-01-31", end: "2027-01-31" }, "monthly", 1).end).toBe("2027-02-28");
  });

  it("refuses a renewal with NO length rather than writing the cap — and says a length is MISSING, not 'that length'", () => {
    const r = canExtend({ ...base, capMonths: 3, renewMonths: null });
    expect(r.ok).toBe(false);
    // 'length_not_offered' here read "doesn't write agreements of that
    // length" about a tap that named no length at all.
    expect(r.refusal).toBe("length_missing");
    expect(refusalText("length_missing")).toBe(
      "Pick how long to renew for — open the link again and tap one of the lengths it offers.",
    );
    expect(refusalText("length_not_offered")).toBe(
      "The park doesn't write agreements of that length. Open the link again and pick one of the lengths it offers.",
    );
    // And a length at a park with no cap is simply not read — it extends.
    expect(canExtend({ ...base, capMonths: null, renewMonths: 3 }).range!.end).toBe("2027-04-14");
  });

  it("refuses a length the park does not write — the ONE judgement (chooseAgreementLength), read here too", () => {
    // Six at a cap of three; twelve at a cap of six. The caller used to make
    // this call itself and hand canExtend a null, which read as 'no length'.
    expect(canExtend({ ...base, capMonths: 3, renewMonths: 6 }).refusal).toBe("length_not_offered");
    expect(canExtend({ ...base, capMonths: 6, defaultMonths: 1, renewMonths: 12 }).refusal).toBe("length_not_offered");
    expect(canExtend({ ...base, capMonths: 6, defaultMonths: 1, renewMonths: 6 }).ok).toBe(true);
    // A house style off the standard list is still offered.
    expect(canExtend({ ...base, capMonths: 6, defaultMonths: 2, renewMonths: 2 }).ok).toBe(true);
  });

  // THE SEASON CLAMP, on the resident's door as on the owner's. On a slip
  // lot closing 15 October the owner's Renew wrote [Sep 1, Oct 16) and the
  // household's own tap for 3 months wrote [Sep 1, Dec 1) — two doors, two
  // rows for one act, and nothing in the database refuses the second.
  describe("the season", () => {
    const september = { ...base, range: { start: "2027-06-01", end: "2027-09-01" }, todayISO: "2027-08-20", capMonths: 3 };

    it("cuts the successor to the season close, and says so on the verdict", () => {
      const r = canExtend({ ...september, renewMonths: 3, seasonEnd: "2027-10-16" });
      expect(r.ok).toBe(true);
      expect(r.range).toEqual({ start: "2027-09-01", end: "2027-10-16" });
      expect(r.cutShortBySeason).toBe(true);
      // One month from 1 September is inside the season — not cut.
      const one = canExtend({ ...september, renewMonths: 1, seasonEnd: "2027-10-16" });
      expect(one.range).toEqual({ start: "2027-09-01", end: "2027-10-01" });
      expect(one.cutShortBySeason).toBe(false);
      // The same arithmetic the owner's door uses — agreementEnd, not a copy.
      expect(extendedRange(september.range, "monthly", 3, "2027-10-16")).toEqual({ start: "2027-09-01", end: "2027-10-16" });
      expect(extendedRange(september.range, "monthly", 3, null)).toEqual({ start: "2027-09-01", end: "2027-12-01" });
    });

    it("refuses a renewal that would start after the close — nothing to renew into", () => {
      const r = canExtend({
        ...september, range: { start: "2027-08-01", end: "2027-11-01" }, todayISO: "2027-10-20",
        renewMonths: 1, seasonEnd: "2027-10-16",
      });
      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("season_closed");
      expect(refusalText("season_closed")).toBe(
        "Your spot is closed for the season after your dates, so there's nothing to renew into yet — the park can book you in again when it opens.",
      );
    });

    it("a year-round lot is not clamped, and an extension at an uncapped park ignores the season", () => {
      expect(canExtend({ ...september, renewMonths: 3, seasonEnd: null }).range!.end).toBe("2027-12-01");
      expect(canExtend({ ...september, renewMonths: 3 }).cutShortBySeason).toBe(false);
      expect(canExtend({ ...september, capMonths: null, seasonEnd: "2027-10-16" }).range!.end).toBe("2027-10-01");
    });
  });

  it("still WIDENS when the park has no cap", () => {
    const r = canExtend({ ...base, capMonths: null });
    expect(r.isRenewal).toBeFalsy();
    expect(r.range!.start).toBe("2026-12-15");   // unchanged
    expect(r.range!.end).toBe("2027-04-14");
  });

  it("falls back to what they already pay when the rate card is empty", () => {
    // Refusing a sitting tenant the next term because the ASKING rate is unset
    // would strand them. On a renewal their own rent is the price whether or
    // not a card exists; the card's absence is not a reason to say no.
    const r = canExtend({ ...base, rates: [], capMonths: 3, currentAmount: 400 });
    expect(r.ok).toBe(true);
    expect(r.price).toBe(400);
  });

  it("a sitting tenant's own rent wins over the park's asking rate", () => {
    // The card is what a NEW tenant is quoted. Writing it onto a renewal would
    // raise a sitting tenant's rent with no notice served — the re-rate screen
    // is the only way that number moves, and it arrives here as currentAmount.
    const r = canExtend({
      ...base, rates: [{ term: "monthly", amount: 500 }], capMonths: 3, currentAmount: 400,
    });
    expect(r.price).toBe(400);
  });

  it("the card is the fallback for a household with no rent on file", () => {
    const r = canExtend({
      ...base, rates: [{ term: "monthly", amount: 500 }], capMonths: 3, currentAmount: null,
    });
    expect(r.ok).toBe(true);
    expect(r.price).toBe(500);
  });

  it("the card still prices an EXTENSION at a park with no cap", () => {
    const r = canExtend({ ...base, capMonths: null, currentAmount: 400 });
    expect(r.price).toBe(400);
    const wider = canExtend({ ...base, rates: [{ term: "monthly", amount: 500 }], capMonths: null, currentAmount: 400 });
    expect(wider.price).toBe(500);
  });

  it("a household still on the seller's arrangement is sent to the park, whatever else is true", () => {
    const r = canExtend({ ...base, capMonths: 3, currentAmount: 400, origin: "grandfathered" });
    expect(r.ok).toBe(false);
    expect(r.refusal).toBe("inherited");
    // Even after it has run out — 'already_ended' points at a door that
    // files a second household.
    expect(canExtend({ ...base, capMonths: 3, todayISO: "2027-04-01", origin: "grandfathered" }).refusal).toBe("inherited");
    expect(refusalText("inherited")).toBe(
      "Your new agreement is signed with the park — give them a call and they'll have it ready.",
    );
    // A signed household is not.
    expect(canExtend({ ...base, capMonths: 3, currentAmount: 400, origin: "office" }).ok).toBe(true);
  });

  it("still refuses when there is no card AND no established rent", () => {
    const r = canExtend({ ...base, rates: [], capMonths: 3, currentAmount: null });
    expect(r.ok).toBe(false);
    expect(r.refusal).toBe("no_rate");
  });

  it("refuses a renewal that would land on somebody else", () => {
    const r = canExtend({
      ...base,
      capMonths: 3,
      otherHeld: [{ start: "2027-04-01", end: "2027-05-01" }],
    });
    expect(r.ok).toBe(false);
    expect(r.refusal).toBe("lot_taken");
  });

  // -------------------------------------------------------------------------
  // THE HOUSEHOLD'S OWN NEXT AGREEMENT IS NOT A CLASH. After a tap (or the
  // office renewing for them) the successor sat in `otherHeld`, and the
  // re-opened link read "That site is spoken for after your dates. The park
  // can look for another one" — to a household whose home site was theirs.
  // -------------------------------------------------------------------------
  describe("a household who already renewed", () => {
    const next = { start: "2027-03-15", end: "2027-06-15" };

    it("reads 'already set' with the successor's dates in words — never 'spoken for'", () => {
      const r = canExtend({ ...base, capMonths: 3, ownSuccessor: next });
      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("already_renewed");
      expect(refusalText("already_renewed", next)).toBe(
        "You're already set — your next agreement runs March 15, 2027 to June 15, 2027. The park will send the agreement to sign.",
      );
      expect(refusalText("already_renewed", next)).not.toMatch(/spoken for|another one|try again/i);
      // Without the dates the sentence still stands on its own.
      expect(refusalText("already_renewed")).toMatch(/^You're already set — your next agreement is written\./);
    });

    it("is judged BEFORE the clash test, so otherHeld keeps meaning somebody else", () => {
      // Both present: the household's own successor wins the sentence.
      const both = canExtend({
        ...base, capMonths: 3, ownSuccessor: next,
        otherHeld: [{ start: "2027-06-15", end: "2027-09-15" }],
      });
      expect(both.refusal).toBe("already_renewed");
      // Only somebody else after their dates: still a clash.
      const other = canExtend({ ...base, capMonths: 3, ownSuccessor: null, otherHeld: [{ start: "2027-04-01", end: "2027-05-01" }] });
      expect(other.refusal).toBe("lot_taken");
      // Neither: written.
      expect(canExtend({ ...base, capMonths: 3, ownSuccessor: null }).ok).toBe(true);
    });

    it("comes after 'inherited' only — a household re-opening the link after the old row ended is still 'already set', never 'already finished'", () => {
      expect(canExtend({ ...base, capMonths: 3, ownSuccessor: next, origin: "grandfathered" }).refusal).toBe("inherited");
      // The old row [Jul 1, Jul 8) is over on 1 April; their next agreement
      // runs 15 March – 15 June. "That stay has already finished. The park
      // can set up a new one." was the sentence, one line above the true one.
      expect(canExtend({ ...base, capMonths: 3, ownSuccessor: next, todayISO: "2027-04-01" }).refusal).toBe("already_renewed");
      // With no successor a finished stay still says so.
      expect(canExtend({ ...base, capMonths: 3, ownSuccessor: null, todayISO: "2027-04-01" }).refusal).toBe("already_ended");
    });

    // -----------------------------------------------------------------------
    // A RENEWAL RULE, ON THE RENEWAL PATH ONLY. At a park with no cap nothing
    // is "renewed" — the stay is widened — and a guest who holds a later,
    // separate booking of their own on the same site is not "already set":
    // they are offered the extension, and their own later booking is judged
    // exactly as anybody else's is for the clash.
    // -----------------------------------------------------------------------
    // A weekly RV guest, 1–8 July, at a park that writes no fixed lengths.
    const rv = {
      range: { start: "2026-07-01", end: "2026-07-08" }, term: "weekly" as const, status: "active",
      todayISO: "2026-07-06", otherHeld: [] as DateRange[], rates: RATES, capMonths: null as number | null,
    };

    it("at a park with NO cap a guest's own later booking keeps the extension — never 'already set'", () => {
      // Their own booking 20–27 July; the extension runs to the 15th and
      // touches nothing. This read {ok:false, already_renewed} — "You're
      // already set … The park will send the agreement to sign" — at a park
      // where nothing is signed, and the nightly sent no text at all.
      const later = { start: "2026-07-20", end: "2026-07-27" };
      const r = canExtend({ ...rv, ownSuccessor: later });
      expect(r).toMatchObject({ ok: true, isRenewal: false, price: 315 });
      expect(r.range).toEqual({ start: "2026-07-01", end: "2026-07-15" });
      // Same with the cap absent altogether.
      expect(canExtend({ ...rv, capMonths: undefined, ownSuccessor: later }).ok).toBe(true);
    });

    it("at a park with NO cap their own later booking still counts for the clash", () => {
      // Their own 12–19 July overlaps an extension to the 15th: the database
      // would refuse the widened range, so the sentence says so up front.
      const r = canExtend({ ...rv, ownSuccessor: { start: "2026-07-12", end: "2026-07-19" } });
      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("lot_taken");
      // Back-to-back with their own next booking is not a clash either.
      expect(canExtend({ ...rv, ownSuccessor: { start: "2026-07-15", end: "2026-07-22" } }).ok).toBe(true);
    });

    it("at a CAPPED park the same later row is their next agreement — 'already set'", () => {
      expect(canExtend({ ...rv, capMonths: 3, renewMonths: 1, ownSuccessor: { start: "2026-07-20", end: "2026-07-27" } }).refusal)
        .toBe("already_renewed");
    });
  });
});

describe("the words a household reads about their lot and their rent", () => {
  it("'lot' for a home, 'site' for a pad booked by the night", () => {
    expect(lotWord("long_term")).toBe("lot");
    expect(lotWord("short_term")).toBe("site");
    expect(lotWord(null)).toBe("lot");
    expect(lotWord(undefined)).toBe("lot");
  });

  it("quotes rent plus the fee and the monthly bill — $400 + $142.53 = $542.53", () => {
    expect(renewalRentWords({ price: 400, term: "monthly", fees: [{ label: "Grounds fee", amount: 142.53 }] }))
      .toBe("$400.00 rent plus the $142.53 Grounds fee — $542.53 a month");
  });

  it("names several fees once, by the park's own labels", () => {
    expect(renewalRentWords({ price: 400, term: "monthly", fees: [{ label: "Grounds fee", amount: 142.53 }, { label: "Water", amount: 20 }] }))
      .toBe("$400.00 rent plus $162.53 in fees (Grounds fee, Water) — $562.53 a month");
  });

  it("a park with no fee reads plain rent — never 'with the fees'", () => {
    expect(renewalRentWords({ price: 400, term: "monthly", fees: [] })).toBe("$400.00 a month");
    expect(renewalRentWords({ price: 400, term: "monthly" })).toBe("$400.00 a month");
    expect(renewalRentWords({ price: 400, term: "monthly", fees: [{ label: "Grounds fee", amount: 0 }] })).toBe("$400.00 a month");
  });

  it("only a monthly rent combines with a monthly fee; other terms quote the rent alone", () => {
    expect(renewalRentWords({ price: 315, term: "weekly", fees: [{ label: "Grounds fee", amount: 142.53 }] })).toBe("$315.00 a week");
    expect(renewalRentWords({ price: null, term: "monthly", fees: [{ label: "Grounds fee", amount: 142.53 }] })).toBe("");
  });
});
