/**
 * THE EXTRA THEY ASKED FOR — the words, the bounds and the staleness rule.
 *
 * Brendon, 23 September 2026: "if a home owner wants extras on that service,
 * can they type what they want done above and beyond the standard service
 * where the crew would provide pricing on that extra and the home owner would
 * either accept or decline that pricing? ... then for the next time that crew
 * is there an option would auto allow the home owner to pick the standard
 * service with their custom add on populated with that new pricing from the
 * crew previously."
 *
 * PURE. No database, no `server-only`, no React — so the sentences a person
 * reads, the bound on the box they type into and the rule that retires a stale
 * price can all be tested without standing a job up. The money itself is
 * `platform-fee.ts` and is never re-derived here.
 */

import { customerPrice, crewPayout, round2, type PlatformFee } from "./platform-fee";

/** The six states a request can be in. Mirrors the `addon_status` enum (0180). */
export type AddonStatus =
  | "requested"
  | "quoted"
  | "crew_declined"
  | "accepted"
  | "owner_declined"
  | "withdrawn"
  /**
   * ACCEPTED, THEN TAKEN BACK OFF BECAUSE THE CREW LEFT THE VISIT.
   *
   * Not a decision anybody made. An accepted extra's payout rides
   * `jobs.vendor_cost`, and six doorways hand a job back to the board and
   * re-assign it at a different crew's base rate — so the extra has to come
   * off with the crew who agreed it, or the owner pays for work nobody will
   * do. `jobs_addon_follows_the_crew` (0180) writes it, in the same statement
   * that moves `vendor_id`.
   */
  | "crew_left";

/**
 * FIVE HUNDRED CHARACTERS. Roughly a paragraph — enough for "trim the four
 * cedars along the seawall and haul the clippings", not enough to paste a
 * novel into a crew's SMS. Restated as a CHECK in 0180, because a bound only
 * the application knows is a bound only on the doorways somebody remembered.
 */
export const ADDON_REQUEST_MAX = 500;

/** A crew's reason for not quoting. Shorter: it is one sentence, not a brief. */
export const ADDON_DECLINE_REASON_MAX = 300;

/**
 * HOW MANY UNANSWERED REQUESTS ONE VISIT MAY CARRY: FIVE.
 *
 * Nothing counted. Every request fires an SMS AND an email at a named
 * contractor's personal number and mailbox, there is no moderation in either
 * direction, and one owner could file five hundred of them at one crew in an
 * afternoon. Five is the number a real visit plausibly carries — "trim the
 * cedars", "move the dock ladder", "haul the brush pile" — and anything past
 * it is not a list of jobs, it is a channel being used as one.
 *
 * It counts only the UNANSWERED ones, so a crew who prices or declines what is
 * there clears the way immediately; nothing is ever blocked for good, and the
 * booked visit is untouched either way.
 */
export const ADDON_OPEN_REQUESTS_MAX = 5;

/**
 * HOW LONG A CREW'S NUMBER STAYS OFFERABLE: NINETY DAYS.
 *
 * "A number quoted in May must not silently bill two Octobers later" is the
 * whole danger in this feature, and the answer has to be a real duration with
 * a reason rather than a round number somebody liked.
 *
 * Ninety days is chosen because it covers every RECURRING cadence this product
 * sells and refuses every SEASONAL one. A weekly mow comes back in 7 days, a
 * fortnightly in 14, monthly housekeeping in ~31 — all comfortably inside, so
 * the thing he actually asked for ("the next time that crew is there") works
 * without anybody re-quoting. A seasonal pair does not: pier install to pier
 * removal is about six months, and open-to-open is a year. Between those two
 * visits the crew has bought fuel at a new price, a season of labour has been
 * repriced, and Indiana has had a winter. A number from the far side of that
 * is not a price, it is a memory.
 *
 * And nothing here auto-bills in any case: inside ninety days the owner is
 * SHOWN what that crew charged and on what date, and must tap it. Past ninety
 * days the price is not offered at all — the words are, so they can ask again
 * and the crew can name a current number.
 */
export const ADDON_OFFER_BACK_DAYS = 90;

/* ------------------------------------------------------------------ input -- */

export interface RequestTextResult {
  ok: boolean;
  /** The text to store. Empty when `ok` is false. */
  text: string;
  /** What to show the person. Null when `ok`. */
  problem: string | null;
  /**
   * HOW MUCH THEY ACTUALLY TYPED, before anything was trimmed away.
   *
   * A guard downstream of a sanitiser cannot otherwise tell "they sent
   * nothing" from "we binned it", so the refusal names the number they hit
   * rather than describing an empty box they did not leave empty.
   */
  attemptedLength: number;
}

