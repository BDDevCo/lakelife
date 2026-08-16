import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  phoneRefusal, mayEmail, maySms,
  fixtureEmail, fixturePhone,
} from "@/lib/contactable";

/**
 * THE GATE IS JUDGED ON TWO THINGS AND THEY PULL IN OPPOSITE DIRECTIONS:
 * it must refuse everything that could reach a stranger, and it must not
 * refuse a single real customer. A gate that fails the first is the bug it
 * was built for; a gate that fails the second silently swallows receipts and
 * nobody finds out until somebody complains they never got one.
 */

// ---------------------------------------------------------------------------
// THE REAL DATA. These are the actual rows in production on 15 Aug 2026 — one
// real person and five fixtures. If this gate does not sort THESE correctly it
// does not matter what else it does.
// ---------------------------------------------------------------------------
describe("the accounts that actually exist", () => {
  it("lets the one real person through, on both channels", () => {
    expect(mayEmail("brendonlochert@gmail.com")).toBe(true);
    expect(maySms("+16024102269")).toBe(true);
  });

  const fixturePhones = [
    ["vendor-test", "+12605551212"],       // directory assistance
    ["owner-forvendor", "+12605551213"],
    ["ops", "+12605551213"],
    ["newcrew", "+12605550000"],
  ];
  it.each(fixturePhones)("refuses the fixture number for %s (%s)", (_who, num) => {
    expect(maySms(num)).toBe(false);
    expect(phoneRefusal(num)?.code).toBe("reserved-number");
  });

  it("does NOT refuse a lakelife.ai address, because that domain is real", () => {
    // The fixture EMAILS sit on a domain Brendon owns. Mail to them lands in
    // his own estate — it cannot reach a stranger, which is the harm this gate
    // exists to prevent. Blocking them would be the gate exceeding its remit
    // and would take real staff addresses down with it.
    expect(mayEmail("ops@lakelife.ai")).toBe(true);
    expect(mayEmail("vendor-test@lakelife.ai")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("email: what must never be written to", () => {
  const refuse: Array<[string, string | null | undefined]> = [
    ["RFC 2606 example.com", "someone@example.com"],
    ["example.net", "someone@example.net"],
    ["example.org", "someone@example.org"],
    ["the transport's own sandbox", "x@resend.dev"],
    [".test TLD", "a@anything.test"],
    [".invalid TLD", "a@anything.invalid"],
    [".localhost TLD", "a@anything.localhost"],
    [".local TLD", "a@anything.local"],
    ["subdomain of a reserved TLD", "a@mail.corp.invalid"],
    ["uppercase reserved domain", "A@EXAMPLE.COM"],
    ["padded reserved domain", "  a@example.com  "],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["no @", "not-an-address"],
    ["nothing before the @", "@example.org"],
    ["nothing after the @", "someone@"],
    ["a bare domain with no dot", "someone@localhost"],
    ["a space inside", "some one@gmail.com"],
  ];
  it.each(refuse)("refuses %s", (_label, addr) => {
    expect(mayEmail(addr as string)).toBe(false);
  });

  const allow = [
    "brendonlochert@gmail.com",
    "ops@lakelife.ai",
    "someone@wolcottville-marine.com",
    "first.last+tag@outlook.co.uk",
    "a@b.co",
    "CAPS@Gmail.Com",
    // Real people have strange addresses. None of these is our business.
    "o'brien@example-marine.com",
    "münchen@xn--mnchen-3ya.de",
  ];
  it.each(allow)("allows %s", (addr) => {
    expect(mayEmail(addr), `${addr} is a deliverable address`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("sms: what must never be dialled", () => {
  it("refuses the whole 555 exchange, not just the reserved block", () => {
    // NANP reserves 555-0100..0199 for fiction, and the fixtures here use
    // 5551212, 5551213 and 5550000 — none inside that block. A rule covering
    // only the reserved range would have looked rigorous and caught nothing.
    expect(maySms("+12605550100")).toBe(false); // inside the reserved block
    expect(maySms("+12605551212")).toBe(false); // directory assistance
    expect(maySms("+12605550000")).toBe(false); // outside the block entirely
    expect(maySms("+15745559999")).toBe(false); // different area code, same rule
  });

  it("matches on the last ten digits, so formatting cannot smuggle one past", () => {
    for (const n of ["+1 260 555 1212", "(260) 555-1212", "260-555-1212", "12605551212", "2605551212"]) {
      expect(maySms(n), `${n} is the same number`).toBe(false);
    }
  });

  const refuse: Array<[string, string | null | undefined]> = [
    ["empty", ""],
    ["null", null],
    ["too short", "555"],
    ["a word", "call me"],
    ["area code 000", "+10005551234"],
    ["area code 999", "+19992001234"],
    ["exchange 000", "+12600001234"],
  ];
  it.each(refuse)("refuses %s", (_label, num) => {
    expect(maySms(num as string)).toBe(false);
  });

  const allow = [
    "+16024102269",       // the real one
    "+12605551213".replace("555", "463"),  // same shape, real exchange
    "+15745551234".replace("555", "268"),
    "+442071838750",      // an international number is not our business
  ];
  it.each(allow)("allows %s", (num) => {
    expect(maySms(num)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the fixture space is unreachable by construction", () => {
  it("every address the helpers mint is refused by the gate", () => {
    for (const who of ["owner", "crew", "guest", "renter"]) {
      expect(mayEmail(fixtureEmail(who))).toBe(false);
    }
    for (let n = 0; n < 100; n++) {
      expect(maySms(fixturePhone(n))).toBe(false);
    }
  });

  it("and the minted phones sit inside NANP's reserved fiction block", () => {
    // Belt and braces: even if the 555-exchange rule were ever narrowed to the
    // strictly reserved range, these would still be refused.
    for (let n = 0; n < 100; n++) {
      const last4 = Number(fixturePhone(n).slice(-4));
      expect(last4).toBeGreaterThanOrEqual(100);
      expect(last4).toBeLessThanOrEqual(199);
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * The gate is worthless if a sender skips it. Both doors are checked in source,
 * because the failure is a call site that FORGOT — and there is no behavioural
 * test for a check nobody wrote. Comments stripped: a scan that reads prose
 * fails on the sentence describing the rule.
 */
describe("both doors call the gate before they send", () => {
  const code = (p: string) =>
    readFileSync(join(process.cwd(), "src", p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("sendSms refuses before it reaches Twilio", () => {
    const src = code("lib/sms.ts");
    expect(src).toMatch(/phoneRefusal/);
    expect(src.indexOf("phoneRefusal")).toBeLessThan(src.indexOf("messages.create"));
  });

  it("sendEmail refuses before it reaches Resend", () => {
    const src = code("lib/email.ts");
    expect(src).toMatch(/emailRefusal/);
    expect(src.indexOf("emailRefusal")).toBeLessThan(src.indexOf("api.resend.com"));
  });

  it("and before the sender is even resolved, which is a separate question", () => {
    const src = code("lib/email.ts");
    expect(src.indexOf("emailRefusal")).toBeLessThan(src.indexOf("EMAIL_FROM"));
  });

  it("both senders also ask the ROW, not just the string (0126)", () => {
    // The shape gate cannot see a fixture wearing jane.doe@gmail.com. If this
    // ever disappears, the column exists with nothing reading it — the single
    // most common bug in this codebase.
    expect(code("lib/email.ts")).toMatch(/recipientIsFixture/);
    expect(code("lib/sms.ts")).toMatch(/recipientIsFixture/);
  });

  it("NO CALLER SILENTLY DISCARDS A SEND THAT CAN NOW BE REFUSED", () => {
    // `void sendEmail(...)` was harmless while the only failure was a
    // transport error. Once the send could be REFUSED, two callers turned
    // that into a lie on screen: the crew importer counted a refused address
    // as "invited", and the crew invite said "Invite sent". Both awaited now.
    for (const f of ["app/vendor/import-actions.ts", "app/ops/crews-invite.ts"]) {
      expect(code(f), `${f} must not fire-and-forget a refusable send`)
        .not.toMatch(/void\s+sendEmail\(/);
    }
  });

  it("and the importer reports who was never written to", () => {
    // Counted separately from `invited`, because a staged customer nobody
    // emailed cannot claim their account — and a retry says "already
    // invited", so this is the crew's only chance to learn it.
    expect(code("app/vendor/import-actions.ts")).toMatch(/notEmailed/);
    expect(code("components/VendorImport.tsx")).toMatch(/notEmailed/);
  });

  it("sendSms checks the recipient BEFORE the credentials", () => {
    // Not cosmetic. Behind the config check, the rule could only be proven by
    // running with live Twilio credentials — i.e. by risking the exact send it
    // exists to prevent. In front of it, the behavioural test below runs with
    // no credentials at all.
    const src = code("lib/sms.ts");
    expect(src.indexOf("phoneRefusal")).toBeLessThan(src.indexOf("TWILIO_ACCOUNT_SID"));
  });
});

/**
 * THE REAL FUNCTION, NOT A MODEL OF IT. sms.ts has no `server-only` import, so
 * the actual sender runs here. With no Twilio credentials in the environment a
 * refusal must still be a REFUSAL — naming the recipient as the reason — and
 * not the generic "not configured", because those two mean different things to
 * whoever reads the log afterwards.
 */
describe("sendSms, actually called", () => {
  it("refuses a fixture number by reason, with no credentials present", async () => {
    const { sendSms } = await import("@/lib/sms");
    const res = await sendSms("+12605551212", "this must never leave the process");
    expect(res.queued).toBe(false);
    expect(res.error).toContain("unsendable recipient");
    expect(res.error).toContain("reserved-number");
    expect(res.error).not.toContain("not configured");
  });

  it("and a real-shaped number gets past the gate to fail on configuration instead", async () => {
    const { sendSms } = await import("@/lib/sms");
    // DELIBERATELY NOT BRENDON'S ACTUAL NUMBER, though it is right there in
    // the fixture list above and would have proved the same point. This test
    // passes today only because vitest does not load .env.local; the day
    // somebody wires env into the test config, a test holding a real number
    // sends a real text. A real EXCHANGE (260-463, Wolcottville) with an
    // invented line proves the gate opens without ever addressing a person.
    const res = await sendSms("+12604631234", "still sends nothing — no credentials here");
    expect(res.queued).toBe(false);
    // Past the recipient gate, stopped by the absent transport. That is the
    // proof the gate is not simply refusing everything.
    expect(res.error).toBe("SMS not configured");
  });
});

/**
 * THE ROW GATE FAILS OPEN, AND THAT HAS TO BE TRUE UNDER TEST TOO.
 *
 * With no database configured it must return false — "no evidence" — so the
 * send proceeds. The alternative is that an unreachable database silences
 * every receipt, confirmation and dispatch text at once. It is safe because
 * the shape gate has already run and cannot fail open: it is pure.
 */
describe("recipientIsFixture with no database", () => {
  it("allows rather than blocks, on both kinds", async () => {
    const { recipientIsFixture } = await import("@/lib/recipient-gate");
    expect(await recipientIsFixture("email", "someone@gmail.com")).toBe(false);
    expect(await recipientIsFixture("phone", "+12604631234")).toBe(false);
  });

  it("and treats an empty value as nothing to look up", async () => {
    const { recipientIsFixture } = await import("@/lib/recipient-gate");
    expect(await recipientIsFixture("email", "")).toBe(false);
    expect(await recipientIsFixture("email", null)).toBe(false);
    expect(await recipientIsFixture("phone", undefined)).toBe(false);
  });

  it("escapes the address before it becomes a LIKE pattern", async () => {
    // users.email is case-uncertain (synced from auth) so the lookup must be
    // ilike — which makes the address a PATTERN. Unescaped, `_` is a wildcard
    // and one fixture's flag could suppress a real customer's mail. This is
    // the same class d5fe0d9 fixed nine times over.
    const src = readFileSync(join(process.cwd(), "src/lib/recipient-gate.ts"), "utf8");
    expect(src).toMatch(/likeLiteral/);
    expect(src).toMatch(/\.ilike\("email", likeLiteral/);
    // The phone side must NOT be a pattern at all — we write that column.
    expect(src).toMatch(/\.eq\("phone"/);
  });
});
