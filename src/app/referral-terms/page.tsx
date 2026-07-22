import Link from "next/link";
import type { Metadata } from "next";
import { TopBar } from "@/components/Brand";
import { getPlatformSettings } from "@/lib/settings";

/**
 * Plain-English referral program terms — the compliance page that must
 * exist before the program scales publicly (single-level, collected-money
 * only, no signup pay, credits are rebates not income). Every number on
 * this page is read from the live platform dials (rule 8), so the terms
 * can never drift from what the machine actually pays. Attorney review is
 * still the gate before any paid-rep expansion; this page states the
 * program as built.
 */

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Referral program terms — plain English | LakeLife",
  description:
    "How LakeLife referral credits and crew earnings work: who earns what, when it pays, and the ground rules. No fine print games.",
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default async function ReferralTermsPage() {
  const s = await getPlatformSettings();

  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 48, maxWidth: 680 }}>
        <div className="ll-eyebrow">The thank-you program</div>
        <h1 style={{ fontSize: 28, margin: "6px 0 8px" }}>Referral program terms, in plain English</h1>
        <p className="mut" style={{ fontSize: 14.5, marginBottom: 20 }}>
          One page, no fine-print games. This is exactly how the program works — the numbers below
          are the live program settings, not marketing copy.
        </p>

        <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Refer a neighbor 🌊</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            When a homeowner joins through your link and books services, you earn{" "}
            <b>{pct(s.referralCustomerPct)} of what they actually pay</b> for their first{" "}
            {s.referralSunsetDays} days on LakeLife — as <b>credits on your own LakeLife bills</b>,
            not cash. Each credit becomes spendable {s.referralMaturationDays}{" "}days after their
            payment clears (that&apos;s our refund window), and then applies automatically the next
            time you&apos;re billed. Credits are a discount on your own service — they&apos;re not
            income, so there&apos;s nothing to report and no tax forms.
          </p>
        </div>

        <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Bring your crew aboard 🛠️</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            If you connect us with a contractor and they join and complete jobs, you earn{" "}
            <b>{pct(s.referralCrewSharePct)} of LakeLife&apos;s collected service fee</b> on their
            work, up to a lifetime total of <b>${s.referralCrewCap}</b>{" "}per crew you bring — paid
            the same way, as credits on your own bills. The reward scales with the work they
            actually do, so it&apos;s real money for a real introduction.
          </p>
        </div>

        <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Crews: bring your customer book 📗</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            When a crew imports their existing customers and those homeowners join, the crew earns
            a <b>{pct(s.referralCrossSellPct)}{" "}finder&apos;s fee on collected revenue from services
            the crew doesn&apos;t perform itself</b> — your mowing customer books a pier install,
            you get a cut of work you never had to do. You never earn a fee on your own jobs
            (you&apos;re already paid your full rate for those). Crew referral earnings pay out in
            the month-end batch alongside regular job earnings and appear on the same 1099.
          </p>
        </div>

        <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }} id="hoa">
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Lake associations 🎆</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            A lake association with a LakeLife partnership earns the neighbor rate
            ({pct(s.referralCustomerPct)} of collected spend) on homeowners who join{" "}
            <b>through the association&apos;s own link</b> — never on the whole lake automatically.
            It accrues as a donation to the association, pays out month-end, and the running total
            shows publicly on the lake&apos;s page. Fireworks fund themselves.
          </p>
        </div>

        <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>The ground rules</h3>
          <ul className="mut" style={{ fontSize: 14, margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li><b>One level, period.</b> You earn on people you personally refer — never on who <i>they</i> refer. This is a thank-you program, not a downline.</li>
            <li><b>Only on money actually collected.</b> Nothing accrues for signups, clicks, or bookings that don&apos;t complete and get paid. If a payment is refunded inside the {s.referralMaturationDays}-day window, the matching reward is cancelled too.</li>
            <li><b>No buying in.</b> Joining the program costs nothing and never will.</li>
            <li><b>Self-referrals don&apos;t count</b>, and gaming the program (fake accounts, circular referrals) voids the earnings involved.</li>
            <li><b>First link wins.</b> A new member is credited to whoever&apos;s link they joined through, once, permanently.</li>
            <li><b>Rates can change going forward.</b> We may adjust percentages, caps, and windows, or end the program — but anything you&apos;ve already earned under the old terms is honored.</li>
            <li><b>This isn&apos;t a job.</b> Participating doesn&apos;t make you an employee, agent, or representative of LakeLife.</li>
          </ul>
        </div>

        <p className="mut" style={{ fontSize: 13, marginBottom: 18 }}>
          Questions? Email <a href="mailto:hello@lakelife.ai">hello@lakelife.ai</a> — a human reads it.
        </p>
        <Link className="ll-btn gold" href="/book" style={{ minHeight: 46, display: "inline-flex", alignItems: "center", padding: "0 20px" }}>
          Grab your link & start sharing 🌊
        </Link>
      </main>
    </>
  );
}
