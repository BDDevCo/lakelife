import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE TWIN MY OWN FIX LEFT BEHIND.
 *
 * Commit 02fc933 fixed the single-service booking email: it said "You're
 * booked" whether or not a crew had been found, while the SMS beside it
 * branched honestly on `soloAssigned`. The storage booking in this directory
 * has the identical defect and was not touched.
 *
 *   SMS   (line ~264): assigned ? "is booked for {date}"
 *                    : "We're lining up the right crew now (storage needs the
 *                       right barn and insurance)…"
 *   EMAIL (line ~274): subject always "Booked: {package}", body always
 *                      "<h2>Winter's handled.</h2>"
 *
 * `assigned` is in scope at both. The function even RETURNS `findingCrew:
 * !assigned` so the screen can branch — and the screen does. Three doorways,
 * two honest, and the dishonest one is the only one the customer still has
 * tomorrow morning.
 *
 * IT IS LATENT, NOT LIVE, and that is worth stating plainly: `service_packages`
 * holds no active rows, so the storage wizard never mounts and this action
 * refuses before it sends. One skeptic refuted the finding on exactly that
 * ground. It fires on the first package switched active — and since every crew
 * in production is still a fixture, `assigned` would be false for every
 * storage booking made that day.
 *
 * AND THESE TWO SENDS CONSULT NO NOTIFICATION SWITCH. The sibling wraps both
 * in `allowsNotification(user.id, "book", …)`. A customer who turned booking
 * texts off still gets one from here.
 */
const src = (() => {
  const raw = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
})();

const emailBlock = (() => {
  const i = src.indexOf("to: me.email,");
  return i < 0 ? "" : src.slice(i, i + 1800);
})();

describe("the scanner is reading the storage confirmation", () => {
  it("found the action, its assignment fact and its email", () => {
    expect(src).toMatch(/createPackageBooking/);
    expect(src, "the `assigned` fact is gone").toMatch(/\bassigned\b/);
    expect(emailBlock.length, "the confirmation email was not found").toBeGreaterThan(400);
  });
});

describe("it does not tell somebody winter is handled when no crew exists", () => {
  it("branches the email on whether a crew was actually assigned", () => {
    expect(emailBlock, "the email still ignores `assigned` while the SMS branches on it")
      .toMatch(/assigned/);
  });

  it("no longer opens with a flat 'Winter's handled'", () => {
    expect(emailBlock).not.toMatch(/<h2>Winter&apos;s handled\.<\/h2>|<h2>Winter's handled\.<\/h2>/);
  });

  it("says a crew is still being found, in the words the SMS already uses", () => {
    // The SMS names WHY storage is harder to staff — the right barn and
    // insurance. The email should not be vaguer than the text about the same
    // fact.
    expect(emailBlock).toMatch(/lining up|still .{0,20}crew|finding/i);
    expect(emailBlock).toMatch(/barn|insur/i);
  });

  it("does not promise a booking in the subject either", () => {
    // "Booked:" in a subject line is the same claim, read first and in bold.
    const subject = src.match(/subject:[\s\S]{0,220}?,\n/)?.[0] ?? "";
    expect(subject, "the subject block was not found").not.toBe("");
    expect(subject, "the subject says Booked regardless of whether it is")
      .toMatch(/assigned/);
  });

  it("keeps what is true either way", () => {
    expect(emailBlock).toMatch(/charged after|never charged/i);
  });
});

describe("it respects the switches the rest of the product respects", () => {
  it("consults the booking preference before texting", () => {
    expect(src, "the storage SMS ignores the customer's notification settings")
      .toMatch(/allowsNotification\([^)]*"book",\s*"sms"\)/);
  });

  it("consults it before emailing", () => {
    expect(src, "the storage email ignores the customer's notification settings")
      .toMatch(/allowsNotification\([^)]*"book",\s*"email"\)/);
  });
});
