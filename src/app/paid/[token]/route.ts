import { htmlPage } from "@/app/a/[token]/respond";
import { loadPaymentByToken, type ConfirmView, confirmByToken, disputeByToken } from "@/lib/confirm-server";
import { ReadFailed } from "@/lib/must-read";
import { escapeHtml } from "@/lib/html-safe";
import { longDay } from "@/lib/lake-time";
import { money } from "@/app/park/ledger-helpers";
import { releasedLead as releasedLeadWords } from "@/lib/released-words";

/**
 * "DOES THIS LOOK RIGHT?" — the renter's half of the receipt.
 *
 * Lives at /paid/, NOT /c/ — the services side already owns /c/[token]/good
 * and /c/[token]/issue for post-job quality verdicts, and two unrelated
 * confirmation flows in one namespace is how somebody eventually lands on the
 * wrong page. A token printed on a receipt is a permanent URL, so this was
 * worth moving before a single one existed.
 *
 * GET IS SAFE and only renders buttons. Link-preview prefetchers issue GETs,
 * and a GET that confirmed a payment would have people agreeing to figures by
 * opening a text message. Same discipline as the extend-stay and
 * Make-It-Right links.
 */

export const dynamic = "force-dynamic";

/**
 * "Sunday, January 3, 2027" — WITH THE YEAR. This URL is printed on paper and
 * opened months later; "Sunday, January 3" on a page read the following
 * winter is a date that could be either year. On the lakes' clock, like every
 * other date a person reads (lib/lake-time).
 */
function pretty(iso: string): string {
  return longDay(iso);
}

/** "It comes off the next bill the park raises for you." — true since 0167: the run applies money on account, oldest first. Said only of a payment that still stands. */
const COMES_OFF = "It comes off the next bill the park raises for you.";
const STILL_COMES_OFF = "what's still on account comes off the next bill the park raises for you.";
/**
 * …UNLESS NO NEXT BILL WILL EVER COME. The household has moved out and the
 * move-out month is billed (`nothingMoreBills` — the loader's read of the
 * same two facts the resident's home screen uses). Then "comes off the next
 * bill" promises a bill the park will never raise, on the receipt of the one
 * person the money belongs to — and since 0169 that is the DEFAULT state of
 * every move-out overpayment: January paid in full, the bill cancelled, the
 * part month settled from it, $70.00 left. The office's own screen calls
 * that "theirs to have back"; this page says only what it knows.
 */
const OFFICE_HAS_IT = "The office has it for you.";
const STILL_OFFICE_HAS_IT = "the office has what's still on account for you.";
function comesOff(view: ConfirmView): string {
  return view.nothingMoreBills ? OFFICE_HAS_IT : COMES_OFF;
}
function stillComesOff(view: ConfirmView): string {
  return view.nothingMoreBills ? STILL_OFFICE_HAS_IT : STILL_COMES_OFF;
}

/**
 * THE BILL THIS PAID WAS CANCELLED (0169), and the money went on account —
 * the sentence that leads every standing shape of a released receipt: read
 * without it, "That money went on account with the office" on a receipt
 * that plainly says "against your January bill" reads as a mistake. Said
 * only while the payment stands: a released row since taken back is a
 * taken-back receipt, and the taken-back branch says so. The words are
 * lib/released-words' — the household's own front page says the same
 * sentence under the cheque, from the same place.
 */
function releasedLead(view: ConfirmView): string {
  if (!view.releasedFrom) return "";
  return ` ${releasedLeadWords(view.releasedFrom.month, view.releasedFrom.on)}`;
}

/**
 * THE SIBLING'S OWN STANDING, if the loader hands it. A split is two rows
 * (recordPayment: the bill's share, and the rest on account under the same
 * key + ":onaccount"), and each stands or falls on its own: `takenBackOn`
 * is the bill row's. Today the loader lists a sibling only while it stands
 * (its read filters reversed_at), so a split's `onAccount` here belongs to
 * a row that stands. Should the loader ever list a sibling that has gone,
 * it says so in `siblingTakenBackOn`, and the page says the whole went.
 * Read only when handed — never assumed either way.
 */
function siblingTakenBackOn(view: ConfirmView): string | null {
  if (!("siblingTakenBackOn" in view)) return null;
  const v = view.siblingTakenBackOn;
  return typeof v === "string" && v ? v : null;
}

