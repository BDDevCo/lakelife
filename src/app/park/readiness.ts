/**
 * IS THIS PARK SET UP — one derived model, read by two screens.
 *
 * Three partial answers used to exist and shared no source: the revenue
 * streams' per-stream "what's missing" lines, the pre-cutover checklist on
 * Today (five rows, no links, shown only when a takeover day was set AND in
 * the future — while the takeover day itself was on the last tab), and the
 * publish button's refusals (a lake and a map pin the owner has no way to
 * set). An owner could tick everything Today asked for and still be refused
 * at publish, by a sentence telling him to do something no screen offered.
 *
 * THE RULES OF A ROW:
 *   EARNED. `done` comes from the column it names, never from an assumption.
 *   The terms row reads the acceptance ledger even though the /park layout
 *   guarantees it is true on screen.
 *   A FACT IN WORDS. The label states what is, in words a person would say:
 *   "21 lots on file", "Rent is due on the 1st". Never "Lots: 21".
 *   THE CONTROL'S OWN WORDS. `next` names the button that writes the column,
 *   quoted as it reads on that screen, and `href` is the route where that
 *   button lives. `href` is null ONLY when no owner-side writer exists — the
 *   lake and the pin are written by ops (NewPark) — and then the label says
 *   who sets it rather than instructing an action the screen lacks.
 *   OPTIONAL WHEN THE FORM SAYS SO. A dial whose own form says blank is a
 *   valid state ("Leave blank for no limit") never gates the list and shows
 *   "–" rather than "☐". Its `done` is still earned by the column.
 *
 * Plain module: no supabase, no env. The loaders (today-actions, and
 * readiness-data for the setup page) hand `readinessFactsFrom` their raw rows.
 */

import { money } from "./ledger-helpers";
import { dayInWords } from "./park-helpers";
import { ordinal, preCutover, lotOccupancy } from "./today-helpers";
import { lakeDateOf } from "@/lib/booking";

export type ReadinessKey =
  | "lots" | "rates" | "households" | "cutover" | "rent_due" | "cap"
  | "fees" | "map" | "terms" | "published" | "notices" | "online";

/** The facts the rows are derived from, each named for the column it comes off. */
export interface ReadinessFacts {
  parkName: string;
  today: string;
  /** park_lots rows for the park, any lifecycle. */
  lots: number;
  /** park_lots where lifecycle = 'live'. */
  liveLots: number;
  /**
   * park_lots where active = true — the owner's "In service" switch, and the
   * column the publish gate (setParkLive) actually counts. A park whose lots
   * are all switched off reads "21 lots on file" and is refused at publish.
   */
  activeLots: number;
  /** Distinct lot_rates.park_lot_id over the live lots. */
  liveLotsWithRate: number;
  /** Σ lot_rates.amount where term = 'monthly', over the live lots. */
  monthlyRoll: number;
  /** Live lots with a household on them today, lapsed included (lotOccupancy). */
  occupiedLiveLots: number;
  /**
   * Live lots with a household FILED whose tenancy starts after today
   * (lotOccupancy's reserved set). Both writers date a pre-go-live row from
   * the takeover day — the roll importer and Who lives here — so between the
   * roll landing in December and go-live on 1 January every filed household
   * is here and none is in occupiedLiveLots. A row that read only the
   * occupied set said "Nobody filed" over eighteen filed households and sent
   * him to a screen that answered "Nothing left to file."
   */
  reservedLiveLots: number;
  /**
   * Households on an approved/active row whose file lacks an email OR a
   * phone_on_file_with_park — the new lease's condition (sign-helpers), and
   * the office column deliberately: a verified mobile with no office number
   * typed still counts, because the office cannot ring what it was not given.
   */
  householdsMissingContact: number;
  /** parks.cutover_date. */
  cutoverOn: string | null;
  /** parks.rent_due_day — NOT NULL, default 1, so this row is always done. */
  rentDueDay: number;
  /** parks.max_agreement_months — nullable; the dial says "Leave blank for no limit". */
  maxAgreementMonths: number | null;
  /** park_fees where active. */
  activeFees: number;
  /** lakes.name via parks.lake_id. */
  lakeName: string | null;
  /** parks.lat and parks.lng both set. */
  hasMapPin: boolean;
  /** hasAccepted(tos, TOS_VERSION) for the viewer. */
  termsAccepted: boolean;
  /** parks.active. */
  published: boolean;
  /** park_members.role = 'owner' for the viewer — only the owner can publish. */
  viewerIsOwner: boolean;
  /**
   * parks.notices_held_at as a LAKE date, or null when lifted. Converted by
   * lakeDateOf in the builder, never sliced: a hold set at 9pm in Indiana is
   * already tomorrow in UTC.
   */
  noticesHeldOn: string | null;
  /** parks.accepts_online_rent. */
  onlineRentOn: boolean;
  /** paymentsAreLive() — the deployment, not the park. */
  processorLive: boolean;
}

