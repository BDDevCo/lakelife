import { describe, it, expect } from "vitest";
import { channelsFor, mergeNotifPrefs, type SavedPref } from "./notif-prefs";
import type { NotifDef } from "./notifications";

const DEFS: NotifDef[] = [
  { type: "book", label: "Booking confirmed", channel: "Text + email", defaultOn: true, locked: false },
  { type: "day", label: "Reminder", channel: "Text", defaultOn: true, locked: false },
  { type: "season", label: "Seasonal", channel: "Email", defaultOn: false, locked: false },
  { type: "rcpt", label: "Receipts", channel: "Email", defaultOn: true, locked: true },
];

describe("channelsFor — parse display label into machine channels", () => {
  it("'Text + email' -> sms + email", () => {
    expect(channelsFor(DEFS[0])).toEqual(["sms", "email"]);
  });
  it("'Text' -> sms only", () => {
    expect(channelsFor(DEFS[1])).toEqual(["sms"]);
  });
  it("'Email' -> email only", () => {
    expect(channelsFor(DEFS[2])).toEqual(["email"]);
  });
});

describe("mergeNotifPrefs — defaults merged with saved rows", () => {
  it("no saved rows: each channel falls back to defaultOn", () => {
    const m = mergeNotifPrefs([], DEFS);
    expect(m.book).toEqual({ sms: true, email: true });
    expect(m.day).toEqual({ sms: true });
    expect(m.season).toEqual({ email: false });
  });

  it("locked type is always on with no saved rows", () => {
    const m = mergeNotifPrefs([], DEFS);
    expect(m.rcpt).toEqual({ email: true });
  });

  it("a saved row overrides the default for that one channel", () => {
    const saved: SavedPref[] = [{ type: "book", channel: "sms", enabled: false }];
    const m = mergeNotifPrefs(saved, DEFS);
    expect(m.book).toEqual({ sms: false, email: true });
  });

  it("locked type can never be turned off, even by a saved row", () => {
    const saved: SavedPref[] = [{ type: "rcpt", channel: "email", enabled: false }];
    const m = mergeNotifPrefs(saved, DEFS);
    expect(m.rcpt).toEqual({ email: true });
  });

  it("ignores saved rows for unknown types and unsupported channels", () => {
    const saved: SavedPref[] = [
      { type: "ghost", channel: "sms", enabled: false },
      { type: "day", channel: "email", enabled: false }, // 'day' has no email channel
    ];
    const m = mergeNotifPrefs(saved, DEFS);
    expect(m.ghost).toBeUndefined();
    expect(m.day).toEqual({ sms: true });
  });
});