/**
 * Tidy and bound what the owner typed.
 *
 * Collapses runs of whitespace (a paste out of a mail client arrives full of
 * them) and trims the ends. It does NOT strip characters: `<`, `&` and `'` are
 * ordinary English, and the one escaper (lib/html-safe, reached through
 * `notify` -> `asHtml`) is what makes them safe in a mail body. Mangling the
 * text here would only mean the crew reads a different sentence from the one
 * the owner wrote.
 *
 * NOTHING MODERATES IT. There is no review queue and no word list between this
 * box and a crew's phone; see the table comment in 0180.
 */
export function normaliseAddonRequest(raw: string | null | undefined): RequestTextResult {
  const attempted = (raw ?? "").length;
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return {
      ok: false,
      text: "",
      problem: "Tell your crew what you'd like doing and they'll put a price on it.",
      attemptedLength: attempted,
    };
  }
  if (text.length > ADDON_REQUEST_MAX) {
    return {
      ok: false,
      text: "",
      problem:
        `That's ${text.length} characters and the box holds ${ADDON_REQUEST_MAX}. ` +
        "Shorten it, or ask for the big one as a separate job.",
      attemptedLength: attempted,
    };
  }
  return { ok: true, text, problem: null, attemptedLength: attempted };
}

/**
 * A CREW'S REASON FOR NOT QUOTING — bounded, and the bound is said out loud.
 *
 * It used to be `.slice(0, 300)`: a crew typing three hundred and forty
 * characters had the last forty binned silently, mid-sentence, and the result
 * was then QUOTED BACK TO THE OWNER inside quotation marks as if it were the
 * whole of what they said. A sanitised value looks exactly like an absent one
 * to everything downstream, so the refusal names the number they hit instead.
 *
 * Empty is fine and always was — a reason is optional, and inventing a
 * sentence for a crew who gave none is worse than saying nothing.
 */
export function normaliseDeclineReason(raw: string | null | undefined): RequestTextResult {
  const attempted = (raw ?? "").length;
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length > ADDON_DECLINE_REASON_MAX) {
    return {
      ok: false,
      text: "",
      problem:
        `That's ${text.length} characters and the box holds ${ADDON_DECLINE_REASON_MAX}. ` +
        "Shorten it — they'll read the whole thing.",
      attemptedLength: attempted,
    };
  }
  return { ok: true, text, problem: null, attemptedLength: attempted };
}

export interface QuoteResult {
  ok: boolean;
  /** Dollars and cents. Zero when `ok` is false — never a guess. */
  amount: number;
  problem: string | null;
}

/**
 * The crew's own number, read off a form.
 *
 * NO DEFAULT, NO SUGGESTION, NO PREFILL. An empty box asks a question; a
 * filled one answers it wrongly, and LakeLife naming a number for a crew is
 * the exact posture 0174 exists to avoid. Zero is refused for the reason the
 * whole platform refuses it: zero is this product's word for "cannot be
 * priced", not for "free".
 *
 * Two decimal places, because Postgres rounds an exact half away from zero and
 * JavaScript rounds it up — a quote with a third decimal is the one input that
 * can make the author of the arithmetic and the database's verifier of it
 * disagree by a cent (0180's `job_addons_quote_is_whole_cents`).
 */
export function normaliseCrewQuote(raw: string | number | null | undefined): QuoteResult {
  const s = typeof raw === "number" ? String(raw) : (raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!s) return { ok: false, amount: 0, problem: "Type what you'd charge for this and we'll put it to them." };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, amount: 0, problem: `"${s}" isn't an amount.` };
  if (n <= 0) return { ok: false, amount: 0, problem: "A price has to be more than $0. If you'd rather not take it on, say no instead." };
  if (round2(n) !== n) return { ok: false, amount: 0, problem: "Dollars and cents only — two decimal places." };
  // NOT "ring us", and not "message us" either: there is no phone line, and
  // this screen draws no message box. Copy that names a control the reader
  // does not have is this codebase's own bug class (lib/notify.test.ts scans
  // for one shape of it), so this states the fact and instructs nothing.
  if (n > 100_000) return { ok: false, amount: 0, problem: "That's larger than any single extra we handle — work that size needs booking as its own job rather than added to this one." };
  return { ok: true, amount: n, problem: null };
}

/* ----------------------------------------------------------------- money -- */

export interface AddonMoney {
  crewQuote: number;
  customerPrice: number;
  crewPayout: number;
}

