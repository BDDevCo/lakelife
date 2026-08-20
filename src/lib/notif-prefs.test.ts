import { describe, it, expect } from "vitest";
import { channelsFor, mergeNotifPrefs, type SavedPref, staticGate, defaultFor,
} from "./notif-prefs";
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

describe("the send gate — six switches that used to do nothing", () => {
  // Every one of these types has been on the settings screen since the start,
  // and no send path ever read one. A customer who turned texts off kept
  // getting texts, which is worse than having no switch at all.
  it("consults the customer's choice for an ordinary notification", () => {
    expect(staticGate("day", "sms")).toBe("consult");
    expect(staticGate("book", "email")).toBe("consult");
  });

  it("never asks about a receipt — that's a record of money, not a preference", () => {
    expect(staticGate("rcpt", "email")).toBe("allow");
  });

  it("refuses a channel the type is never delivered on", () => {
    // "Crew on the way" is a text and the seasonal nudge is an email; neither
    // has the other's switch to consult, so those paths must not silently fall
    // through to allowed.
    expect(staticGate("day", "email")).toBe("deny");
    expect(staticGate("season", "sms")).toBe("deny");
  });

  it("consults BOTH channels for the crew flag — the email is the one that arrives", () => {
    // This assertion used to read `staticGate("appr","email") === "deny"`,
    // which was true of the DEFINITION and false of the code: submitFlag sent
    // that email with no gate at all. The def now matches what sends.
    expect(staticGate("appr", "sms")).toBe("consult");
    expect(staticGate("appr", "email")).toBe("consult");
  });

  it("allows a type it has never heard of rather than swallowing it", () => {
    // A swallowed send leaves no trace, which is the exact failure class this
    // whole gate exists to stop repeating.
    expect(staticGate("something_new", "sms")).toBe("allow");
  });

  it("defaults to the def's own default when they've never opened settings", () => {
    expect(defaultFor("day")).toBe(true);
    expect(defaultFor("nonsense")).toBe(true);
  });
});