/**
 * WHERE THE MONEY ON ACCOUNT SITS TODAY, for the sentence the page asks her
 * to agree to. Five shapes, from the loader's own reads (never assumed):
 *
 *   a payment that no longer stands — the office reversed it (a bounced
 *   cheque, a typo) or the bank returned it — says so, with the day and the
 *   reason, and where the money HAD gone; nothing of it is on account and no
 *   "comes off the next bill" is ever said about it. This link is printed on
 *   paper and read the following winter;
 *   a split receipt whose BILL half alone was taken back — the on-account
 *   half is a separate row and still stands, so the page says which half
 *   went and where the rest sits today. "That no longer stands" is said
 *   only of the taken-back row's OWN allocations, never of a standing
 *   sibling's: its $40 is still on December, its $17.47 is still held;
 *   a split receipt ($600 for a $542.53 bill) — `onAccount` is the part that
 *   went on account; `whereItWent` says which months it has since paid and
 *   what is still held;
 *   a payment that IS money on account (a cheque before its bill existed, a
 *   quarter paid ahead) — `onAccount` is null and `onAccountRemaining` is its
 *   own; the same sentence, about the whole;
 *   a bill payment with nothing on account, or a deposit — nothing to say;
 *   a payment whose BILL WAS CANCELLED after it was paid (0169) — the money
 *   was released onto account, the row never moved; the page leads with
 *   which bill and when, then the same held / applied / gone states, over
 *   this row AND its split sibling together.
 *
 * "It comes off the next bill" is said only while something is still held —
 * in EVERY branch — and only while a next bill can come (`comesOff`). The
 * not-applied branches used to say "held for you … it comes off the next
 * bill" unconditionally, so money on account sent back
 * to the card, or handed back across the window, before anything was
 * applied read "held for you" and "was sent back to you" in one breath.
 * When nothing is applied and nothing is held, the money went somewhere,
 * and the sent-back / handed-back sentence after this one says where.
 */
function onAccountWords(view: ConfirmView): string {
  const held = (view.onAccountRemaining ?? 0) > 0;
  if (view.takenBackOn) {
    const why = view.takenBackWhy?.trim() ? ` — ${view.takenBackWhy.trim()}` : "";
    const when = `taken back on ${longDay(view.takenBackOn)}${why}`;
    if (view.onAccount != null && !siblingTakenBackOn(view)) {
      // The bill's share went; the $57.47 on account is its own row and
      // stands. Not "this payment was taken back" — $57.47 of it was not.
      const rest = `The ${money(view.onAccount)} on account is a separate record — it still stands`;
      return (
        ` The part of this against your bill was ${when}. ` +
        (view.onAccountApplied
          ? `${rest}, and has since been put against a bill. That's ${view.whereItWent}${held ? ` — ${stillComesOff(view)}` : "."}`
          : held
            ? `${rest}, held for you, not yet put against a bill. ${comesOff(view)}`
            : `${rest}; none of it is still held.`)
      );
    }
    // The whole of it went: the row's own allocations (a quarter-ahead
    // cheque), or both halves of a split.
    const hadGone = view.onAccount != null ? ` ${money(view.onAccount)} of that had gone on account with the office.` : "";
    return (
      hadGone +
      (view.onAccountApplied && view.whereItWent
        ? ` It had been put against ${view.whereItWent}; that no longer stands.`
        : "") +
      ` This payment was ${when}.`
    );
  }
  // THE BILL WAS CANCELLED AFTER SHE PAID IT (0169). The whole of this money
  // is on account now — and on a split, so was the $57.47 from the start —
  // and the loader's `whereItWent` / `onAccountRemaining` already cover both
  // rows. One lead, then the same three states as every other shape.
  const cancelled = releasedLead(view);
  if (cancelled) {
    return (
      cancelled +
      (view.onAccount != null ? ` ${money(view.onAccount)} of it had been on account from the start.` : "") +
      (view.onAccountApplied
        ? ` Where it went: ${view.whereItWent}${held ? ` — ${stillComesOff(view)}` : "."}`
        : held
          ? ` It's held for you. ${comesOff(view)}`
          : ` None of it is still held.`)
    );
  }
  if (view.onAccount == null) {
    if (view.onAccountRemaining == null) return "";
    return view.onAccountApplied
      ? ` That money went on account with the office. Where it went: ${view.whereItWent}${held ? ` — ${stillComesOff(view)}` : "."}`
      : held
        ? ` That money is on account with the office — held for you. ${comesOff(view)}`
        : ` That money went on account with the office; none of it is still held.`;
  }
  return view.onAccountApplied
    ? ` ${money(view.onAccount)} of that went on account with the office and has since been put against a bill. That's ${view.whereItWent}${held ? ` — ${stillComesOff(view)}` : "."}`
    : held
      ? ` ${money(view.onAccount)} of that is on account with the office — held for you, not yet put against a bill. ${comesOff(view)}`
      : ` ${money(view.onAccount)} of that went on account with the office; none of it is still held.`;
}

