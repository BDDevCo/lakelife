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
  { type: "day", label: "Crew on the way / service-day reminder", channel: "Text", defaultOn: true, locked: false },
  { type: "done", label: "Service complete — with photos", channel: "Text + email", defaultOn: true, locked: false },
  { type: "appr", label: "Approval needed from a crew flag", channel: "Text", defaultOn: true, locked: false },
  { type: "rcpt", label: "Invoices & receipts", channel: "Email", defaultOn: true, locked: true },
  { type: "season", label: "Seasonal reminders — book your fall pull before freeze", channel: "Email", defaultOn: true, locked: false },
];
