/**
 * FOUR SAVE BUTTONS, AND THE WRONG ONE SAYS "SAVED."
 *
 * /park/setup stacks four independent cards, each with its own Save and its
 * own server action: what the park earns from, how it runs, how rent comes in,
 * and the park profile. Two of the four tracked whether they had anything to
 * save; two did not. So the failure was: type into the profile at the bottom,
 * scroll up, press the Save you can see — "Save how this park runs" — and get
 * a toast reading "Saved." The dials genuinely did save. The profile edit sat
 * there unsaved, and left the moment he tapped Today in the nav.
 *
 * That is [[copy-that-lies]] with a data-loss consequence rather than a
 * confusing sentence: the word was true about the card it came from and false
 * about the work he had just done, and nothing anywhere said so.
 *
 * This module holds the part that can be decided without a browser, so it can
 * be tested: WHICH cards are unsaved, how that reads as a sentence, and
 * whether a given click is about to lose work. The React glue in
 * UnsavedGuard.tsx is deliberately thin.
 */

export interface UnsavedCard {
  /** Stable per card, so a re-render does not register it twice. */
  key: string;
  /** The card's own heading, in its own words — never "section 2". */
  label: string;
}

/**
 * The sentence the bar shows.
 *
 * NAMED, NEVER COUNTED. "2 unsaved changes" is a number he cannot act on; it
 * does not say which two, and on a page of four cards that is the whole
 * question. Small-N naming, the same rule as the roll: at four cards you say
 * the four words.
 */
export function unsavedSentence(labels: readonly string[]): string | null {
  const named = labels.filter((l) => l.trim().length > 0);
  if (named.length === 0) return null;
  if (named.length === 1) return `You've changed “${named[0]}” and haven't saved it yet.`;
  const last = named[named.length - 1];
  const rest = named.slice(0, -1).map((l) => `“${l}”`).join(", ");
  return `You've changed ${rest} and “${last}” and haven't saved them yet.`;
}

/** What the button on the bar says. One card or four, it is one tap. */
export function unsavedButtonLabel(count: number): string {
  return count <= 1 ? "Save it" : "Save all of it";
}

/**
 * Whether this click is about to lose work.
 *
 * Only in-app navigation is decided here. A full page load — closing the tab,
 * reloading, typing a new address, following a link off the site — is the
 * browser's own `beforeunload`, which it already handles and which this file
 * must not try to second-guess. The one the browser does NOT catch is the
 * client-side route change, which is every tab in ParkNav and the link to the
 * agreements page at the bottom of this very screen. That is the one that
 * silently dropped his edit, so that is the one blocked here.
 *
 * A click that keeps this page alive is never blocked: cmd/ctrl/shift-click
 * and middle-click open a new tab, `target="_blank"` opens a new tab, a
 * download does not navigate at all, and a link to the page he is already on
 * (including a bare `#anchor`) goes nowhere.
 */
export function leavingLosesWork(opts: {
  dirty: boolean;
  /** The anchor's href attribute as authored, or null if it has none. */
  href: string | null;
  currentPath: string;
  target?: string | null;
  /** cmd / ctrl / shift / alt held, or a middle click — this page survives. */
  modified?: boolean;
  download?: boolean;
}): boolean {
  if (!opts.dirty) return false;
  if (opts.modified) return false;
  if (opts.download) return false;
  if (opts.target && opts.target !== "_self") return false;

  const href = opts.href?.trim();
  if (!href) return false;
  // An in-page anchor and a bare query change stay on the screen.
  if (href.startsWith("#")) return false;
  // Not a navigation at all.
  if (/^(mailto:|tel:|sms:|javascript:)/i.test(href)) return false;
  // Off-site, or protocol-relative: a full load, so beforeunload has it.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) return false;
  if (href.startsWith("//")) return false;
  // Only app routes are client-side navigations.
  if (!href.startsWith("/")) return false;

  // Going nowhere: the same path, with or without a hash or query on it.
  const path = href.split(/[?#]/)[0];
  const here = opts.currentPath.split(/[?#]/)[0];
  if (strip(path) === strip(here)) return false;

  return true;
}

/** Trailing slashes are the same route to the router; treat them as one. */
const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * Whether a form still matches what it was loaded with.
 *
 * Shared because every card on this screen is the same shape — a flat object
 * of strings, flags and one list of chips — and four hand-written comparisons
 * would be four chances to get one wrong in the direction that matters (a card
 * reading clean while it holds an edit).
 *
 * A LIST OF CHIPS IS A SET, NOT A SEQUENCE. The utilities a park includes are
 * toggled on and off, so turning Water off and back on leaves the same facts
 * in a different order. Comparing those as sequences would leave the card
 * stuck dirty forever with nothing on screen to explain it, and the bar would
 * then nag about work he had already saved — which is how a warning becomes
 * noise and stops being read.
 */
export function sameForm<T extends object>(a: T, b: T): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    const x = ra[k];
    const y = rb[k];
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y)) return false;
      if (x.length !== y.length) return false;
      const sx = [...x].map(String).sort();
      const sy = [...y].map(String).sort();
      if (sx.some((v, i) => v !== sy[i])) return false;
      continue;
    }
    if (x !== y) return false;
  }
  return true;
}

/**
 * The warning itself. Phrased as the loss, not as the mechanism — "you have
 * unsaved changes" describes the software's state, and what he needs to know
 * is which of his own work is about to go.
 */
export function leaveWarning(labels: readonly string[]): string {
  const s = unsavedSentence(labels);
  return s
    ? `${s} Leave this screen and that change is lost.`
    : "Leave this screen and your change is lost.";
}
