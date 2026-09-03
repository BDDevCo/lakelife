/**
 * OVERDUE REMINDERS — deciding who gets told, and how.
 *
 * THE HOUSEHOLDS THIS HAS TO REACH ARE THE ONES SOFTWARE USUALLY MISSES.
 * A quarter to a third of a park never goes digital — `contact_pref` defaults
 * to 'paper' for that reason. Those are often the longest-standing, oldest,
 * most at-risk residents, and if the reminder system can only send email and
 * SMS they are the only people who never get reminded. The first thing they
 * then hear about arrears is something much worse than a reminder.
 *
 * So PAPER IS A REAL OUTCOME, not a failure. It produces a printable notice
 * the office hand-delivers, and it is logged exactly like a sent email —
 * because "did we tell them?" must be answerable the same way regardless of
 * how.
 *
 * WHAT IT REFUSES:
 *
 *   NEVER TEXT WITHOUT CONSENT. A verified mobile is not permission; the
 *   operational-SMS consent is. And `phone_on_file_with_park` — a number off a
 *   seller's roll — is NEVER a send target, which is why it does not appear in
 *   this file at all.
 *
 *   NEVER TWICE FOR ONE BILL. Somebody chased three times stops reading
 *   anything from the park, and the message they stop reading is the freeze
 *   warning.
 *
 *   NEVER REMIND SOMEBODY WHO IS NOT ACTUALLY LATE. Inside the office's
 *   catch-up window a bill is unrecorded, not unpaid.
 */

import type { LedgerRow } from "./ledger-helpers";
import { prettyMonth } from "./ledger-helpers";

export type ReminderChannel = "email" | "sms" | "paper" | "none";
export type ReminderOutcome = "sent" | "printed" | "blocked" | "failed";

export interface RenterContact {
  renterId: string;
  displayName: string;
  email: string | null;
  /** A VERIFIED mobile. An unverified one is not a channel. */
  mobile: string | null;
  /** Operational SMS consent. A rent reminder is operational, not marketing. */
  smsConsent: boolean;
  contactPref: "sms" | "email" | "paper" | "none";
}

export interface PlannedReminder {
  chargeId: string;
  renterId: string | null;
  lotNumber: string;
  name: string;
  balance: number;
  overdueDays: number;
  channel: ReminderChannel;
  /** Set when nothing can be sent. Always with a reason. */
  blocked: boolean;
  reason: string | null;
  /**
   * Set when they got a DIFFERENT channel than they asked for. Not a failure —
   * the notice still goes — but the owner should see it, because a run of
   * these is a signal about the park (nobody's on email, or texting is still
   * off) rather than about one household.
   */
  note: string | null;
  body: string;
}

export interface ReminderOptions {
  parkName: string;
  /** Where to pay / who to call. Printed on every notice. */
  officeLine: string;
  /**
   * FALSE until A2P 10DLC registration clears. Blocked-with-a-reason rather
   * than a silent skip, so the owner can see that four people would have been
   * texted and were not.
   */
  smsEnabled: boolean;
  /** Charges already reminded — never chased twice. */
  alreadyReminded: ReadonlySet<string>;
}

/**
 * The notice itself.
 *
 * States the amount, the month and where to pay, and NOTHING ELSE. No threat,
 * no fee that has not been agreed, no tone. A rent reminder that reads as a
 * warning turns a forgotten cheque into a fight, and the overwhelming majority
 * of these are forgotten cheques.
 */
export function reminderBody(input: {
  name: string;
  lotNumber: string;
  month: string;
  balance: number;
  parkName: string;
  officeLine: string;
}): string {
  const { name, lotNumber, month, balance, parkName, officeLine } = input;
  return [
    `Hi ${name.split(",")[0].trim() || "there"},`,
    ``,
    `This is a reminder that $${balance.toFixed(2)} is outstanding on lot ${lotNumber} for ${prettyMonth(month)}.`,
    ``,
    `If you've already paid, thank you — nothing more to do, and it may have crossed with this.`,
    ``,
    officeLine,
    ``,
    `— ${parkName}`,
  ].join("\n");
}

