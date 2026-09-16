import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RenterHome as RenterHomeView } from "@/app/parks/my-data";

/**
 * A STICKER THAT IS NOT ON THE PEDESTAL.
 *
 * "Nothing yet. The sticker on your pedestal opens a form — no login, no app."
 *
 * `park_lots.qr_token` is NULL for all 21 lots at The Haven. A token exists
 * only after the office runs `mintStickers` and physically prints and fixes
 * them, and the screen never read the column — it asserted the sticker
 * unconditionally.
 *
 * It is also the ONLY route offered. `fileRequestByToken` is the sole writer
 * of park_requests a resident can reach and it hangs off /fix/<token>; this
 * card carries no report control of its own. So a household with a leaking
 * riser on 2 January was sent outside to scan something that is not there,
 * from a screen that gave her no other button.
 *
 * Every Haven household is in this exact state on 1 January.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));
// The children are client components wrapping server actions. This card's
// words are the subject; theirs are tested where they live.
vi.mock("@/components/PayRentButton", () => ({ PayRentButton: () => <i>pay</i> }));
vi.mock("@/components/IPaidForm", () => ({ IPaidForm: () => <i>ipaid</i> }));
vi.mock("@/components/TextOptIn", () => ({ TextOptIn: () => <i>texts</i> }));
vi.mock("@/components/EnableLotBooking", () => ({ EnableLotBooking: () => <i>booking</i> }));

const { RenterHome } = await import("./RenterHome");

const view = (over: Partial<RenterHomeView> = {}): RenterHomeView => ({
  parkName: "The Haven", parkAddress: "9085 E 500 S, Wolcottville, IN 46795",
  lotNumber: "7", hasSticker: false,
  displayName: "Roy Amberg", since: "2015-04-01",
  textsOn: false, textNumber: null, term: "Month to month", leavingOn: null,
  acceptsOnlineRent: false, hasCard: false, bookingReady: false, cardFeePct: 0,
  today: "2027-01-02",
  bill: null, arrears: [], tenancyEnded: null, finalMonthBilled: false, deposit: null, depositReturned: null,
  payments: [], reported: [], reportedFailed: false,
  ...over,
});

const words = (v: RenterHomeView) =>
  renderToStaticMarkup(<RenterHome view={v} />).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("what you reported — the empty state every household starts in", () => {
  it("does not promise a sticker that has not been fixed to anything", () => {
    expect(words(view({ hasSticker: false })))
      .not.toMatch(/The sticker on your pedestal opens a form/);
  });

  it("gives her a route that actually exists today", () => {
    // Not a control this card does not have — the office, which is who mints
    // the sticker in the first place.
    expect(words(view({ hasSticker: false }))).toMatch(/Tell the office/i);
  });

  it("says the sticker is coming, rather than pretending it was never the plan", () => {
    expect(words(view({ hasSticker: false }))).toMatch(/when they put a sticker on your pedestal/i);
  });

  it("makes the original promise once the sticker is real", () => {
    const w = words(view({ hasSticker: true }));
    expect(w).toMatch(/The sticker on your pedestal opens a form/);
    expect(w).not.toMatch(/Tell the office/i);
  });
});

describe("the three states of that card stay distinct", () => {
  it("a failed read is still not an empty list", () => {
    // "Nothing yet" and "we couldn't look" are different sentences and only
    // one of them is ever a fact — true whatever the sticker is doing.
    for (const hasSticker of [true, false]) {
      const w = words(view({ hasSticker, reportedFailed: true }));
      expect(w, `hasSticker=${hasSticker}`).toMatch(/list we failed to fetch/);
      expect(w).not.toMatch(/Nothing yet/);
    }
  });

  it("an actual report is shown rather than either sentence", () => {
    const w = words(view({
      hasSticker: false,
      reported: [{ note: "Riser is leaking", status: "in_hand", resolutionNote: null, ageDays: 2 }],
    }));
    expect(w).toMatch(/Riser is leaking/);
    expect(w).not.toMatch(/Nothing yet/);
  });
});

/**
 * THE SCREEN THAT WOULD HAVE CONTRADICTED ITSELF.
 *
 * A bank return reopens the bill — `recompute_charge_paid` drops it from
 * paid_total (0155) — so the rent card correctly goes back to OPEN. The
 * payments list below it filtered `reversed_at` alone, so the payment stayed
 * on screen with its receipt number. One screen, two answers, and a resident
 * ringing the office quoting a receipt for money that is not there.
 *
 * Rendered rather than scanned, because the question is what a person SEES and
 * a source scan cannot tell a rendered line from a dead branch.
 */
type PaymentRow = RenterHomeView["payments"][number];

const PAID: PaymentRow = {
  on: "2027-01-03",
  amount: 542.53,
  fee: null,
  method: "ach",
  receiptNo: 104,
  bankReturnedOn: null,
  takenBackOn: null,
  takenBackWhy: null,
  handedBack: 0,
  handedBackOn: null,
};

