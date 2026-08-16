# A2P 10DLC registration — what to fill in, and what to bring back

**Status: BLOCKED on this, and it has been blocking silently since July.**
Not a future limitation — a live outage nobody could see.

Written 2026-08-16, after texting a real handset for the first time.

---

## Why it matters, in messages

Twilio's own delivery log, checked 16 Aug 2026:

| | Count |
|---|---|
| Messages sent since 19 July | **81** |
| Delivered | **0** |
| Rejected — error 30034, sender not registered for A2P 10DLC | 66 |
| Rejected — error 21268, a reserved service line (pre-dates the recipient gate) | 15 |

The 66 are real operational messages: booking confirmations, crew dispatch,
Autopilot mowing reminders, a crew reporting pier damage, a "this doesn't match
your profile" alert. Every one accepted by Twilio, every one dropped by the
carrier.

**Twilio Verify codes are unaffected** and do arrive — they go out on Twilio's
own managed sender pool, not the 10DLC long code. That is why sign-in works,
why the resident text opt-in works, and why this stayed hidden: the only SMS
anybody ever confirmed receiving was a Verify code.

Until this clears, **SMS is a dead channel for everyone** — residents, crews and
customers. Email and paper carry everything. The invite path and the printed
slip already assume that.

---

## Step zero: the entity. This is the real gate.

Registration is a **business** registration. It needs a legal entity name and an
**EIN that matches IRS records exactly**.

The launch plan (§ weeks 1–2) still lists "form the LakeLife entity, open the
bank account, start processor underwriting" as open. **That same entity + EIN is
what the payment processor underwrites.** Forming it unblocks both of the
externally-blocked items at once — texting and card processing. Nothing below
can start without it.

Sole-proprietor registration is possible and is a worse deal: materially lower
throughput and more restrictions. With an EIN, register as the company.

---

## Then two registrations, in order

Console path is roughly **Messaging → Regulatory Compliance → A2P 10DLC**.
Twilio moves things; follow what is on screen. Expect a one-time brand vetting
fee and a small monthly campaign fee, both modest — confirm current numbers in
the console rather than trusting this file.

### 1. The Brand — who you are

Legal name, EIN, business address, website, contact name/email/phone, entity
type, industry. Twilio passes it to The Campaign Registry, which checks it
against public records.

**Almost every rejection here is the same mistake: the legal name or EIN does
not match the IRS letter exactly.** Copy both character-for-character off the
CP-575 or the state formation document. Not from memory, not as it appears on
invoices.

### 2. The Campaign — what you send, and how they agreed

**Use case:** Mixed, or Low Volume Mixed. The traffic genuinely is several kinds
— appointment reminders, account notifications, and two-factor.

**Opt-in description.** This is where campaigns get rejected far more than
anywhere else. Every sentence below is true of the code as it stands, so it can
be defended if they ask:

> Recipients are existing customers, contracted service crews, and residents of
> mobile-home parks we administer. Every number is provided by the person
> themselves and verified with a one-time code sent to that handset before any
> message is sent. Residents additionally tick an explicit consent line, which
> is stored verbatim with a timestamp against their record. Numbers obtained
> from third-party records — for example a rent roll supplied by a park — are
> stored in a separate field and are never used for messaging. Consent can be
> withdrawn in one tap in the app or by replying STOP.

Where each claim lives, if they want proof:

| Claim | Enforced by |
|---|---|
| Number verified by one-time code | `startTextOptIn` / `confirmTextOptIn`, Twilio Verify |
| Explicit consent line, stored verbatim | `park_renters.sms_consent_text` (0133) |
| Third-party numbers never messaged | `phone_on_file_with_park`, never a send target; `planChannels` |
| A changed number loses its proof | trigger `park_renters_claim_stamp` (0135/0136) |
| One tap to withdraw | `stopTexts`, clears consent immediately |

**Sample messages — use these, they are real traffic.** Reviewers compare
samples against what actually sends, so invented ones are a risk:

- `LakeLife: Housekeeping is booked for Friday, August 21. We'll text you when a crew is on the way. 🌊`
- `LakeLife reminder: Pier install is scheduled tomorrow (Aug 22) at 9am. We'll text you when it's done, with photos. 🌊`
- `LakeLife: $149 for your Lawn mowing is on its way back to your card — allow a few business days. 🌊`
- `Cedar Bend: you can see lot 14 — your rent and receipts — here: https://lakelife.ai/parks/welcome?t=… Reply STOP to opt out.`

Keep "Reply STOP to opt out" in at least one sample. Twilio enforces STOP
automatically at their end, so the promise in the app copy is already true —
reviewers simply like seeing it in a body.

### 3. Link the +1 260 number to the campaign.

---

## The code change afterwards

`sendSms` currently sends from `TWILIO_PHONE_NUMBER` directly. Campaigns attach
to a **Messaging Service**, and sending through it is what gets the registered
throughput.

One change, in `src/lib/sms.ts`: `messagingServiceSid` instead of `from`, and a
new env var. Bring back the **Messaging Service SID** and it is a ten-minute job.

---

## How you will know it worked

The ops console has an **SMS health** panel reading Twilio's delivery log
directly. Today it says:

> **TEXTS · NOTHING IS ARRIVING** — 0 of 81 delivered

When registration clears, that number starts climbing on its own. Nothing to
configure, and it is the same panel that would have caught this in July.

---

## What to bring back

1. Brand status — approved, or the exact rejection reason.
2. Campaign status, and the **Messaging Service SID**.
3. Whether they assigned a throughput tier, and what it is.
4. Confirmation the +1 260 number is linked to the campaign.
