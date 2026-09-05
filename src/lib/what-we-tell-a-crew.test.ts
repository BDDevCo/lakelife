import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FIRST THING A CREW EVER READS FROM US IS AN EMAIL, AND IT PROMISED TWO
 * THINGS THAT DO NOT HAPPEN.
 *
 * "your day's stops arrive by text, in drive order, and payouts release the
 * moment a job is photo-verified complete."
 *
 * Text has delivered NOTHING since 19 July — 0 of 81 — because the A2P
 * registration was rejected twice and the EIN is too new. And `notify()` sends
 * by both doors at once, so the route link a crew actually receives comes by
 * EMAIL. Naming only the dead channel is not a small inaccuracy: it tells a
 * stranger to watch their phone for the one thing that decides whether they
 * make money that day, and nothing arrives there.
 *
 * This is the whole reason it matters NOW. The owner's directive is to onboard
 * crews to service The Haven, and every one of them starts here. Production
 * holds three vendors and all three are fixtures — so no real person has ever
 * read this sentence, and none has to.
 *
 * SCANNED, NOT ASSERTED IN A BEHAVIOUR TEST, because the failure is a sentence.
 * There is no runtime check that catches copy, and the same sentence was
 * already living in two files — the fix has to be the class, not the instance.
 */

const read = (rel: string) =>
  stripComments(readFileSync(join(process.cwd(), "src", rel), "utf8"));

/** Comments describe intent; only the strings that ship count. The paragraph
 *  above quotes the removed sentence, and so does each fix's own note. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every place we write to a crew who has not joined yet. */
const INVITES = [
  { file: "app/ops/crews-invite.ts", who: "ops invites a crew" },
  { file: "app/book/contractor-actions.ts", who: "a homeowner invites their own contractor" },
] as const;

