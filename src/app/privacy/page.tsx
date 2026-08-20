import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { CONTACT_EMAIL, LEGAL_ENTITY, LEGAL_STATE, LEGAL_VERSION } from "@/lib/legal";

/**
 * WRITTEN FROM THE SCHEMA, NOT FROM A TEMPLATE.
 *
 * Every category, recipient and retention statement below was checked against
 * the actual tables and send paths on 20 Aug 2026. Where the product does
 * something a boilerplate policy would not mention — customer message content
 * reaching a third-party AI model, and a contact record surviving account
 * deletion — it is stated plainly rather than left out, because the whole point
 * of this document is that somebody can rely on it.
 *
 * NOT LEGAL ADVICE and not a substitute for counsel. The structure is honest
 * and complete; an attorney should review the wording before launch, and the
 * items flagged in docs/legal-open-questions.md need a decision.
 */

export const metadata: Metadata = {
  title: "Privacy policy | LakeLife",
  description:
    "What LakeLife collects, who processes it, how long we keep it, and the choices you have.",
};

function H({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 17, margin: "26px 0 6px" }}>{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 15, lineHeight: 1.65, margin: "0 0 10px" }}>{children}</p>;
}
function UL({ children }: { children: React.ReactNode }) {
  return <ul style={{ fontSize: 15, lineHeight: 1.65, paddingLeft: 20, margin: "0 0 10px" }}>{children}</ul>;
}

