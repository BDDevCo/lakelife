import { TermsBody } from "@/components/TermsBody";
import { acceptTos } from "@/app/portal/tos-actions";

/**
 * ONE CARD, THREE DOORS.
 *
 * A crew, a park owner and a resident all reach the same terms — LakeLife runs
 * ONE agreement, not one per role (owner posture, 2026-07-22), and the document
 * has a section describing each. So there is one card, and it goes through
 * `acceptTos`, which goes through `ensureTos`, which is the only writer to the
 * acceptance ledger.
 *
 * The crew's version of this was written inline in `src/app/vendor/page.tsx`
 * and was the only one that existed. Copying that JSX into two more routes is
 * how the three doors end up recording three slightly different things — which
 * is exactly the failure the ledger's single-source rule exists to prevent, one
 * level up.
 *
 * `next` is where they were going. It is passed through `acceptTos`, which
 * refuses anything that is not a local path.
 */
export function TermsGate({
  heading,
  intro,
  next,
  cta = "I agree — continue",
}: {
  heading: string;
  /** One line saying why they are seeing this, in their own situation. */
  intro?: string;
  next: string;
  cta?: string;
}) {
  return (
    <div className="wrap" style={{ paddingTop: 24, paddingBottom: 48, maxWidth: 560 }}>
      <div className="ll-card ll-card-pad">
        <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>{heading}</h2>
        {intro && (
          <p className="mut" style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 14px" }}>
            {intro}
          </p>
        )}

        <TermsBody />

        <form action={acceptTos}>
          <input type="hidden" name="next" value={next} />
          <button className="ll-btn" type="submit" style={{ marginTop: 6 }}>
            {cta}
          </button>
        </form>

        <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.6, margin: "12px 0 0" }}>
          We keep a copy of exactly these words and the date you agreed to them,
          so this page can always be shown back to you as it was.
        </p>
      </div>
    </div>
  );
}
