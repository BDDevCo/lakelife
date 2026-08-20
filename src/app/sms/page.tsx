import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { CONTACT_EMAIL, LEGAL_ENTITY, LEGAL_VERSION } from "@/lib/legal";

/**
 * THE PAGE THE CARRIERS ACTUALLY READ.
 *
 * A2P 10DLC campaign vetting checks for a public, unauthenticated page that
 * states the program, the message types, frequency, "message and data rates
 * may apply", HELP and STOP, the carrier disclaimer, and a link to a privacy
 * policy. A campaign is commonly rejected for the absence of any one of them.
 *
 * Everything below describes what this codebase actually sends. The message
 * examples are real bodies from the send paths, not invented samples, and the
 * consent sentence is the exact string in `src/lib/sms-consent.ts` that is
 * snapshotted onto the household's record at the moment they tap.
 */

export const metadata: Metadata = {
  title: "Text messages | LakeLife",
  description:
    "What LakeLife texts you, how often, how you consent, and how to stop. Message and data rates may apply.",
};

function H({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 17, margin: "26px 0 6px" }}>{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 15, lineHeight: 1.65, margin: "0 0 10px" }}>{children}</p>;
}

export default function SmsTermsPage() {
  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 56, maxWidth: 680 }}>
        <div className="ll-eyebrow">Messaging</div>
        <h1 style={{ fontSize: 28, margin: "6px 0 8px" }}>Text messages from LakeLife</h1>
        <p className="mut" style={{ fontSize: 13, marginBottom: 18 }}>
          Last updated {LEGAL_VERSION}. {LEGAL_ENTITY}, {""}
          an Indiana company. Questions:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>

        <div className="ll-card ll-card-pad" style={{ marginBottom: 18 }}>
          <P>
            <b>Message and data rates may apply.</b> Reply <b>STOP</b> to any message to stop
            them. Reply <b>HELP</b>, or email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>, for help.
          </P>
        </div>

        <H>Who this is for</H>
        <P>
          LakeLife runs scheduling, photo-verified completion and payment rails for lake-home
          services and for mobile-home parks in northeast Indiana. We text three different
          groups, and each one agrees separately:
        </P>
        <ul style={{ fontSize: 15, lineHeight: 1.65, paddingLeft: 20, margin: "0 0 10px" }}>
          <li>
            <b>Homeowners</b> who book work — you give us your mobile number when you create
            your account and verify it by code.
          </li>
          <li>
            <b>Park residents</b> — you turn texts on yourself, from your own screen. Nobody
            can turn them on for you.
          </li>
          <li>
            <b>Crews</b> — independent contractors who accept work through LakeLife. Your
            number is part of the working relationship you agree to at onboarding.
          </li>
        </ul>

        <H>What we send, and how often</H>
        <P>
          These are operational messages about work you have booked, a visit at your property,
          or rent on your lot. Volume follows your own activity — most people get a few
          messages around each visit, and nothing between visits. A homeowner with one job a
          year gets a handful of messages a year. Message frequency varies.
        </P>
        <ul style={{ fontSize: 15, lineHeight: 1.65, paddingLeft: 20, margin: "0 0 10px" }}>
          <li>Booking confirmations</li>
          <li>A reminder the day before a crew comes</li>
          <li>Completion notices, with a link to the photos of the work</li>
          <li>A request to approve a change a crew found on site, before anything is charged</li>
          <li>Rent reminders and receipts, for park residents</li>
          <li>Route and job messages, for crews</li>
        </ul>
        <p className="mut" style={{ fontSize: 15, lineHeight: 1.65, margin: "0 0 10px" }}>
          Real examples of what arrives:
        </p>
        <div className="ll-card ll-card-pad" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 10 }}>
          <div style={{ marginBottom: 8 }}>
            &ldquo;LakeLife: Weekly mow is done at 4521 Lakeview Dr — 4 photos are in your
            property log. All good: [link] · Something&apos;s off: [link] 🌊&rdquo;
          </div>
          <div>
            &ldquo;LakeLife reminder: Pier removal is scheduled tomorrow (Fri, Nov 6) at 4521
            Lakeview Dr. We&apos;ll text you when it&apos;s done, with photos. 🌊&rdquo;
          </div>
        </div>

        <H>How you say yes</H>
        <P>
          We do not buy, rent or share phone numbers, and we never add a number somebody else
          gave us. Consent is given by the person whose number it is, and we keep a record of
          the exact words they agreed to and when.
        </P>
        <P>
          A park resident turning texts on sees, and agrees to, this sentence:
        </P>
        <div className="ll-card ll-card-pad" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 10 }}>
          &ldquo;Yes — text this number about my lot and my rent at [your park]. Message and data
          rates may apply. I can stop them any time by replying STOP or turning this off
          here.&rdquo;
        </div>
        <P>
          Agreeing to operational texts is <b>not</b> a condition of buying anything, and it is
          separate from any marketing consent — we record those two separately and one never
          implies the other. Your consent is never shared with third parties or affiliates for
          their own marketing.
        </P>

        <H>How to stop</H>
        <P>
          Reply <b>STOP</b> to any message and we will stop texting that number. You can also
          turn texts off from your own screen — homeowners under Notification settings,
          residents on the rent screen — or email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will do it for you.
        </P>
        <P>
          Stopping texts does not close your account or cancel any work. We will keep reaching
          you by email about anything that affects your money or a visit at your property,
          because those are records of a transaction rather than marketing.
        </P>
        <P>
          Reply <b>HELP</b> for help. Carriers supported include AT&amp;T, Verizon, T-Mobile,
          Sprint, US Cellular, and smaller regional carriers.
        </P>

        <H>What we cannot promise</H>
        <P>
          <b>Carriers are not liable for delayed or undelivered messages.</b> A text can fail
          for reasons outside our control, so we do not treat one as proof you were told.
          Anything that affects your money or your property also goes by email, and everything
          is on your screen when you sign in.
        </P>

        <H>Your information</H>
        <P>
          Your number is used to send you these messages and to verify it is yours. It is
          handled by our messaging provider, Twilio, so that messages can be delivered. We do
          not sell it. The{" "}
          <Link href="/privacy">privacy policy</Link> sets out what we collect, who processes
          it, and the rights you have over it.
        </P>

        <p className="mut" style={{ fontSize: 13, marginTop: 26 }}>
          <Link href="/privacy">Privacy policy</Link> · <Link href="/terms">Terms of service</Link>
        </p>
      </main>
    </>
  );
}
