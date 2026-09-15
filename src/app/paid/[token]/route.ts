import { htmlPage } from "@/app/a/[token]/respond";
import { loadPaymentByToken, type ConfirmView, confirmByToken, disputeByToken } from "@/lib/confirm-server";
import { ReadFailed } from "@/lib/must-read";
import { escapeHtml } from "@/lib/html-safe";
import { longDay } from "@/lib/lake-time";
import { money } from "@/app/park/ledger-helpers";

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
 *   a bill payment with nothing on account, or a deposit — nothing to say.
 *
 * "It comes off the next bill" is said only while something is still held.
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
          ? `${rest}, and has since been put against a bill. That's ${view.whereItWent}${held ? ` — ${STILL_COMES_OFF}` : "."}`
          : `${rest}, held for you, not yet put against a bill. ${COMES_OFF}`)
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
  if (view.onAccount == null) {
    if (view.onAccountRemaining == null) return "";
    return view.onAccountApplied
      ? ` That money went on account with the office. Where it went: ${view.whereItWent}${held ? ` — ${STILL_COMES_OFF}` : "."}`
      : ` That money is on account with the office — held for you. ${COMES_OFF}`;
  }
  return view.onAccountApplied
    ? ` ${money(view.onAccount)} of that went on account with the office and has since been put against a bill. That's ${view.whereItWent}${held ? ` — ${STILL_COMES_OFF}` : "."}`
    : ` ${money(view.onAccount)} of that is on account with the office — held for you, not yet put against a bill. ${COMES_OFF}`;
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
    onAccountWords(view);

  if (view.alreadyConfirmedAt) {
    return htmlPage("Already confirmed 🌊", `${line}\n\nYou've confirmed this one — nothing more to do.`);
  }

  // Two buttons, equally weighted. A page with only "yes" is a rubber stamp,
  // which is why htmlPage's single-button form isn't used here.
  return confirmPage(token, line);
}

/**
 * htmlPage only renders one button, so the two-answer page is built here. Both
 * answers are the same size and weight — making "yes" the easy one is how you
 * get agreement that means nothing.
 */
function confirmPage(token: string, line: string): Response {
  // ONE COPY OF THIS RULE, in lib/html-safe. This local one covered & < > " but not '.
  const esc = escapeHtml;
  const t = encodeURIComponent(token);
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
<p>If that matches what you handed over, tap the first button. If it doesn&#39;t, tap the second and the park will look into it — nothing will be chased while they do.</p>
<form method="post" action="/paid/${t}"><button class="yes" name="answer" value="yes" type="submit">Yes, that&#39;s right</button></form>
<form method="post" action="/paid/${t}"><button class="no" name="answer" value="no" type="submit">That&#39;s not what I paid</button></form>
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
