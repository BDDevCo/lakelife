import { money, prettyMonth, type LedgerRow } from "./ledger-helpers";
import { dayInWords } from "./park-helpers";
import {
  channelFor,
  type RenterContact,
  type PlannedReminder,
  type ReminderOptions,
} from "./reminder-helpers";

/**
 * TELLING A HOUSEHOLD THEIR BILL EXISTS.
 *
 * `runCharges` ends its own success sentence with the words "Nobody has been
 * told." That is honest, and it is the defect: the run raises eighteen bills
 * and the only resident-facing money message in the product is the OVERDUE
 * demand, which by definition fires after somebody is already late. On
 * 1 January 2027 every household at The Haven signs at $542.53, the run raises
 * their bills, nobody is told — and the first thing any of them hears from the
 * software is a demand.
 *
 * NOT A REMINDER, AND THE SEPARATION IS THE POINT. 0192 gives park_reminders a
 * `kind`, because this table's unique index is the hard guarantee behind "never
 * chased twice" and an announcement must not consume the demand's only slot.
 * The two acts also want opposite tones: a demand asks for money that is late,
 * this one asks for nothing at all.
 *
 * THE CHANNEL RULE IS NOT COPIED. `channelFor` decides which channel a
 * household actually gets — a resident who asked not to be contacted, an
 * unverified mobile, texting that has never delivered — and it stays the one
 * home for that. Duplicating it here is how the-rule-in-one-doorway-of-three
 * got written.
 */

/**
 * The notice itself.
 *
 * STATES THE BILL AND NOTHING ELSE. No "please remit", no consequence, no
 * deadline language beyond the date the bill itself carries — this is the
 * software's FIRST contact with a household about money, and `reminderBody`'s
 * own rule applies with more force here: "A rent reminder that reads as a
 * warning turns a forgotten cheque into a fight."
 *
 * It names what the bill is FOR when the bill knows. At The Haven every January
 * bill is $400 rent plus a $142.53 grounds fee, and a household who has only
 * ever paid $400 needs the second line explained before they are asked for it —
 * otherwise the first thing they do is ring the office, and the second is
 * assume they have been overcharged.
 */
export function billNoticeBody(input: {
  name: string;
  lotNumber: string;
  month: string;
  amount: number;
  dueOn: string;
  /** The bill's own frozen breakdown, when it carries one. */
  lines?: readonly { label: string; amount: number }[];
  parkName: string;
  officeLine: string;
}): string {
  const { name, lotNumber, month, amount, dueOn, lines = [], parkName, officeLine } = input;
  // One line is the whole bill and explains nothing; two or more are worth
  // printing. A bill with no breakdown at all says only its total, rather
  // than inventing one.
  const breakdown = lines.length > 1
    ? ["", ...lines.map((l) => `  ${l.label} — ${money(l.amount)}`)]
    : [];
  return [
    `Hi ${name.split(",")[0].trim() || "there"},`,
    ``,
    `Your bill for ${prettyMonth(month)} on lot ${lotNumber} is ${money(amount)}, due ${dayInWords(dueOn)}.`,
    ...breakdown,
    ``,
    officeLine,
    ``,
    `If you've already paid this, thank you — it may have crossed with this note.`,
    ``,
    `— ${parkName}`,
  ].join("\n");
}

export interface BillNoticePlan {
  toSend: PlannedReminder[];
  /** Printable notices for the office to hand over. */
  toPrint: PlannedReminder[];
  /** Nothing can go out, each with a reason on screen. */
  blocked: PlannedReminder[];
  /** Already told about this bill. Never told twice. */
  skippedAlreadyTold: number;
  /** Nothing is owed on it, so there is nothing to tell them about. */
  skippedSettled: number;
  /**
   * They have already spoken to the office about this bill — they said they
   * paid it, or their bank debit is on its way. Either way they know the bill
   * exists, and announcing it would read as though nobody had listened.
   */
  skippedTheyKnow: number;
  totalTold: number;
}

/**
 * Who gets told, and how.
 *
 * A BILL WITH NOTHING OWING IS NOT ANNOUNCED. The household has already paid
 * it — a notice saying "your bill is $542.53" to somebody whose receipt is on
 * the fridge is how a working system loses trust.
 *
 * A LATE BILL STILL GETS ONE, deliberately. The owner may be catching up weeks
 * after the run, and "we never told you" is worse than "we told you late". The
 * copy carries the due date as a fact rather than a threat, so it reads
 * correctly either side of it.
 */
