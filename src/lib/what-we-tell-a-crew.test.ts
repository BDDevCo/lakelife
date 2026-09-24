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
  // THE THIRD DOOR, and the reason the guard below is shared rather than copied.
  { file: "app/park/crew-actions.ts", who: "a park invites a crew — so Josh can be invited from the Parks portal" },
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

  /**
   * THE GUARD WAS THE INSTANCE, SO THE CLASS WALKED STRAIGHT BACK IN.
   *
   * The regex above pins one phrasing. A later package added "Released pay
   * goes out in the month-end batch" to BOTH invitations — a different
   * sentence making the identical promise, and it sailed past a test written
   * against its own rule. Widened to the thing that is actually forbidden: a
   * WHEN. `LAKELIFE_PAYMENTS_LIVE` is unset, ACH is still blocked on the
   * processor, and 0 of 81 texts have delivered since July — we control none
   * of the clocks an invitation could name.
   *
   * What a crew may be told is unchanged and is the whole truth they need:
   * photo-verifying a job releases the payout, and a payout goes to the bank
   * account on file. Neither dates anything.
   */
  const NAMES_A_PAYOUT_CLOCK =
    /(month-?end|end of (the )?month|same day|next day|within \d|in \d+ (business )?days?|weekly|fortnight|every (friday|monday|week|month)|by (friday|monday|the \d))[^.]{0,60}(pay|payout|batch|transfer|deposit)|(pay|payout|batch|transfer|deposit)[^.]{0,60}(month-?end|end of (the )?month|same day|next day|within \d|in \d+ (business )?days?|weekly|every (friday|monday|week|month))/i;

  for (const { file } of INVITES) {
    it(`${file} names no date, batch or cadence for the money`, () => {
      expect(
        read(file),
        `This invitation tells a crew WHEN their money moves. Nothing here ` +
          `controls that clock — payments are not live, ACH is blocked on the ` +
          `processor, and a crew who joins on a promised cadence and doesn't ` +
          `get it is the most expensive kind of unhappy. Say what photo ` +
          `verification does, and that a payout needs a bank account on file.`,
      ).not.toMatch(NAMES_A_PAYOUT_CLOCK);
    });
  }

  it("the widened guard would have caught the sentence that got past the narrow one", () => {
    // NON-VACUITY, PINNED. If NAMES_A_PAYOUT_CLOCK is ever loosened back to
    // something this string slips through, this fails — the test cannot be
    // reduced to "it matches nothing".
    expect("Released pay goes out in the month-end batch, to the bank account you give us.")
      .toMatch(NAMES_A_PAYOUT_CLOCK);
    // And the sentence we DO allow must still be allowed, or the guard just
    // forbids talking about money at all.
    expect("Released pay goes to the bank account you give us in step 5.")
      .not.toMatch(NAMES_A_PAYOUT_CLOCK);
  });
});

