import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { assertOps } from "@/app/ops/data";
import { getTextingSetup, type TextingSetup } from "@/app/ops/texting-setup";
import { LOG_WINDOW } from "@/app/ops/sms-health";
import { lakeStamp, longDate } from "@/lib/lake-time";

/**
 * THE PAGE THAT SAYS WHETHER TEXTING IS ON, IN WORDS, FROM LIVE FACTS.
 *
 * Its own route rather than another card on /ops, for the reason the job file
 * is its own route: /ops already loads about fifteen datasets for every view,
 * and this is a page somebody opens on the one day they are switching texting
 * on and then does not open again for a month. Nobody should pay for it on
 * every console load.
 *
 * force-dynamic because every sentence on it is a live read — the environment
 * as the running server sees it, Twilio's log as it stands this minute, and
 * the park hold as it is right now. A cached copy of this page would be a
 * confident report about a state that has since changed, which is the exact
 * failure this page exists to end.
 *
 * WHAT IT WILL NOT DO: promise anything. Approval is not delivery. Until a
 * real message has reached a real handset and this page can show its receipt,
 * every sentence here describes configuration, never arrival.
 */
export const dynamic = "force-dynamic";

export default async function OpsTextingPage() {
  if (!hasSupabaseEnv()) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div>
      </>
    );
  }

  const ops = await assertOps();
  if (!ops) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Operations only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the ops console</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Your account isn&apos;t an operations account. If you think that&apos;s wrong, contact your admin.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  const setup = await getTextingSetup();

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 760 }}>
        <p style={{ fontSize: 13.5, margin: "0 0 10px" }}>
          <Link href="/ops">← Back to ops</Link>
        </p>

        <span className="ll-pill gold">Operations · Internal</span>
        <h1 style={{ fontSize: 26, margin: "10px 0 6px" }}>Texting setup</h1>
        <p className="mut" style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
          Everything below was read just now — from this server&apos;s settings, from
          Twilio&apos;s own message log, and from the parks table. Nothing on this page
          is remembered or assumed. Credentials are reported as set or not set; no
          value of one is ever shown here.
        </p>

        <Channels setup={setup} />
        <DeliveryLog setup={setup} />
        <Holds setup={setup} />
        <WhatIsStillTrue setup={setup} />
      </div>
    </>
  );
}

/* -- the two channels ------------------------------------------------------ */

/**
 * TWO ANSWERS, NEVER ONE. Codes and notifications travel on different Twilio
 * transports, and for two months a single "Twilio: yes" answered for both
 * while only the codes were arriving.
 */
