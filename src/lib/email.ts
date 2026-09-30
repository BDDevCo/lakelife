import "server-only";
import type { RawHtml } from "./html-safe";
import { emailRefusal } from "@/lib/contactable";
import { recipientIsFixture } from "@/lib/recipient-gate";
import { recipientIsHeld, holdRefusal } from "@/lib/notice-hold";
import { recordEmailAttempt } from "@/lib/email-receipts";

/**
 * Send a transactional email via Resend (welcome recap, booking confirmations,
 * etc.). Mirrors the shape of sendSms in ./sms.ts.
 *
 * SERVER ONLY.
 *
 * Best-effort: returns {ok:false} instead of throwing so a booking or wizard
 * never fails just because an email couldn't send. No-ops gracefully when
 * Resend isn't configured (missing RESEND_API_KEY) or there's no recipient.
 *
 * Sender resolution: explicit opts.from wins, else EMAIL_FROM env (set this to
 * "LakeLife <noreply@lakelife.ai>" once the domain is verified in Resend), else
 * Resend's shared onboarding@resend.dev (test mode — only delivers to the Resend
 * account owner). So flipping every app email to the branded domain is a single
 * env var, no code change.
 */
/**
 * Resend's shared sandbox sender. It only ever delivers to the Resend account
 * owner, which has quietly been doing a job nobody assigned it: every email
 * this app has sent to a scratch address bounced off it harmlessly.
 *
 * THAT SAFETY IS AN ACCIDENT AND IT ENDS WITHOUT A DEPLOY. Setting `EMAIL_FROM`
 * in Vercel is a legitimate, expected step — and the moment it lands, every
 * send in the codebase starts reaching real inboxes, with no code change, no
 * migration and nothing on screen to mark the transition.
 *
 * WHICH SIDE OF THAT SWITCH A DEPLOYMENT IS ON IS NOT KNOWABLE FROM THIS FILE,
 * and this comment used to claim it was. It said `EMAIL_FROM` "is absent",
 * reading .env.local — a local, gitignored dev file that says nothing about
 * production, whose environment is Vercel's. Production has had EMAIL_FROM set
 * for some time (the nightly digests deliver from noreply@lakelife.ai), so the
 * sentence was false everywhere it mattered. Read the deployment, or the
 * Channels panel at /ops/texting, which asks the running server; never a file
 * in the tree, and never a comment.
 *
 * So the fallback says so. Not an error — using the sandbox is correct today,
 * and refusing to send would break the app for a configuration that is right.
 * Just no longer INVISIBLE: whoever reads the logs before flipping it can see
 * which state they are in, and the log line names the switch.
 *
 * The real protection for the other side of that switch is a recipient gate —
 * something that knows a scratch address from a customer's. That is its own
 * piece of work with its own question ("what proves a recipient is real?") and
 * this comment is not a substitute for it.
 */
const SANDBOX_FROM = "LakeLife <onboarding@resend.dev>";

