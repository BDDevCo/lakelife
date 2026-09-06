import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
  parkName: "The Haven", lotNumber: "7", hasSticker: false,
  displayName: "Roy Amberg", since: "2015-04-01",
  textsOn: false, textNumber: null, term: "Month to month", leavingOn: null,
  acceptsOnlineRent: false, hasCard: false, bookingReady: false, cardFeePct: 0,
  today: "2027-01-02",
  bill: null, arrears: [], tenancyEnded: null, deposit: null,
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
};

describe("a payment the bank sent back", () => {
  const returned: PaymentRow = { ...PAID, bankReturnedOn: "2027-02-04T00:00:00Z" };

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
    expect(html).not.toMatch(/line-through/);
  });
});
