import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE FIRST EMAIL A CUSTOMER GETS AFTER SPENDING MONEY, AND IT SAYS TWO
 * THINGS THAT ARE NOT TRUE.
 *
 * 1. "YOU'RE BOOKED" WHETHER OR NOT ANYBODY IS COMING. `createBookingBatch`
 *    calls `autoAssignJob` and keeps the answer in `soloAssigned`. The TEXT
 *    branches on it honestly:
 *
 *      assigned  -> "is booked for Friday. We'll text you when a crew is on
 *                    the way."
 *      unassigned-> "got it — ... We're lining up a crew now and you'll hear
 *                    the moment one's locked in."
 *
 *    The EMAIL, twenty lines below, is built in the same function with the
 *    same variable in scope, and says "You're booked." to both. A customer who
 *    reads the email and not the text believes a crew is coming on Friday when
 *    none has been found. That is the rule in one doorway of two, on the money
 *    path, in the message most likely to be read on a laptop.
 *
 * 2. IT GREETS THEM BY THEIR STREET ADDRESS. `<h2>You're booked,
 *    ${profile.address ?? "friend"}.</h2>` renders "You're booked, 1414 E Lane
 *    Rd." The `users` row this function already loads does not even select
 *    `name`, so the email could not say it. A person's address is not their
 *    name, and reading it in the greeting slot is the tell that nobody has
 *    opened this email.
 *
 * Scanned rather than executed: `createBookingBatch` is a server action
 * needing a session, a profile, a live service and an assignment engine. What
 * can break is the SHAPE — a branch dropped, or a greeting reading a column
 * that is not a name.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const src = strip(read("./actions.ts"));

/**
 * The email body, bounded — never the SMS above it, which was always right.
 *
 * Anchored on the sendEmail call rather than on the subject line: the first
 * version of this scan keyed on the literal `subject: solo ?`, which is
 * exactly the text the fix had to change, so the scanner lost the body the
 * moment the defect was fixed and every assertion started failing for the
 * wrong reason.
 */
const emailBody = (() => {
  const i = src.indexOf("to: me.email,");
  return i < 0 ? "" : src.slice(i, i + 3000);
})();

describe("the scanner is reading the booking confirmation", () => {
  it("found the function and its email", () => {
    expect(src, "createBookingBatch is gone or renamed").toMatch(/createBookingBatch/);
    expect(emailBody.length, "the confirmation email body was not found").toBeGreaterThan(500);
    expect(emailBody).toMatch(/sendEmail|html`/);
  });

  it("found the assignment fact the text already uses", () => {
    expect(src, "soloAssigned is gone — the SMS branch it feeds may have gone too")
      .toMatch(/soloAssigned/);
  });
});

describe("it does not promise a crew nobody has found", () => {
  it("branches the email on whether a crew was actually assigned", () => {
    // The whole defect: the variable is in scope here and was unread.
    expect(emailBody, "the email ignores soloAssigned while the SMS branches on it")
      .toMatch(/soloAssigned/);
  });

  it("no longer opens with a flat 'You're booked'", () => {
    // The unconditional headline. Whatever replaces it must not assert the
    // booking is settled for a job with no crew.
    expect(emailBody).not.toMatch(/You&apos;re booked,|You're booked,/);
  });

  it("says out loud that a crew is still being found", () => {
    // The honest half has to actually appear, or this is only a deletion.
    expect(emailBody).toMatch(/lining up|looking for|find(ing)? (you )?a crew|not .{0,20}crew yet/i);
  });

  it("keeps the promise that is true either way", () => {
    // "You're only charged after the service is completed" holds in both
    // branches and must survive.
    expect(emailBody).toMatch(/only charged after|never charged until/i);
  });
});

describe("it calls the customer by their name, not their address", () => {
  it("does not greet a person with a street address", () => {
    expect(emailBody, "the greeting still reads the property address")
      .not.toMatch(/\$\{profile\.address\s*\?\?\s*"friend"\}/);
  });

  it("loads a name to greet them with", () => {
    // The `users` select in this action did not carry `name`, so the email
    // had nothing else to use. A greeting cannot be fixed without it.
    const meSelect = src.match(/\.from\("users"\)\s*\.select\("(email_verified[^"]*)"\)/);
    expect(meSelect, "the account lookup is gone or renamed").toBeTruthy();
    expect(meSelect![1], "the booking action still does not load the customer's name")
      .toMatch(/\bname\b/);
  });

  it("still has something to say when we have no name on file", () => {
    // Plenty of accounts have no name yet. The fallback must be a word a
    // person can be called, not an empty greeting or "null".
    expect(emailBody).toMatch(/\?\?\s*"(friend|there)"/);
  });
});
