import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THREE MORE FROM THE CUSTOMER-COPY SWEEP, all confirmed 3/3 by adversarial
 * verification before being fixed.
 *
 * 1. "PHOTOS ARE IN YOUR PROPERTY LOG." There is no property log. Every
 *    completion message — the first sentence a homeowner reads after the
 *    work — sent them to a screen with no route. The photos are on the job
 *    page, which is now named and linked.
 *
 * 2. "NOTHING ELSE IS NEEDED FROM YOU" — EMAILED EVERY NIGHT. settleJob runs
 *    nightly over every unpaid invoice, and the no-card / declined notice had
 *    no memory of having been sent. Now stamped (0165) and repeated weekly at
 *    most; ops is untouched because the digest carries a count, not an alarm.
 *
 * 3. THE REFUSED DAYS PRINTED TWICE. `refusalLines` already writes
 *    "Tue, Thu: that day filled up"; the email prefixed it with "We couldn't
 *    book Tue, Thu:" — so the customer read the same dates twice, back to back.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("1. the completion message names a page that exists", () => {
  const src = strip(read("../app/vendor/actions.ts"));
  const done = src.slice(src.indexOf("their service is done and their photos are up"));

  it("no longer sends anybody to a property log", () => {
    expect(done.slice(0, 1500), "still names the property log").not.toMatch(/property log/);
  });

  it("links the job page instead, in both the text and the email", () => {
    const links = done.slice(0, 1500).match(/\/requests\/\$\{jobId\}/g) ?? [];
    expect(links.length, "the job page is not linked from both channels").toBeGreaterThanOrEqual(2);
  });

  it("keeps the 👍/👎 links beside it", () => {
    expect(done.slice(0, 1500)).toMatch(/confirmLinks/);
    expect(done.slice(0, 1500)).toMatch(/confirmLines/);
  });
});

describe("2. the unpaid-invoice notice is sent once, then weekly", () => {
  const src = strip(read("./automation.ts"));
  const fn = src.slice(src.indexOf("async function noteSettleFailure"), src.indexOf("async function noteSettleFailure") + 4000);

  it("reads the stamp before deciding to email", () => {
    expect(fn, "no stamp is read — the notice goes out every night").toMatch(/settle_notice_sent_at/);
    expect(fn).toMatch(/dueAgain/);
  });

  it("gates the CUSTOMER email on it, and not the ops note", () => {
    // The customer branch is behind the stamp; the ops branch further down
    // must not be — a completed job nobody has paid for should keep showing.
    expect(fn).toMatch(/if \(f\.ownerId && dueAgain\)/);
    // Anchored on CODE. The first version anchored on the comment "Ops needs
    // to know", which strip() removes — so the slice was one character long
    // and the absence check passed against nothing.
    const opsAt = fn.indexOf("opsUsers");
    expect(opsAt, "the ops branch is gone").toBeGreaterThan(0);
    const opsPart = fn.slice(opsAt - 200, opsAt + 600);
    expect(opsPart.length).toBeGreaterThan(500);
    expect(opsPart, "the ops notice was gated on the customer stamp").not.toMatch(/dueAgain/);
  });

  it("stamps AFTER the send, not before", () => {
    // A send that threw must be retried tomorrow, not recorded as told.
    const sendAt = fn.indexOf("await sendEmail({");
    const stampAt = fn.indexOf("settle_notice_sent_at: new Date()");
    expect(sendAt).toBeGreaterThan(0);
    expect(stampAt, "the stamp is written before the email is sent").toBeGreaterThan(sendAt);
  });

  it("repeats weekly, not never — an unpaid job still deserves a nudge", () => {
    expect(src).toMatch(/SETTLE_NOTICE_EVERY_DAYS\s*=\s*7\b/);
  });

  it("has a column to stamp — migration 0165 exists on disk", () => {
    const mig = read("../../supabase/migrations/0165_told_once_that_the_card_said_no.sql");
    expect(mig).toMatch(/add column if not exists settle_notice_sent_at timestamptz/);
  });
});

describe("3. the refused days are listed once", () => {
  const src = strip(read("../app/book/actions.ts"));
  const email = src.slice(src.indexOf("to: me.email,"));

  it("does not prefix the lines with the same dates they already carry", () => {
    expect(email, "the dates still print twice").not.toMatch(/We couldn't book \$\{prettyDateList\(refused/);
  });

  it("renders each refusal as its own line", () => {
    expect(email).toMatch(/copy\.lines\.map\(\(l\) => html`<li>\$\{l\}<\/li>`\)/);
  });

  it("still tells them they can pick those days again", () => {
    expect(email).toMatch(/Pick those days again anytime/);
  });
});
