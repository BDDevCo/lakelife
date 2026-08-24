import type { MyAgreements as View, AgreementLine } from "@/app/agreements/data";

/**
 * WHAT YOU AGREED TO, AND THE WORDS YOU AGREED TO.
 *
 * The ledger has snapshotted the exact text of every acceptance since 0139 and
 * nothing has ever shown it to anybody. Snapshotting the words rather than a
 * version string was done so a person could be shown, later, precisely what
 * was on their screen — which only happens if there is a screen.
 *
 * THE HONEST STATES MATTER MORE THAN THE HAPPY ONE:
 *
 *   * a row whose wording was never captured says so, in its own sentence. The
 *     four acceptances migrated from the old two columns are exactly this, and
 *     rendering them as if the text were merely collapsed would be the lie the
 *     `provenance` column exists to prevent.
 *   * a WITHDRAWN row stays on the page. The acceptance is not deleted when
 *     somebody walks away from it, and hiding it here would undo that.
 *   * "nothing yet" says what was looked for, so it cannot be mistaken for a
 *     broken screen.
 */

/**
 * "21 August 2026" — a date a person reads, never 2026-08-21, IN LAKE TIME.
 *
 * Both inputs here are timestamptz — `acceptances.occurred_at` and
 * `park_renters.sms_consent_operational_at` — not date columns. Formatting an
 * instant in UTC rolls every Indiana evening into the next day: tap "I agree"
 * at 9:30pm on the 23rd and this printed "24 August 2026".
 *
 * That is the wrong mistake to make HERE of all places. This screen's entire
 * stated purpose is being trusted about what is on file, and its own header
 * promises "the exact words as they were on the day".
 *
 * The UTC form elsewhere is correct and must stay: RenterHome and VendorDocs
 * split a y-m-d DATE string and rebuild it through Date.UTC, which is right for
 * a date column. This is a timestamp, so it takes the timezone the lake is in.
 */
const LAKE_TZ = "America/Indiana/Indianapolis";

function prettyDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric", month: "long", year: "numeric", timeZone: LAKE_TZ,
  });
}

/**
 * EVERY ROW SAYS WHERE IT STANDS.
 *
 * With a badge on only the live one, a reader looking at two cards both titled
 * "Terms of service" cannot tell whether the other is superseded or broken.
 * "Out of date" earns its place separately: it is the one that predicts
 * something — they will meet the agree screen next time they book or open
 * their park, and this is where that stops being a surprise.
 */
const STANDING: Record<
  AgreementLine["standing"],
  { label: string; className: string; note?: string }
> = {
  in_force:    { label: "In force",    className: "ll-pill" },
  replaced:    { label: "Replaced",    className: "ll-pill slate",
                 note: "You agreed again later — the newer one above is the one that counts." },
  out_of_date: { label: "Out of date", className: "ll-pill slate",
                 note: "The terms have changed since. We'll ask you to read the new ones next time." },
  withdrawn:   { label: "Withdrawn",   className: "ll-pill slate" },
};

function Line({ line }: { line: AgreementLine }) {
  const withdrawn = line.act === "withdrawn";
  const standing = STANDING[line.standing];
  return (
    <div
      className="ll-card ll-card-pad"
      style={{ marginBottom: 12, opacity: withdrawn ? 0.75 : 1 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 16 }}>{line.label}</strong>
        <span className={standing.className}>{standing.label}</span>
      </div>

      <p className="mut" style={{ fontSize: 13.5, margin: "6px 0 0", lineHeight: 1.6 }}>
        {withdrawn ? "You withdrew this on " : "You agreed to this on "}
        <strong>{prettyDay(line.occurredAt)}</strong>
        {line.version ? <> · version {line.version}</> : null}
      </p>

      {standing.note && (
        <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.6 }}>
          {standing.note}
        </p>
      )}

      {line.wordsWereKept && line.text ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 13.5 }}>
            Read exactly what you agreed to
          </summary>
          {/* Verbatim, in a monospace block, so nobody mistakes it for a
              paraphrase written for this screen. */}
          <pre
            style={{
              font: "12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
              whiteSpace: "pre-wrap",
              margin: "10px 0 0",
              padding: "12px 14px",
              background: "rgba(0,0,0,.03)",
              borderRadius: 8,
            }}
          >
            {line.text}
          </pre>
        </details>
      ) : (
        <p className="mut" style={{ fontSize: 13, margin: "10px 0 0", lineHeight: 1.6 }}>
          We have the date and the version of this one, but not the wording —
          it was recorded before we started keeping the words. Everything you
          agree to from now on is kept in full.
        </p>
      )}
    </div>
  );
}