function Channels({ setup }: { setup: TextingSetup }) {
  const { verify, messaging, bareNumberOnly, deliveryVerdicts } = setup;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>The two channels</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.55 }}>
        Twilio carries our texts on two separate transports. Each is configured
        on its own, and either can be working while the other is dead.
      </p>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ padding: "10px 12px", background: "var(--sand-light)", borderRadius: 12 }}>
          <span className={`ll-pill ${verify.ready ? "ok" : "warn"}`}>
            {verify.ready ? "Codes · configured" : "Codes · not configured"}
          </span>
          <p style={{ fontSize: 14, margin: "8px 0 0", lineHeight: 1.55 }}>
            The six-digit codes for signing in and for a resident confirming their
            mobile. These go out on Twilio&apos;s own managed sender pool, which is why
            they kept arriving all through the outage.
          </p>
          <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
            {verify.ready
              ? "Read from TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID — all three are set on this server."
              : `Not set on this server: ${verify.missing.join(", ")}.`}
          </p>
        </div>

        <div style={{ padding: "10px 12px", background: "var(--sand-light)", borderRadius: 12 }}>
          <span className={`ll-pill ${messaging.ready ? "ok" : "warn"}`}>
            {messaging.ready ? "Notifications · configured" : "Notifications · not configured"}
          </span>
          <p style={{ fontSize: 14, margin: "8px 0 0", lineHeight: 1.55 }}>
            Booking confirmations, crew dispatch, Autopilot reminders, a park
            invite — everything that is not a code. These go out on our own
            registered sender, and carriers route them on the Messaging Service.
          </p>
          <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
            {messaging.ready
              ? "TWILIO_MESSAGING_SERVICE_SID is set on this server. Its value is deliberately not shown."
              : `Not set on this server: ${messaging.missing.join(", ")}.`}
          </p>
          {/* THE STATE THE WHOLE OUTAGE HAPPENED IN, so it gets said rather
              than folded into "not configured". A number with no service is
              how the console looked green while every message was rejected. */}
          {/* THE SECOND SILENT FAILURE, and it survives a correct SID. A
              send with no status callback is accepted, delivered or dropped,
              and never tells us which — so this says whether the verdict has
              a door to come back through. */}
          {!deliveryVerdicts.wired && (
            <div className="ll-notice" style={{ marginTop: 8 }}>
              No delivery verdicts are being recorded. Twilio is only asked to
              report back when NEXT_PUBLIC_SITE_URL is a real https address, and
              on this server it is not — so every message we send will sit at
              &ldquo;queued&rdquo; for ever and a clean sheet here would mean
              nothing. On production it should be https://www.lakelife.ai.
            </div>
          )}
          {deliveryVerdicts.wired && (
            <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
              Carriers report back to {deliveryVerdicts.url}, and each verdict is
              written onto the receipt for that message.
            </p>
          )}
          {bareNumberOnly && (
            <div className="ll-notice" style={{ marginTop: 8 }}>
              TWILIO_PHONE_NUMBER is set but TWILIO_MESSAGING_SERVICE_SID is not.
              A bare number is not enough once the campaign is registered —
              carriers route on the Messaging Service, so traffic sent from the
              number alone counts as unregistered and is rejected. This is the
              setting the outage ran on.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -- what Twilio's log says ------------------------------------------------ */

/**
 * READ STRAIGHT FROM TWILIO, AND SAYING SO.
 *
 * The carrier's verdict arrives out of band, seconds after the send, and for
 * two months it was addressed to nobody. It now has an address: every send
 * files a receipt (lib/sms-receipts.ts) and /api/twilio/status writes the
 * verdict onto it. Migration 0171 IS applied in production.
 *
 * This window still reads Twilio's own log, and that is a decision rather than
 * a leftover: two independent answers to "did it arrive" is the point, and a
 * bug in our own writer must not be able to make this screen agree with
 * itself. The nightly digest counts OUR receipts; this screen counts THEIRS.
 * When they disagree, the disagreement is the finding.
 *
 * What our receipts would add — a window reaching further back than 200
 * messages, and knowing which of OUR sends each verdict belongs to — belongs
 * in a panel BESIDE this one, never as a replacement for it.
 */
function DeliveryLog({ setup }: { setup: TextingSetup }) {
  const { log } = setup;

  if (!log.configured) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>What Twilio&apos;s log says</h2>
        <p className="mut" style={{ fontSize: 13.5, margin: 0, lineHeight: 1.55 }}>
          Nothing was asked. TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are what
          read the log, and they are not both set on this server — so this is
          &ldquo;we did not look&rdquo;, not &ldquo;there is nothing there&rdquo;.
        </p>
      </div>
    );
  }

  // COULD NOT ASK ≠ ALL WELL.
  if (!log.window) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18, borderLeft: "4px solid var(--warn)" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>What Twilio&apos;s log says</h2>
        <p style={{ fontSize: 14, margin: 0, lineHeight: 1.55 }}>
          We couldn&apos;t reach Twilio to read the message log just now.
          {log.error ? ` Twilio said: ${log.error}.` : ""} Assume nothing about
          delivery until this answers — this line is a failed read, not a clean
          bill of health.
        </p>
      </div>
    );
  }

  const { sent, delivered, failed } = log.window;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>What Twilio&apos;s log says</h2>

      {sent === 0 ? (
        <p className="mut" style={{ fontSize: 13.5, margin: 0, lineHeight: 1.55 }}>
          Twilio&apos;s log holds no messages at all in the last {LOG_WINDOW}, so there
          is nothing to judge — that is &ldquo;nothing was sent&rdquo;, not &ldquo;nothing arrived&rdquo;.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 14, margin: "0 0 4px", lineHeight: 1.55 }}>
            <strong>
              {delivered} of the last {sent}
            </strong>{" "}
            reached a handset. {failed} were rejected by a carrier. Read from
            Twilio&apos;s own log — the newest {LOG_WINDOW} messages on the account.
          </p>
          {log.oldest && log.newest && (
            <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px", lineHeight: 1.5 }}>
              That window runs from {longDate(log.oldest)} to {longDate(log.newest)}.
            </p>
          )}
          {log.reasons.length > 0 && (
            <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
              {log.reasons.map((r) => (
                <li key={r.code}>
                  <strong>{r.count}</strong> — {r.text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* THE LAST ATTEMPT, NAMED. "Nothing is arriving" and "we have not tried
          since July" are different problems with the same empty screen. */}
      <div className="ll-notice quiet" style={{ marginTop: 8 }}>
        {log.lastAttempt ? (
          <>
            <strong>Last text attempted:</strong>{" "}
            {log.lastAttempt.at ? lakeStamp(log.lastAttempt.at) : "at a time Twilio did not record"} —
            Twilio&apos;s word for it is &ldquo;{log.lastAttempt.status}&rdquo;.
            {log.lastAttempt.errorText ? ` It came back rejected: ${log.lastAttempt.errorText}.` : ""}
          </>
        ) : (
          <>
            <strong>Last text attempted:</strong> never, as far as this log goes.
            No message appears in the window above.
          </>
        )}
      </div>
    </div>
  );
}

/* -- parks holding notices ------------------------------------------------- */

/**
 * A HELD PARK LOOKS EXACTLY LIKE A BROKEN TRANSPORT FROM THE DASHBOARD.
 *
 * `parks.notices_held_at` is checked inside sendSms and sendEmail and fails
 * closed, so while a park holds, nothing reaches a single one of its
 * households — by the owner's own instruction. On a page about why texts are
 * not arriving, leaving that out is how somebody lifts a hold to fix a fault
 * that was never a fault.
 */
function Holds({ setup }: { setup: TextingSetup }) {
  const { holds } = setup;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Parks holding notices</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.55 }}>
        A hold is a deliberate refusal, not a fault. While one is on, no text and
        no email reaches any household at that park — and from the delivery log
        that looks identical to texting being broken. Read from
        parks.notices_held_at.
      </p>

      {holds.failed ? (
        <div className="ll-notice">
          We couldn&apos;t read which parks are holding notices. That is a failed read,
          not an answer — do not take it to mean none are held.
        </div>
      ) : holds.unavailable ? (
        <p className="mut" style={{ fontSize: 13.5, margin: 0, lineHeight: 1.55 }}>
          There is no database configured on this server, so nothing was asked.
        </p>
      ) : holds.parks.length === 0 ? (
        <p style={{ fontSize: 14, margin: 0, lineHeight: 1.55 }}>
          No park is holding notices. Every park in the table was checked and
          none has a hold date on it.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
          {holds.parks.map((p) => (
            <li key={p.name}>
              <strong>{p.name}</strong> — held since{" "}
              {p.heldAt ? longDate(p.heldAt) : "a date that was not recorded"}.
              {p.reason ? ` ${p.reason}` : " No reason was recorded with the hold."}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -- what is still true ---------------------------------------------------- */

/**
 * THE HONEST FOOTER. Approval is not delivery, and this is the list that keeps
 * the product from claiming otherwise. Each line is computed, not typed: the
 * first two come from the facts above, and the third is a judgement only a
 * person can make.
 */
function WhatIsStillTrue({ setup }: { setup: TextingSetup }) {
  const configured = setup.messaging.ready;
  const proven = Boolean(setup.log.window && setup.log.window.delivered > 0);

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 18, marginBottom: 28 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Before any sentence on the site may promise a text</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.55 }}>
        Carrier approval means the campaign is registered. It does not mean a
        message has arrived. These are the three things, in order.
      </p>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.75 }}>
        <li>
          <strong>TWILIO_MESSAGING_SERVICE_SID set in Vercel production.</strong>{" "}
          {configured
            ? "Done — this server can see it."
            : "Not yet — this server cannot see it. It is the one step only you can do; docs/a2p-registration.md has the screens."}
        </li>
        <li>
          <strong>One real message delivered.</strong>{" "}
          {proven
            ? `Twilio's log shows ${setup.log.window?.delivered} delivered in the window above.`
            : "Not yet — Twilio's log shows nothing delivered in the window above."}
        </li>
        <li>
          <strong>The copy sweep.</strong> Every sentence that says we will text
          somebody has to be read again against what is true on the day it ships.
          Nothing here can decide that for you.
        </li>
      </ol>
    </div>
  );
}
