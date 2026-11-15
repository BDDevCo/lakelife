"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TakePayment } from "@/components/TakePayment";

export type ParkPill = { href: string; label: string };
export type ParkTab = {
  href: string;
  label: string;
  /** The glyph beside the label in the column, and the whole of the label's
      company in the bottom bar on a phone. Decoration: it is `aria-hidden`
      and the word is always there, because an icon row with no words is a
      guessing game on a strip where "Money" and "On site" are different
      answers to the same morning. */
  mark: string;
  /** Every route that lights this tab: the tab's own, plus each pill's, plus
      anything nested under them (`/park/import/[batchId]` lives under
      `/park/import`). A route in NO list lights nothing — that is a defect
      the test catches, not a state the strip should have. */
  matches: string[];
  /** The second row. Absent on a tab that IS one screen. */
  pills?: ParkPill[];
};

/**
 * SIX TABS, NOT THIRTEEN.
 *
 * The strip grew one tab per screen until it was thirteen wide — three rows
 * deep on a phone, with "Rent", "Costs" and "Statements" sitting apart from
 * each other and "Load the roll" beside "Who's on site". His own blueprint
 * drew six (docs/park-experience-blueprint.md, "Navigation"), and this is
 * that drawing. Every screen keeps its file, its URL and its title: a tab
 * that groups screens shows them as a pill row underneath, the prototype's
 * one second-level device (lakelife.html `.vt`). Nothing was removed, and
 * every door is at most one more tap away than it was.
 *
 * A pill's label is the screen's own h1, so the word he taps is the word he
 * lands on — "Costs & fees", not "Costs". The tab label "Park setup" is kept
 * on purpose: six sentences on other screens send him to it by that name,
 * and its first pill carries the same word because that is the screen's h1
 * (the way "Lots & rates" is both the tab and its first pill).
 */
export const TABS: ParkTab[] = [
  // Today comes first — it is the one he opens with coffee. /park stays the
  // default landing route until he has used both with real rows.
  { href: "/park/today", label: "Today", mark: "\u25F7", matches: ["/park/today"] },
  {
    href: "/park", label: "Renters", mark: "\u2302",
    // The Renters list is EXACT — `/park` is a prefix of every park route,
    // so it may not claim anything it does not name. Saying so here is not
    // enough: matchLength below treats the bare "/park" entry as an exact
    // match in code, or every unlisted park route would light Rent roll.
    matches: ["/park", "/park/onboard", "/park/documents"],
    pills: [
      { href: "/park", label: "Rent roll" },
      { href: "/park/onboard", label: "Who lives here" },
      { href: "/park/documents", label: "Documents" },
    ],
  },
  {
    href: "/park/rent", label: "Money", mark: "$",
    matches: ["/park/rent", "/park/costs", "/park/statements"],
    pills: [
      { href: "/park/rent", label: "Rent" },
      { href: "/park/costs", label: "Costs & fees" },
      { href: "/park/statements", label: "Statements" },
    ],
  },
  {
    href: "/park/visits", label: "On site", mark: "\u2691",
    // Crew validation (is that truck meant to be here?) and the work the
    // park buys for its own ground, which is where those visits come from.
    matches: ["/park/visits", "/park/services"],
    pills: [
      { href: "/park/visits", label: "Who's on site" },
      { href: "/park/services", label: "Park services" },
    ],
  },
  {
    href: "/park/lots", label: "Lots & rates", mark: "\u25A6",
    matches: ["/park/lots", "/park/amenities"],
    pills: [
      { href: "/park/lots", label: "Lots & rates" },
      { href: "/park/amenities", label: "Things you rent out" },
    ],
  },
  {
    href: "/park/setup", label: "Park setup", mark: "\u2699",
    // THE IMPORTER USED TO BE A ONE-WAY DOOR. Its only link lived inside the
    // rent roll's zero-lots empty state, so the moment a single lot existed
    // the file box became unreachable, and the fallback was the three hours
    // of manual typing it exists to prevent. It is not a first-run wizard; it
    // is a tool, and it lives with the rest of the park's setup.
    matches: ["/park/setup", "/park/import", "/park/people"],
    pills: [
      { href: "/park/setup", label: "Park setup" },
      { href: "/park/import", label: "Load the roll" },
      // WHO CAN OPEN THIS PARK. Under setup rather than on its own tab: six
      // tabs stay six, and who may administer a park is a setup decision, not
      // something he does on a morning. Before this screen existed there was
      // no door anywhere that could put a second person on a park.
      { href: "/park/people", label: "Who can open this park" },
    ],
  },
];

/**
 * HOW LONG A ROUTE MATCHES A PREFIX, OR -1.
 *
 * "Starts with" is by SEGMENT: `/park/rent` is under `/park/rent` and under
 * nothing that merely shares its letters (`/park/re`). Returning the LENGTH
 * lets the caller take the most specific match, so `/park/statements/export`
 * lights Statements and `/park/import/[batchId]` lights Load the roll.
 *
 * THE BARE "/park" IS EXACT. It is the Rent roll's own route and a prefix of
 * every other park route, so as a prefix it would claim all of them: a new
 * page.tsx under /park that nobody added to a list would light Renters ›
 * Rent roll, and the per-route test — one tab, one pill — would pass it.
 * The committed strip kept "/park" exact (`t.href !== "/park" && startsWith`)
 * so that a route in no list lit nothing, which is the promise at the top of
 * this file; the first cut of the length-based match dropped that and the
 * catch-all came back. Exactness lives HERE, in the one doorway both the
 * tab and the pill pass through, not as a flag on the entry.
 */
