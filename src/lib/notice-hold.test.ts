import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { holdRefusal, recipientIsHeld } from "./notice-hold";

/**
 * NOTHING GOES OUT UNTIL HE SAYS.
 *
 * The switch lives inside `sendEmail` and `sendSms` rather than at the call
 * sites, and that is the whole design: a dozen places can write to a renter
 * today and there will be more, and a guard each of them has to remember is a
 * guard the next one forgets.
 *
 * The tests that matter here are about DIRECTION — this gate fails closed
 * where its neighbour fails open — and about the switch actually being in the
 * doorway rather than beside it.
 */

const code = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const EMAIL = code("./email.ts");
const SMS = code("./sms.ts");
const HOLD = code("./notice-hold.ts");

describe("the scanner", () => {
  it("reads the files it thinks it reads", () => {
    expect(EMAIL).toContain("export async function sendEmail");
    expect(SMS).toContain("export async function sendSms");
    expect(HOLD).toContain("export async function recipientIsHeld");
  });
});

describe("what the owner is told when a send is refused", () => {
  it("quotes his own reason back at him", () => {
    expect(holdRefusal({ held: true, reason: "Waiting on the leases.", failed: false }))
      .toBe("Notices are on hold for this park — Waiting on the leases.");
  });

  it("still says where to lift it when no reason was recorded", () => {
    const s = holdRefusal({ held: true, reason: null, failed: false });
    expect(s).toContain("on hold");
    expect(s).toContain("Park setup");
  });

  it("says plainly when we could not TELL, which is a different thing", () => {
    // "On hold" would be a claim about his settings that we did not verify.
    const s = holdRefusal({ held: true, reason: null, failed: true });
    expect(s).toContain("couldn't check");
    expect(s).toContain("nothing was sent");
    expect(s).not.toContain("on hold");
  });
});

