import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * NOTHING REACHES A PARK RENTER UNTIL HE SAYS SO.
 *
 * The owner's standing instruction, 25 August 2026:
 *
 *   "we cannot switch it on till we get everyone loaded in and leases executed.
 *    I dont want any notifications going out until we get them all comfortable."
 *
 * A sweep of every send path found exactly ONE that can address a park renter
 * without him tapping anything: `remindExpiringStays`, step 6 of the nightly
 * cron. It scans `lot_reservations` with no park filter, no `parks.active`
 * check and no cutover check — so The Haven being "off" is irrelevant to it —
 * and it emails AND texts a one-tap link that extends a tenancy and prices it.
 *
 * WHAT IS ACTUALLY HOLDING THAT DOOR SHUT IS AN ACCIDENT. The gate requires
 * `contact_pref === 'sms'`, and NOTHING IN THE CODEBASE EVER WRITES 'sms'.
 * Every writer sets 'paper' or 'email'; the edit builder accepts only
 * 'paper' | 'email' | 'none' and deliberately refuses 'sms'. So the step can
 * reach nobody — not by decision, but because a column has no writer for the
 * one value that would open it.
 *
 * That is this codebase's most-repaired defect class, load-bearing in his
 * favour for once. It is one row update away from live, and `0055` still
 * permits 'sms' in the check constraint. `parks.active` will not save him: it
 * is an inbound visibility flag and gates zero sends.
 *
 * THIS FILE IS THE MEMORY, MADE DURABLE. It does not build a hold — he has not
 * asked for one and the roll is months out, behind the processor, the bank and
 * diligence. It fails loudly the day the accident stops protecting him, and
 * says which sentence to re-read.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every .ts/.tsx under src, minus tests, with comments stripped. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { sourceFiles(p, out); continue; }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    out.push(p);
  }
  return out;
}

const code = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const FILES = sourceFiles();

describe("the scanner", () => {
  it("reads the tree it thinks it reads", () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((f) => f.endsWith("automation.ts"))).toBe(true);
  });

  it("strips comments, so prose about the gate cannot satisfy a test", () => {
    // automation.ts explains this very gate at length, quoting the string.
    const auto = FILES.find((f) => f.endsWith("lib/automation.ts"))!;
    expect(readFileSync(auto, "utf8")).toContain("contact_pref === 'sms'");
    expect(code(auto)).not.toContain("contact_pref === 'sms'");
  });
});

describe("nothing sets a park renter to be texted", () => {
  /** `contact_pref: "sms"` or `contact_pref = "sms"`, in real code. */
  const WRITES_SMS = /contact_pref\s*[:=]\s*["']sms["']/;

  it("no file writes contact_pref = 'sms'", () => {
    const offenders = FILES.filter((f) => WRITES_SMS.test(code(f)))
      .map((f) => f.slice(SRC.length));
    // If this goes red: a park renter can now be enrolled into the nightly
    // extend reminder, which emails AND texts them a one-tap link with nobody
    // approving it. That is the thing he asked not to happen. Before removing
    // this test, build the hold — a per-park column read inside sendEmail and
    // sendSms, so a new call site cannot walk past it.
    expect(offenders).toEqual([]);
  });

  it("the edit builder still refuses 'sms' rather than accepting it", () => {
    const helpers = code(
      FILES.find((f) => f.endsWith("park/park-helpers.ts"))!,
    );
    expect(helpers).toMatch(/pref === "paper" \|\| pref === "email" \|\| pref === "none"/);
    expect(helpers).not.toMatch(/pref === "sms"/);
  });

  it("the writers that do exist all choose a silent default", () => {
    const writes = FILES.flatMap((f) =>
      [...code(f).matchAll(/contact_pref\s*[:=]\s*["'](\w+)["']/g)].map((m) => m[1]),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const v of writes) {
      expect({ value: v, allowed: ["paper", "email", "none"].includes(v) })
        .toEqual({ value: v, allowed: true });
    }
  });
});

describe("the one unattended path still checks the thing that is shut", () => {
  const auto = code(FILES.find((f) => f.endsWith("lib/automation.ts"))!);

  it("remindExpiringStays still requires contact_pref === 'sms'", () => {
    // This is the load-bearing half. Widen or drop this condition — a
    // plausible edit the day A2P clears, or if somebody decides email should
    // not need SMS consent — and the email door opens with it, because the
    // `continue` sits ABOVE the send and suppresses both channels.
    expect(auto).toMatch(/renter\?\.contact_pref !== "sms"/);
  });

  it("and still requires a verified number and recorded consent", () => {
    expect(auto).toMatch(/!renter\?\.mobile_verified_at/);
    expect(auto).toMatch(/!renter\?\.sms_consent_operational_at/);
  });

  it("the gate sits ABOVE the send, so failing it suppresses the email too", () => {
    const gate = auto.indexOf('renter?.contact_pref !== "sms"');
    const send = auto.indexOf("notify(", gate);
    expect(gate).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(gate);
  });
});

describe("what the owner is told about being 'switched on'", () => {
  it("parks.active is never read by a send path", () => {
    /**
     * It is an INBOUND visibility flag — who may see the park page, who may
     * apply. It gates no outbound message, so "the park isn't live" is not a
     * promise of silence and no screen should imply it is.
     *
     * SCOPED TO THE `parks` TABLE, because `.eq("active", true)` is everywhere
     * and means something different each time. The first version looked for
     * that string anywhere in a sending file and went red on park_fees,
     * services and autopilot_enrollments — three filters with nothing to do
     * with whether a park is switched on.
     *
     * AND SCOPED TO THE SELECT LIST, not to "everything up to the next
     * semicolon". The second version did that and still went red, on a
     * `from("parks").select("name")` that sits inside a Promise.all — the
     * statement ends with a COMMA, so the match ran on into the next query and
     * found an `active` belonging to a different table. A test that fails on
     * correct code is a test somebody deletes.
     */
    const senders = FILES.filter((f) => /\bsendEmail\(|\bsendSms\(/.test(code(f)));
    expect(senders.length).toBeGreaterThan(3);
    for (const f of senders) {
      const selects = [...code(f).matchAll(/from\("parks"\)\s*\.select\(\s*"([^"]*)"/g)]
        .map((m) => m[1]);
      const gatesOnActive = selects.some((s) => /\bactive\b/.test(s));
      expect({ file: f.slice(SRC.length), gatesOnActive })
        .toEqual({ file: f.slice(SRC.length), gatesOnActive: false });
    }
  });
});
