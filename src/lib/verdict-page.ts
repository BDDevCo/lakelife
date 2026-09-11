import type { VerdictOutcome, Verdict } from "./job-verdict";

/**
 * WHAT THE CUSTOMER IS TOLD AFTER TAPPING 👍 OR 👎.
 *
 * `recordJobVerdict` answers with THREE distinct states and both doors were
 * reading one flag:
 *
 *   { ok: false, recorded: false, error }  the write FAILED
 *   { ok: true,  recorded: false }         somebody already answered
 *   { ok: true,  recorded: true,  … }      this tap won
 *
 * The 👎 door branched on `recorded` alone, so a failed write and a
 * second tap both rendered "Your feedback is already in." A homeowner types
 * what went wrong, the write fails, and they are told it landed — on the ONLY
 * channel they have to say the work was wrong, with their crew's pay hold and
 * their free return visit both hanging off that tap. The 👍 door was worse: it
 * discarded the result entirely and thanked them unconditionally.
 *
 * AND "THEY'VE BEEN TOLD" WAS PRINTED WHETHER OR NOT ANYBODY WAS. A 👎 on a
 * CORRECTION visit resolves the original dispute instead of opening a new one
 * and returns without `disputeOpened`, so no crew was texted and nothing was
 * put on them — while the page said "they've been told and it's on them to
 * make it right".
 *
 * One rule, one place, every state named. The routes render it; this decides
 * it, which is the only way the two doors can be tested at all.
 */
export interface VerdictPage {
  title: string;
  body: string;
  /** false renders the page's "something went wrong" treatment. */
  ok: boolean;
  /** True when the tap did NOT land and the customer should try again. */
  retry: boolean;
}

export function verdictPage(res: VerdictOutcome, verdict: Verdict): VerdictPage {
  // A FAILED WRITE IS NOT A SECOND TAP. Say so, and say the thing they most
  // need to know: it is not recorded yet, so trying again is worth doing.
  if (!res.ok) {
    return {
      ok: false,
      retry: true,
      title: "That didn't save",
      body:
        (res.error ? `${res.error} ` : "") +
        "Nothing has been recorded yet — try again in a minute and it will go " +
        "straight through. 🌊",
    };
  }

  // Genuinely already answered: the first tap won, from this door or the job
  // page. Saying so is right, and it is the only case where it is right.
  if (!res.recorded) {
    return {
      ok: true,
      retry: false,
      title: "Thanks — got it ✓",
      // FOUR COPIES OF THIS SENTENCE EXISTED, in three different wordings:
      // the issue route's GET guard, its POST guard, its post-write branch,
      // and the good route's guard. Only one told the customer where to go if
      // it is still not resolved — and that clause only belongs on the 👎
      // side. Somebody who already said the work was fine does not need to be
      // pointed at a complaints channel.
      body:
        verdict === "good"
          ? "Your answer is already in. See you out there. 🌊"
          : "Your answer is already in. If anything's still unresolved, message us from your portal. 🌊",
    };
  }

  if (verdict === "good") {
    return {
      ok: true,
      retry: false,
      title: "Thanks — that's what we like to hear 🌊",
      body: "Your crew gets the credit. See you next time.",
    };
  }

  // A 👎 THAT OPENED A DISPUTE: the crew has their cure links, their pay is
  // held, and it really is on them.
  if (res.disputeOpened) {
    return {
      ok: true,
      retry: false,
      title: "Flagged — your crew is on it 🌊",
      body:
        "They've been told and it's on them to make it right. You can follow " +
        "up anytime from Messages in your portal — and this never costs you " +
        "anything.",
    };
  }

  // A 👎 WITH NO DISPUTE — a make-it-right visit that still was not right.
  // Nobody has been texted and nothing is on the crew; it comes to us.
  return {
    ok: true,
    retry: false,
    title: "Got it — we'll take this one 🌊",
    body:
      "That was already a return visit, so this comes to us rather than back " +
      "to the crew. We'll look at it and be in touch — and this never costs " +
      "you anything.",
  };
}