describe("a payment the bank sent back", () => {
  // The loader writes both: takenBackOn = reversed_at ?? returned_at.
  const returned: PaymentRow = { ...PAID, bankReturnedOn: "2027-02-04T15:00:00Z", takenBackOn: "2027-02-04T15:00:00Z", takenBackWhy: "R01" };

  it("is drawing the real list at all", () => {
    // Otherwise every assertion below is green against a screen with no
    // payments section on it.
    expect(words(view({ payments: [PAID] }))).toMatch(/#104/);
  });

  it("says so, on the row, in words a resident can act on", () => {
    const w = words(view({ payments: [returned] }));
    expect(w, "the resident is not told their payment came back")
      .toMatch(/bank sent this payment back/);
    // The consequence, not just the event — this is the sentence that stops
    // the phone call, because the rent card above now says OPEN.
    expect(w).toMatch(/showing as unpaid again/);
  });

  it("keeps the row rather than hiding it", () => {
    // A REVERSAL is dropped from this list, because it says the payment never
    // happened. A RETURN happened and then came back, and their own bank
    // statement shows both legs — quietly dropping our copy would make us look
    // wrong about their money.
    expect(words(view({ payments: [returned] }))).toMatch(/#104/);
    expect(renderToStaticMarkup(<RenterHome view={view({ payments: [returned] })} />))
      .toMatch(/line-through/);
  });

  it("says nothing of the kind about a payment that stood", () => {
    // The other half of the mutation: a banner that always shows passes the
    // test above and terrifies everybody who paid on time.
    const html = renderToStaticMarkup(<RenterHome view={view({ payments: [PAID] })} />);
    expect(html).not.toMatch(/bank sent this payment back/);
    expect(html).not.toMatch(/taken back/);
    expect(html).not.toMatch(/line-through/);
  });

  it("prints the day in words on the lakes' clock — a timestamp, never 'Invalid Date'", () => {
    // `returned_at` is a timestamptz. The screen's own pretty() splits on "-"
    // and printed "Your bank sent this payment back on Invalid Date".
    const w = words(view({ payments: [returned] }));
    expect(w).not.toMatch(/Invalid Date/);
    expect(w).toMatch(/Your bank sent this payment back on Thursday, February 4, 2027, so this month is showing as unpaid again\./);
  });
});

/**
 * THE CHEQUE THAT BOUNCED. At a park where 17 of 18 pay by cheque, a bounce
 * is a REVERSAL — the database refuses `returned_at` on a cheque (0155) and
 * the office's only door is reversePayment. The list dropped every reversed
 * row, so a household holding receipt #101 read "Nothing recorded yet" under
 * two months that had flipped to unpaid with no sentence why — while her own
 * /paid link said "This payment was taken back on … — the cheque bounced".
 * Two resident surfaces, one truth.
 */
describe("a cheque the office took back", () => {
  const bounced: PaymentRow = { ...PAID, method: "check", receiptNo: 101, amount: 1627.59,
    takenBackOn: "2027-02-10T20:30:00Z", takenBackWhy: "the cheque bounced" };

  it("stays on the list, struck through, with its receipt number", () => {
    const html = renderToStaticMarkup(<RenterHome view={view({ payments: [bounced] })} />);
    expect(html).toMatch(/#101/);
    expect(html).toMatch(/line-through/);
    expect(html).not.toMatch(/Nothing recorded yet/);
  });

  it("says what happened, in the words her /paid link already uses — the day in words, and the office's reason — as the EVENT, never the state of her bills now", () => {
    const w = words(view({ payments: [bounced] }));
    expect(w).toMatch(/This payment was taken back on Wednesday, February 10, 2027 — the cheque bounced\. Anything it had paid was reopened that day\./);
    // Once she has paid January again another way, "is showing as owed
    // again" is false on the same screen that shows it paid.
    expect(w).not.toMatch(/is showing as owed again/);
    // Never "your bank": the ledger cannot tell a bounce from a typo.
    expect(w).not.toMatch(/bank sent this payment back/);
    expect(w).not.toMatch(/Invalid Date/);
  });

  it("a reason the record does not carry is left out, not printed as 'null' or '— .'", () => {
    const w = words(view({ payments: [{ ...bounced, takenBackWhy: null }] }));
    expect(w).toMatch(/This payment was taken back on Wednesday, February 10, 2027\. Anything it had paid was reopened that day\./);
    expect(w).not.toMatch(/null/);
    expect(w).not.toMatch(/— \./);
  });

  it("the strike-through and the sentence both key on takenBackOn — collapse either and the row reads as money", () => {
    const src = readFileSync(fileURLToPath(new URL("./RenterHome.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/textDecoration: p\.takenBackOn \? "line-through"/);
    expect(src).toMatch(/longDay\(p\.takenBackOn\)/);
    expect(src).toMatch(/longDay\(p\.bankReturnedOn\)/);
    expect(src, "the bank-return line is back on pretty(), which prints Invalid Date for a timestamp").not.toMatch(/pretty\(p\.bankReturnedOn\)/);
    expect(src).toMatch(/import \{ longDay \} from "@\/lib\/lake-time"/);
  });
});

/**
 * MONEY ON ACCOUNT AFTER THE LAST BILL. "It comes off your bills, oldest
 * first" is true right up to the final month; once the tenancy has ended AND
 * that month is billed there will never be another bill, and the card
 * promised one to the person the money belongs to. Whether it is owed back
 * to her is the office's to say — the card says only what is true.
 */
describe("the on-account card once the tenancy has ended", () => {
  const gone = (over: Partial<RenterHomeView> = {}) =>
    view({ tenancyEnded: "2027-01-27", onAccount: 57.47, ...over });

  it("with the move-out month billed: nothing more bills — never 'comes off your bills'", () => {
    const w = words(gone({ finalMonthBilled: true }));
    const card = w.slice(w.indexOf("On account"), w.indexOf("Your agreement"));
    expect(card).toMatch(/\$57\.47/);
    expect(card).toMatch(/with the office — nothing more bills for you/);
    expect(card).not.toMatch(/comes off your bills/);
    // Not a product decision the owner has not made.
    expect(w).not.toMatch(/owed back|refund/i);
  });

  it("with the move-out month NOT yet billed: the final part-month is still coming, and the money will come off it", () => {
    const w = words(gone({ finalMonthBilled: false }));
    const card = w.slice(w.indexOf("On account"), w.indexOf("Your agreement"));
    expect(card).toMatch(/comes off your bills, oldest first/);
    expect(card).not.toMatch(/nothing more bills/);
  });

  it("a standing tenancy is unchanged, whatever the flag says", () => {
    const w = words(view({ onAccount: 57.47, tenancyEnded: null, finalMonthBilled: true }));
    const card = w.slice(w.indexOf("On account"), w.indexOf("Your agreement"));
    expect(card).toMatch(/comes off your bills, oldest first/);
  });

  it("the wrap-up lists money on account among what keeps the page open", () => {
    const w = words(gone({ finalMonthBilled: true }));
    expect(w).toMatch(/anything you still owe, any deposit still held, and any money of yours still on account\./);
  });
});

/**
 * THE MONEY SCREENS, IN HER FIRST MONTH AND HER LAST.
 *
 * Three findings from the UX review, all on the same person's screen, all
 * about money:
 *
 *   she could see what she owed with no way to pay it and no sentence saying
 *   how — and 17 of The Haven's 18 households pay cash or a cheque;
 *
 *   the move-out card promised "your receipts stay" over a list of six;
 *
 *   (the third, the portal sending a moved-out resident to /book, is pinned in
 *   the portal's own guard — it is routing, not rendering.)
 */
const owing = (over: Partial<RenterHomeView> = {}) =>
  view({
    acceptsOnlineRent: false,
    bill: {
      id: "c1", monthLabel: "January 2027", dueOn: "2027-01-01",
      amount: 542.53, paidTotal: 0, outstanding: 542.53,
      status: "open", disputed: false, claimedPaidOn: null, lines: [], fromOnAccount: 0,
    },
    ...over,
  });

describe("a household that pays cash", () => {
  it("is told where to take the money", () => {
    // THE WORST GAP ON THIS SCREEN. With no card rail the pay button renders
    // nothing, and the only control left invited her to declare she had
    // ALREADY paid.
    const w = words(owing());
    expect(w, "the screen shows a balance and no way to settle it").toMatch(/pay the office/i);
    expect(w).toContain("9085 E 500 S");
  });

  it("does not pretend the park takes cards", () => {
    // Apostrophes arrive HTML-escaped, so the assertion sits on the half of
    // the sentence that carries the meaning.
    expect(words(owing())).toMatch(/take card payments through LakeLife yet/i);
  });

  it("says nothing of the kind once the park takes cards", () => {
    // The other half: a park WITH a processor must not be told to walk to the
    // office instead of tapping the button it has.
    expect(words(owing({ acceptsOnlineRent: true }))).not.toMatch(/pay the office/i);
  });

  it("stays quiet when she owes nothing", () => {
    const paid = owing({
      bill: { id: "c1", monthLabel: "January 2027", dueOn: "2027-01-01",
        amount: 542.53, paidTotal: 542.53, outstanding: 0,
        status: "paid", disputed: false, claimedPaidOn: null, lines: [], fromOnAccount: 0 },
    });
    expect(words(paid)).not.toMatch(/pay the office/i);
  });

  it("still tells her how when only a BACK month is unpaid", () => {
    // The case a sentence living inside the bill card would have missed: this
    // month settled, December outstanding, so there is no current balance to
    // hang it off — and she is the person most in need of it.
    const backOnly = owing({
      bill: { id: "c2", monthLabel: "January 2027", dueOn: "2027-01-01",
        amount: 542.53, paidTotal: 542.53, outstanding: 0,
        status: "paid", disputed: false, claimedPaidOn: null, lines: [], fromOnAccount: 0 },
      arrears: [{ id: "c1", monthLabel: "December 2026", dueOn: "2026-12-01",
        amount: 542.53, paidTotal: 0, outstanding: 542.53,
        status: "open", disputed: false, claimedPaidOn: null, lines: [], fromOnAccount: 0 }],
    });
    expect(words(backOnly), "a household in arrears is told nothing").toMatch(/pay the office/i);
  });

  it("writes a usable sentence for a park with no address on file", () => {
    // Never "pay the office at undefined".
    const w = words(owing({ parkAddress: null }));
    expect(w).toMatch(/pay the office/i);
    expect(w).not.toMatch(/undefined|null/);
  });
});

describe("the receipts promise", () => {
  it("the copy and the cap agree about how much is shown", () => {
    // THE PAIR THAT MUST MOVE TOGETHER. The card says "the last two years";
    // my-data decides how many rows it hands over. When those two disagree
    // the card is lying, which is exactly how this started — a list of six
    // under a promise of "always".
    const data = readFileSync(
      fileURLToPath(new URL("../app/parks/my-data.ts", import.meta.url)),
      "utf8",
    );
    expect(data, "the payment list is capped below the two years the card promises")
      .toMatch(/\.slice\(0,\s*24\)/);
    // And the read must actually fetch what the slice is allowed to keep —
    // a slice of 24 over a limit of 6 is still a list of six.
    expect(data).toMatch(/\.limit\(24\)/);
  });

  it("no longer claims more than the screen holds", () => {
    const w = words(view({ tenancyEnded: "2027-03-31" }));
    expect(w, "the card promises receipts it does not show")
      .not.toMatch(/always show what you paid/);
    expect(w).toMatch(/last two years are below/);
    // And it says where the rest are, rather than implying they are gone.
    expect(w).toMatch(/by receipt number/);
  });
});

/**
 * THE FOURTH EXIT, ON HER SCREEN. The $57.47 of a $600 cheque handed back
 * across the window after she left (0168): her on-account card had already
 * stopped counting it, so the card simply shrank and the cheque sat on her
 * list unmarked. And a deposit returned read "None held." — true, and
 * silent about the return she was waiting on.
 */
describe("money handed back to her across the window", () => {
  const cheque: PaymentRow = { ...PAID, method: "check", receiptNo: 14, amount: 600, handedBack: 57.47, handedBackOn: "2027-01-28" };

  it("says, under the cheque, how much of it came back and the day — in words", () => {
    const w = words(view({ payments: [cheque] }));
    expect(w).toMatch(/\$600\.00/);
    expect(w).toMatch(/\$57\.47 of this was handed back to you on Thursday, January 28, 2027\./);
    expect(w).not.toMatch(/2027-01-28/);
    // Not taken back, not struck through: the cheque arrived and stands.
    const html = renderToStaticMarkup(<RenterHome view={view({ payments: [cheque] })} />);
    expect(html).not.toMatch(/line-through/);
    expect(w).not.toMatch(/taken back/);
  });

  it("says nothing of the kind about a payment nothing came back from", () => {
    expect(words(view({ payments: [PAID] }))).not.toMatch(/handed back/);
  });

  it("the deposit card names a return instead of 'None held.' alone", () => {
    const w = words(view({ deposit: null, depositReturned: { amount: 500, on: "2027-02-03" } }));
    expect(w).toMatch(/None held\. \$500\.00 was handed back to you on Wednesday, February 3, 2027\./);
    expect(words(view({ deposit: null, depositReturned: null }))).toMatch(/None held\./);
    expect(words(view({ deposit: null, depositReturned: null }))).not.toMatch(/handed back/);
  });

  it("the line keys on handedBack AND handedBackOn — a stamp with no amount, or an amount with no day, prints nothing", () => {
    expect(words(view({ payments: [{ ...cheque, handedBack: 0 }] }))).not.toMatch(/handed back/);
    expect(words(view({ payments: [{ ...cheque, handedBackOn: null }] }))).not.toMatch(/handed back/);
    const src = readFileSync(fileURLToPath(new URL("./RenterHome.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/p\.handedBack > 0 && p\.handedBackOn &&/);
    expect(src).toMatch(/longDay\(p\.handedBackOn\)/);
    expect(src).toMatch(/longDay\(view\.depositReturned\.on\)/);
  });
});