/**
 * WHAT WENT BACK THROUGH THE PROCESSOR (0142), one sentence per refund. The
 * page asked her to confirm $600 and listed $560 of it against bills with
 * nothing about the $40 that went back — on the one page built to show every
 * event on her money. Said after the on-account sentence, whatever shape
 * that took, and never folded into "where it went": a refund is not a bill
 * month. "Your card" or "your bank account" by the payment's rail — 0142
 * refunds ACH money too.
 */
function sentBackWords(view: ConfirmView): string {
  return (view.sentBack ?? [])
    .map((r) =>
      ` ${money(r.amount)} was sent back to your ${r.method === "ach" ? "bank account" : "card"} on ${longDay(r.on)}` +
      (r.fee > 0 ? `, with the ${money(r.fee)} card fee` : "") +
      `.`)
    .join("");
}

/**
 * WHAT WENT BACK ACROSS THE WINDOW — a deposit returned at move-out, rent on
 * account handed back after the household left (0168) — one sentence per
 * hand-back, off this row or its split sibling. The fourth way money leaves,
 * and the one this page said nothing about: "$542.53 to January 2027" for a
 * $600 cheque, with the $57.47 the office handed across the counter
 * unexplained. Never "comes off the next bill" about it — the on-account
 * sentence above stops promising that once nothing is held.
 */
function handedBackWords(view: ConfirmView): string {
  return (view.handedBack ?? [])
    .map((h) => ` ${money(h.amount)} of that was handed back to you on ${longDay(h.on)}.`)
    .join("");
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  // The loader THROWS on a failed read and a Route Handler has no error
  // boundary. This page asks somebody to agree to a figure, so it must never
  // guess one — and "this link doesn't match a payment" is itself a figure-
  // shaped claim we couldn't check. Nothing here is recorded either way.
  let view: ConfirmView | null;
  try {
    view = await loadPaymentByToken(token);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return htmlPage(
      "We couldn't load that just now",
      "Nothing has been confirmed and nothing has been changed on your bill. Open the link again in a moment — if it keeps happening, give the park a call. 🌊",
      false,
    );
  }
  if (!view) {
    return htmlPage("That link isn't right", "This link doesn't match a payment. 🌊", false);
  }

  // "from lot —" is what a cheque with no bill behind it used to print: the
  // loader hands "—" to mean there is no lot on the record, so say "from you".
  const from = view.lotNumber === "—" ? "from you" : `from lot ${view.lotNumber}`;
  const line =
    `${view.parkName} recorded ${money(view.amount)} ${from}, ` +
    `paid by ${view.method}${view.reference ? ` ${view.reference}` : ""} ` +
    `on ${pretty(view.receivedOn)}. Receipt ${view.ref}.` +
    // ASKING "DOES THIS MATCH?" AGAINST THE WRONG NUMBER MANUFACTURES A
    // DISPUTE. Their bank shows rent + fee; this page showed rent alone, so a
    // careful resident comparing the two would honestly answer "no".
    (view.fee && view.fee > 0
      ? ` A card fee of ${money(view.fee)} was charged on top, so ${money(view.amount + view.fee)} left your card. The fee isn't rent and isn't credited against your bill.`
      : "") +
    // THE HALF THE PAPER RECEIPT SAYS. `amount` is the whole she handed over
    // (bill share + on account), so the page must say where the rest sits or
    // she agrees to $600 with no word that $57.47 of it is not against her
    // bill.
    //
    // AND WHERE IT SITS TODAY. This URL is printed on paper and outlives the
    // day it was written: once the run or the office puts the $57.47 against
    // a bill, "held for you, not yet put against a bill" is false, and a
    // resident reading it in March would rightly ask why her money is still
    // sitting in a drawer. The loader reads the allocations (0167); this says
    // which months, and — while any is still held — that it comes off the
    // next bill, which since 0167 the run does.
    onAccountWords(view) +
    sentBackWords(view) +
    handedBackWords(view);

  if (view.alreadyConfirmedAt) {
    return htmlPage("Already confirmed 🌊", `${line}\n\nYou've confirmed this one — nothing more to do.`);
  }

  // Two buttons, equally weighted — when both can do something. A page with
  // only "yes" is a rubber stamp, which is why htmlPage's single-button form
  // isn't used here; but a "no" the server refuses by design is worse than
  // no "no" at all, so the second button is rendered only when a claim can
  // actually be saved (`canDispute`), and otherwise the page names the real
  // path.
  return confirmPage(token, line, view);
}

