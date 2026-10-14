/**
 * "NOBODY HAS STARTED ONBOARDING A PARK YET."
 *
 * That sentence was on the ops console with The Haven loaded — a real park,
 * twenty-one lots, a cutover date in the database. It was reading one fact
 * (no invites and no slips in the last thirty days) and reporting a different
 * one (no park has been set up). Those come apart for a whole year at a time:
 * The Haven's households do not sign until 1 January 2027, so no invite CAN
 * have been sent, and the console called that an empty platform.
 *
 * The same card had a second way of saying it, which claims-data.ts had
 * already written down as a known lie: a FAILED tally read fell back to
 * `empty: true`, so a broken query rendered as the reassuring sentence about
 * nobody having started. A read that did not happen is a third state, not a
 * zero — the convention the SMS and email cards on this console already use.
 *
 * This file holds the part that can be decided without a database, so the
 * sentence can be tested against the shapes that actually occur.
 */

export interface QuietPark {
  name: string;
  /** Households on the roll — who there is to invite at all. */
  occupied: number;
}

export type QuietVerdict =
  /** The tally read did not happen. Never dressed up as a zero. */
  | { kind: "unchecked" }
  /** No park on the platform. The only case the old sentence was true for. */
  | { kind: "no_parks"; said: string }
  /** Parks are set up; nobody in them has been invited yet. */
  | { kind: "nobody_invited"; said: string }
  /** Parks are set up but have nobody on the roll to invite. */
  | { kind: "nobody_to_invite"; said: string };

/**
 * What the quiet state actually found.
 *
 * NAMED AT SMALL N. One park is "The Haven"; four is "4 parks". A count where
 * a name would fit is the console telling him less than it knows, and at this
 * size the name is the useful half — it is the difference between "something
 * is idle" and "The Haven is idle".
 */
export function quietClaimState(opts: {
  checked: boolean;
  parks: readonly QuietPark[];
}): QuietVerdict {
  if (!opts.checked) return { kind: "unchecked" };

  const parks = opts.parks;
  if (parks.length === 0) {
    return {
      kind: "no_parks",
      said:
        "No park is set up on the platform yet. When one is, anyone who gets " +
        "stuck getting into their rent screen shows up here.",
    };
  }

  const withHouseholds = parks.filter((p) => p.occupied > 0);

  if (withHouseholds.length === 0) {
    return {
      kind: "nobody_to_invite",
      said:
        `${subject(parks)} set up, but ${parks.length === 1 ? "it has" : "they have"} ` +
        "nobody on the roll yet — so there is nobody to invite. Load the roll " +
        "first and this card starts watching.",
    };
  }

  const households = withHouseholds.reduce((n, p) => n + p.occupied, 0);
  return {
    kind: "nobody_invited",
    said:
      `${subject(withHouseholds)} set up, with ` +
      `${households} ${households === 1 ? "household" : "households"} on the roll, and ` +
      `${households === 1 ? "they have" : "none of them have"} been invited to ` +
      "their rent screen yet — no slips printed and no invites sent in the " +
      "last 30 days. That is expected before a park's cutover date. Anyone " +
      "who gets stuck once invites go out shows up here.",
  };
}

/** "The Haven is" · "The Haven and Pine Ridge are" · "4 parks are". */
function subject(parks: readonly QuietPark[]): string {
  if (parks.length === 1) return `${parks[0].name} is`;
  if (parks.length <= 3) {
    const names = parks.map((p) => p.name);
    const last = names[names.length - 1];
    return `${names.slice(0, -1).join(", ")} and ${last} are`;
  }
  return `${parks.length} parks are`;
}