/**
 * The two ends of an add-on, from the crew's number and the frozen dials.
 *
 * A thin pass-through to `platform-fee.ts` on purpose: it exists so that no
 * screen and no action ever writes `quote * 1.12` of its own, and so a grep
 * for the add-on money finds ONE place. 0180's
 * `job_addons_money_ties_to_the_quote` refuses any pair these two functions
 * did not produce.
 */
export function addonMoney(crewQuote: number, fee: PlatformFee): AddonMoney {
  return {
    crewQuote,
    customerPrice: customerPrice(crewQuote, fee),
    crewPayout: crewPayout(crewQuote, fee),
  };
}

/**
 * A visit's money with its accepted extras folded in.
 *
 * Used by the one repricing routine there is (`approveFlag`), so that
 * approving a crew's correction recomputes the BASE and puts the agreed extras
 * back on top — rather than writing a bare base price over a job the owner had
 * added $44.80 of work to. `round2` is imported rather than rewritten: both
 * inputs are already whole cents, so this only ever repairs float dust.
 */
export function withAddons(
  base: { customer: number; cost: number },
  extra: { customer: number; payout: number },
): { customer: number; cost: number; margin: number } {
  const customer = round2(base.customer + extra.customer);
  const cost = round2(base.cost + extra.payout);
  return { customer, cost, margin: round2(customer - cost) };
}

/* ------------------------------------------------------------ staleness -- */

export interface OfferBack {
  /** May this remembered price be put in front of the owner at all? */
  offerable: boolean;
  /** Whole days since the crew named it. */
  ageDays: number;
  /** Why it is not offerable, in words. Null when it is. */
  why: string | null;
}

/**
 * THE INSTANT THIS CLOCK RUNS FROM IS `quoted_at`, NOT `decided_at`, AND THAT
 * IS THE WHOLE RULE.
 *
 * Measuring from the acceptance made the window reset itself: `repeatAddon`
 * files a fresh row carrying the SAME crew quote and accepts it, so
 * `decided_at` moved to today every time somebody tapped "add it again". A
 * number named in January, tapped every six weeks, was still "fresh" in 2028
 * and no crew was ever asked to re-quote it — the exact thing the brief said
 * must not happen ("a number quoted in May must not silently bill two Octobers
 * later"), reachable in three taps.
 *
 * `repeatAddon` now carries the ORIGINAL `quoted_at` forward onto the repeat,
 * so a chain ages from the day the crew actually named the number and dies
 * ninety days after it, however many times it has been tapped in between. That
 * also makes the card's "Your crew priced it on ..." true: it prints the same
 * column.
 */

