import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AmenityRow } from "@/app/park/amenity-actions";

/**
 * THE LINK THE OFFICE COULD NEVER HAND OUT.
 *
 * 0120 mints `use_token` on every live stay and /use/[token] consumes it, and
 * between those two nothing in src ever showed the URL to a person. The
 * migration says "so the office can text the link the day it books a guest
 * in" — and the office had no way to see it. These pin that the booking row
 * now carries the full URL with a Copy link button, that a missing link is a
 * sentence and never an empty cell, and that the sentence is honest to what
 * the route does with a stay that is no longer live.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }) }));
vi.mock("@/app/park/amenity-actions", () => ({
  saveAmenity: async () => ({ ok: true }),
  setAmenityActive: async () => ({ ok: true }),
  addAmenityUnit: async () => ({ ok: true }),
  blackoutDays: async () => ({ ok: true }),
  bookAmenityForStay: async () => ({ ok: true }),
  cancelAmenityBooking: async () => ({ ok: true }),
  collectAmenityMoney: async () => ({ ok: true }),
  staysOverlapping: async () => [],
}));
vi.mock("@/app/park/ledger-actions", () => ({ reversePayment: async () => ({ ok: true }) }));

const { ParkAmenities } = await import("./ParkAmenities");

const TODAY = "2027-06-10";
const TOKEN = "3f9a1c4e7b2d6a8f0c1e5b9d3a7f2c4e6b8d0a1f3c5e7b9d";
const URL = `https://lakelife.ai/use/${TOKEN}`;

type Held = AmenityRow["held"][number];

const held = (over: Partial<Held> = {}): Held => ({
  id: "bk-1", unitId: "unit-1", unitLabel: "The pontoon",
  from: "2027-06-12", to: "2027-06-13", status: "booked",
  who: "Dana Guest", lotNumber: "14", quotedAmount: 150, collected: 0, payments: [],
  guestLink: URL, stayLive: true,
  ...over,
});

const row = (heldRows: Held[]): AmenityRow => ({
  id: "am-1", name: "The pontoon", kind: "boat", chargeModel: "per_day", dayRate: 150,
  whoMayBook: "guests", maxDays: 2,
  season: { openMonth: null, openDay: null, closeMonth: null, closeDay: null },
  rules: null, active: true,
  units: [{ id: "unit-1", amenityId: "am-1", label: "The pontoon", active: true }],
  held: heldRows,
});

const render = (rows: AmenityRow[]) =>
  renderToStaticMarkup(<ParkAmenities parkId="park-1" rows={rows} today={TODAY} />);
/** As a person reads it: tags gone, React's escaped apostrophe decoded. */
const words = (rows: AmenityRow[]) =>
  render(rows).replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("a booking row carries the guest's link", () => {
  it("prints the FULL url as text, so it can be read out as well as copied", () => {
    const html = render([row([held()])]);
    expect(html).toContain(`<code`);
    expect(html).toContain(URL);
    // Wrapped, never elided: a link with its middle missing cannot be read out.
    expect(html).toMatch(/word-break:break-all/);
    expect(html).not.toMatch(/text-overflow:ellipsis/);
  });

  it("has a button that says exactly 'Copy link'", () => {
    const html = render([row([held()])]);
    expect(html).toMatch(/<button[^>]*>Copy link<\/button>/);
  });

  it("says in one place what the link does, honest to the route", () => {
    const w = words([row([held()])]);
    expect(w).toMatch(/their own page for this stay, no sign-in needed/);
    expect(w).toMatch(/take or give back days/);
    expect(w).toMatch(/see what they owe/);
    // Not one-use, and dead once the stay is not approved/active.
    expect(w).toMatch(/keeps working until their stay ends/);
    expect(w).toMatch(/anyone holding it can book against their stay/);
  });

  it("the explanation is absent when no row on the card has a link", () => {
    const w = words([row([held({ guestLink: null, stayLive: false })])]);
    expect(w).not.toMatch(/their own page for this stay/);
    expect(w).not.toMatch(/Copy link/);
  });
});

describe("a missing link is a sentence, never an empty cell", () => {
  it("a live stay with no token says so", () => {
    const w = words([row([held({ guestLink: null, stayLive: true })])]);
    expect(w).toMatch(/No booking link on this stay yet\./);
    expect(w).not.toContain(URL);
    expect(w).not.toMatch(/Copy link/);
  });

  it("a stay that is over says the link no longer opens — the route answers 'that link isn't right' to it", () => {
    const w = words([row([held({ guestLink: null, stayLive: false })])]);
    expect(w).toMatch(/Their stay is over or was cancelled, so their booking link no longer opens\./);
    expect(w).not.toMatch(/No booking link on this stay yet/);
  });

  it("the two sentences are pinned both ways — the branch reads stayLive", () => {
    const live = words([row([held({ guestLink: null, stayLive: true })])]);
    const over = words([row([held({ guestLink: null, stayLive: false })])]);
    expect(live).not.toBe(over);
    expect(live).toMatch(/No booking link/);
    expect(over).toMatch(/no longer opens/);
  });

  it("a held-back day is the park's own hold — no link, no sentence about a guest", () => {
    const w = words([row([held({
      status: "blackout", who: null, lotNumber: null, quotedAmount: null,
      guestLink: null, stayLive: false,
    })])]);
    expect(w).toMatch(/Held back — nobody can book it/);
    expect(w).not.toMatch(/booking link/);
    expect(w).not.toMatch(/Copy link/);
  });

  it("a past day still owed keeps its row AND its link — money outlives the date, so does the way to settle it", () => {
    const w = words([row([held({ from: "2027-06-01", to: "2027-06-02", collected: 0 })])]);
    expect(w).toMatch(/been and gone with money still owed/);
    expect(w).toContain(URL);
  });
});

describe("the figure on the row comes from the one money() helper", () => {
  it("$1,500.00 to collect prints with the thousands comma only money() adds", () => {
    const w = words([row([held({ quotedAmount: 1500 })])]);
    expect(w).toMatch(/\$1,500\.00 to collect/);
  });
});