export interface ChannelDecision {
  channel: ReminderChannel;
  blocked: boolean;
  reason: string | null;
  note: string | null;
}

/**
 * Which channel a household actually gets.
 *
 * Preference first, then what is possible. Somebody who asked for paper gets
 * paper even if we hold an email address — the preference is the instruction.
 *
 * A CHANNEL WE CANNOT USE IS NEVER THE END OF THE ROAD. If texting is off, the
 * notice goes by email, and if there is no email it gets printed. The only
 * household this function gives up on is one that asked to be left alone. A
 * reminder system that blocks whenever its preferred channel is unavailable
 * silently stops telling the people it is least able to reach — which is
 * exactly backwards.
 */
export function channelFor(c: RenterContact, smsEnabled: boolean): ChannelDecision {
  // 'none' is a resident who asked not to be contacted. It is not a gap to
  // route around — it is an answer, and the office visits in person instead.
  if (c.contactPref === "none") {
    return {
      channel: "none", blocked: true, note: null,
      reason: "They've asked not to be contacted — call in instead.",
    };
  }

  const fallback = (note: string): ChannelDecision =>
    c.email
      ? { channel: "email", blocked: false, reason: null, note: `${note} Emailed instead.` }
      : { channel: "paper", blocked: false, reason: null, note: `${note} Printed instead.` };

  if (c.contactPref === "sms") {
    if (!c.mobile || !c.smsConsent) {
      return fallback("They asked for texts, but we don't have a verified mobile with consent.");
    }
    if (!smsEnabled) {
      return fallback("Texting isn't switched on yet — carrier registration is still pending.");
    }
    return { channel: "sms", blocked: false, reason: null, note: null };
  }

  if (c.contactPref === "email") {
    return c.email
      ? { channel: "email", blocked: false, reason: null, note: null }
      : fallback("They asked for email, but we don't have an address for them.");
  }

  // 'paper' — the default, and a permanent, respectable answer.
  return { channel: "paper", blocked: false, reason: null, note: null };
}

export interface ReminderPlan {
  toSend: PlannedReminder[];
  /** Printable notices for the office to hand over. */
  toPrint: PlannedReminder[];
  /** Nothing can go out, each with a reason on screen. */
  blocked: PlannedReminder[];
  skippedAlreadyReminded: number;
  skippedNotLate: number;
  /**
   * Households who say they paid. Never chased — a demand sent to somebody who
   * handed over cash last week is how a clerical gap becomes a fight, and it is
   * the park that will be wrong roughly as often as the renter.
   */
  skippedDisputed: number;
  totalChased: number;
}