/**
 * Whether anyone has been written to, and whether the park is operating —
 * the facts behind the first-run card's most important sentence. Each is an
 * earned witness: a column something actually writes when a send happens.
 * sendEmail/sendSms keep no log, so nothing that bypasses these four witnesses
 * can be counted — which is why the card is also gated on `chargesRaised` and
 * `paymentsRecorded`: a park that has raised a bill, or taken money, is
 * running, whatever it has or hasn't sent.
 */
export interface ContactFacts {
  /** park_renters.invite_sent_at set — a portal invite email actually went. */
  invitesSent: number;
  /** park_document_deliveries rows — one per send, by email, hand or post. */
  documentsDelivered: number;
  /** park_reminders to a resident with outcome sent or printed — the overdue chase. */
  remindersSent: number;
  /**
   * park_renters.claim_code_issued_at set — a claim slip was printed for
   * them (issue_park_claim_code, 0129). Paper is contact by the card's own
   * rule: the reminders witness already counts `printed`. And it is the one
   * contact door the hold leaves open — the slip consults no hold, while
   * every email is refused. The stamp is the MINT, not the handover: nobody
   * records that the slip changed hands, so the sentence says "printed",
   * never "given". It is a was-ever stamp on the file — 0134's trigger clears
   * invite_sent_at on release or rename but never this column — so a renamed
   * file's previous household still counts; changing that is a DB decision.
   */
  slipsIssued: number;
  /** park_charges rows — any bill ever raised. */
  chargesRaised: number;
  /**
   * park_payments rows by park_id, UNFILTERED — reversed and returned rows
   * included, because a bounced cheque still proves a receipt may have gone
   * out. An on-account payment (recordOnAccount) needs no bill and emails a
   * receipt that leaves no row of its own, so the card cannot be gated on
   * the first bill alone.
   */
  paymentsRecorded: number;
}

export interface ReadinessRow {
  key: ReadinessKey;
  done: boolean;
  /** A dial the form itself says may be blank. Never gates the list, never shows ☐. */
  optional: boolean;
  /** A fact in words. */
  label: string;
  /** What to do, in the words of the control that does it. */
  next: string | null;
  /** The route where that control lives; null ONLY when no owner-side writer exists. */
  href: string | null;
}

/**
 * The lake and the pin are written by ops when the park is created (NewPark),
 * and the publish gate refuses without them. ONE sentence for the gate and the
 * row, because the old refusal — "Set the park's lake first" — instructed an
 * action no owner screen offers.
 */