/** Whole days between two instants, floored — negative clock skew reads as 0. */
function daysBetween(then: Date, now: Date): number {
  const ms = now.getTime() - then.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/**
 * Is a price this crew named still offerable?
 *
 * A BAD DATE IS NOT A FRESH ONE. An unparseable or missing `decidedAt` returns
 * `offerable: false` — the failure direction that shows the owner a text box
 * instead of a number, rather than the one that bills a price of unknown age.
 */
export function offerBack(
  quotedAt: string | Date | null | undefined,
  now: Date = new Date(),
): OfferBack {
  const d = quotedAt == null ? null : new Date(quotedAt);
  if (!d || Number.isNaN(d.getTime())) {
    return { offerable: false, ageDays: 0, why: "We can't tell when your crew gave that price, so we won't offer it again." };
  }
  const ageDays = daysBetween(d, now);
  if (ageDays > ADDON_OFFER_BACK_DAYS) {
    return {
      offerable: false,
      ageDays,
      why:
        `Your crew named that price more than ${ADDON_OFFER_BACK_DAYS} days ago, so we won't put it back in front of you. ` +
        "Ask again below and they'll price it as it stands today.",
    };
  }
  return { offerable: true, ageDays, why: null };
}

/**
 * WHAT THEY CHARGED LAST TIME, with the date — never a bare number.
 *
 * TWO FACTS, AND THEY ARE NOT THE SAME FACT. `charged` is the figure frozen on
 * the accepted row — what this household actually paid — and `named` is the
 * day the crew put that number on it. The first version of this sentence
 * stated a historical charge using a figure RECOMPUTED at today's dial, over a
 * date taken from the acceptance: two different moments in one sentence, both
 * mislabelled, on a screen where somebody authorises money. The day the dial
 * moves, "what this crew charged last time" would have been a number nobody
 * was ever charged.
 *
 * `todayPrice` is passed ONLY when it differs from `charged` — the dial has
 * moved since — and then the difference is said out loud rather than left for
 * the owner to find on the button.
 *
 * Both dates and figures arrive already formatted by the caller (lake-time
 * `longDate`, ledger-helpers `money`), because a date a person reads is
 * "August 12, 2026" and never "2026-08-12".
 */
export function lastChargedLine(input: {
  charged: string;
  named: string;
  todayPrice?: string | null;
}): string {
  const head = `This crew charged you ${input.charged} for this, at a price they named on ${input.named}.`;
  return input.todayPrice && input.todayPrice !== input.charged
    ? `${head} Our fee has changed since, so today it comes to ${input.todayPrice}.`
    : head;
}

/* ------------------------------------------------------------ sentences -- */

export interface OwnerStateSentence {
  /** The pill at the top of the card. */
  pill: string;
  /** The tone class for that pill — lib/status-colors' vocabulary. */
  tone: "warn" | "teal" | "ok" | "slate";
  /** The sentence under it. */
  line: string;
}

/**
 * WHAT THE OWNER IS LOOKING AT — and the three states that are NOT the same.
 *
 * "Your crew hasn't answered yet", "your crew won't take this on" and "you
 * said no to their price" are three different facts. Collapsing any two of
 * them is this codebase's copy-that-lies class pointed at somebody's money.
 *
 * AND NONE OF THEM IS AN ERROR. Every sentence below ends by saying the
 * booked visit is unaffected, because the one thing an owner must never have
 * to wonder is whether asking for something extra put their mow at risk.
 */
export function ownerStateSentence(input: {
  status: AddonStatus;
  serviceName: string;
  /** The customer's price, already formatted. Only read when accepted/quoted. */
  price?: string | null;
  /** What the crew said when they would not quote. */
  crewReason?: string | null;
}): OwnerStateSentence {
  const svc = input.serviceName?.trim() || "your visit";
  switch (input.status) {
    case "requested":
      return {
        pill: "Waiting on your crew",
        tone: "warn",
        line: `Your crew hasn't put a price on this yet. Your ${svc} goes ahead as booked either way — nothing is added and nothing is charged unless you say yes to their price.`,
      };
    case "quoted":
      return {
        pill: "Your decision",
        tone: "teal",
        line: input.price
          ? `Your crew will do this for ${input.price}, added to your ${svc}. Say no and your ${svc} still goes ahead exactly as booked, at the price you already have.`
          : `Your crew has answered. Say no and your ${svc} still goes ahead exactly as booked.`,
      };
    case "crew_declined": {
      const why = (input.crewReason ?? "").trim();
      return {
        pill: "Crew said no",
        tone: "slate",
        // THE FULL STOP IS PART OF THE SENTENCE, NOT PART OF THE BRANCH.
        // `...on: "no chipper on the truck" Nothing was added` ran two
        // sentences together for every crew who gave a reason, which is the
        // half that ships most often.
        line:
          `Your crew isn't taking this one on${why ? `: "${why}".` : "."}` +
          ` Nothing was added and nothing was charged. Your ${svc} goes ahead as booked.`,
      };
    }
    case "accepted":
      return {
        pill: "Added",
        tone: "ok",
        line: input.price
          ? `You agreed ${input.price} for this and it's on your ${svc}.`
          : `You agreed this and it's on your ${svc}.`,
      };
    case "owner_declined":
      return {
        pill: "You said no",
        tone: "slate",
        line: input.price
          ? `You turned down ${input.price} for this. Nothing was added and nothing was charged. Your ${svc} goes ahead as booked.`
          : `You turned this down. Nothing was added and nothing was charged. Your ${svc} goes ahead as booked.`,
      };
    case "withdrawn":
      return {
        pill: "Withdrawn",
        tone: "slate",
        line: `You took this back before your crew priced it. Your ${svc} goes ahead as booked.`,
      };
    case "crew_left":
      // NOT AN ERROR AND NOT A DECISION. The crew who priced it is no longer
      // on this visit, so the price they named came off with them — and the
      // sentence has to say it came OFF THE BILL, because the one thing an
      // owner will want to know is whether they are still being charged.
      return {
        pill: "Taken off",
        tone: "slate",
        line: input.price
          ? `The crew who agreed ${input.price} for this is no longer on this visit, so it's been taken off and you won't be charged for it. Your ${svc} goes ahead as booked — ask your new crew if you'd still like it doing.`
          : `The crew who agreed this is no longer on this visit, so it's been taken off and you won't be charged for it. Your ${svc} goes ahead as booked — ask your new crew if you'd still like it doing.`,
      };
  }
}

/**
 * THE SAME FACTS, THE CREW'S SIDE — and the crew never sees a customer number.
 *
 * `payout` is what they are actually paid, which is LESS than what they typed.
 * 0174's copy obligation in full: a silent platform deduction on a
 * contractor's invoice is the worst outcome available on this path, so both
 * numbers are said in words every time one of them is shown.
 */
export function crewStateSentence(input: {
  status: AddonStatus;
  /** The crew's own quote, formatted. */
  quote?: string | null;
  /** What they are paid after the crew-side fee, formatted. */
  payout?: string | null;
}): OwnerStateSentence {
  switch (input.status) {
    case "requested":
      return {
        pill: "Needs your price",
        tone: "warn",
        line: "The owner has asked for something beyond the booked job. Name your price or say you'd rather not — the booked job goes ahead either way.",
      };
    case "quoted":
      return {
        pill: "With the owner",
        tone: "teal",
        line:
          input.quote && input.payout
            ? `You quoted ${input.quote}; you'd be paid ${input.payout} after the platform fee. Waiting on the owner — do the booked job as normal until they say yes.`
            : "Waiting on the owner. Do the booked job as normal until they say yes.",
      };
    case "crew_declined":
      return { pill: "You said no", tone: "slate", line: "You're not taking this one on. Nothing changes about the booked job." };
    case "accepted":
      return {
        pill: "Do this too",
        tone: "ok",
        line:
          input.quote && input.payout
            ? `The owner said yes at your ${input.quote}. You'll be paid ${input.payout} for it after the platform fee, on top of the booked job, in the same payout.`
            : "The owner said yes. Do this on the same visit; it's paid with the booked job.",
      };
    case "owner_declined":
      return { pill: "Owner said no", tone: "slate", line: "The owner turned the price down. Don't do the extra; the booked job goes ahead as normal." };
    case "withdrawn":
      return { pill: "Withdrawn", tone: "slate", line: "The owner took the request back before you priced it. Nothing to do." };
    case "crew_left":
      return {
        pill: "Off this job",
        tone: "slate",
        line: "This job is no longer yours, so the extra came off with it. You aren't expected to do it and you aren't paid for it.",
      };
  }
}

/**
 * WHAT THE STANDARD SERVICE ALREADY COVERS — and the honest answer is that we
 * cannot say.
 *
 * Approving a price for work you may already be paying for is not informed
 * consent, so the owner has to be told what the base visit includes. THIS
 * PRODUCT DOES NOT HOLD THAT. `services` carries a name, a pricing model, rate
 * columns, durations, photo minimums and a shot list; there is no scope, no
 * description and no inclusions list anywhere in the schema, and there is no
 * screen that states one.
 *
 * The nearest true thing is the named shot list a crew must photograph
 * (`services.required_photo_slots`, 0146), and it is a list of EVIDENCE, not a
 * list of work — so it is offered as exactly that and never as a scope.
 *
 * Saying "your mow includes trimming" when nothing in the database says so
 * would be the copy-that-lies class at the moment somebody authorises a
 * charge. So this says what is true, and points at the control the screen
 * actually draws — the box, where they can ask the crew.
 */
export type ScopeControl = "box" | "visit" | "none";

export function standardScopeLine(input: {
  serviceName: string;
  /** `services.required_photo_slots`, de-slugged by the caller. May be empty. */
  photographed?: string[] | null;
  /**
   * WHICH CONTROL THE SCREEN CALLING THIS ACTUALLY DRAWS.
   *
   * "Ask your crew in the box below" was printed unconditionally, including
   * over a finished visit and one with no crew, where the box is not rendered
   * at all — this codebase's own copy-that-instructs-a-missing-action class,
   * and on the approvals card there is no box on the page in any state. So the
   * caller says what it draws and this names that, or names nothing.
   */
  control?: ScopeControl;
}): { headline: string; detail: string; photographed: string[] } {
  // "a Lawn mowing & trim" and "a Housekeeping" are what `a ${svc}` produced
  // on the two services this feature was written for. `your` is right for
  // every service name in the table and needs no article agreement.
  const svc = input.serviceName?.trim() || "this service";
  const shots = (input.photographed ?? []).filter((s) => !!s && s.trim().length > 0);
  const control = input.control ?? "none";
  const ask =
    control === "box"
      ? "Ask your crew in the box below and they'll tell you. "
      : control === "visit"
        ? "Open the visit and ask your crew there — they'll tell you. "
        : "";
  return {
    headline: `We don't hold a written list of what your ${svc} covers.`,
    detail:
      `So before you agree a price for an extra, make sure it isn't something the booked ${svc} already includes. ` +
      ask +
      (shots.length > 0
        ? "All we can show you is what they have to photograph on the visit, which is evidence rather than a list of the work:"
        : "We can't even show you what they photograph on this one."),
    photographed: shots,
  };
}
