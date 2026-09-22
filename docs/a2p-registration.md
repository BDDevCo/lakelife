# A2P 10DLC — approved. What that changes, and what it doesn't.

**Status: APPROVED, as reported by the owner on 22 September 2026.**

That sentence is his report, written down as his report. Nobody here has
opened the Twilio console, so this file does not claim it as a verified fact.

**What would verify it** — two screens, both read-only:

1. Twilio Console → **Messaging → Regulatory Compliance → A2P 10DLC**. The
   campaign row reads **Approved** (Twilio has also used "Active" and
   "Verified" for this over the past year — what matters is that it is not
   *Pending*, *In review* or *Failed*).
2. The **Messaging Service** the campaign is attached to has our +1 260 number
   in its **Sender Pool**. A campaign approved with no number attached sends
   nothing.

Until one real message has been delivered and its receipt recorded, approval
is the only thing that is true. **Approval is not delivery**, and no sentence
anywhere on the site may promise a customer a text until the product can show
that a text arrived.

---

## What the outage was

Twilio's own delivery log, read on 16 August 2026:

| | Count |
|---|---|
| Messages sent since 19 July 2026 | **81** |
| Delivered | **0** |
| Rejected — error 30034, sender not registered for A2P 10DLC | 66 |
| Rejected — error 21268, a reserved service line | 15 |

The 66 were real operational messages: booking confirmations, crew dispatch,
Autopilot mowing reminders, a crew reporting pier damage, a "this doesn't match
your profile" alert. Every one accepted by Twilio. Every one dropped by the
carrier.

**It hid for two months for two separate reasons, and both are now fixed in
code.**

*The first: one question answered for two transports.* Twilio carries our
texts on two completely different channels. The **Verify** channel sends the
six-digit codes and rides Twilio's own managed sender pool — it never stopped
working. The **Messaging** channel sends everything else and rides our own
number, which carriers reject until the campaign is registered. A single
`hasTwilioEnv()` answered *yes* on the Verify credentials, and every screen
read that as "texting works". The only text anybody ever confirmed receiving
was a sign-in code. That predicate is now two: `hasTwilioVerifyEnv()` and
`hasTwilioMessagingEnv()` (`src/lib/env.ts`), and each caller asks the one it
means.

*The second: accepted was recorded as sent.* `sendSms` returns the moment
Twilio **accepts** a message. The carrier's verdict arrives seconds later, out
of band, and this app had nowhere for it to land — so all 81 rejections were
recorded by this product as successes. The delivery-receipt table and the
status callback that fills it are being built now (`lib/sms-receipts.ts`,
`api/twilio/status`, migration 0171).

---

## The three things still between us and a promise

**1. `TWILIO_MESSAGING_SERVICE_SID` set in Vercel production.** Not done here —
it is a credential, and nobody but the owner touches those. The steps are
below.

**2. One real message delivered, and its receipt recorded.** Approval fixes the
sender. It does not prove a handset ever rang.

**3. The copy sweep.** Every sentence in the product that says we will text
somebody has to be read again against what is true on the day it ships.

---

## Putting the Messaging Service SID in — the one step only you can do

This is the single value that has to move from one website to another. There is
no way for the software to fetch it for you: Twilio will only show it to
somebody signed in to the Twilio account, and Vercel will only accept it from
somebody signed in to Vercel. **Use the copy button on each screen. Do not
retype it by hand** — it is thirty-four characters, "MG" and then thirty-two
of hex, and a single wrong one fails silently.

Twilio and Vercel both move their menus around. The labels below are what to
look for; if a menu has been renamed, the thing you are looking for is still
the same thing.

### In Twilio — find the value

1. Sign in at **console.twilio.com**.
2. Left menu: **Messaging → Services**. (Not "Phone Numbers". A Messaging
   Service is a different object from the number inside it.)
3. Click the service the approved campaign is attached to. If there is more
   than one, the right one is the one whose **Sender Pool** contains our
   +1 260 number.
4. At the top of that page is a line labelled **Messaging Service SID**,
   beginning with the two letters **MG**. Next to it is a **copy icon**.
   Click the copy icon. Do not select the text and retype it.

### In Vercel — put it in

5. Sign in at **vercel.com** and open the project that serves www.lakelife.ai.
6. **Settings → Environment Variables**.
7. **Key:** type `TWILIO_MESSAGING_SERVICE_SID` — exactly that, capitals and
   underscores, no spaces before or after.
   **Value:** paste. Do not type.
8. Environments: tick **Production**. (Tick Preview too if you want the staging
   copies to text as well; leave Development alone.)
9. **Save**.

### Then — and this is the step people skip

10. **Redeploy.** A running deployment keeps the settings it was built with, so
    saving the variable changes nothing on the live site by itself. Go to
    **Deployments**, find the top row (the current production one), open the
    **⋯** menu on the right and choose **Redeploy**. Leave "use existing build
    cache" as it comes. Wait for the row to go green.

### Then — check you got it right, without reading the value back

11. Open **https://www.lakelife.ai/ops/texting** signed in as yourself.

That page reads the live settings, Twilio's own message log and the parks
table, every time you open it. What you are looking for:

- The **Notifications** panel says **configured**, and underneath it,
  "TWILIO_MESSAGING_SERVICE_SID is set on this server."
- The amber warning about a bare phone number is **gone**. While that warning
  is showing, the site is still sending on the unregistered number — the exact
  setting the outage ran on.