/**
 * htmlPage only renders one button, so the two-answer page is built here. Both
 * answers are the same size and weight — making "yes" the easy one is how you
 * get agreement that means nothing.
 */
function confirmPage(token: string, line: string, view: ConfirmView): Response {
  // ONE COPY OF THIS RULE, in lib/html-safe. This local one covered & < > " but not '.
  const esc = escapeHtml;
  const t = encodeURIComponent(token);
  // THE SECOND BUTTON EXISTS ONLY WHERE IT CAN SAVE SOMETHING. A claim hangs
  // off a bill; a receipt for money on account or a deposit has none, so the
  // button used to promise "the park will look into it — nothing will be
  // chased while they do" and then answer "We couldn't save that". No
  // promise a page cannot keep: the office and the receipt reference are
  // the path that works today.
  const canDispute = view.canDispute === true;
  const ask = canDispute
    ? `If that matches what you handed over, tap the first button. If it doesn&#39;t, tap the second and the park will look into it — nothing will be chased while they do.`
    : `If that matches what you handed over, tap the button. If it doesn&#39;t, ring the office and quote receipt ${esc(view.ref)} — they can log it for you.`;
  const noForm = canDispute
    ? `<form method="post" action="/paid/${t}"><button class="no" name="answer" value="no" type="submit">That&#39;s not what I paid</button></form>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Does this look right? — LakeLife</title><style>
body{margin:0;background:#f4f7f8;color:#0a2430;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{max-width:520px;margin:36px auto;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 2px 18px rgba(10,36,48,.08)}
h1{font-size:22px;margin:0 0 14px}
p{white-space:pre-wrap;margin:0 0 18px}
button{width:100%;min-height:48px;border:0;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer}
.yes{background:#d9a441;color:#0a2430}
.no{background:#fff;color:#0a2430;border:2px solid #cbd8dd;margin-top:10px}
</style></head><body><div class="card">
<h1>Does this look right?</h1>
<p>${esc(line)}</p>
<p>${ask}</p>
<form method="post" action="/paid/${t}"><button class="yes" name="answer" value="yes" type="submit">Yes, that&#39;s right</button></form>
${noForm}
</div></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const form = await req.formData().catch(() => null);
  const answer = String(form?.get("answer") ?? "yes");

  if (answer === "no") {
    const res = await disputeByToken(token);
    // A BY-DESIGN REFUSAL IS NOT A FAILED WRITE. The page hides the button for
    // money on account, so this answers a stray POST — and "We couldn't save
    // that" over it would say something tried and broke. Nothing did.
    if (!res.ok && res.unsupported) return htmlPage("This one can't be flagged here", res.error ?? "Give the park a call. 🌊", false);
    if (!res.ok) return htmlPage("We couldn't save that", res.error ?? "Give the park a call. 🌊", false);
    return htmlPage(
      "Thanks — we've flagged it 🌊",
      "The park has been told this doesn't match what you paid. " +
        "Nothing will be chased on this bill while they look into it. " +
        "If you have a receipt or a check number, bring it in.",
    );
  }

  const res = await confirmByToken(token);
  if (!res.ok) return htmlPage("We couldn't save that", res.error ?? "Give the park a call. 🌊", false);
  return htmlPage(
    "Thanks 🌊",
    "That's on the record now, from you as well as the park. Keep your receipt.",
  );
}