export const NO_LAKE_LINE = "The park's lake isn't set — that's ours to fix; get in touch.";
export const NO_PIN_LINE = "The park's map location isn't set — that's ours to fix; get in touch.";
export const NO_LAKE_OR_PIN_LINE = "The park's lake and map location aren't set — that's ours to fix; get in touch.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function readinessFor(f: ReadinessFacts): ReadinessRow[] {
  const rows: ReadinessRow[] = [];

  // 1. Lots — park_lots. Writers: at zero lots the Lots & rates screen opens
  //    on BOTH forms — "Add your lots" with 'Add these lots', and "New lot"
  //    with 'Save lot' — so those are the buttons quoted; 'Add a lot' and
  //    'Add a row of lots' are hidden in exactly that state. And Load the roll.
  {
    const switchedOff = f.lots - f.activeLots;
    rows.push(f.lots > 0
      ? {
          key: "lots", done: true, optional: false,
          label: `${plural(f.lots, "lot", "lots")} on file`
            + (f.liveLots < f.lots ? ` — ${f.liveLots} live` : "")
            + (switchedOff > 0 ? ` — ${switchedOff} switched off` : ""),
          next: null, href: "/park/lots",
        }
      : {
          key: "lots", done: false, optional: false,
          label: "No lots yet",
          next: "Add your lots — 'Add these lots' numbers a whole row, or 'Save lot' adds one — under Lots & rates",
          href: "/park/lots",
        });
  }

  // 2. Rates — lot_rates.park_lot_id over the live lots. Writer: 'Rates' on
  //    a lot card, then 'Save rates'; or the bulk button, which reads "Set
  //    rates on all N lots" where N is EVERY lot on file (ParkLots counts
  //    lots.length, any lifecycle — so f.lots, never f.liveLots) and is not
  //    drawn at all for a one-lot park.
  if (f.liveLots === 0) {
    rows.push({ key: "rates", done: false, optional: false, label: "No live lots to price yet", next: null, href: "/park/lots" });
  } else if (f.liveLotsWithRate === f.liveLots) {
    rows.push({
      key: "rates", done: true, optional: false,
      label: `Every live lot has a rent — ${f.liveLots} of ${f.liveLots}`
        + (f.monthlyRoll > 0 ? `, ${money(f.monthlyRoll)} a month` : ""),
      next: null, href: "/park/lots",
    });
  } else {
    rows.push({
      key: "rates", done: false, optional: false,
      label: `${f.liveLotsWithRate} of ${f.liveLots} live lots have a rent`,
      next: f.lots > 1
        ? `'Rates' on a lot, then 'Save rates' — or 'Set rates on all ${f.lots} lots'`
        : "'Rates' on the lot, then 'Save rates'",
      href: "/park/lots",
    });
  }

  // 3. Households — lot_reservations on live lots (lotOccupancy), FILED not
  //    started: the reserved set counts too, or the December roll reads as
  //    nobody. The contact count is off park_renters.email /
  //    phone_on_file_with_park. OPTIONAL ONCE PUBLISHED: before publishing,
  //    an empty roll is unfinished setup; after, an empty lot is a vacancy,
  //    which the occupancy line already names — not a chore the list keeps
  //    him on for ever. With NO live lot the Who lives here door answers
  //    "there's nobody to put on one", so the row has no next and points at
  //    the lots screen the way the rates row does.
  {
    const filed = f.occupiedLiveLots + f.reservedLiveLots;
    const m = f.householdsMissingContact;
    const contactTail = m > 0 ? ` — ${m} still ${m === 1 ? "lacks" : "lack"} an email or a number the office can ring` : "";
    const contactNext = m > 0 ? "Add their email and phone from their row on the rent roll" : null;
    if (f.liveLots === 0) {
      rows.push({
        key: "households", done: false, optional: f.published,
        label: f.lots === 0
          ? "No lots yet to put anyone on"
          : `Nobody filed yet — none of your ${plural(f.lots, "lot", "lots")} is live`,
        next: null,
        href: "/park/lots",
      });
    } else if (filed === 0) {
      rows.push({
        key: "households", done: false, optional: f.published,
        label: `Nobody filed on your ${plural(f.liveLots, "live lot", "live lots")} yet`,
        next: "File who lives on each lot — Who lives here",
        href: "/park/onboard",
      });
    } else if (f.occupiedLiveLots === 0) {
      // The occupancy line's own words for the same state (today-helpers
      // occupancyLine): "spoken for … their tenancies start later".
      rows.push({
        key: "households", done: true, optional: f.published,
        label: `${f.reservedLiveLots} of ${f.liveLots} live lots spoken for — their tenancies start later${contactTail}`,
        next: contactNext,
        href: "/park",
      });
    } else {
      rows.push({
        key: "households", done: true, optional: f.published,
        label: `${filed} of ${f.liveLots} live lots have a household on them`
          + (f.reservedLiveLots > 0 ? ` — ${f.reservedLiveLots} of those ${f.reservedLiveLots === 1 ? "starts" : "start"} later` : "")
          + contactTail,
        next: contactNext,
        href: "/park",
      });
    }
  }

  // 4. Cutover — parks.cutover_date. Optional: the dial says leave it blank
  //    and bills can be raised for any month.
  rows.push(f.cutoverOn
    ? {
        key: "cutover", done: true, optional: true,
        label: f.cutoverOn > f.today
          ? `You take over on ${dayInWords(f.cutoverOn)}`
          : `You took over on ${dayInWords(f.cutoverOn)}`,
        next: null, href: "/park/setup",
      }
    : {
        key: "cutover", done: false, optional: true,
        label: "No takeover day set — bills can be raised for any month; fine if the park has always been yours",
        next: "Set 'The day you take over' under 'How this park runs' if the park changed hands",
        href: "/park/setup",
      });

  // 5. Rent due day — parks.rent_due_day, NOT NULL default 1: cannot be unset.
  rows.push({
    key: "rent_due", done: true, optional: false,
    label: `Rent is due on the ${ordinal(f.rentDueDay)}`,
    next: null, href: "/park/setup",
  });

  // 6. Cap — parks.max_agreement_months. Optional: "Leave blank for no limit".
  rows.push(f.maxAgreementMonths != null
    ? {
        key: "cap", done: true, optional: true,
        label: `Agreements run up to ${plural(f.maxAgreementMonths, "month", "months")}`,
        next: null, href: "/park/setup",
      }
    : {
        key: "cap", done: false, optional: true,
        label: "No cap on how long an agreement can run",
        next: "Set 'Longest one agreement can run' under 'How this park runs' if you want one",
        href: "/park/setup",
      });

  // 7. Fees — park_fees where active. Optional: a park with no fee is not nagged.
  rows.push(f.activeFees > 0
    ? {
        key: "fees", done: true, optional: true,
        label: `${plural(f.activeFees, "fee", "fees")} set up`,
        next: null, href: "/park/costs",
      }
    : {
        key: "fees", done: false, optional: true,
        label: "No fees — fine if you don't charge any",
        next: "'Add a fee' under Costs & fees if you do",
        href: "/park/costs",
      });

  // 8. Lake and pin — parks.lake_id, parks.lat, parks.lng. No owner-side
  //    writer: href null, and the label says who sets it.
  {
    const lakeOk = f.lakeName != null;
    const done = lakeOk && f.hasMapPin;
    rows.push({
      key: "map", done, optional: false,
      label: done
        ? `On ${f.lakeName}, map pin set — both set by LakeLife; ask us if either is wrong`
        : !lakeOk && !f.hasMapPin ? NO_LAKE_OR_PIN_LINE
        : !lakeOk ? NO_LAKE_LINE
        : NO_PIN_LINE,
      next: null, href: null,
    });
  }

  // 9. Terms — the acceptance ledger. Earned, never assumed.
  rows.push(f.termsAccepted
    ? { key: "terms", done: true, optional: false, label: "You've accepted LakeLife's park terms", next: null, href: "/agreements" }
    // The writer is the TermsGate the /park layout draws, in its button's own
    // words; /agreements is a read-back of what was accepted and has no
    // accept control, so only the done branch points there.
    : { key: "terms", done: false, optional: false, label: "LakeLife's park terms not accepted yet", next: "I agree — take me to my park", href: "/park" });

  // 10. Published — parks.active. Writer: "Publish my park" on the Rent roll,
  //     owner only. Its `next` mirrors the gate that button applies: with
  //     every lot switched off it refuses, so the row says so first.
  if (f.published) {
    rows.push({ key: "published", done: true, optional: false, label: "Published — your park has its own page", next: null, href: "/park" });
  } else if (f.lots > 0 && f.activeLots === 0) {
    rows.push({
      key: "published", done: false, optional: false,
      label: "Not published — only you can see it",
      next: "Switch at least one lot to 'In service' under Lots & rates — the park can't publish with every lot off",
      href: "/park/lots",
    });
  } else {
    rows.push({
      key: "published", done: false, optional: false,
      label: "Not published — only you can see it",
      next: f.viewerIsOwner
        ? "'Publish my park' on the Rent roll, once the lots and rates look right"
        : "The park owner publishes it from the Rent roll",
      href: "/park",
    });
  }

  // 11. Notices — parks.notices_held_at. A fact about the hold column, never
  //     "lift it": nothing goes out until he says. And nothing after the dash
  //     on the lifted line — the row knows the hold, not the carrier.
  rows.push(f.noticesHeldOn
    ? {
        key: "notices", done: false, optional: true,
        label: `Notices on hold since ${dayInWords(f.noticesHeldOn)} — nobody on your roll is written to, including anything you send by hand`,
        next: null, href: "/park/setup",
      }
    : { key: "notices", done: true, optional: true, label: "Notices can go out", next: null, href: "/park/setup" });

  // 12. Online rent — parks.accepts_online_rent AND the processor. A switch is
  //     a wish; the processor is the rail.
  rows.push({
    key: "online", done: f.onlineRentOn && f.processorLive, optional: true,
    label: !f.onlineRentOn
      ? "Online rent is off — residents pay you the way they do now"
      : !f.processorLive
        ? "Online rent is switched on, but no card processor is connected yet — that's ours; until then the pay button stays hidden"
        : "Residents can pay rent in the app",
    next: null, href: "/park/setup",
  });

  return rows;
}