describe("a step number in the prose matches the list underneath it", () => {
  /**
   * THE FIRST THING JOSH READS, NAMING THE WRONG STEP.
   *
   * A bank step was inserted into the ops invitation's list and the sentence
   * above it — "to the bank account you give us in step 4" — was not
   * renumbered. Step 4 in that list is the rate card; the bank is 5. The
   * identical sentence in the homeowner's invitation was correct, because
   * THAT list happens to have the bank at 4 — which is exactly how a pasted
   * cross-reference goes wrong in only one of two places.
   *
   * Checked against the <li> items themselves rather than a number written
   * down here, so inserting another step fails this instead of quietly
   * re-breaking it.
   */
  for (const { file, who } of INVITES) {
    it(`${file} — ${who}`, () => {
      const s = read(file);
      const items = [...s.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
      expect(items.length, "no numbered list found — this scanner is measuring nothing").toBeGreaterThan(3);
      for (const m of s.matchAll(/step (\d+)/gi)) {
        const n = Number(m[1]);
        expect(n, `${file} points at step ${n}, and the list has ${items.length} items`)
          .toBeLessThanOrEqual(items.length);
        // The sentences that name a step all name the BANK step today. Pin
        // that the item they point at is in fact about the bank, which is the
        // half a bare range check would miss.
        expect(
          items[n - 1],
          `"step ${n}" in ${file} points at an item that is not the bank step:\n${items[n - 1]}`,
        ).toMatch(/bank/i);
      }
    });
  }

  it("and the list's own count matches the '<n> steps:' heading above it", () => {
    // "4 steps:" sat above a list that omitted lakes, capacity and the Go live
    // button — the exact bug crews-invite.ts carries a paragraph about having
    // fixed, still live in the file that was not fixed.
    for (const { file } of INVITES) {
      const s = read(file);
      const items = [...s.matchAll(/<li>[\s\S]*?<\/li>/g)].length;
      const heading = s.match(/<b>(\d+) steps:<\/b>/);
      if (!heading) continue;
      expect(Number(heading[1]), `${file} promises ${heading[1]} steps and lists ${items}`).toBe(items);
    }
  });

  it("neither invitation leaves out a step that gates going live", () => {
    // A list that never mentions the lakes is the finding this package began
    // with: an untapped lake is silent, and a crew who follows the email to
    // the letter never learns that.
    for (const { file } of INVITES) {
      const s = read(file);
      expect(s, `${file} never mentions which lakes the crew covers`).toMatch(/lakes?\b/i);
      expect(s, `${file} never mentions the Go live button`).toMatch(/go live/i);
    }
  });
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

  it("and every door refuses a duplicate open invite — which is what makes the above matter", () => {
    // THE RULE MOVED AND THIS PIN FOLLOWED IT, RATHER THAN BEING LOOSENED.
    //
    // It used to scan each door for the phrase "open invite", which worked
    // while each door carried its own copy of the check. There were two; a
    // third arrived with the park's own invite door, and three copies of a
    // duplicate rule that agree today is this codebase's most expensive habit.
    // They now share ONE guard (lib/invite-guard checkInviteEmail), so the
    // literal is no longer in the doors and the old assertion could only be
    // satisfied by putting the drift back.
    //
    // So the pin is now stronger, not weaker: every door must REACH the guard,
    // and the guard must still carry the rule. Delete the guard's open-invite
    // branch and the second half goes red; stop calling it from any one door
    // and the first half names which.
    for (const { file } of INVITES) {
      // `checkInviteEmail(` WITH THE PAREN, and that is not pedantry — the
      // first version of this pin matched the bare identifier and went green
      // against a file that IMPORTED the guard and called none of it. The
      // homeowner door sat like that for an hour: six unused imports, the old
      // inline check still running, and a test saying the rule had moved.
      // Only eslint's unused-variable warning caught it.
      expect(read(file), `${file} imports the guard but never calls it`)
        .toMatch(/checkInviteEmail\(/);
    }
    const guard = read("lib/invite-guard.ts");
    expect(guard, "the shared guard no longer knows about an open invite")
      .toMatch(/open_invite/);
    // Case-INSENSITIVELY, which is the half that was broken: the pre-checks
    // used `.eq` while the index that actually enforces it is on
    // lower(invite_email), so a capitalised address slipped past the friendly
    // message and hit a raw 23505 instead.
    expect(guard, "the guard matches an address case-sensitively again")
      .toMatch(/ilike|lower\(/i);
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

describe("a truck with its own number still reaches its crew", () => {
  /**
   * THE COPY I SHIPPED THIS MORNING SAYS "by email and text". THIS PATH MADE
   * THAT FALSE.
   *
   * The route build sends each truck its day. `crew_units` carries a `phone`
   * and no email column, so the code chose:
   *
   *     const email = tp.truck.phone ? null : vendorContact.email;
   *
   * — and said so in its own comment: "Where it doesn't, the route still rides
   * the dead channel alone." A crew who names a truck and gives it a number
   * therefore gets their stops by SMS ONLY, and SMS has delivered 0 of 81 since
   * 19 July. They get nothing at all.
   *
   * The truck's own number is still the right PRIMARY — that is the driver who
   * is actually going out. But the company's email is a backstop that costs
   * nothing and is the only door currently delivering, and the vendor owns
   * every truck on their account, so it is their mail either way.
   *
   * `crew_units` holds 0 rows in production, so nobody has been bitten. The
   * first crew Brendon onboards for The Haven who adds a truck would be.
   */
  const src = read("lib/automation.ts");

  it("does not drop the email door when a truck has its own phone", () => {
    expect(
      src,
      "a truck with its own number is sent its route on the dead channel alone",
    ).not.toMatch(/const email = tp\.truck\.phone \? null : vendorContact\.email/);
  });

  it("still sends to the truck's own number when it has one", () => {
    // The fix must not quietly reroute the driver's text to the office.
    expect(src).toMatch(/tp\.truck\.phone \?\? vendorContact\.phone/);
  });

  it("and the crew's email is what the route falls back to", () => {
    const block = src.match(/const phone = tp\.truck\.phone[\s\S]{0,600}?notify\(/)?.[0] ?? "";
    expect(block, "the truck-route send block moved — this scan is stale").not.toBe("");
    expect(block, "vendorContact.email is never reached on the truck path")
      .toMatch(/vendorContact\.email/);
  });
});