export function matchLength(pathname: string, prefix: string): number {
  if (prefix === "/park") return pathname === "/park" ? prefix.length : -1;
  return pathname === prefix || pathname.startsWith(prefix + "/") ? prefix.length : -1;
}

/** The index of the entry whose prefix list matches the route most
    specifically, or -1 when none does. */
export function activeIndex(pathname: string, lists: string[][]): number {
  let best = -1;
  let bestLen = -1;
  lists.forEach((list, i) => {
    for (const m of list) {
      const n = matchLength(pathname, m);
      if (n > bestLen) { bestLen = n; best = i; }
    }
  });
  return best;
}

/**
 * TAKES THE PARK, NOT ITS FIELDS.
 *
 * This used to take `parkName` and `live` — two props, spelled out at fourteen
 * call sites. Adding a fifteenth field would have meant editing all fourteen
 * and trusting the next screen to remember, which is the shape of guard this
 * codebase keeps having to repair. Passing the park means a new field is
 * available on every park screen the moment `getMyPark` returns it.
 */
export function ParkNav({ park }: {
  park: {
    id: string;
    name: string;
    active: boolean;
    noticesHeldAt?: string | null;
    noticesHeldReason?: string | null;
  };
}) {
  const pathname = usePathname();
  const parkName = park.name;
  const live = park.active;
  const tabAt = activeIndex(pathname, TABS.map((t) => t.matches));
  const tab = tabAt >= 0 ? TABS[tabAt] : null;
  const pills = tab?.pills ?? null;
  const pillAt = pills ? activeIndex(pathname, pills.map((p) => [p.href])) : -1;
  return (
    <>
      {/* THE CONTEXT BAR — full width, above both the column and the page.
          THREE THINGS THAT MUST NOT GO TO THE BOTTOM OF A PHONE. The hold
          banner is the loudest thing this product can say; which park he is
          in answers "am I in the right place"; and Take a payment is the one
          control with somebody standing in front of him. The column is a bar
          along the bottom at 900px and below, so none of these could live in
          it. */}
      <div className="ll-ws-ctx">
        {/* A HOLD NOBODY CAN SEE IS A PRODUCT THAT LOOKS BROKEN.
            Every send to a household is refused while this is up, including
            the ones he taps himself — so it says so on every park screen, and
            says where to lift it. Silence he did not ask for is
            indistinguishable from silence that is failing. */}
        {park.noticesHeldAt && (
          <div className="ll-notice" role="status" style={{ width: "100%", marginBottom: 4 }}>
            <strong style={{ fontSize: 14 }}>
              Notices are on hold — nothing is reaching your households.
            </strong>
            <p style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.5 }}>
              {park.noticesHeldReason
                ? `${park.noticesHeldReason} `
                : "No email or text will go out to anyone on your roll — including anything you send by hand. "}
              Lift it in <Link href="/park/setup">Park setup</Link> when everyone is ready.
            </p>
          </div>
        )}
        <span className="ll-ws-ctx-name">{parkName}</span>
        {/* A dark park is the normal state during setup, so this reads as a
            status, not an error. */}
        <span className={`ll-pill ${live ? "" : "slate"}`}>{live ? "Live" : "Not published"}</span>
        {/* A BUTTON, NOT A TAB. Somebody is standing in front of him with a
            money order; it has to work in three taps from whichever screen he
            is on, so it sits in this bar on every one of them. It replaced
            the "Book services for the park" ghost link — that door is now the
            Park services pill under On site, one tap away. */}
        <div className="ll-ws-ctx-act">
          <TakePayment parkId={park.id} />
        </div>
      </div>

      {/* THE COLUMN. The same six groups, in the same order, pointing at the
          same URLs — this is where they are drawn, not what they are. */}
      <aside className="ll-sidebar">
        <div className="ll-ws-id">
          <small>My park</small>
          <b>{parkName}</b>
          <span>{live ? "Published" : "Not published yet"}</span>
        </div>
        <nav className="ll-sidenav" aria-label="Park office">
          {TABS.map((t, i) => {
            const active = i === tabAt;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={active ? "on" : undefined}
                aria-current={active ? "page" : undefined}
              >
                <span className="ll-sidenav-mark" aria-hidden="true">{t.mark}</span>
                {t.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* THE SECOND LEVEL. Only a grouped tab has one; a tab that is one
          screen draws nothing. Links and nothing else — no menu, no accordion
          — so every screen is still a URL he can bookmark. It sits above the
          page rather than inside the column because the column is a bottom
          bar on a phone, and a second fixed row there is a tenth of the
          screen gone before anything is read. */}
      {pills && (
        <div className="ll-subrow">
          {pills.map((p, i) => {
            const on = i === pillAt;
            return (
              <Link
                key={p.href}
                href={p.href}
                className={`ll-subtab${on ? " on" : ""}`}
                aria-current={on ? "page" : undefined}
              >
                {p.label}
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
