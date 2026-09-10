import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkEnquiryForm } from "@/components/ParkEnquiryForm";

export const metadata = {
  title: "LakeLife for mobile-home parks",
  description:
    "Rent, shared costs, work orders and the crews who do the work — for mobile-home and RV parks.",
};

/**
 * THE PARK OWNER'S DOOR.
 *
 * lakelife.ai is written for a lake house — "House, lawn, dock, lift, boat and
 * toys" — and until now the word "park" appeared nowhere on it. A park owner
 * who heard about this had nowhere to land at all.
 *
 * DELIBERATELY NOT UNDER /parks. That namespace is the RESIDENT's (the code
 * comments in parks/claim and parks/my both say so explicitly, against /park
 * which is the owner's portal). This is neither: it is a page for somebody who
 * is not yet a customer.
 *
 * IT PROMISES A CONVERSATION, NOT A SIGNUP, because that is what actually
 * happens: nothing in this product creates a park. There is no INSERT on
 * `parks` or `park_members` anywhere in `src`, by design — every park is set
 * up by hand. A "Get started" button would be a lie about the next step.
 */
export default function ForParksPage() {
  return (
    <>
      <TopBar />
      <main>
        <section className="wrap" style={{ paddingTop: 32, paddingBottom: 8 }}>
          <div className="ll-eyebrow">FOR PARK OWNERS</div>
          <h1 style={{ fontSize: 30, margin: "6px 0 10px", textWrap: "balance" }}>
            The rent, the shared costs, and the people who do the work.
          </h1>
          <p className="mut" style={{ fontSize: 15.5, lineHeight: 1.65, maxWidth: "60ch" }}>
            LakeLife runs the money and the work for mobile-home and RV parks. Rent
            goes out on a schedule and gets recorded whether it arrives by card,
            cheque or cash across the office counter. Shared costs get split across
            the lots that should carry them. And when something needs mowing,
            ploughing or fixing, the crew who turns up is booked, priced and paid
            through the same system.
          </p>
        </section>

        <section className="wrap" style={{ paddingTop: 8, paddingBottom: 8 }}>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            {/* Three claims, each one a thing the product actually does today.
                Nothing here describes work that is not built — the temptation
                on a page like this is to describe the roadmap. */}
            <div className="ll-card ll-card-pad">
              <div className="ll-pill teal">RENT</div>
              <p style={{ fontSize: 14, lineHeight: 1.6, margin: "10px 0 0" }}>
                Bills raised on a schedule, per lot. Cash and cheques recorded the
                way you take them now — a resident says they paid, you confirm it,
                and only that credits the bill.
              </p>
            </div>
            <div className="ll-card ll-card-pad">
              <div className="ll-pill teal">SHARED COSTS</div>
              <p style={{ fontSize: 14, lineHeight: 1.6, margin: "10px 0 0" }}>
                Water, sewer, trash, common electric and grounds, split across the
                lots that carry them, with the bill it came from attached.
              </p>
            </div>
            <div className="ll-card ll-card-pad">
              <div className="ll-pill teal">THE WORK</div>
              <p style={{ fontSize: 14, lineHeight: 1.6, margin: "10px 0 0" }}>
                Mowing, ploughing and repairs, booked to insured crews at a price
                you set, with photographs before the job counts as done.
              </p>
            </div>
          </div>
        </section>

        <section className="wrap" style={{ paddingTop: 24, paddingBottom: 48 }}>
          <h2 style={{ fontSize: 20, margin: "0 0 6px" }}>Tell us about your park</h2>
          <p className="mut" style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 16px", maxWidth: "60ch" }}>
            There is no instant signup, and that is on purpose — every park is set
            up by hand so the lots, the rents and the shared costs are right before
            anybody is billed. Two fields are all we need to start.
          </p>
          <ParkEnquiryForm />

          <p className="mut" style={{ fontSize: 13, marginTop: 18, lineHeight: 1.6 }}>
            Renting a lot in a park rather than running one?{" "}
            <Link href="/parks/claim">Find your lot</Link>. Looking after a lake
            house? <Link href="/">Start here</Link>.
          </p>
        </section>
      </main>
    </>
  );
}