export default function PrivacyPage() {
  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 56, maxWidth: 680 }}>
        <div className="ll-eyebrow">Privacy</div>
        <h1 style={{ fontSize: 28, margin: "6px 0 8px" }}>Privacy policy</h1>
        <p className="mut" style={{ fontSize: 13, marginBottom: 18 }}>
          Last updated {LEGAL_VERSION}. {LEGAL_ENTITY}, an {LEGAL_STATE} company. Questions or
          requests: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> — a human reads it.
        </p>

        <div className="ll-card ll-card-pad" style={{ marginBottom: 18 }}>
          <P>
            <b>The short version.</b> We collect what is needed to schedule work at your
            property, prove it was done, and move the money for it. We do not sell your
            information and we do not share it for cross-context behavioural advertising. Card
            numbers never reach our database. You can stop texts any time, and you can delete
            your account from your own screen.
          </P>
        </div>

        <H>Who we are, and who this covers</H>
        <P>
          LakeLife is a third-party administrator: we run the booking, scheduling,
          photo-verification and payment rails that connect lake homeowners with independent
          local crews, and that let mobile-home park owners run their own rent and grounds. The
          services themselves are performed by those independent crews. We never own a park, a
          lot or a home.
        </P>
        <P>
          This policy covers four kinds of people, and what we hold differs for each:
          homeowners who book work, crews who perform it, park owners who run a park on
          LakeLife, and park residents who live on a lot.
        </P>

        <H>What we collect</H>
        <P>
          <b>Because you gave it to us.</b> Your name, email address and mobile number; the
          address of your property, and a nickname for it if you set one; details that make a
          price exact, such as pier sections, lawn size or square footage; and messages you
          send us.
        </P>
        <P>
          <b>Because a job needs it.</b> Photographs a crew takes of the work at your property.
          The approximate location of a property, so a route can be built. A gate or door code
          if you choose to give us one — <b>encrypted at rest, and visible to a crew only on
          the day of their own visit to your property.</b>
        </P>
        <P>
          <b>Because money moved.</b> What was booked, what it cost, what was charged or
          refunded, and when. <b>We never receive or store your card number.</b> Payment
          details are entered directly into our payment processor&apos;s hosted fields; we keep
          only a token and the last four digits, which are enough to charge a card you have
          already approved and not enough to use it anywhere else.
        </P>
        <P>
          <b>If you are a crew.</b> Your business details, your service area and rates, your
          certificate of insurance and your W-9. That W-9 contains an EIN or Social Security
          number: it is stored as an uploaded document in access-controlled storage, is never
          displayed on any screen, and is used only to meet our tax-reporting obligations. Bank
          details for payouts are stored encrypted; we display only the last four digits.
        </P>
        <P>
          <b>If you are a park resident.</b> Your name, lot, and what you owe and have paid.
          Your phone number and email only if you give them to us. Whether you have agreed to
          texts, the exact sentence you agreed to, and the moment you agreed — kept precisely
          so we can show what you were asked.
        </P>
        <P>
          <b>Automatically.</b> A cookie that keeps you signed in, and a cookie remembering
          which of your properties you were last looking at. We do not use advertising cookies
          or third-party trackers, and we do not run analytics that profile you.
        </P>

        <H>What we do with it</H>
        <UL>
          <li>Schedule work, build routes, and tell the right crew where to go and when.</li>
          <li>Show you proof the work was done, and let you say whether it was right.</li>
          <li>Charge for work, pay crews, issue refunds, and keep the records behind those.</li>
          <li>Send you the messages described in our <Link href="/sms">text message terms</Link> and by email.</li>
          <li>Verify your mobile number by sending a one-time code.</li>
          <li>Meet legal, tax and insurance obligations.</li>
        </UL>
        <P>
          We do not sell personal information, and we do not share it for cross-context
          behavioural advertising or targeted advertising. We have never done either.
        </P>

        <H>Who else sees it</H>
        <P>
          <b>Your crew</b> sees what they need to do the job: the address, the service, the
          time, and — only on the day, only for their own visit — a gate code if you gave one.
          A crew never sees what you paid. Prices and our margin are withheld at the data
          layer, not merely hidden on screen.
        </P>
        <P>
          <b>Your park owner</b>, if you rent a lot and book work through LakeLife, sees that a
          crew came to your lot, what they were there to do, and when — the same things they
          could see out of a window. They never see what you paid.
        </P>
        <P>
          <b>Service providers</b> who process data so the product can function, and who are
          permitted to use it only for that purpose:
        </P>
        <UL>
          <li><b>Supabase</b> — database, authentication and file storage.</li>
          <li><b>Vercel</b> — application hosting.</li>
          <li><b>Twilio</b> — text messages and phone verification.</li>
          <li><b>Resend</b> — email delivery.</li>
          <li><b>Anthropic</b> — see the next section.</li>
          <li>A <b>payment processor</b>, once card payments are live, which receives card details directly from you and never through us.</li>
        </UL>
        <P>
          We may also disclose information where the law requires it, to protect someone&apos;s
          safety, or in connection with a sale or transfer of the business — in which case this
          policy travels with it.
        </P>

        <H>Automated drafting, and what reaches it</H>
        <P>
          When you message us, our operations team may use an AI model provided by Anthropic to
          triage the message and draft a reply. To do that, the content of your message and a
          summary of your account — your properties, the services you have booked, upcoming
          visits and any credits — is sent to Anthropic&apos;s API.
        </P>
        <P>
          Two limits on that, which are enforced in code rather than by policy: messages that
          touch money, anger or legal exposure are never sent to the model at all, and{" "}
          <b>a person reviews and approves every drafted reply before it is sent to you.</b>{" "}
          Nothing about you is used to train a model.
        </P>

        <H>How long we keep it</H>
        <P>
          While your account is open, we keep what the product needs. Records of money — bills,
          payments, refunds and payouts — are kept for as long as tax and accounting rules
          require, typically seven years, even after an account closes.
        </P>
        <P>
          <b>You can delete your account yourself</b>, from Property profile. Doing so removes
          your login and, with it, your properties, jobs, photos, messages and the rest of your
          household data. <b>One thing survives on purpose:</b> we retain your name, email,
          phone and lake on a contact list, along with the fact that you closed your account.
          If you would rather we did not keep that either, email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will remove it.
        </P>

        <H>Your choices and rights</H>
        <UL>
          <li><b>Texts</b> — reply STOP to any message, or turn them off on your own screen. See the <Link href="/sms">text message terms</Link>.</li>
          <li><b>Email</b> — choose which kinds you receive under Notification settings. Receipts and invoices always send, because they are records of money.</li>
          <li><b>Access and correction</b> — most of what we hold is on your own screens and editable there. For anything else, ask us.</li>
          <li><b>Deletion</b> — delete your account from Property profile, or ask us.</li>
          <li><b>A copy of your data</b> — ask us and we will provide it.</li>
        </UL>
        <P>
          Depending on where you live, you may have rights under a state privacy law — including
          Indiana&apos;s Consumer Data Protection Act — to confirm what we hold, correct it,
          delete it, obtain a portable copy, and to appeal if we refuse. We honour these
          requests regardless of whether a given law applies to a business of our size, and we
          will not treat you differently for making one. Email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>; we will verify that the
          request is yours before we act on it, and respond within 45 days.
        </P>

        <H>Security</H>
        <P>
          Access is controlled at the database layer, so a screen that should not show
          something cannot be persuaded to. Gate codes and crew bank details are encrypted at
          rest. Card numbers never reach us. Photographs and documents are served through
          short-lived signed links rather than public URLs. No system is perfect, and we do not
          claim otherwise — if a breach affects you we will tell you, and we will tell you what
          we actually know rather than what is comfortable.
        </P>

        <H>Children</H>
        <P>
          LakeLife is for adults arranging work on property. It is not directed to children
          under 13 and we do not knowingly collect their information. If you believe a child
          has given us information, email us and we will delete it.
        </P>

        <H>Changes</H>
        <P>
          If we change how we handle your information we will update this page and its date. If
          the change is significant, we will tell you rather than rely on you noticing.
        </P>

        <p className="mut" style={{ fontSize: 13, marginTop: 26 }}>
          <Link href="/sms">Text message terms</Link> · <Link href="/terms">Terms of service</Link>
        </p>
      </main>
    </>
  );
}