/** Done and required, over the non-optional rows only. */
export function readinessProgress(rows: readonly ReadinessRow[]): { done: number; required: number } {
  const required = rows.filter((r) => !r.optional);
  return { done: required.filter((r) => r.done).length, required: required.length };
}

export function readinessComplete(rows: readonly ReadinessRow[]): boolean {
  return rows.every((r) => r.optional || r.done);
}

/** Where "Let's look at it" goes: the first required undone row with a door, else any undone row with one. */
export function firstUndone(rows: readonly ReadinessRow[]): ReadinessRow | null {
  return rows.find((r) => !r.done && !r.optional && r.href)
    ?? rows.find((r) => !r.done && r.href)
    ?? null;
}

/**
 * Whether Today carries the list. No takeover-date gate, deliberately: the old
 * checklist showed only when a cutover was set and in the future, so a park
 * with no takeover day (most of them) never saw it at all.
 */
export function showReadinessOnToday(f: ReadinessFacts, rows: readonly ReadinessRow[]): boolean {
  return !f.published || !readinessComplete(rows);
}

export function readinessHeadline(f: ReadinessFacts, rows: readonly ReadinessRow[]): { headline: string; sub: string } {
  const p = readinessProgress(rows);
  if (f.cutoverOn && f.cutoverOn >= f.today) {
    // The countdown's own two sentences, then the count the first-run card's
    // "N things left on the list" refers to — this card is the only one on
    // Today before go-live, so the count has nowhere else to stand.
    const pc = preCutover({ today: f.today, cutoverOn: f.cutoverOn, parkName: f.parkName });
    return { headline: pc.headline, sub: `${pc.sub} ${p.done} of ${p.required} done.` };
  }
  return {
    headline: `Getting ${f.parkName} ready`,
    sub: `${p.done} of ${p.required} done.` + (readinessComplete(rows) ? " Everything the list checks is in place." : ""),
  };
}

