# LakeLife User Agreement — DRAFT FOR COUNSEL REVIEW

> **SUPERSEDED (2026-07-23):** the owner's clean counsel draft
> (docs/user-agreement-counsel-draft-v2.txt) replaces this v1. v1 is kept
> as the mechanics-source history. The v2 mechanics were audited against
> the production system on 2026-07-23 — see
> docs/tos-implementation-checklist.md for the three app-side items v2
> commits us to before adoption.

**Status:** Draft v1 for attorney redline — NOT in effect.
**Prepared:** July 23, 2026, from the platform as built (every mechanic described
below is how the software actually behaves today).
**Replaces:** the beta terms ("tos-v0-beta") currently accepted in-app.

---

## MEMO TO COUNSEL — what we need from you

The operative mechanics in this draft describe a working system and should not
change. What we need is your legal armor and judgment on the following, each
flagged inline as **[NOTE TO COUNSEL #]**:

1. **Limited payment agent clause (§7).** The load-bearing clause. LakeLife
   collects from Customers and pays Crews; Customer's payment to LakeLife must
   fully discharge the Customer's payment obligation to the Crew. Please
   confirm this (a) holds up, and (b) keeps LakeLife outside money-transmitter
   licensing, given funds flow: card processor → LakeLife settlement account →
   ACH to Crew.
2. **Limitation of liability & disclaimers (§16).** Caps, consequential-damages
   waiver, and the administrator (non-provider) disclaimer.
3. **Indemnification (§15).** Crew indemnifies Customer and LakeLife for the
   work; scope and carve-outs are yours.
4. **Dispute resolution (§17).** Arbitration + class-action waiver vs. courts;
   venue and governing law (Indiana; county TBD).
5. **Storage bailment (§10).** Custody sits with the Crew (bailee), never
   LakeLife. Please confirm characterization, and advise on lien/abandonment
   rights for unpaid or unclaimed stored boats.
6. **Independent-contractor posture (§11).** The facts are baked in (Crews set
   their own rates, tools, schedules, service areas, and may run multiple
   trucks/employees). Strengthen as you see fit.
7. **Communications consent (§14).** TCPA-compliant SMS consent wording.
8. **Insurance minimums (§11.2).** Amounts bracketed — advise on GL and
   garagekeepers limits.
9. **Indiana consumer statutes.** Some services may fall under the Indiana Home
   Improvement Contracts Act or similar consumer statutes — please advise
   whether any disclosures must be added to the booking flow.
10. **Entity block.** Legal entity name/state bracketed throughout as
    **[LAKELIFE ENTITY]**.

---

## 1. Agreement and acceptance

These Terms are a single agreement accepted by every user of the LakeLife
platform — homeowners and property owners ("**Customers**") and independent
service businesses ("**Crews**"). You accept by tapping "Agree" in the app,
which is required **before your first booking** (Customers) or **before going
live** (Crews). If we materially update these Terms, you will be asked to
accept the updated version before your next booking or job. Continued use
after acceptance constitutes agreement.

## 2. Definitions

- "**LakeLife**," "we," "us" — **[LAKELIFE ENTITY]**, operator of the platform.
- "**Platform**" — the LakeLife website, app, booking, scheduling, dispatch,
  photo-verification, messaging, and payment systems.
- "**Services**" — lake-home services listed on the Platform (e.g., lawn care,
  housekeeping, pier and lift work, winterization, hauling, boat storage),
  performed by Crews, not by LakeLife.
- "**Service Agreement**" — the agreement formed directly between a Customer
  and a Crew when a job is booked and accepted, on the terms in this document.
- "**All-In Price**" — the single total price shown to the Customer at booking.

## 3. LakeLife's role: third-party administrator

LakeLife is a **third-party administrator**. We operate the rails — booking,
crew matching, scheduling, routing, photo verification, records, and payment
processing — that connect Customers with independent Crews. **LakeLife does
not perform Services, does not employ Crews, and is not a party to the Service
Agreement** except in the limited payment agent capacity described in §7.
LakeLife's verification role is limited to the document checks described in
§11.2; LakeLife does not supervise, direct, or control any Crew's work.

## 4. The Service Agreement is between Customer and Crew

When a job is booked and a Crew is assigned (or claims the job), a Service
Agreement is formed **directly between that Customer and that Crew**, on these
shared Terms. Both sides have already accepted these Terms, which serve as the
standing rules of that relationship: one All-In Price, photo-verified
completion, payment released only after the work is done. Any claim arising
from the performance of a Service is between the Customer and the Crew (see
§15–16).

## 5. Accounts

Every account requires a working email address and an SMS-verified mobile
number before first booking. You agree to keep account and property
information accurate (lot, pier sections, boats, engines, access notes) —
pricing and crew safety depend on it. Accounts are personal; you are
responsible for activity under your login. You may delete your account and
data from the Platform at any time, subject to completing open jobs and
settling amounts owed.

## 6. Booking, pricing, and payment (Customers)

**6.1 All-In Price.** The price shown at booking is the complete price for the
Service. Prices come from the Platform's published menu at the time of booking
and are calculated from your property profile.

**6.2 Card on file; automatic charge.** A valid payment card is required.
By booking you authorize LakeLife to charge your card **when the job is
completed and photo-verified**, and for any other amounts you authorize under
these Terms (cancellation fees, storage per-diem, accepted price offers).
Card data is handled by our payment processor; LakeLife does not store card
numbers. A receipt is sent for every charge.

**6.3 Price offers you may accept (never imposed).** In limited cases the
Platform may *offer* — never impose — a price change: a **scarcity offer**
(add a stated amount to unlock a crew when none is available at the listed
price) or a **same-day rush premium** (a stated surcharge for same-day
service). These take effect only if you accept them in the app.

**6.4 Autopilot.** If you enroll a service in Autopilot, your price is locked
at enrollment and each proposed visit is confirmed by you (one tap) before it
is booked. You may disable Autopilot at any time.

**6.5 Credits.** Referral and promotional credits are **rebates applied to
future purchases** on the Platform. They have no cash value, are not
transferable or redeemable for cash, and apply automatically at billing.

## 7. Payments to Crews; LakeLife as limited payment agent

**[NOTE TO COUNSEL #1 — this is the clause we most need hardened.]**

Each Crew appoints LakeLife as its **limited agent solely for the purpose of
collecting payment from Customers** for Services performed under a Service
Agreement. **A Customer's payment to LakeLife fully discharges the Customer's
payment obligation to the Crew** for that Service, as if paid directly to the
Crew. LakeLife remits amounts owed to Crews per §11.4. LakeLife's agency is
limited to payment collection and remittance; it does not extend to the
performance of Services.

## 8. Cancellations (Customers)

- Cancelling a request that has **no crew assigned yet** is always free.
- Once a crew is scheduled: cancellation is free outside the notice window
  displayed at booking (currently 48 hours for routine services and 7 days for
  water work such as pier, lift, and boat services). Inside the window, a
  **late-cancellation fee** (currently 25% of the All-In Price) applies,
  charged to your card on file; a share is paid to the scheduled Crew for the
  reserved slot. Current windows and percentages are always displayed in the
  cancellation flow before you confirm.

## 9. Photo verification and property access

**9.1 Photos.** Every completed job requires a minimum number of photos of the
work performed. Customers consent to photos of the serviced areas of their
property being taken, stored, and shared with them and with LakeLife for
verification, quality, and dispute purposes.

**9.2 Access; gate and door codes.** Codes a Customer stores on the Platform
are encrypted and are made visible to a Crew **only on the day of that Crew's
scheduled job at that property**. Crews may use access information solely to
perform the scheduled Service.

## 10. Boat storage and winterization

**[NOTE TO COUNSEL #5 — bailment characterization + lien/abandonment advice.]**

**10.1 Custody is with the Crew.** When a storage package is booked, the
Customer's boat is in the **care, custody, and control of the storing Crew**
(the bailee), not LakeLife. Storage Crews are required to carry garagekeepers/
bailee coverage (§11.2) before any storage job is routed to them.

**10.2 Season and per-diem.** Seasonal storage runs through the posted season
end (currently May 31). After season end, continued storage accrues a posted
**per-diem charge** (currently $10/day) until the boat is returned/splashed,
billed with the spring service. Current dates and rates are always shown at
booking and in the customer portal.

**10.3 Condition documentation.** Intake and return are photo-documented by
the Crew through the Platform.

## 11. Crew terms

**11.1 Independent businesses.** Crews are **independent contractors**, not
employees, agents (except §7), partners, or joint venturers of LakeLife. Crews
set their own rates on their rate card, choose their own service areas, lakes,
working days, hours, capacity, equipment, and staffing (including operating
multiple trucks/employees), and may accept or decline work. Nothing in these
Terms guarantees any volume of work. **[NOTE TO COUNSEL #6]**

**11.2 Verification requirements.** Before any work is routed: a current
certificate of insurance (general liability, minimum **[$ AMOUNT — NOTE TO
COUNSEL #8]**), re-attested annually; a W-9 with a valid EIN or SSN; and for
storage work, current garagekeepers/bailee coverage (minimum **[$ AMOUNT]**).
Lapsed documents pause routing automatically until refreshed. LakeLife
verifies that documents are present, current, and facially valid; LakeLife
does not guarantee coverage adequacy.

**11.3 Performance standards.** Crews agree to: complete scheduled jobs on the
scheduled day, upload the required photos before completion, use property
access information only as permitted (§9.2), and maintain professional
conduct. Missed jobs without advance notice ("no-shows") release the job back
to the pool at no charge to the Customer and affect the Crew's standing on the
Platform, which can pause routing on affected lakes. Standing recovers through
completed work.

**11.4 Getting paid.** Crews are paid their own rates — the take-home amounts
shown in the Crew app for each job. Payment for a completed, photo-verified
job is released after the Customer is billed, and paid out **monthly at no
cost**, or earlier on request for a disclosed early-payout fee (currently 2%).
Crews provide bank details for direct deposit (ACH); details are encrypted and
never displayed back. Crews receive a 1099 as required by law and are solely
responsible for their own taxes, insurance, licenses, and permits.

**11.5 Posted-price offers.** Some jobs appear to Crews with a **posted
take-home price** (for example, same-day fill-ins or fill-in-rate offers).
Claiming such a job in the app **is acceptance of that posted amount** for
that job. A Crew's standing rate card is never changed by claiming a
posted-price job.

**11.6 Assumption of responsibility.** As between the Crew, the Customer, and
LakeLife, **the Crew performing a Service bears full responsibility for the
performance of that Service**, including damage to property or equipment
caused by its work, subject to §15–16. **[NOTE TO COUNSEL #3]**

## 12. Customer responsibilities

Customers agree to: provide safe and lawful access on the scheduled day;
keep property, boat, and engine details accurate; disclose known hazards; and
not solicit Crews to take Platform-originated relationships off-Platform to
circumvent these Terms during an active season. **[NOTE TO COUNSEL — advise on
enforceability/duration of the non-circumvention sentence.]**

## 13. Referral program

Referral rewards follow the posted Referral Terms page, which controls:
single-level only; rewards accrue **only on money actually collected**; no
payment for signups alone; Customer rewards are credits (rebates, §6.5); Crew
rewards are paid through the Crew's normal 1099 payout rails; program terms
may change prospectively at any time.

## 14. Communications

By creating an account you consent to receive **transactional and service
messages** (booking confirmations, schedule and crew updates, completion
photos, receipts, security alerts) by SMS and email — these are how the
service operates. Marketing/growth messages are email-only by default and can
be disabled in notification settings. Message and data rates may apply; reply
STOP to opt out of SMS (this may limit service functionality).
**[NOTE TO COUNSEL #7 — TCPA wording.]**

## 15. Indemnification

**[NOTE TO COUNSEL #3 — your language. Intended allocation:]** Each Crew
indemnifies and holds harmless the Customer and LakeLife from claims arising
out of the Crew's performance of Services, negligence, or violation of law.
Each user indemnifies LakeLife for claims arising from that user's breach of
these Terms or misuse of the Platform.

## 16. Disclaimers; limitation of liability

**[NOTE TO COUNSEL #2 — your language. Intended posture:]** The Platform is
provided "as is." LakeLife administers, verifies documents, and processes
payments, but does not perform, supervise, or warrant Services. To the
maximum extent permitted by law, LakeLife's aggregate liability is capped at
**[the amounts paid through the Platform for the Service giving rise to the
claim / other cap you recommend]**, and no party is liable for consequential,
incidental, or punitive damages.

## 17. Governing law; dispute resolution

**[NOTE TO COUNSEL #4 — decide arbitration vs. courts; class waiver; venue.]**
These Terms are governed by Indiana law. Venue: **[COUNTY]**, Indiana.

## 18. Suspension and termination

LakeLife may suspend or remove accounts for breach of these Terms, fraud,
safety issues, document lapses (automatic pause), or unlawful conduct.
Customers may delete their account at any time (§5). Crews may go inactive at
any time; obligations for in-progress jobs, custody of stored boats, and
amounts owed survive termination.

## 19. Privacy

LakeLife's Privacy Policy **[to be published alongside these Terms]** governs
personal data. Highlights baked into the Platform: gate codes and bank
details are encrypted at rest; card numbers never touch LakeLife systems;
crews never see Customer pricing; Customers never see Crew rates.

## 20. General

Entire agreement between you and LakeLife regarding the Platform (and, per
§4, the standing terms between Customer and Crew for Service Agreements);
severability; no waiver by inaction; LakeLife may assign in connection with a
sale of the business; notices via the email/SMS on file; headings are for
convenience. Updated versions take effect per §1.

---

*Draft prepared from the production system's actual behavior. Numbers marked
"currently" are operator-tunable platform settings displayed to users in-app
at the moment of decision; the document intentionally defers to the in-app
display so the Terms can never drift from what users were shown.*