let warnedSandbox = false;
function warnSandboxSender() {
  if (warnedSandbox) return; // once per process, not once per email
  warnedSandbox = true;
  console.warn(
    "[email] EMAIL_FROM is unset — sending as Resend's sandbox address, which " +
    "only delivers to the Resend account owner. Set EMAIL_FROM (see " +
    ".env.local.example) to send from lakelife.ai. Doing so makes every send " +
    "in this app reach its real recipient.",
  );
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  /**
   * Prefer the `html` tagged template from lib/html-safe — it escapes every
   * interpolated value and returns RawHtml, which lands here untouched. A
   * plain string is still accepted for bodies with nothing interpolated.
   */
  html: string | RawHtml;
  from?: string;
  text?: string;
  /**
   * What this message is and who it is about, for the receipt row.
   *
   * OPTIONAL, AND THAT IS A DECISION. Thirty-one call sites reach this door
   * directly and roughly seventy more come through `notify`. A required
   * parameter would not buy a hundred good labels; it would buy a hundred
   * hurried ones, written in one afternoon to make the compiler quiet, and it
   * would hold up the record for the sake of a word. `sendSms` settled the same
   * question the same way: a send with no label is filed as "unlabelled", which
   * reads worse in a week of failures than the real words and is never a reason
   * to skip the row.
   *
   * `notify` already holds the consequence in words — "the owner that their
   * pier removal was cancelled" — and now passes it here, as it already did to
   * sendSms.
   */
  about?: { kind?: string; parkId?: string | null; lakeId?: string | null };
}): Promise<{ ok: boolean; error?: string; id?: string; recorded?: boolean }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "email not configured" };

  // THE RECIPIENT GATE, and it goes BEFORE the sender resolution on purpose:
  // whether we may write to this person does not depend on which address we
  // would write from. Today an unset EMAIL_FROM means the sandbox swallows a
  // scratch send; the day that variable is set in Vercel the swallowing stops,
  // with no code change. This check is what makes that day uneventful.
  const refusal = emailRefusal(opts.to);
  if (refusal) {
    console.warn(`[email] refused: ${refusal.why}`);
    return { ok: false, error: `unsendable recipient (${refusal.code})` };
  }

  // AND THE SECOND GATE: a fixture wearing a plausible address (0126). The
  // shape check above cannot see this one — jane.doe@gmail.com is a real
  // mailbox belonging to a real stranger, and only the row knows nobody is
  // behind it. Fails open by design; see recipient-gate.ts.
  if (await recipientIsFixture("email", opts.to)) {
    console.warn(`[email] refused: ${opts.to} belongs to an account marked not-a-person`);
    return { ok: false, error: "unsendable recipient (fixture)" };
  }

  // AND THE THIRD: a park that has not said it is ready. The owner's rule is
  // that nothing reaches a renter until the roll is loaded, the leases are
  // executed and the households are comfortable, and nothing enforced it —
  // parks.active gates no send, and the one unattended path was held shut only
  // by a column nobody writes.
  //
  // IT LIVES HERE, NOT AT THE CALL SITES. A dozen places can write to a renter
  // today and there will be more; a guard each of them has to remember is a
  // guard the next one forgets. This door and sendSms are the only two out.
  //
  // Unlike the gate above it, this one FAILS CLOSED — see notice-hold.ts.
  const hold = await recipientIsHeld("email", opts.to);
  if (hold.held) {
    console.warn(`[email] held: ${opts.to} — ${hold.failed ? "could not check" : "park is holding notices"}`);
    return { ok: false, error: holdRefusal(hold) };
  }

  // `||`, NOT `??`, and the difference is the whole guard above. An env var set
  // to the empty string — the shape a half-finished Vercel entry takes, and the
  // shape `EMAIL_FROM=` in a .env file takes — is neither null nor undefined, so
  // `??` hands it straight through. Resend is then posted `from: ""`, the send
  // fails with a 4xx nobody is watching for, and the ONE line that exists to say
  // which side of the sandbox switch this deployment is on never prints, because
  // "" is not SANDBOX_FROM. The invitation IS the invite: a crew who never gets
  // it has no other door in, and the Crews board just says "invited" either way.
  const from = opts.from || process.env.EMAIL_FROM || SANDBOX_FROM;
  if (from === SANDBOX_FROM) warnSandboxSender();

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: opts.to,
        subject: opts.subject,
        html: String(opts.html),
        ...(opts.text ? { text: opts.text } : {}),
      }),
    });

    // READ ONCE, WHICHEVER WAY THIS WENT. A response body can only be consumed
    // once, and the id we need on the way out lives in the same place the error
    // text does.
    const raw = await res.text().catch(() => "");

    if (!res.ok) {
      // REFUSED AT THE DOOR, SO THERE IS NOTHING TO FILE. Resend hands back no
      // id for a message it would not take, and the id is the only key a
      // delivery event can ever carry — a row without one is a row no verdict
      // can ever answer, counting against the delivery rate for ever. Same rule
      // as a Twilio create that throws (lib/sms.ts).
      //
      // WHICH MEANS THIS CLASS OF FAILURE IS INVISIBLE TO THE RECEIPTS TABLE: a
      // suppressed recipient, an unverified sending domain, a rate limit. It is
      // loud here and it is returned to the caller, and no screen may read a
      // quiet receipts table as a healthy channel.
      console.error(`[email] Resend refused the send to ${opts.to}: ${res.status} ${raw}`);
      return { ok: false, error: `Resend ${res.status}: ${raw}` };
    }

    // WHAT RESEND CALLS THIS MESSAGE. Nothing in this repository writes down the
    // shape of a successful response, so it is read defensively rather than
    // asserted — see acceptedFromResend below.
    const accepted = acceptedFromResend(raw);

    if (!accepted.id) {
      // ACCEPTED, AND UNTRACEABLE. The mail has gone, so saying otherwise would
      // put "it didn't send" on a screen about a message sitting in somebody's
      // inbox. But with no id there is nothing for a delivery event to land on,
      // and this send is invisible to every count built on top of the receipts.
      // That is an alarm, not a footnote.
      console.error(
        `[email] Resend accepted a message to ${opts.to} and returned no id — ` +
        `nothing can tell us whether that one arrived. Body: ${raw.slice(0, 200)}`,
      );
      return { ok: true, recorded: false };
    }

    // THE RECEIPT, AFTER THE SEND AND NEVER INSTEAD OF IT. Awaited rather than
    // fired and forgotten — `void` on a result is the exact habit that let this
    // channel's twin go dark for a month — but it cannot undo or block a send
    // that has already happened: recordEmailAttempt catches its own errors and
    // reports them as `recorded: false` plus a line in the log.
    const { recorded } = await recordEmailAttempt({
      id: accepted.id,
      to: opts.to,
      // Hashed in the recorder and then dropped. A subject is "$542.53 due on
      // lot 26" — a fact about a household, not an operations datum.
      subject: opts.subject,
      kind: opts.about?.kind ?? null,
      parkId: opts.about?.parkId ?? null,
      lakeId: opts.about?.lakeId ?? null,
      // The html is what was actually posted; `text` is the same sentence in
      // plain form (notify builds both from one string), so one digest is the
      // honest answer rather than two that can disagree.
      body: String(opts.html),
      acceptedStatus: accepted.status,
      // ONLY EVER DELIVERED TO THE RESEND ACCOUNT OWNER, AND THE ROW HAS TO SAY
      // SO. The send is real — Resend takes it, gives it an id and will report
      // on it — so it belongs in the table; filing nothing would leave an empty
      // receipts table on a deployment that sends all day, and an empty table
      // reads as a quiet week. But a sandbox message that arrives arrives to US,
      // not to the person it names, so nothing downstream may count it as a
      // person reached.
      sandbox: from === SANDBOX_FROM,
    });

    return { ok: true, id: accepted.id, recorded };
  } catch (e) {
    // NO ID, SO NOTHING TO FILE IT UNDER. A fetch that threw may never have
    // reached Resend at all, and inventing a key would put a row in the table
    // that no event can ever answer.
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

/**
 * What Resend said when it took the message, read defensively.
 *
 * NOTHING IN THIS REPOSITORY DOCUMENTS THIS SHAPE, so nothing here asserts it.
 * The id is read as `id` — what the send endpoint returns — and `email_id` is
 * accepted alongside it because a provider naming the same thing twice is
 * cheaper to survive than to crash on. WHICH NAME THE DELIVERY EVENTS CARRY,
 * AND WHETHER IT IS THE SAME VALUE, MUST BE CONFIRMED AGAINST RESEND BEFORE
 * anything is built on the join: if the two ids differ, every receipt row is
 * unjoinable and this table is decorative.
 *
 * A status is read the same way and is allowed to be absent — Resend may say
 * nothing at accept time, which is a real difference from Twilio's `queued` and
 * leaves `accepted_status` null rather than invented.
 */
function acceptedFromResend(raw: string): { id: string | null; status: string | null } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { id: null, status: null };
    const o = parsed as Record<string, unknown>;
    const pick = (...vs: unknown[]) =>
      (vs.find((v) => typeof v === "string" && v.trim() !== "") as string | undefined) ?? null;
    return { id: pick(o.id, o.email_id), status: pick(o.status, o.last_event) };
  } catch {
    // A 2xx whose body is not JSON. Not a send failure — the mail went — but
    // nothing we can file, and the caller says so out loud.
    return { id: null, status: null };
  }
}