describe("it fails CLOSED, unlike the gate beside it", () => {
  /**
   * `recipientIsFixture` fails OPEN because the cost of missing one is an email
   * to a mailbox we invented. The cost of missing one HERE is a real household
   * — somebody who has signed nothing — getting a demand or a one-tap link
   * before anyone is ready. A database blip must never be the reason that
   * happens, and a delayed notice is the recoverable direction.
   */
  it("holds the send when the lookup errors", () => {
    expect(HOLD).toMatch(/if \(error\) \{[\s\S]{0,200}?return \{ held: true, reason: null, failed: true \}/);
  });

  it("holds the send when the lookup throws", () => {
    expect(HOLD).toMatch(/catch[\s\S]{0,220}?return \{ held: true, reason: null, failed: true \}/);
  });

  it("never returns a bare false on a failure path", () => {
    // The neighbour's shape — `return false` in a catch — is the exact thing
    // that must not be copied across.
    const failurePaths = HOLD.slice(HOLD.indexOf("try {"));
    expect(failurePaths).not.toMatch(/console\.(warn|error)[\s\S]{0,120}?return CLEAR/);
  });

  it("says the opposite of recipient-gate on purpose, and both are documented", () => {
    const neighbour = readFileSync(
      fileURLToPath(new URL("./recipient-gate.ts", import.meta.url)), "utf8");
    expect(neighbour).toContain("FAILS OPEN");
    const mine = readFileSync(fileURLToPath(new URL("./notice-hold.ts", import.meta.url)), "utf8");
    expect(mine).toContain("FAILS CLOSED");
  });

  it("is inert with no database, so a unit test is not a blocked send", async () => {
    // Every test in this repo touches code that can send. Failing closed with
    // no Supabase configured would turn that into hundreds of red tests about
    // something else entirely.
    const before = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(await recipientIsHeld("email", "someone@example.com"))
        .toEqual({ held: false, reason: null, failed: false });
    } finally {
      if (before !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = before;
    }
  });

  it("asks nothing for an empty recipient", async () => {
    expect(await recipientIsHeld("email", "")).toEqual({ held: false, reason: null, failed: false });
    expect(await recipientIsHeld("phone", null)).toEqual({ held: false, reason: null, failed: false });
  });
});

describe("the switch is in the doorway, not beside it", () => {
  it("both transports consult it", () => {
    expect(EMAIL).toMatch(/await recipientIsHeld\("email", opts\.to\)/);
    expect(SMS).toMatch(/await recipientIsHeld\("phone", to\)/);
  });

  it("and refuse when it says so", () => {
    expect(EMAIL).toMatch(/if \(hold\.held\)[\s\S]{0,200}?return \{ ok: false, error: holdRefusal\(hold\) \}/);
    expect(SMS).toMatch(/if \(hold\.held\)[\s\S]{0,200}?return \{ queued: false, error: holdRefusal\(hold\) \}/);
  });

  it("consults it BEFORE the network call", () => {
    // A hold checked after the send is not a hold.
    //
    // The two transports reach the wire differently and the marker has to match
    // each: email POSTs a URL, SMS goes through the Twilio SDK. Looking for a
    // twilio URL found nothing, indexOf returned -1, and the test failed
    // against correct code — which is how a check gets deleted rather than
    // fixed.
    for (const [name, src, marker] of [
      ["email", EMAIL, "api.resend.com"],
      ["sms", SMS, "messages.create"],
    ] as const) {
      const gate = src.indexOf("recipientIsHeld");
      const call = src.indexOf(marker);
      expect({ name, gateFound: gate > 0, sendFound: call > 0, before: gate < call })
        .toEqual({ name, gateFound: true, sendFound: true, before: true });
    }
  });

  it("checks BOTH phone columns, so the office number is covered too", () => {
    // A hold covering only the verified mobile would let a text reach exactly
    // the people who never asked to be texted.
    expect(HOLD).toContain("mobile_e164");
    expect(HOLD).toContain("phone_on_file_with_park");
  });

  it("escapes the address before using it as a LIKE pattern", () => {
    // An unescaped `_` in one renter's address would hold another's mail.
    expect(HOLD).toMatch(/ilike\("email", likeLiteral\(/);
  });
});

describe("the hold is visible on every park screen", () => {
  it("ParkNav takes the park, so a new field cannot be forgotten at a call site", () => {
    const nav = code("../components/ParkNav.tsx");
    expect(nav).toMatch(/export function ParkNav\(\{ park \}/);
    expect(nav).not.toMatch(/parkName: string; live: boolean/);
  });

  it("and says so, rather than leaving the product looking broken", () => {
    const nav = code("../components/ParkNav.tsx");
    expect(nav).toContain("park.noticesHeldAt");
    expect(nav).toMatch(/nothing is reaching your households/i);
  });

  it("every park screen passes the whole park", () => {
    // 14 call sites used to spell out two props each. If one reverts, the
    // banner silently stops appearing on that screen.
    const app = fileURLToPath(new URL("../app", import.meta.url));
    const out = execSync(`grep -rn "<ParkNav" ${JSON.stringify(app)} || true`).toString();
    const lines = out.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) expect(l).toContain("park={park}");
  });
});

describe("the migration holds every park from the start", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/0141_nothing_goes_out_until_he_says.sql", import.meta.url)),
    "utf8");

  it("defaults a new park to held", () => {
    // A default is a claim about what is true on day one, and day one is
    // nobody's consent.
    expect(sql).toMatch(/notices_held_at\s+timestamptz default now\(\)/);
  });

  it("backfills the parks that already exist", () => {
    // A default does nothing for rows already there — and the one park in this
    // database is the one whose owner asked for the hold.
    expect(sql).toMatch(/update public\.parks/);
    expect(sql).toMatch(/where notices_held_at is null/);
  });

  it("refuses to apply if any park came out able to send", () => {
    expect(sql).toMatch(/select count\(\*\) into n_unheld from public\.parks where notices_held_at is null/);
    expect(sql).toContain("still able to send notices");
  });
});