export function MyAgreements({ view }: { view: View }) {
  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 56, maxWidth: 720 }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>What you&apos;ve agreed to</h1>
      {/* TWO CLAIMS REMOVED, BOTH FALSE ON THIS VERY PAGE.
          (1) "with the exact words as they were on the day" — true of rows
          recorded since the ledger, and NOT of the four migrated ones, which
          say so themselves in their own card. Three accounts have ONLY such a
          row, so the header contradicted every card beneath it.
          (2) "the original is never deleted" — nothing in the app can withdraw
          a ledger agreement (withdrawAcceptance has no caller), and the one
          thing on this page a person CAN withdraw is the text consent, which
          stopTexts() genuinely does delete, card and all. The footnote on that
          card admits it six lines lower. A blanket promise a reader can
          disprove in one tap is worse than no promise. */}
      <p className="mut" style={{ fontSize: 14, marginTop: 0, lineHeight: 1.6 }}>
        Everything you&apos;ve accepted here, and — wherever we kept them — the
        exact words as they were on the day. Nothing in this list is ever
        edited: each card says where it stands and what we hold for it.
      </p>

      {view.empty && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
          <strong style={{ display: "block", marginBottom: 6 }}>Nothing on file yet</strong>
          <p className="mut" style={{ fontSize: 13.5, margin: 0, lineHeight: 1.6 }}>
            We looked for agreements recorded against this sign-in and for any
            text-message consent on a park file, and found neither. You&apos;ll
            be asked to agree the first time you book, go live, or open your
            park — and it will appear here straight afterwards.
          </p>
        </div>
      )}

      {view.lines.length > 0 && (
        <section style={{ marginTop: 18 }}>
          {view.lines.map((l) => <Line key={l.id} line={l} />)}
        </section>
      )}

      {view.textConsents.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 17, margin: "0 0 10px" }}>Text messages</h2>
          {view.textConsents.map((c) => (
            <div className="ll-card ll-card-pad" key={`${c.parkName}-${c.consentedAt}`} style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: 15 }}>{c.parkName}</strong>
              <p className="mut" style={{ fontSize: 13.5, margin: "6px 0 0", lineHeight: 1.6 }}>
                You said we could text {c.number ?? "your mobile"} on{" "}
                <strong>{prettyDay(c.consentedAt)}</strong>.
              </p>
              {c.sentence ? (
                <p style={{ fontSize: 13.5, margin: "10px 0 0", lineHeight: 1.6, fontStyle: "italic" }}>
                  &ldquo;{c.sentence}&rdquo;
                </p>
              ) : (
                <p className="mut" style={{ fontSize: 13, margin: "10px 0 0", lineHeight: 1.6 }}>
                  We have the date but not the wording for this one.
                </p>
              )}
              {/* HONEST ABOUT THE ONE THING THAT DOES VANISH. `stopTexts()`
                  nulls the consent and its snapshotted sentence, so stopping
                  removes this card rather than marking it withdrawn — the
                  opposite of how the agreements above behave. Saying so beats
                  a blanket "nothing is ever removed" that a person can
                  disprove in one tap. */}
              <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.6 }}>
                Reply STOP to any message, or turn texts off on your lot page,
                and we&apos;ll stop — this card goes with it.
              </p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