export function planBillNotices(
  rows: readonly LedgerRow[],
  contacts: ReadonlyMap<string, RenterContact>,
  month: string,
  opts: ReminderOptions & {
    /** Charges already announced — never told twice. */
    alreadyTold: ReadonlySet<string>;
    /**
     * EACH BILL'S OWN FROZEN BREAKDOWN, by charge id. Passed in rather than
     * read off the row because `Charge` does not carry it and widening that
     * type would reach every constructor of it in the module. Absent is a real
     * answer — a bill raised before the breakdown was carried has none — and
     * then the notice states its total and explains nothing, rather than
     * inventing a split.
     */
    linesByCharge?: ReadonlyMap<string, readonly { label: string; amount: number }[]>;
  },
): BillNoticePlan {
  const toSend: PlannedReminder[] = [];
  const toPrint: PlannedReminder[] = [];
  const blocked: PlannedReminder[] = [];
  let skippedAlreadyTold = 0;
  let skippedSettled = 0;
  let skippedTheyKnow = 0;

  for (const r of rows) {
    // A cancelled bill is not a bill, and a settled one needs no telling.
    if (r.state === "void" || r.balance <= 0) { skippedSettled += 1; continue; }
    // THEY RAISED IT FIRST. A household who has told the office they paid, or
    // whose debit is clearing, already knows this bill exists.
    if (r.state === "disputed" || r.state === "clearing") { skippedTheyKnow += 1; continue; }
    if (opts.alreadyTold.has(r.id)) { skippedAlreadyTold += 1; continue; }

    const contact = r.renterName ? contacts.get(r.id) : undefined;
    const name = contact?.displayName ?? r.renterName ?? "there";

    const body = billNoticeBody({
      name,
      lotNumber: r.lotNumber,
      month,
      // THE BILL, NOT THE BALANCE. A household who has part-paid is being told
      // what the month costs; what is left is the office's arithmetic, and
      // putting it here would read as a demand for the remainder.
      amount: r.amount,
      dueOn: r.dueOn,
      lines: opts.linesByCharge?.get(r.id),
      parkName: opts.parkName,
      officeLine: opts.officeLine,
    });

    // A household with no contact row at all cannot be routed by preference —
    // paper is the honest answer, and it is also the default this park runs on.
    const decision = contact
      ? channelFor(contact, opts.smsEnabled)
      : { channel: "paper" as const, blocked: false, reason: null, note: null };

    const planned: PlannedReminder = {
      chargeId: r.id,
      renterId: contact?.renterId ?? null,
      lotNumber: r.lotNumber,
      name,
      balance: r.amount,
      overdueDays: r.overdueDays,
      channel: decision.channel,
      blocked: decision.blocked,
      reason: decision.reason,
      note: decision.note,
      body,
    };

    if (decision.blocked) blocked.push(planned);
    else if (decision.channel === "paper") toPrint.push(planned);
    else toSend.push(planned);
  }

  return {
    toSend, toPrint, blocked,
    skippedAlreadyTold, skippedSettled, skippedTheyKnow,
    totalTold: toSend.length + toPrint.length,
  };
}

/**
 * What the owner reads before anything goes out.
 *
 * Names the PAPER count out loud, like the reminder summary does and for the
 * same reason: those are the ones he has to physically do something about, and
 * a number he skips is a household nobody ever tells.
 */
export function billNoticeSummary(plan: BillNoticePlan): string {
  if (plan.totalTold === 0 && plan.blocked.length === 0) {
    if (plan.skippedAlreadyTold > 0) return "Everyone with a bill this month has already been told.";
    if (plan.skippedTheyKnow > 0) {
      return "Nobody left to tell — the households with money owing have already been in touch about it.";
    }
    if (plan.skippedSettled > 0) return "Nothing to tell anybody — every bill this month is settled.";
    return "No bills to tell anybody about.";
  }

  const parts: string[] = [];
  if (plan.toSend.length > 0) parts.push(`${plan.toSend.length} by email`);
  if (plan.toPrint.length > 0) parts.push(`${plan.toPrint.length} to print and hand over`);
  if (plan.blocked.length > 0) parts.push(`${plan.blocked.length} we can't reach`);
  if (plan.skippedAlreadyTold > 0) parts.push(`${plan.skippedAlreadyTold} already told`);
  if (plan.skippedTheyKnow > 0) parts.push(`${plan.skippedTheyKnow} already in touch`);
  return parts.join(" · ");
}