- **The Codes panel is not the answer.** It was green all through the outage.
- **No red box about delivery verdicts.** If the page says *"No delivery
  verdicts are being recorded"*, the SID is not the problem — `NEXT_PUBLIC_SITE_URL`
  is. Carriers only report back whether a message actually arrived when that
  variable is a real https address (it should be `https://www.lakelife.ai`), and
  without it every message sits at "queued" for ever. That matters more than it
  sounds: a delivery report of zero failures and a channel nobody is watching
  look exactly the same from here, which is the shape the whole outage had.
  Fix it the same way as step 7 — same screen, same redeploy.

If the Notifications panel still says *not configured* after a redeploy, one of
three things happened: the key is misspelled, Production was not ticked, or the
redeploy has not finished. The page never shows the value, so a wrong value
looks exactly like a right one from here — that is what step 12 is for.

12. **Get one real text sent to your own phone**, then reload `/ops/texting`.

**There is no "send a test text" button in the product, and this file is not
going to pretend there is.** The honest way to produce one is to make the
product do its ordinary job at yourself: book a service on your own account —
the one carrying your own verified mobile — and then schedule it from the ops
console. Scheduling texts the customer and the crew, and the customer on that
booking is you.

Do not reach for one of the example accounts to do this. Every one of them
carries a 555 number, the product refuses to text those on purpose, and the
refusal is not a delivery failure — it never reaches a carrier and leaves no
row in Twilio's log at all.

On `/ops/texting`, the **Last text attempted** line then names the time and
Twilio's own word for what happened. **Delivered** is the word you want. If it
says *undelivered* or *failed*, the line underneath says why in plain English —
and a rejection that still mentions registration means our number is not in the
approved campaign's sender pool, which is a Twilio-side fix, not a Vercel one.

Only after a real message comes back **delivered** may item 2 above be ticked,
and only then may any sentence on the public site promise a text.

---

## What does NOT change when the SID goes in

Worth knowing before the first text goes out, because each of these looks like
a fault and is not.

- **The park notice hold stays on.** `parks.notices_held_at` is checked inside
  both `sendSms` and `sendEmail` and fails closed. The Haven has been holding
  since 26 August 2026 — "Held on setup — lift it when the roll is loaded and
  the leases are executed." While it holds, **no text and no email reaches a
  single household there**, and from the delivery log that is indistinguishable
  from texting being broken. `/ops/texting` names every holding park for
  exactly this reason. Nothing about Twilio lifts that hold; only you do.
- **Park invites still go by email alone.** `planChannels` will only text a
  number the resident gave us and confirmed, with consent recorded. Nothing
  writes `mobile_verified_at` or `sms_consent_operational_at` for an imported
  household, so in practice no household from a roll qualifies. That gate is
  about consent, not about the carrier, and registration does not open it.
- **Verify codes carry on exactly as they did.** They never used the 10DLC
  number.

---

## The registration file, for the record

Kept because a campaign can be re-reviewed, and these are the answers that
were given.

**The entity.** LAKELIFE AI, LLC — Indiana domestic single-member LLC, Business
ID 202608172029158, effective 17 August 2026. EIN assigned the same day; the
CP-575 is in OneDrive under LakeLife/Corporate Docs. Where a form asks for the
name as it appears with the IRS, it is **LAKELIFE AI**, with no "LLC" — the
state registered the designator, the CP-575 does not carry it, and the IRS name
control is LAKE.

**Use case:** Mixed, or Low Volume Mixed.

**Opt-in description**, as filed. Every sentence is true of the code:

> Recipients are existing customers, contracted service crews, and residents of
> mobile-home parks we administer. Every number is provided by the person
> themselves and verified with a one-time code sent to that handset before any
> message is sent. Residents additionally tick an explicit consent line — the
> box is unticked by default and the button will not send without it — and that
> line is stored verbatim with a timestamp against their record. Numbers obtained
> from third-party records — for example a rent roll supplied by a park — are
> stored in a separate field and are never used for messaging. Consent can be
> withdrawn in one tap in the app or by replying STOP.

Where each claim lives, if a reviewer asks for proof:

| Claim | Enforced by |
|---|---|
| Number verified by one-time code | `startTextOptIn` / `confirmTextOptIn`, Twilio Verify |
| An unticked box, which gates the button | `TextOptIn`, `agreed` state — a screen check, not a server one |
| Explicit consent line, stored verbatim | `park_renters.sms_consent_text` (0133) |
| Third-party numbers never messaged | `phone_on_file_with_park`, never a send target; `planChannels` |
| A changed number loses its proof | trigger `park_renters_claim_stamp` (0135/0136) |
| One tap to withdraw | `stopTexts`, clears consent immediately |

The tick is on the screen, not in the database, and the row above says so
deliberately. What the database enforces is stronger and separate: consent is
written only after a code sent to that handset comes back approved, and only
against the file belonging to the signed-in account.

**One thing that table still cannot say.** `/api/verify/start` — the sign-up
route, not the resident opt-in — still lacks the reserved-number guard that
`startTextOptIn` has. It is a separate path and does not affect the opt-in
described above, but do not claim otherwise if asked.

**Sample messages**, as filed — real traffic, which is what reviewers compare
against:

- `LakeLife: Housekeeping is booked for Friday, August 21. We'll text you when a crew is on the way. 🌊`
- `LakeLife reminder: Pier install is scheduled tomorrow (Aug 22) at 9am. We'll text you when it's done, with photos. 🌊`
- `LakeLife: $149 for your Lawn mowing is on its way back to your card — allow a few business days. 🌊`
- `Cedar Bend: you can see lot 14 — your rent and receipts — here: https://lakelife.ai/parks/welcome?t=… Reply STOP to opt out.`