export function planReminders(
  rows: readonly LedgerRow[],
  contacts: ReadonlyMap<string, RenterContact>,
  month: string,
  opts: ReminderOptions,
): ReminderPlan {
  const toSend: PlannedReminder[] = [];
  const toPrint: PlannedReminder[] = [];
  const blocked: PlannedReminder[] = [];
  let skippedAlreadyReminded = 0;
  let skippedNotLate = 0;
  let skippedDisputed = 0;

  for (const r of rows) {
    // THEY SAY THEY PAID. Never chased while that is unanswered — the park is
    // wrong about as often as the renter, and a demand sent to somebody who
    // handed over cash last week is how a clerical gap becomes a fight.
    if (r.state === "disputed") { skippedDisputed += 1; continue; }
    // Inside the catch-up window a bill is unrecorded, not unpaid. Chasing it
    // is the false alarm the whole ledger is built to avoid.
    if (r.state !== "late") { skippedNotLate += 1; continue; }
    if (opts.alreadyReminded.has(r.id)) { skippedAlreadyReminded += 1; continue; }

    const contact = r.renterName ? contacts.get(r.id) : undefined;
    const name = contact?.displayName ?? r.renterName ?? "there";

    const body = reminderBody({
      name,
      lotNumber: r.lotNumber,
      month,
      balance: r.balance,
      parkName: opts.parkName,
      officeLine: opts.officeLine,
    });

    // No contact record at all — an unclaimed file with nothing on it. Paper is
    // the honest fallback: somebody lives there and the office knows the lot.
    const decided: ChannelDecision = contact
      ? channelFor(contact, opts.smsEnabled)
      : { channel: "paper", blocked: false, reason: null, note: null };

    const planned: PlannedReminder = {
      chargeId: r.id,
      renterId: contact?.renterId ?? null,
      lotNumber: r.lotNumber,
      name,
      balance: r.balance,
      overdueDays: r.overdueDays,
      channel: decided.channel,
      blocked: decided.blocked,
      reason: decided.reason,
      note: decided.note,
      body,
    };

    if (decided.blocked) blocked.push(planned);
    else if (decided.channel === "paper") toPrint.push(planned);
    else toSend.push(planned);
  }

  return {
    toSend, toPrint, blocked,
    skippedAlreadyReminded, skippedNotLate, skippedDisputed,
    totalChased: toSend.length + toPrint.length,
  };
}

/**
 * What the owner reads before anything goes out.
 *
 * Names the PAPER count out loud rather than burying it, because those are the
 * ones he has to physically do something about — a number he skips is a
 * household nobody ever tells.
 */
export function reminderSummary(plan: ReminderPlan): string {
  if (plan.totalChased === 0 && plan.blocked.length === 0) {
    if (plan.skippedDisputed > 0) {
      return `Nobody to chase — ${plan.skippedDisputed} say they've already paid. Check those first.`;
    }
    if (plan.skippedAlreadyReminded > 0) return "Everyone late has already been reminded.";
    return "Nobody is late.";
  }

  const parts: string[] = [];
  if (plan.toSend.length > 0) parts.push(`${plan.toSend.length} by email`);
  if (plan.toPrint.length > 0) {
    parts.push(`${plan.toPrint.length} to print and hand over`);
  }
  if (plan.blocked.length > 0) parts.push(`${plan.blocked.length} we can't reach`);
  if (plan.skippedAlreadyReminded > 0) parts.push(`${plan.skippedAlreadyReminded} already reminded`);
  if (plan.skippedDisputed > 0) parts.push(`${plan.skippedDisputed} say they've paid — not chased`);
  return parts.join(" · ");
}

/** The owner's own digest line. One message about twenty, never twenty. */
export function ownerDigest(plan: ReminderPlan, parkName: string, month: string): string | null {
  if (plan.totalChased === 0 && plan.blocked.length === 0) return null;
  const total = plan.toSend.concat(plan.toPrint).reduce((s, r) => s + r.balance, 0);
  const lines = [
    `${parkName} — ${prettyMonth(month)} reminders`,
    ``,
    `${plan.totalChased} ${plan.totalChased === 1 ? "household" : "households"} chased, $${total.toFixed(2)} outstanding.`,
  ];
  if (plan.toPrint.length > 0) {
    lines.push(``, `${plan.toPrint.length} need a printed notice — they're not on email.`);
  }
  const downgraded = plan.toSend.concat(plan.toPrint).filter((r) => r.note);
  if (downgraded.length > 0) {
    lines.push(``, `${downgraded.length} didn't get the channel they asked for:`);
    for (const d of downgraded) lines.push(`  Lot ${d.lotNumber} — ${d.note}`);
  }
  if (plan.blocked.length > 0) {
    lines.push(``, `Couldn't reach ${plan.blocked.length}:`);
    for (const b of plan.blocked) lines.push(`  Lot ${b.lotNumber} — ${b.reason}`);
  }
  return lines.join("\n");
}