// ------------------------------------------------------------ first run ----

export interface FirstRunCard {
  heading: "Welcome to LakeLife 🌊";
  parkLine: string;
  stateLine: string;
  contactLine: string;
  listLine: string;
  cta: { label: "Let's look at it"; href: string };
  alt: { label: string; href: string } | null;
}

/** The park_task_states key under which "Don't show this again" is recorded. */
export function firstRunTaskKey(parkId: string): string {
  return `first_run:${parkId}`;
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The blueprint's card, with first lines that read the park's actual state.
 * Null once the park is published, has raised a bill OR has recorded a
 * payment: a park billing or taking rent is operating, not on its first run —
 * and a receipt emailed to a resident leaves no row anywhere, so "nobody has
 * been contacted" cannot be trusted past either. The payment gate is there
 * because a receipt can go BEFORE the first bill: an on-account cheque at
 * signing needs no bill and is receipted straight away.
 */
export function firstRunCard(
  f: ReadinessFacts,
  contact: ContactFacts,
  rows: readonly ReadinessRow[],
): FirstRunCard | null {
  if (f.published || contact.chargesRaised > 0 || contact.paymentsRecorded > 0) return null;

  // Filed counts before it has started — the December roll is eighteen
  // households spoken for, not nobody. The occupancy line's words again.
  const stateLine = f.lots === 0
    ? "No lots on file yet."
    : f.occupiedLiveLots + f.reservedLiveLots === 0
      ? `${plural(f.lots, "lot", "lots")} on file · nobody filed on them yet.`
      : f.occupiedLiveLots === 0
        ? `${plural(f.lots, "lot", "lots")} · ${f.reservedLiveLots} spoken for, their tenancies start later.`
        : `${plural(f.lots, "lot", "lots")} · ${plural(f.occupiedLiveLots, "household", "households")} living here`
          + (f.reservedLiveLots > 0 ? `, ${f.reservedLiveLots} more spoken for.` : ".");

  const held = f.noticesHeldOn != null;
  const parts: string[] = [];
  if (contact.invitesSent > 0) parts.push(`${plural(contact.invitesSent, "household has", "households have")} been sent an invite`);
  if (contact.documentsDelivered > 0) parts.push(`${plural(contact.documentsDelivered, "document has", "documents have")} been delivered`);
  if (contact.remindersSent > 0) parts.push(`${plural(contact.remindersSent, "reminder has", "reminders have")} been sent`);
  if (contact.slipsIssued > 0) parts.push(`${plural(contact.slipsIssued, "household has", "households have")} had a slip printed`);
  const nothingSent = parts.length === 0;
  const sent = nothingSent ? "" : `${joinParts(parts)}.`;

  // THE SENTENCE IS PRINTED ONLY WHILE IT IS TRUE: hold on, and none of the
  // four witnesses has a row. "It" is the roll, so with no lots there is
  // nothing sitting here waiting.
  const contactLine = held && nothingSent
    ? "Nothing is published and nobody has been contacted. "
      + (f.lots === 0 ? "Nothing goes out until you say so." : "It's sitting here waiting for you to say it's right.")
    : held
      ? `Nothing is published. ${sent} Notices are on hold now, so nothing more goes out until you lift it.`
      : nothingSent
        ? "Nothing is published. Notices can go out."
        : `Nothing is published. ${sent} Notices can go out.`;

  // What the list says — nothing the code reads can defend a duration.
  const p = readinessProgress(rows);
  const left = p.required - p.done;
  const listLine = left === 0
    ? "Everything on the list is done — publish it when you're ready."
    : left === 1
      ? "One thing left on the list. You can stop anywhere and pick it back up."
      : `${left} things left on the list. You can stop anywhere and pick it back up.`;

  return {
    heading: "Welcome to LakeLife 🌊",
    parkLine: f.parkName,
    stateLine,
    contactLine,
    listLine,
    cta: { label: "Let's look at it", href: firstUndone(rows)?.href ?? "/park/setup" },
    // The Rent roll's own empty state offers both doors; the readiness row
    // points at Lots & rates, so the card offers the file one as well.
    alt: f.lots === 0 ? { label: "or load a rent roll", href: "/park/import" } : null,
  };
}

// ------------------------------------------------------------ the builder --

/** The light reads the two loaders share, made by readiness-data readinessExtras. */
export interface ReadinessExtras {
  lakeName: string | null;
  activeFees: number;
  documentsDelivered: number;
  remindersSent: number;
  /** park_payments rows for the park, unfiltered — see ContactFacts. */
  paymentsRecorded: number;
  termsAccepted: boolean;
  processorLive: boolean;
}

/**
 * The raw rows, as the loaders already hold them. getToday reads parks, lots,
 * reservations, renters and charges for its own card and hands them here
 * rather than reading them twice; the setup page's loader reads the same
 * shape itself.
 */
export interface ReadinessPreRead {
  today: string;
  viewerIsOwner: boolean;
  park: Record<string, unknown> | null;
  lots: readonly Record<string, unknown>[];
  /** approved | active | ended rows on the live lots. */
  reservations: readonly Record<string, unknown>[];
  renters: readonly Record<string, unknown>[];
  /** lot_rates over the live lots. */
  rates: readonly Record<string, unknown>[];
  chargesRaised: number;
  extras: ReadinessExtras;
}

export function readinessFactsFrom(pre: ReadinessPreRead): { facts: ReadinessFacts; contact: ContactFacts } {
  const park = pre.park ?? {};
  const liveLots = pre.lots
    .filter((l) => (l.lifecycle as string) === "live")
    .map((l) => ({ id: l.id as string, lot_number: String(l.lot_number ?? "") }));
  const liveIds = new Set(liveLots.map((l) => l.id));

  const reservations = pre.reservations
    .filter((r) => liveIds.has(r.park_lot_id as string))
    .map((r) => ({
      park_lot_id: r.park_lot_id as string,
      renter_id: (r.renter_id as string | null) ?? null,
      during: r.during as string,
      status: r.status as string,
      term: String(r.term ?? "monthly"),
    }));
  // THE ONE occupancy rule (today-helpers lotOccupancy), so this list and the
  // occupancy line under the money card cannot count a lot two ways.
  const occupancy = lotOccupancy(reservations, liveLots, pre.today);

  const held = reservations.filter((r) => r.status === "approved" || r.status === "active");
  const fileById = new Map(pre.renters.map((r) => [r.id as string, r]));
  const missing = new Set<string>();
  for (const r of held) {
    if (!r.renter_id) continue;
    const file = fileById.get(r.renter_id);
    if (!file) continue;
    if (!file.email || !file.phone_on_file_with_park) missing.add(r.renter_id);
  }

  const liveRates = pre.rates.filter((r) => liveIds.has(r.park_lot_id as string));
  const liveLotsWithRate = new Set(liveRates.map((r) => r.park_lot_id as string)).size;
  const monthlyRoll = liveRates
    .filter((r) => (r.term as string) === "monthly")
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);

  const heldAt = (park.notices_held_at as string | null) ?? null;

  return {
    facts: {
      parkName: (park.name as string) ?? "Your park",
      today: pre.today,
      lots: pre.lots.length,
      liveLots: liveLots.length,
      activeLots: pre.lots.filter((l) => l.active === true).length,
      liveLotsWithRate,
      monthlyRoll,
      occupiedLiveLots: occupancy.occupiedLotIds.size,
      reservedLiveLots: occupancy.reservedLotIds.size,
      householdsMissingContact: missing.size,
      cutoverOn: (park.cutover_date as string | null) ?? null,
      rentDueDay: Number(park.rent_due_day ?? 1),
      maxAgreementMonths: park.max_agreement_months == null ? null : Number(park.max_agreement_months),
      activeFees: pre.extras.activeFees,
      lakeName: pre.extras.lakeName,
      hasMapPin: park.lat != null && park.lng != null,
      termsAccepted: pre.extras.termsAccepted,
      published: park.active === true,
      viewerIsOwner: pre.viewerIsOwner,
      noticesHeldOn: heldAt ? lakeDateOf(heldAt) : null,
      onlineRentOn: park.accepts_online_rent === true,
      processorLive: pre.extras.processorLive,
    },
    contact: {
      invitesSent: pre.renters.filter((r) => r.invite_sent_at != null).length,
      documentsDelivered: pre.extras.documentsDelivered,
      remindersSent: pre.extras.remindersSent,
      slipsIssued: pre.renters.filter((r) => r.claim_code_issued_at != null).length,
      chargesRaised: pre.chargesRaised,
      paymentsRecorded: pre.extras.paymentsRecorded,
    },
  };
}
