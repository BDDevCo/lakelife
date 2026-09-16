import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE GUEST LINK'S ORIGIN COMES FROM ONE PLACE.
 *
 * A guest's one-tap link (0120, /use/[token]) is only useful as a FULL url —
 * "/use/abc" is a working link in a browser already on the site and a dead
 * string in a text message. The origin is `siteUrl()` in lib/env, the helper
 * the auth links already use; a second `process.env.NEXT_PUBLIC_SITE_URL ??
 * "http://localhost:3000"` here would be one more copy to drift.
 *
 * Scanned with comments stripped, so a comment that MENTIONS the env var
 * cannot read as a copy of it — and the scan proves it still finds the code
 * it is measuring.
 */

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const action = strip(src("./amenity-actions.ts"));
const ui = strip(src("../../components/ParkAmenities.tsx"));
const route = src("../use/[token]/route.ts");
const guest = src("../../lib/amenity-guest-server.ts");

describe("the scanner is measuring something", () => {
  it("finds the link builder, the row field and the copy button", () => {
    expect(action).toMatch(/function guestLinkFor\(/);
    expect(action).toMatch(/guestLink: guestLinkFor\(/);
    expect(ui).toMatch(/navigator\.clipboard\.writeText\(url\)/);
    expect(ui).toMatch(/Copy link/);
  });

  it("strips a comment that would otherwise match", () => {
    expect(strip("// process.env.NEXT_PUBLIC_SITE_URL\nconst a = 1;")).not.toMatch(/NEXT_PUBLIC_SITE_URL/);
    expect(strip("/* http://localhost:3000 */ x")).not.toMatch(/localhost/);
  });
});

describe("the origin is the shared helper, never a second copy", () => {
  it("amenity-actions imports siteUrl from lib/env and builds the link from it", () => {
    expect(action).toMatch(/^import \{ siteUrl \} from "@\/lib\/env";$/m);
    expect(action).toMatch(/`\$\{siteUrl\(\)\.replace\(\/\\\/\+\$\/, ""\)\}\/use\/\$\{token\}`/);
  });

  it("neither file reads the env var or hardcodes an origin itself", () => {
    for (const [name, s] of [["amenity-actions", action], ["ParkAmenities", ui]] as const) {
      expect(s, `${name}: a second copy of the site origin`).not.toMatch(/NEXT_PUBLIC_SITE_URL/);
      expect(s, `${name}: a hardcoded origin`).not.toMatch(/localhost:3000|https?:\/\/lakelife/);
      expect(s, `${name}: reading request headers for the host`).not.toMatch(/x-forwarded-host/);
    }
  });

  it("the client never builds the url — it arrives on the row from the loader", () => {
    expect(ui).not.toMatch(/\/use\/\$\{/);
    expect(ui).not.toMatch(/siteUrl/);
    expect(ui).toMatch(/row\.guestLink/);
  });
});

describe("the loader reads what the link needs", () => {
  it("selects use_token AND status off the stay — the token is the link, the status says whether it opens", () => {
    expect(action).toMatch(/from\("lot_reservations"\)\.select\("id, park_lot_id, use_token, status"\)/);
  });

  it("a link is built only for a stay the route will open", () => {
    // loadGuestView returns null for anything but approved/active, and the
    // route prints "That link isn't right" for null. Same two words here.
    expect(guest).toMatch(/if \(!\["approved", "active"\]\.includes\(stay\.status as string\)\) return null;/);
    expect(route).toMatch(/htmlPage\("That link isn't right"/);
    expect(action).toMatch(/const LIVE_STAY = new Set\(\["approved", "active"\]\);/);
    expect(action).toMatch(/if \(!token \|\| !LIVE_STAY\.has\(status \?\? ""\)\) return null;/);
  });

  it("the row carries stayLive so the screen can say WHY there is no link", () => {
    expect(action).toMatch(/stayLive: LIVE_STAY\.has\(/);
    expect(ui).toMatch(/row\.stayLive\s*\?\s*"No booking link on this stay yet\."/);
  });
});

describe("nothing is sent", () => {
  it("the amenity files call no email or SMS sender", () => {
    for (const [name, s] of [["amenity-actions", action], ["ParkAmenities", ui]] as const) {
      expect(s, `${name}: a send door grew here`).not.toMatch(/sendEmail|sendSms|sendSMS|twilio|resend/i);
    }
  });

  it("the booking confirmation points at the row rather than sending anything", () => {
    expect(action).toMatch(/to collect\. Their link is on the booking\./);
    expect(action).toMatch(/Included with their stay\. Their link is on the booking\./);
  });
});

describe("the route is what the sentence on screen describes", () => {
  it("GET only renders; POST books or gives back a day; no expiry or one-use logic exists", () => {
    const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
    expect(get).not.toMatch(/bookDayByToken|cancelDayByToken/);
    const post = route.slice(route.indexOf("export async function POST"));
    expect(post).toMatch(/cancelDayByToken\(token, give\)/);
    expect(post).toMatch(/bookDayByToken\(token,/);
    expect(route).not.toMatch(/expires?_at|used_at|one[_-]?use/i);
  });
});