/**
 * WHY A REMINDER DIDN'T GO, IN WORDS THAT ARE TRUE.
 *
 * The reason was hardcoded to "The email didn't go — check the address." and
 * `sendEmail`'s own error was discarded, so every cause wrote the same
 * permanent ledger row: a held park, a missing API key, a Resend 5xx and an
 * actually-bad address were indistinguishable. On 1 January, with notices
 * held by default, that is twenty rows blaming twenty good addresses for
 * something the owner did on purpose.
 *
 * `sendEmail` refuses in two registers. The hold refusals are already written
 * for a person and are passed through untouched. A transport error is
 * technical, so it is LABELLED as the technical thing it is rather than
 * translated into a guess about the recipient.
 */
export function whyItDidntGo(error?: string): string {
  if (!error) return "The email didn't go, and no reason came back.";
  // notice-hold.ts writes both of these to be read by the park owner.
  if (/^Notices are on hold|^We couldn't check whether/.test(error)) return error;
  return `The email didn't go — ${error}`;
}

/**
 * The one reason to put in the result sentence.
 *
 * "20 didn't go" with no cause sends him to look at twenty addresses. When
 * they all failed the same way — which is the normal case, because the normal
 * cause is a setting — say which. When they didn't, say that instead of
 * picking a winner.
 */
export function commonestReason(reasons: string[]): string {
  if (reasons.length === 0) return "";
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  if (counts.size === 1) return lowerFirst(reasons[0]);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return `${lowerFirst(top)} (${n} of ${reasons.length}; the rest for other reasons)`;
}

/**
 * "Notices are on hold…" reads wrong mid-sentence after an em dash.
 *
 * Every input here is a `whyItDidntGo` output, so it is always one of our own
 * sentences — "Notices are on hold…", "We couldn't check…", "The email didn't
 * go — …". Lower-casing the first word of one of those is right. A raw
 * transport string like "Resend 503" never reaches this, because
 * `whyItDidntGo` has already put "The email didn't go — " in front of it.
 */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * THE SENTENCE HE READS AFTER PRESSING "SEND N AND LOG THE REST".
 *
 * It used to be assembled from `sent`, `printed` and `blocked` — three
 * numbers that between them cannot describe a send that was ATTEMPTED and
 * REFUSED. With notices held (the default, and his own standing rule) all
 * twenty were refused and the sentence read "0 emailed." A true number and a
 * completely misleading sentence, on the morning he chases rent for the first
 * time.
 *
 * It lives here, pure, rather than inline in the action — the first attempt at
 * this fix built it inline and tested a COPY of the expression, so deleting
 * the failure clause from the real one kept every test green.
 */
export function reminderSignal(r: {
  sent: number;
  /** One entry per failure, already in words. Length is the count. */
  failed: string[];
  printed: number;
  blocked: number;
  toldOwners: number;
  ownerLookupFailed: boolean;
  logSaved: boolean;
}): string {
  const body =
    `${r.sent} emailed` +
    // Named, because "20 didn't go" with no cause sends him to look at twenty
    // addresses — which is exactly what the old hardcoded reason told him to do.
    (r.failed.length ? `, ${r.failed.length} didn't go — ${commonestReason(r.failed)}` : "") +
    (r.printed ? `, ${r.printed} to print` : "") +
    (r.blocked ? `, ${r.blocked} couldn't be reached` : "") +
    (r.toldOwners > 0 ? `. ${r.toldOwners === 1 ? "The owner was" : "Owners were"} sent a summary` : "") +
    (r.ownerLookupFailed ? ". We couldn't check who else to send a summary to, so assume they weren't told" : "") +
    (r.logSaved ? "" : ". These sends didn't get recorded, so don't send again until that's checked — they'd be chased twice");

  // The failure reason is a whole sentence and ends in its own full stop, so
  // appending one unconditionally produced "…when everyone is ready..".
  return body.endsWith(".") ? body : `${body}.`;
}