describe("the scanner is looking at the right files", () => {
  for (const { file, who } of INVITES) {
    it(`${file} still sends an invitation (${who})`, () => {
      const src = read(file);
      expect(src, "no sendEmail here any more — this scan is measuring nothing")
        .toMatch(/sendEmail\(/);
      expect(src, "the invite no longer names the three steps").toMatch(/COI/);
    });
  }
});

describe("we never name the channel that delivers nothing", () => {
  /**
   * The rule is not "never say text" — it is never to say text ALONE. The day
   * A2P clears, a crew genuinely does get their stops by text, and this test
   * keeps passing because the honest sentence already names both doors, which
   * is what `notify()` has always done.
   */
  const TEXT_ONLY = /\bby text\b(?![^.]*\bemail\b)/i;

  for (const { file, who } of INVITES) {
    it(`${file} — ${who}`, () => {
      expect(
        read(file),
        `This invitation tells a crew their work arrives "by text" without ` +
          `naming email. SMS has delivered 0 of 81 since July; notify() sends ` +
          `both, and email is the one that lands.`,
      ).not.toMatch(TEXT_ONLY);
    });
  }

  it("the routes screen doesn't tell ops the same thing", () => {
    // Ops is him. The toast on this screen was corrected once — "texted" became
    // "notified" — and the standing paragraph four lines below it still said
    // every crew gets their map link by text. Fixing the instance and leaving
    // the sentence beside it is how this class survives.
    expect(read("components/ops/RouteBuilder.tsx")).not.toMatch(TEXT_ONLY);
  });
});

describe("we don't promise money on a clock we don't control", () => {
  /**
   * "payouts release the moment a job is photo-verified complete."
   *
   * A payout ROW is released on photo verification — that part is real and it
   * is the crew's actual protection. The money moves in a batch, and today it
   * cannot move at all: `LAKELIFE_PAYMENTS_LIVE` is unset, so charge-gate.ts
   * declines every charge and refund. "The moment" is a promise about timing
   * made to somebody deciding whether to work for us.
   */
  for (const { file } of INVITES) {
    it(`${file} doesn't say a payout lands "the moment" anything happens`, () => {
      expect(
        read(file),
        `An invitation promises a payout releases "the moment" a job is done. ` +
          `Money cannot move until the processor is live. Describe what photo ` +
          `verification DOES — it releases the payout — without dating it.`,
      ).not.toMatch(/payouts? releases? the moment/i);
    });
  }
});

describe("an invitation IS the email, so a refused send may never read as sent", () => {
  /**
   * THE SAME BUG, THE SECOND DOORWAY.
   *
   * crews-invite.ts carries a paragraph explaining why its send stopped being
   * `void`ed at 0126: the crew row is unreachable until somebody signs in with
   * that address, so a refused send leaves an invite nobody can claim — and the
   * row then blocks the retry, because both invite paths refuse a duplicate
   * open invite ("There's already an open invite out to that email").
   *
   * That paragraph was written in one file. The other one still `void`ed it,
   * and its caller returned `ok: true` — so a homeowner whose crew never got
   * the mail is told it was sent, and can never send it again.
   */
  for (const { file } of INVITES) {
    it(`${file} waits for the send and reports it`, () => {
      const src = read(file);
      expect(
        src,
        `The invitation email is fired and forgotten. A refused send leaves a ` +
          `vendors row nobody can claim, and the duplicate-invite guard makes ` +
          `the retry impossible. Await it and say so.`,
      ).not.toMatch(/void\s+sendEmail\(/);
      // Bound to a name, or returned to a caller that binds it. What must never
      // happen is the result going nowhere.
      expect(src, "the send result is never looked at")
        .toMatch(/(const|let)\s+\w+\s*=\s*await send(Email|Invitation)\(|return sendEmail\(/);
    });
  }

  it("and both of them refuse a duplicate open invite — which is what makes the above matter", () => {
    for (const { file } of INVITES) {
      expect(read(file), `${file} no longer guards duplicate invites`)
        .toMatch(/open invite/i);
    }
  });
});

describe("an invite that never arrived can be told apart, and sent again", () => {
  /**
   * THE INVITATION IS THE EMAIL, AND THERE WAS NO RECORD THAT IT WENT.
   *
   * `inviteCrew` inserts an unclaimed vendors row and mails a join link. The
   * row is unreachable until somebody signs in with that exact address, so a
   * refused send — a bounce, a typo'd domain, a fixture recipient, Resend down
   * — leaves an invite nobody can claim.
   *
   * The only place that was ever said is a toast, and Toast.tsx clears it after
   * 3800ms. After that, a bounced invite, a spam-foldered invite and one
   * somebody simply hasn't opened all render identically on the Crews board:
   * "Invited — waiting on documents and approval", "hasn't signed up yet".
   *
   * And it could not be sent again: `inviteCrew` refuses a duplicate open
   * invite, which is correct and is exactly what makes the missing resend a
   * dead end. The only recovery was a database edit — on the board that exists
   * to onboard crews, in the month he starts onboarding crews.
   *
   * 0154 adds invite_sent_at (NULL = never left our hands) and invite_error
   * (the last refusal, verbatim), plus the resend that acts on them.
   */
  const invite = read("app/ops/crews-invite.ts");
  const board = read("components/ops/CrewBoard.tsx");
  const data = read("app/ops/crews-data.ts");

  it("records WHEN a send actually succeeded", () => {
    expect(invite, "nothing writes invite_sent_at, so the board cannot date an invite")
      .toMatch(/invite_sent_at/);
  });

  it("and keeps the refusal, rather than only flashing it in a toast", () => {
    expect(invite, "a failed send leaves no trace once the toast clears")
      .toMatch(/invite_error/);
  });

  it("offers a resend, which is the whole point of knowing", () => {
    expect(invite).toMatch(/export async function resendCrewInvite/);
    const fn = invite.match(/export async function resendCrewInvite[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "resendCrewInvite not found — this scan is measuring nothing").not.toBe("");
    expect(fn, "an ops action that does not assert ops").toMatch(/assertOps\(\)/);
    expect(fn, "a resend must only ever go to a still-open invite").toMatch(/is\("user_id", null\)/);
  });

  it("builds ONE invitation, so the resend cannot drift from the first send", () => {
    // Two copies of this email would be two sets of promises to keep true, and
    // the copy fixes above would have to be made twice.
    expect(invite).toMatch(/function sendInvitation/);
    expect(
      (invite.match(/stops come to you in drive order/g) ?? []).length,
      "the invitation body appears more than once — the resend will drift",
    ).toBe(1);
  });

  it("the board reads both columns, or the resend has nothing to act on", () => {
    const select = data.match(/"id, company, status, invite_email[^"]*"/)?.[0] ?? "";
    expect(select, "the crews select is gone — this scan is stale").not.toBe("");
    expect(select, "a card that cannot say whether the invite ever left")
      .toMatch(/invite_sent_at/);
    expect(select).toMatch(/invite_error/);
  });

  it("and the card actually says which of the three states it is in", () => {
    expect(board).toMatch(/resendCrewInvite\(/);
    expect(board, "the board never distinguishes 'never sent' from 'sent and quiet'")
      .toMatch(/inviteSentAt/);
  });
});
