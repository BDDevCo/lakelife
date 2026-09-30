/**
 * Customer notification preferences, straight from the prototype.
 * Receipts are locked always-on (CLAUDE.md / launch plan §5).
 */
export interface NotifDef {
  type: string;
  label: string;
  channel: string;
  defaultOn: boolean;
  locked: boolean;
}

export const NOTIF_DEFS: NotifDef[] = [
  { type: "book", label: "Booking confirmed", channel: "Text + email", defaultOn: true, locked: false },
  // TEXT + EMAIL, and until a carrier delivers something the email is the only
  // half that arrives. Declared "Text" alone, `channelsFor` yielded ['sms'],
  // `staticGate('day','email')` answered "deny", and the email half of
  // sendNightBeforeReminders could never fire — so the one notice that stops a
  // homeowner being surprised by a crew in the driveway reached nobody at all.
  // The settings screen draws its chips from this line, so the customer now
  // gets an Email switch as well, and setNotifPref accepts it because it
  // validates against channelsFor(def).
  { type: "day", label: "Crew on the way / service-day reminder", channel: "Text + email", defaultOn: true, locked: false },
  { type: "done", label: "Service complete — with photos", channel: "Text + email", defaultOn: true, locked: false },
  { type: "appr", label: "Approval needed from a crew flag", channel: "Text + email", defaultOn: true, locked: false },
  { type: "rcpt", label: "Invoices & receipts", channel: "Email", defaultOn: true, locked: true },
  { type: "season", label: "Seasonal reminders — book your fall pull before freeze", channel: "Email", defaultOn: true, locked: false },
];
