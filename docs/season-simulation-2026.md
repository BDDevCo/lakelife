# Season simulation — eight personas, a full year each

**Run 18 Aug 2026.** Eight agents walked a complete year through the real code as
a park renter, a stranger park owner, a seasonal homeowner, a full-time resident,
a crew, ops, an STR guest, and the money itself. Every non-cosmetic bug claim was
then handed to a separate agent told to **refute** it.

**36 confirmed. 20 refuted.** The refusals matter as much as the findings — a
third of what the personas reported did not survive someone reading the code
properly.

---

## The five things that actually matter

### 1. SMS decides money and time, and it has delivered nothing since July

This is the largest finding by reach and it appears in **every persona**. A2P
registration is incomplete — 0 of 81 messages delivered — and the code treats SMS
as a working channel for decisions that cost money:

- A customer thumbs-down **holds the crew's pay** and starts a 24-hour clock. The
  crew is told only by text.
- The nightly **cancels the fall pier removal and lift pull** — a pier left in the
  ice — and tells the homeowner only by text.
- A **late-cancellation fee is charged to the card** and announced only by text.
- "Service complete — with photos" is SMS-only, and **its Email switch is wired to
  nothing** — the settings screen and the home page both promise email.
- **Autopilot proposals have no delivery channel at all.** The row is minted with a
  token and expires unseen 14 days later. That is the entire feature.
- **Nothing in the app can produce the guest's booking link**, so park amenity
  rental cannot be used by anybody, at all.
- The resident's screen says "Texts are on. We'll text you about your lot and your
  rent."

Structurally: every call site does `void sendSms(...)` and discards the result, so
nothing anywhere knows a message did not go.

**One fix covers most of it**: a channel planner that falls back to email whenever
the recipient has a verified address, plus honouring the switches that already
exist. The data is all there — the loops already hold the owner's email.

### 2. Nothing raises the rent

`runCharges` fires from one button on one screen. There is **no charge run in the
nightly cron**. If the owner forgets, the month silently does not happen and lands
on ops to reconstruct by hand.

`parks.rent_due_day` already exists. This is the single most important automation
gap before 1 January.

And when he does click it, the screen says: *"Raising bills tells nobody. You hand
them out, or post them, the way you do now."* Forty envelopes a month.

### 3. The resident can only ever see one bill

- **Arrears vanish.** The loader reads `.order(period_month desc).limit(1)`. On 1
  February an unpaid January leaves the screen — she cannot pay it, cannot file
  "I already paid this" against it, and if February is paid the card reads
  "Paid in full — thank you."
- **Move-out erases everything.** The tenancy read excludes `ended`, so the loader
  returns null and she gets *"No lot on your account… ring them and they can join
  the two up"* — every clause false. Behind it go her deposit and the final
  part-month that `runCharges` deliberately raises *after* the move-out.

The deposit's own comment says it sits on the front page all year *so that
argument never happens*. It disappears on the exact day the argument starts.

### 4. Money with no way back, and money nobody can see

- A guest can use the boat all day and then **delete the charge herself**.
- An amenity payment **can never be reversed from any screen**.
- Uncollected boat money **disappears from the owner's screen the next morning**.
- A captured charge whose ledger insert fails for any reason but a duplicate key
  becomes **unrefundable and unreported**.
- A refund the processor honoured **can be deleted from the ledger**, and the
  digest then says no cash moved.
- Rent collected on LakeLife's merchant account **creates no obligation to the park
  owner** — no payable, no record that it is his. That is the pass-through promise
  with nothing behind it.
- **No accountant export. No 1099 data.** Ops cannot see what LakeLife owes crews
  right now.

### 5. Ops runs a business he cannot see

- **32 of 34 platform dials have no control anywhere** — changing one means the
  Supabase SQL editor.
- **Ops administers the rent and cannot see one dollar of it.**
- The nightly digest **reports 12 of 27 steps**.
- Every unpaid completed job **emails him and the customer every night, forever**.
- A crew is **silently paused off a lake overnight** and ops is never told.

---

## What this says about the read-failure work

Four of the confirmed bugs are the *same* failed-read-renders-a-lie class I spent
today fixing, on surfaces my pass never reached:

- `/requests` — "No requests yet" to a customer with a full season booked
- `/approvals` — "No approvals waiting" while a crew is held in the driveway
- a job page — tells the customer their job was **cancelled**
- the ops dispatch board — "All jobs have a crew ✓" when the read failed

A directory scan confirms it: `requests/` (32 bare reads), `approvals/` (6),
`messages/` (7), `a/`, `verify/`, `welcome/` were **never touched**. The 574 sites
were real, but they were the files the audit's finders had listed — not the whole
app. Finishing that sweep is cheap and should happen before anything else here.

---

## Every confirmed bug

### MONEY

**A free make-it-right visit tells the crew their payout was released**  
`src/components/VendorStopCard.tsx:91` · crew · *The first correction visit — usually within a week of the first dispute.*  
settleJob (src/lib/automation.ts) returns early on `job.correction_of` — no payout row is created at all, by design. But markComplete() toasts 'Job complete — payout released. 🌊' unconditionally, and line 151 then renders the pill 'Done ✓ · payout released'. src/lib/job-view.ts:67 says the same thing a third time: crewStatusLabel('complete') = 'Done — pay released on the next batch'. Only the job-detail page gets it right ('a make-it-right visit carries no charge and no separate pay'). The crew drives back for free, is told twice on the busiest screen in the product that they were paid, and finds out at month-end that they weren't.

**Saving a rate with the box empty stores $0 and reports 'Rate set ✓ — you'll be considered for matching jobs'**  
`src/app/vendor/rates-helpers.ts:111` · crew · *Week one, setting rates. Also every time a band service has an unfilled tier.*  
coerceRate('') returns { ok: true, value: 0 }, so computeRateRow writes base 0. rates-actions.ts:117 answers `qualifies: true, signal: "Saved — you'll be considered for matching jobs."` and VendorRates.tsx:122 paints the green 'Rate set ✓' pill. Dispatch does the opposite: dispatch.ts:214 filters out `crewRate <= 0` ('no_qualifying_rate') and canClaim (:283) returns blocker 'no_rate'. On the claim board this renders as a card reading 'You'd take home $0.00' with a button 'Set your rate to claim' (OpenJobsBoard.tsx:126,153) that links to the page which says 'Rate set ✓'. A closed loop: the crew is never routed, never claimable, and every screen says they're fine.

**An at-arrival flag holds the job forever — nothing expires it, no ops override, no crew exit**  
`src/app/vendor/actions.ts:353` · crew · *First time an owner doesn't answer their approval. Peak pier season, when owners are three hours away.*  
submitFlag(atArrival) stamps jobs.held_at. Grep for held_at across src: the ONLY writers that clear it are approveFlag and declineFlag in src/app/approvals/actions.ts (lines 201, 321, 371) — both require the homeowner to tap. The no-show sweep explicitly skips held jobs (src/lib/automation.ts:880 `if (arrival.no_show_at || arrival.stood_down_at || arrival.held_at) continue;`), so the job is never released, never re-dispatched, never struck. Ops has no release control (src/app/ops/*-actions.ts has none). The crew cannot record a no-show instead — recordNoShow refuses any service where needs_interior_access is false, which is every pier and mow job. So the visit sits 'scheduled' and held indefinitely: no completion, no payout, no trip fee (job_visit_attempts is only written on no-show/stand-down), and the card reads 'Waiting on the owner to approve what you found. You'll get a text the moment they answer.' (src/lib/arrival.ts:325) forever. The next day it drops off Today's route entirely.

**The cure-window countdown runs from the complaint, but the return-visit date picker runs from today — so it offers dates that guarantee a clawback**  
`src/components/VendorJobPanel.tsx:184` · crew · *Any dispute the crew answers a day or two late — i.e. most of them, given the notification is a text.*  
nextSevenDays(today) offers seven return-visit dates starting from the day the crew taps. The sweep in src/lib/disputes.ts computes fixCutoff = now − disputeFixDays (7, settings.ts:119) and at line 766 fires the policy for any 'fixing' dispute where `opened_at < fixCutoff` and the correction job is not yet complete — 'correction visit never happened in the window'. Concretely: complaint opens Monday 9am; crew sees it Wednesday and books the return for the following Tuesday (option 6 of 7, day 8 from opening). The nightly on day 8 escalates or auto-refunds and claws back their held pay — the day before the visit the customer was already texted about ('your crew is coming back Tue to make it right — no charge'). Nothing at booking time checks the chosen date against the dispute's own deadline, and nothing tells the crew a deadline exists.

**An owner declining a correction for budget reasons is scored as the crew making a bad call**  
`src/lib/scoring.ts:50` · crew · *Every declined flag, all season — compounding into rank from about the third one.*  
getVendorScores (src/lib/scoring-data.ts:24) counts flags by status approved/declined; scoring.ts:50 computes flagAccuracy = approved / (approved + declined) and line 55 gives it 0.2 of rawQuality. But declineFlag (src/app/approvals/actions.ts:279) is the same write for two entirely different owner answers — the arrival flow's own copy (src/lib/arrival.ts:237-244) frames the common one as 'No — just do what I booked', a spending decision, not a claim the crew miscounted. So a crew that correctly counts twelve pier sections and whose owner says 'do the eight I paid for' takes a permanent accuracy hit. Score is sort key #1 in rankCrews (src/lib/dispatch.ts:159), so it demotes them on every future job on every lake. VendorStanding.tsx never renders flagAccuracy, so the crew watches their tier slip with no explanation on any screen — the exact 'the crew who told us the truth was the only party who lost by it' failure the arrival flow says it fixed.

**A guest can use the boat all day and then delete the charge herself**  
`src/lib/amenity-guest-server.ts:352` · guest-and-calendar · *Any evening in the water season, after the boat comes back*  
cancelDayByToken has no date guard — it matches only .eq("status","booked"). Marisol takes the pontoon out Saturday, comes back at six, opens the link and taps "Give it back" on her own row. The booking flips to cancelled; listAmenities filters cancelled rows out (src/app/park/amenity-actions.ts:85), so the "$150.00 to collect" line and the "Took cash" button vanish from the owner's screen. There is no record on any screen that the pontoon went out that day, and no money is owed by anyone.

**Uncollected boat money disappears from the owner's screen the next morning**  
`src/components/ParkAmenities.tsx:109` · guest-and-calendar · *Every boat day, at midnight lake time*  
`const upcoming = a.held.filter((h) => h.to > today)`. A one-day booking is the half-open range [2026-08-15, 2026-08-16), so `h.to` is "2026-08-16". On Aug 16 the comparison is false and the row is gone. "Took cash" (line 244) is the only caller of collectAmenityMoney anywhere in the codebase, so from the morning after the boat day the $150 can never be recorded at all — the owner has the guest's cash in his hand and no screen that will take it.

**An amenity payment can never be reversed from any screen**  
`src/app/park/receipts-actions.ts:155` · guest-and-calendar · *The first time a boat-day amount is keyed wrong*  
Amenity payments carry kind='amenity' and charge_id NULL. The statement's per-receipt list (with its "take it back" control) is scoped `.in("charge_id", chargeIds)`, and getHeldMoney (src/app/park/money-actions.ts:416-419) selects only kind='rent' with a null charge and kind='deposit'. reversePayment handles the row correctly server-side but nothing lists it. A $1,500 keying slip for a $150 boat day sits permanently inside the CPA statement's "Also received: $1,500.00 for things you rent out" line with no control anywhere that can undo it.

**A captured charge whose payments-row insert fails for any reason but 23505 becomes unrefundable and unreported**  
`src/lib/automation.ts:651` · money-and-close · *Any completed job, any night the database hiccups mid-settle*  
The alert fires only on `payErr?.code === "23505"`. On any other insert error with charge.ok, execution falls straight through: the invoice is flipped to 'paid' with the processor ref (line 654), the customer is emailed a receipt (line 657), referral accruals run, and no payments row exists. Both quoteRefund (ops/refund-actions.ts:55) and executeRefund (lib/refund-core.ts:62) then answer 'Nothing captured on this job — there's no cash to send back', so ops physically cannot refund a customer who was charged. Nobody is alerted. The identical bug in the tip path was already found and fixed with the note 'ANY insert failure here, not just a duplicate' (src/app/requests/actions.ts:670-686); this call site and src/app/ops/recovery-actions.ts:156 were never brought along.

**A refund the processor honored can be deleted from the ledger, and the digest says no cash moved**  
`src/lib/refund-core.ts:169` · money-and-close · *Any refund where the write immediately after the processor call fails — a dropped connection, a timeout*  
`await admin.from("refunds").update({ processor_ref: res.ref })` discards its error. The claim survives with processor_ref null. Thirty minutes later reconcileRefunds (src/lib/automation.ts:2884-2888) deletes every claim older than 30 minutes with a null processor_ref, and the nightly digest renders it as 'N stranded claims cleared (no cash ever moved)' (src/lib/digest-render.ts:221). The customer has the money back; the refunds table says no refund ever happened; the crew's clawback stays applied; and the one line ops would read actively asserts the opposite. Ops refunds again.

**A crew is silently paused off a lake overnight and ops is never told**  
`src/lib/automation.ts:2064` · ops · *Mid-season, the first time a crew misses two jobs on one lake without offsetting completions.*  
demoteLakeStrikes strips the lake from vendors.service_lakes and notifies the crew by SMS only (dead channel). The nightly returns `lakeStanding` in its JSON (route.ts:151) but never passes it to sendNightlyDigest (route.ts:125-150), and the ops Crews board doesn't render service_lakes or vendor_lake_demotions at all (crews-data.ts:74). Next morning every job on that lake shows 'No crew serves Big Turkey yet — recruiting is the unblock' (dispatch-data.ts:139) and Brendon goes recruiting for a crew he already has, sitting idle, one dial away.

**Tapping 'Refund the customer' on an escalated dispute can fail with nothing on screen**  
`src/app/ops/dispute-actions.ts:22` · ops · *Any escalated Make-It-Right — the one place the ladder says a person decides.*  
opsResolveEscalated returns rich sentences ('Refund failed — dispute stays escalated.', 'couldn't read the bill on this job'), and resolveEscalationAction console.errors them, returns void, and calls revalidatePath anyway. The card re-renders unchanged with no toast, no error, no pending state — indistinguishable from a stale render. The crew's pay stays frozen, the customer he just promised a refund never gets one, and his next move is to tap it again. The buttons are a bare <form action={…}> (page.tsx:191) with no disabled state, so on a phone a double-tap is the default behaviour.

**"Leave blank until the contract says" hands him a bill for a month he already collected**  
`src/components/ParkDials.tsx:104` · park-owner-2 · *The first billing month*  
He has no contract and no takeover, so he follows the hint and leaves the cutover date blank. firstBillablePeriod(null) returns null and periodIsBillable returns true for everything (src/lib/billing-start.ts:52), which is correct for a park with no handover — except he joined on the 17th and collected the 1st himself on paper. The rent roll then shows "about $X owed this month", previewChargeRun offers the month, and Raise them writes forty charges for rent already in his own account. Nothing on the dials screen says that blank means "bill this month from scratch"; the hint says the opposite of what the field does for him.

**Her arrears vanish the day the next bill is raised — and she can never pay them online**  
`src/app/parks/my-data.ts:183` · park-renter · *1 February 2027, the morning after a January she was late on*  
The bill read is `.order("period_month", desc).limit(1)` — exactly one charge. On 1 Feb the January charge she still owes $412.53 on disappears from /parks/my entirely; the card shows only "Rent — February 2027". If February is then paid, RenterHome.tsx:93 prints "Paid in full — thank you." to a household one month in arrears. `PayRentButton` is handed `b.id`, the latest charge only, so there is no control anywhere on her screen that can pay January. Her only route to her own arrears is ringing the office — the phone call this module exists to stop.

**Move-out erases her deposit, her final bill and her whole screen, and blames her account**  
`src/app/parks/my-data.ts:144` · park-renter · *end of June 2027, the moment the office records her last day*  
The tenancy read filters `.in("status", ["approved","active"])`; `endTenancy` writes status 'ended'. `stay` is undefined, `getRenterHome` returns null, and /parks/my renders the quiet state at page.tsx:29-45: "No lot on your account — We looked for a tenancy attached to this sign-in and didn't find one. If you rent a lot and the office set you up by hand, your file isn't linked to this account yet — ring them and they can join the two up." Every clause of that is false; her file is linked, it is the tenancy that closed. Behind it go the $500 deposit (the number this codebase itself calls "the single most argued-about number in this business") and her final part-month charge, which `runCharges` raises AFTER the move-out by design (ledger-actions.ts:377-390) and which she therefore can never see or pay.

**A failed read on My requests renders 'No requests yet' to a customer with a full season booked**  
`src/app/requests/page.tsx:52` · seasonal-homeowner · *Any transient RLS/connection error, any time*  
`const { data: jobs } = await query;` is unguarded — no mustRead, unlike /billing which was hardened at lines 64-68. On error data is null, rows is [], and line 130 renders 'No requests yet. Book your first service to see it here.' with a 'Book a service →' button. The obvious next action is to rebook, which createBookingBatch will happily accept as a second job on the same date if capacity allows. Same file, line 70: a failed job_groups read silently drops the 'Your boat is tucked in' card, so a customer whose boat is in a barn is shown nothing about it.

**A failed read on Approvals says 'No approvals waiting' while a crew is held in the driveway**  
`src/app/approvals/data.ts:37` · seasonal-homeowner · *Any at-arrival flag — the crew counts 12 pier sections against a profile of 8*  
getOwnerFlags does a bare `const { data } = await admin.from('flags')` and returns `data ?? []`. The comment at lines 42-47 documents that this exact shape once produced 'an EMPTY approvals screen with nothing logged' and fixes the FK ambiguity — but never adds mustRead, so every other error still lands in the same place. approvals/page.tsx:43 then prints 'No approvals waiting.' An at-arrival flag sets jobs.held_at (vendor/actions.ts:350), and when crew_can_proceed is false, declining stands the crew down. The customer sees a page that says nothing is waiting, taps nothing, and the crew leaves. 0084's trigger keeps the job uncompletable until somebody decides.

**A failed read on a job page tells the customer their job was cancelled**  
`src/app/requests/job-detail-data.ts:173` · seasonal-homeowner · *Any time they open a visit from the requests table*  
The jobs read is unguarded; `if (!job) return null` at line 179, and requests/[id]/page.tsx:69-72 renders 'We couldn't find that job — It may have been cancelled, or it belongs to another account.' Worse are the sub-reads at 194-199: a failed invoices read leaves invoiceStatus null, and invoiceCopy() at page.tsx:265 prints 'Nothing billed yet — You're charged only after the work is done and photo-verified' on a visit that was billed and paid. A failed refunds read at line 195 shows refundedTotal $0 to somebody who was refunded.

### BLOCKS

**The invite email promises a review step that does not exist**  
`src/app/ops/crews-invite.ts:93` · crew · *Day one — the first thing this crew ever reads from LakeLife.*  
The invitation lists step 3 as 'Tell us what work you do — LakeLife reviews and jobs start routing.' There is no review. finishOnboarding (src/app/vendor/onboarding-actions.ts:279) is documented as ZERO-OPS SELF-ACTIVATION and the checklist's own card says 'Flip yourself on and jobs start routing to your crew — no waiting on us' (VendorOnboarding.tsx:582). A crew who believes the email uploads their COI and W-9, ticks their services and lakes, and then waits for a call that no code will ever place — while the 'Go live — start getting jobs' button sits on the screen they already left.

**Editing the profile through guided setup nulls the property's lat/lng**  
`src/app/profile/setup/page.tsx:69` · fulltime-homeowner · *The first time they add or drop a service — the only way this persona ever buys a second job*  
The `initial` object passed to ProfileWizard (lines 69-92) has no `lat` or `lng` keys — getFullProfile never selects them either (src/app/profile/data.ts:166). ProfileWizard therefore starts `lat: initial.lat ?? null` (src/components/ProfileWizard.tsx:110-111) and sends `lat: draft.lat, lng: draft.lng` on finish. saveProfile writes them unconditionally on the UPDATE path: `lat: input.lat ?? null, lng: input.lng ?? null` (src/app/profile/actions.ts:110-111). Unless the customer happens to re-pick their address out of the Google autocomplete during the edit, `properties.lat` and `.lng` become NULL. Downstream: crew proximity ranking ties at Infinity (src/lib/dispatch.ts:161-163), and the nightly route build drops the house out of the ordered stops and out of the crew's map link entirely (src/lib/router.ts:35-36, 82-84). A customer who added one service to their menu is now an unlocated stop appended to the end of a crew's day.

**Nothing in the app can produce the guest's booking link**  
`src/lib/amenity-guest-server.ts:78` · guest-and-calendar · *The moment the office books its first short-stay guest in*  
0120 mints use_token on every approved/active stay. Its only readers are lines 78, 281 and 360 of this file. Grepping the whole repo for "/use/" returns one other hit: src/app/robots.ts:45, the crawler disallow list. No screen renders the URL, no email carries it, no printable slip contains it, and there is no sendSms call for it either. The park owner has no control that produces the address of the page, so /use/[token] is unreachable by the guest it was built for.

**A completed job with no card on file emails the customer and every ops user, every night, with no exit**  
`src/lib/automation.ts:684` · money-and-close · *The very first completed job of the beta — src/app/book/actions.ts requires no card to book, and removePaymentMethod (profile/payment-actions.ts:87) has no guard*  
The no_card branch calls noteSettleFailure but never inserts a payments row. reconcileUnsettledJobs's five-attempt cap (automation.ts:819-826) counts only payments rows with status 'failed', so failCount stays 0 forever and settleJob is re-run on that job every single night. The homeowner receives 'Action needed — $1,540.00 for your Fall Close' nightly, indefinitely; every ops user receives 'Unpaid completed job — $1,540.00' nightly for the same job. Email is the only channel that works right now, and this is the fastest way to lose it. There is no ops control that stops it and no state the job can be moved to.

**Every unpaid completed job emails him — and the customer — every single night, forever**  
`src/lib/automation.ts:684` · ops · *From the first completed job onward, and all season. With no processor live and no card gate on booking, this is EVERY completed job.*  
settleJob's no-card branch calls noteSettleFailure but writes NO payments row. reconcileUnsettledJobs' five-attempt retry cap (line 826) counts only payments rows with status='failed', so failCount stays 0 forever and the job is re-settled every night. Each night the customer gets 'Action needed — $X for your <service>' and every ops user gets 'Unpaid completed job — $X'. Thirty unpaid jobs = thirty emails a night to Brendon, growing without bound, in the same inbox as the nightly digest. He stops reading the folder, and the digest — the only thing that reports the night — goes with it.

**Service-complete-with-photos is SMS-only, and its Email switch is wired to nothing**  
`src/app/vendor/actions.ts:265` · seasonal-homeowner · *After every one of the ~20 completed visits*  
completeJob's only customer notification is `if (ownerPhone && allowsNotification(ownerUser?.id, 'done', 'sms'))`. There is no sendEmail on this path (grep '"done"' returns exactly this one send). But NOTIF_DEFS declares done as channel 'Text + email' (src/lib/notifications.ts:16), so channelsFor() renders both an SMS chip and an Email chip on /settings/notifications, and toggling Email on sends nothing. The 👍/👎 confirm links ride in that same dead text, so job_confirmations rows are created with tokens nobody receives. Net: the product's headline promise — photo proof after each visit — reaches this customer zero times a season unless they remember to open /requests/[id] themselves.

### WRONG INFO

**"Service complete — with photos" is SMS-only, though the settings screen and the home page both promise email**  
`src/app/vendor/actions.ts:265` · fulltime-homeowner · *The moment their one job of the year is finished*  
completeJob sends only `sendSms(ownerPhone, ...)` at lines 265-270. There is no sendEmail anywhere in that function. But NOTIF_DEFS declares `{ type: "done", label: "Service complete — with photos", channel: "Text + email" }` (src/lib/notifications.ts:16), the settings screen renders that literal string, and the home page card says "Receive photos after each visit" (src/app/page.tsx:110). The homeowner turns the Email chip on for "Service complete", and no email is ever sent on that type. Their job silently flips to Done · paid, the card is charged, and the only thing that arrives is the receipt email — which does not mention photos or link the job.

**Autopilot on a one-time seasonal service proposes it every 30 days, year-round**  
`src/lib/autopilot.ts:42` · fulltime-homeowner · *Any time they enroll "Spring opening" or "Fall winterization"*  
Both services are seeded `is_water_work = false` (0047_seeds_and_backfills.sql:63-67), so proposeAutopilotDate never enters the `if (input.isWaterWork)` block where the /(spring|open)/ and /(fall|winter|clos)/ name branches live (lines 42-51). They fall through to "recurring land work": with no completed job it returns today+7, and thereafter lastCompleted+30. AutopilotCard offers the toggle for exactly these services (src/app/book/page.tsx:216-218). Enroll "Fall winterization" in June and the confirm page reads "Ready to book? Fall winterization at 4821 E Shoreline Dr — Tuesday, June 23, at your locked price", with a working one-tap button that creates and dispatches the job. The name-matching branches for the two services actually named spring and fall are unreachable.

**Switching an amenity off erases the guest's existing booking from her own page**  
`src/lib/amenity-guest-server.ts:136` · guest-and-calendar · *Any day the owner trailers the boat for repairs*  
The amenities read filters `.eq("active", true)`. When the park's only amenity is switched off, the loader returns early with `mine: []` and prints "There's nothing to book here at the moment." Marisol, who has the pontoon booked and quoted for tomorrow, opens her link and is told nothing exists — her booking, her $150, and her "Give it back" button are all gone. The owner's screen still shows "$150.00 to collect" against her, and setAmenityActive's own toast (src/app/park/amenity-actions.ts:280) says "Off. Nothing already booked was cancelled."

**"Hold days back for yourself" only ever holds the first kayak, and says otherwise**  
`src/components/ParkAmenities.tsx:272` · guest-and-calendar · *Any park with more than one unit under an amenity — four kayaks, two carts*  
HoldBackDays is passed `unitId={a.units[0]?.id ?? ""}` with no unit picker inside it (BookForSomebody has one at line 438; this does not). The owner holds the July 4 weekend back for his own family, and blackoutDays returns "Held back. Nobody can book those days." (src/app/park/amenity-actions.ts:348). Kayaks 2, 3 and 4 remain fully bookable, and the guest page will hand them out.

**Every payout a crew has already been paid still reads "In the next month-end payout"**  
`src/app/vendor/earnings-helpers.ts:218` · money-and-close · *From the second month of the season onward, and worst in April*  
Nothing in the codebase ever writes payouts.status = 'paid', 'queued' or 'exported' — runMonthlyPayoutBatches (automation.ts:2602) only stamps batch_id and leaves the status 'released'. So statusLabel's 'paid'/'queued'/'exported' branches (lines 225-226) are unreachable, and every historical row renders 'In the next month-end payout'. By September a crew's Earnings list, printed statement and CSV all claim that every job since March is still awaiting payment, and `allTimeReleased` ('all-time released', earnings-data.ts:205) keeps counting money that is already in their bank. Their bookkeeper cannot tell paid from unpaid from the document we give them.

**The dispatch board says 'All jobs have a crew ✓' when the read failed**  
`src/app/ops/dispatch-data.ts:51` · ops · *Any transient Supabase error, at any point in the year — worst in November when past-due protective work is the only thing on it.*  
getNeedsAttention destructures `const { data } = await admin.from('jobs')…` with no mustRead and no error branch. An error yields data:null → rows [] → early return []. NeedsAttention.tsx:67 then renders 'All jobs have a crew ✓ / The machine placed everything on the board.' That card is the ONLY surface for past-due protective winterization the nightly deliberately refuses to cancel (migration 0053). A burst pipe becomes a green tick. getPropertiesWithPreferred:184 and getPreferredJobIds:243 have the identical shape.

**'N visit fees to decide' never counts down — waived rows are terminal but still listed**  
`src/app/ops/recovery-actions.ts:325` · ops · *From the first stand-down or waiver, then monotonically for the rest of the year.*  
getProposedFees selects recovery_state in ('fee_proposed','fee_waived','fee_charging') with no date bound. Nothing anywhere writes a state OUT of fee_waived — and proposeOverdueFees (automation.ts:3522, 3545) auto-waives every stand-down into it. So /ops/page.tsx:209 headlines '7 visit fees to decide' and says 'Nothing is charged until you say so' when zero of the seven are decidable (ProposedFees.tsx:51 gates the buttons on state==='fee_proposed'). By August the card is a permanent red block of decisions he already made.

**A waived fee card still says 'waiting on you'**  
`src/app/ops/recovery-actions.ts:383` · ops · *Immediately after he waives his first fee.*  
`headline: recoveryHeadline("fee_proposed", …)` is hard-coded regardless of the row's actual `state` two lines below at 394. On a waived row the card renders the pill 'waived', the line 'Fee proposed — $35.00, waiting on you', and then 'Waived — "first time, and they called to apologise"' — three statements, two of which contradict the middle one. On a fee_charging row (a charge that died mid-flight, which 0092 says explicitly needs a human) it also reads 'waiting on you' rather than anything about the stuck charge.

**The importer silently eats the Move-In and Due columns**  
`src/lib/roll-parse.ts:824` · park-owner-2 · *Import day — the one afternoon the shoebox becomes data*  
"Move In" / "Moved In" / "Since" / "Lease Start" and "Due" / "Due Day" are recognised header targets (roll-parse.ts:160-161), so they land in columns.index with role kind "field" — which pulls them out of `unrecognised` and out of the CARRY list. Then the notes loop only pushes carry and unrecognised cells; a "field" role with no ParsedRow slot falls through with no else. ParsedRow has no moveIn and no dueDay member. Result: the column is not mapped, not carried to notes, not listed as refused, and not mentioned on the import receipt (LoadedBatch returns refusedColumns but never columns.unrecognised). Eleven years of tenure — the single most valuable column on his sheet, the one that decides who he can raise and who he leaves alone — vanishes with no line anywhere saying it was dropped. The commit never writes tenancy_began_on either (src/app/park/import-actions.ts:672), so every household reads as having arrived on the cutover date.

**When the office answers "we looked and there's no such payment", her screen just silently flips back to "Not paid yet"**  
`src/app/parks/my-data.ts:205` · park-renter · *March 2027 — the month she says she already paid and the office disagrees*  
The claim read is `.is("resolved_at", null)` — open claims only. While it is open she reads "You've told the office you paid this on 3 March. Nothing is being chased until they've confirmed it." The instant `resolvePaymentClaim` writes `resolution: 'not_found'`, `disputed` goes false: the banner disappears, "Not paid yet." returns, and the Pay button reappears. No message, no date, no notification. The database and the action both REFUSE to record that resolution without a written explanation ("Say what you checked. This one puts them back in arrears on your word alone") — and `resolution_note` is then never read by any renter-facing code. The one person entitled to the explanation is the one person who cannot see it.

**"Texts are on. We'll text you about your lot and your rent" — on a channel that has delivered 0 of 81 messages**  
`src/components/TextOptIn.tsx:81` · park-renter · *any month she is talked through the opt-in at the office window*  
She completes the code dance (Twilio Verify codes DO arrive), `confirmTextOptIn` writes consent, and her card reads "Texts are on — We'll text (260) 555-0142 about your lot and your rent." `SMS_ENABLED = false` (reminder-actions.ts:38), so `channelFor` routes her to paper anyway, and no code path in src/app/park* calls `sendSms` at all — the SMS_OPT_IN_BLURB promise of "a receipt when it's paid" is not implemented even if A2P clears. Meanwhile the OWNER's screen on the same product tells the truth: "Texting isn't available yet, so a number here is one the office can ring. Nothing is sent to it." (ParkRentRoll.tsx:676). She stops watching for the paper notice because she is waiting for a text.

**The overdue notice posted through her door greets her by her surname**  
`src/app/park/reminder-helpers.ts:101` · park-renter · *the first month she is genuinely late*  
`Hi ${name.split(",")[0].trim() || "there"},` — rolls write "Kellner, Doris" about as often as "Doris Kellner", so the printed notice opens "Hi Kellner," for the first case and "Hi Doris Kellner," for the second. This exact mistake was found and fixed for the invite email, and `firstNameFrom()` sits exported in src/lib/park-invite.ts:103 doing the right thing (after the comma, or nothing at all for a household label). It is not imported here, nor at receipt-helpers.ts:89 and :157, where the receipt she keeps prints "Received from Kellner". A demand for money that calls a 78-year-old by her surname reads as a collections letter, which is precisely the tone reminderBody's own docstring forbids.

---

## Automation gaps, by what they save

### Two-truck mow-and-dock outfit invited by ops

**Every crew notification is SMS; the crew has an email address the code already reads**  
Today: The crew has to keep opening /vendor, /vendor/open and each /vendor/jobs/<id> to discover what happened — or ops phones them.  
Trigger: Route built for tomorrow, a 👎 opened, a held flag released, a lake paused, a month-end batch queued, open jobs unclaimed.  
Decides: Which channel carries a crew-facing event, and whether a crew who misses a text loses money.  
Keep human: Nothing must go out to a crew who opted out (notification_prefs already models this per-channel), and a send failure must never undo the write it announces — every existing call site already treats notification as best-effort.  
Saves: automation.ts sends 8 distinct crew SMS (route, overflow, open-board, missed-job, lake pause, month-end payout) plus job-verdict.ts and approvals/actions.ts tellTheCrew. All 8 have a working sendEmail alongside them for the OWNER in the same function. Only runFillInDigest emails a crew at all.

**No calendar feed for the one role whose entire job is a route**  
Today: The crew reads tomorrow's stops off a screen and copies them into their own phone, or works off a text that never arrives.  
Trigger: A job is assigned, moved, or cancelled for this vendor.  
Decides: Whether the crew's day exists anywhere outside the LakeLife tab.  
Keep human: Rule 3 — the feed must carry service, time and address, never gate codes (the homeowner feed at api/ics/[token]/route.ts already gets this right) and never a price.  
Saves: /api/ics/[token] filters `.eq("properties.owner_id", user.id)` (route.ts:28), so a crew subscribing with their own token sees an empty calendar; CalendarSubscribe is only rendered on /requests, the homeowner page.

**A payout that says 'Get it now' is three manual steps and a bank upload**  
Today: Ops POSTs /api/ops/payout-export, downloads a CSV of decrypted routing numbers, uploads it to a bank by hand, then clicks markBatchesPaid to close each batch.  
Trigger: Crew taps 'Get it now' (requestEarlyPayout) or the last-day-of-month cron queues a batch.  
Decides: When the money actually lands, and whether the 2% early fee bought anything.  
Keep human: This one must stay human until real processor keys exist — the export carries plaintext bank details and the double-payment guard is a person saying 'yes, that file went up'.  
Saves: The 2% fee is charged and the batch flipped to 'queued' the instant the crew taps; VendorPayouts.tsx:191 says '$X lands' and :175 toasts 'on the way', with no state, ETA, or cancel path between 'queued' and a human's browser.

**Blocking one slot takes the whole day off dispatch, and the fix is 'tell dispatch'**  
Today: The crew phones ops to keep an afternoon they already have per-slot data for.  
Trigger: setSlot writes a 'blocked' row for one slot on one date.  
Decides: Whether the rest of the day is sellable.  
Keep human: Splitting a day between two crews is a real routing change, not a copy change — but the per-slot data is already stored and the day-collapse happens in exactly three readers (dispatch loader, claim board, booking calendar).  
Saves: AvailabilityGrid.tsx:140-145 now says this out loud, honestly — and ends with 'tell dispatch and they'll work around it', i.e. a phone call per partial day, all season.

**Booking the free return visit skips every gate the crew's own claims must pass**  
Today: Nothing — it just lands, and the crew finds it on a day they don't work or a day that's already full.  
Trigger: crewChooseFix inserts the correction job (src/lib/disputes.ts:163).  
Decides: Which day a make-it-right visit occupies.  
Keep human: The gate must not be able to refuse the cure outright — a crew with no free day still has to be able to book one, so this is a warning plus a nudge to a workable date, not a hard block.  
Saves: The insert sets date/status/vendor_id directly with no work_days check, no daily_capacity check, no vendor_availability check and no est_minutes — canClaim in src/lib/dispatch.ts already encodes all four and is never called.

**A tip arrives and nobody tells the crew**  
Today: The crew discovers it on the earnings page or the month-end statement, weeks later.  
Trigger: addTip charges the card and inserts a `kind: 'tip'` payout at status 'released' (src/app/requests/actions.ts).  
Decides: Whether the person who was actually thanked ever hears about it — which is the entire premise of the /vendor/crew roster page.  
Keep human: None worth naming: it is good news about money already collected. The receipt email to the customer in the same function is the template.  
Saves: The customer gets an emailed receipt; the crew gets nothing. VendorEarnings surfaces tipsByCrew only when they go looking.

### Doris, 78, lot 14, eleven years on the pad, pays by cheque, landline only, no smartphone. She is the household this module says it exists for

**Nothing tells her a bill exists — the only outbound message is the one that arrives after she is already late**  
Today: The owner raises the charges and then, separately and manually, has to remember to hand or post anything. `runCharges` ends its own success message with the words "Nobody has been told." The only resident-facing send in the whole module is the OVERDUE chase, which by definition fires after the due date plus the office's catch-up window.  
Trigger: The insert of a park_charges row for a household whose contact_pref is paper or email.  
Decides: Channel from `contact_pref` (the same three-way `channelFor` already implements for chases), and the body from the charge's own snapshotted `lines` — the breakdown is already stored on the row. Paper goes into the same print sheet `printNotices` already builds; email goes through `sendEmail`.  
Keep human: The print step must stay a human act — the notices are folded and put through doors. What can be automated is producing the sheet and logging that it was produced, exactly as park_reminders already does.  
Saves: 19 households × 12 months of "has my bill gone out?" — and it removes the structural oddity that the first thing the software ever says to a resident is a demand.

**The bills are only raised if the owner remembers to click**  
Today: There is no charge run in src/app/api/cron/nightly. `runCharges` fires only from the Rent screen. If the owner is away on 1 January, nineteen households are simply not billed; Doris's screen says "Nothing to pay right now — Your next bill hasn't been sent yet", which she will read as being square, and in February she gets two months at once.  
Trigger: The park's `rent_due_day` minus a small lead, per park.  
Decides: Whether the month is billable (`preCutoverRefusal` already answers that), whether anything is unpriced (buildStatement already returns `problems` rather than a total), and whether a run has already happened (the unique index already makes it idempotent).  
Keep human: Keep the human confirm on the first run for a new park, and never auto-raise a month with any `problems` row — bill nobody rather than bill nineteen households a wrong figure. The `monthBilled` flag on the Today feed already exists to nag; this replaces the nag with the act.  
Saves: 12 owner-dependent moments a year, each of which fails silently and lands on the resident.

**Every reason the office is compelled to write down is unreadable by the person it is about**  
Today: Three separate actions refuse to proceed without a written explanation — `resolvePaymentClaim` ("Say what you checked"), `returnDeposit` ("In six months that note is the only record of the reason"), `reversePayment` ("a bounced check, a typo — the record has to carry the reason"). All three write to columns no renter-facing loader reads. Doris learns her claim was rejected, or $200 of her deposit was kept, or her cheque was reversed, by noticing a number changed.  
Trigger: The write itself — resolution_note, return_note, reversed_reason.  
Decides: One line on /parks/my under the affected bill or the deposit card, and one line on the next printed notice for a paper household. The text is already written and already mandatory; nothing needs to be composed.  
Keep human: None of the three is a judgement call the machine makes — it is transcription of a sentence a human was already required to type. The only care needed is that a reversal shows as a reversal rather than deleting the payment row from her list (my-data.ts:227 currently filters reversed payments out entirely, so a bounced cheque leaves no trace on her side).  

**Her own refusal is never recorded — she taps "I'd rather not" and the office keeps printing slips**  
Today: `ClaimMyLot`'s opt-out is `setOptedOut(true)` — local React state (ClaimMyLot.tsx:167). It renders a genuinely kind card and writes nothing at all. The only writer of `claim_declined_at` is the owner's "They said no" button, so her answer only exists if somebody at the office happens to hear it and re-enter it.  
Trigger: That tap, on her own screen, about her own file.  
Decides: The same column `decline_park_claim` writes, plus a claim event row so the ledger of who-decided-what stays complete.  
Keep human: Only worth doing once the undo exists (see the declined-is-permanent bug) — otherwise a stray tap on a phone she borrowed becomes an irreversible fact about her household. That ordering matters more than the feature.  

**A rent increase is known, dated and served weeks in advance, and her screen never mentions it**  
Today: `lot_rent_changes` carries `to_amount`, `effective_on`, `notice_given_on` and `notice_days_required`, and the owner's Today feed reads all four. `getRenterHome` has no field for any of it. The first time the software tells Doris her rent went up is when the total on a bill is larger, under a line still labelled "Rent".  
Trigger: A row in lot_rent_changes for her reservation with notice_given_on set and effective_on in the future.  
Decides: A sentence under her bill: from 1 July your rent is $X, notice given 15 May. The 30/45-day notice period is a park dial and must not be quoted from a default — read `parks.rent_notice_days`, and say nothing if it is unset.  
Keep human: Must never render a change whose notice has NOT been served — showing an unserved increase would tell her about a decision she has not legally been told about, which is worse than silence.  

**Nothing connects a move-out to the deposit sitting on the ledger**  
Today: `endTenancy` records the last day and trims the range. The deposit is an unrelated park_payments row with `returned_on` null, visible only if the owner remembers to open the Held money panel. There is no prompt, no clock and no note to her. `returnDeposit`'s own docstring says tracking a statutory return clock is deliberately out of scope — but nothing tracks the un-statutory one either.  
Trigger: lot_reservations.moved_out_on being set on a tenancy whose renter has an unreturned deposit.  
Decides: A Today task naming the household, the amount and the date it was taken, plus the final part-month balance to be settled against or alongside it.  
Keep human: Never net the deposit against the final bill automatically — that is a money decision with a required written reason, and `returnDeposit` already forces the reason for exactly this case. Surface it; do not do it.  

### Brendon

**The nightly digest reports 12 of 27 steps**  
Today: He reads an email that is silent about most of what happened, then reconstructs the rest by opening tabs — or doesn't, and finds out later.  
Trigger: Every night at 00:00 UTC, sendNightlyDigest (automation.ts:3086).  
Decides: What he opens tomorrow morning. Everything the machine did that a person might need to reverse or chase should be in it.  
Keep human: Nothing must be added that reads as an action item when it isn't — the digest's value is that a quiet night says one line. But these are already computed and already discarded at nightly/route.ts:151: park findings + park errors, lake demotions (a crew lost a lake), expireUnfilledJobs (a customer's job died), recordNoShows (a crew ghosted), birthSpringJobs, applyDueRentChangesFor (rent went up on a household), sendCoiRevalidations, revalidateAssignments (a job changed crews overnight), selfHealCrewBases, resolveRushFallbacks, remindExpiringStays, overstayNotices, and sweepDisputeDeadlines.couldNotRead.  
Saves: He stops needing to open /ops to find out whether anything happened; the digest becomes trustworthy enough to act on from a phone.

**Ops administers the rent and cannot see one dollar of it**  
Today: Nothing. He can't. The Parks tab shows lots, occupancy and manager count and nothing else; every /park screen gates on assertMyPark (park/data.ts:111), which reads park_members, and the only insert into park_members anywhere in src is createPark's single owner row (parks-actions.ts:126).  
Trigger: 1 Jan 2027, first billing at The Haven, and every month after.  
Decides: Whether to phone the owner. Which lots are billed, which cash claims are sitting unconfirmed (park_payment_claims with resolved_at null), whether the nightly reconcile found an occupied lot with no charge against it, and whether the owner has opened the app at all this month.  
Keep human: He must NOT be able to approve a tenancy or touch a housing decision — ParkBoard.tsx:150 draws that line correctly and it should stay. This is a read: counts, ages, and the park_machine_runs liveness row, on the Parks tab. A rent number nobody can see is a rent rail nobody is administering.  
Saves: A whole class of 'the owner went quiet in February and nobody noticed until March' — 19 households' rent.

**Thirty-two of thirty-four platform dials have no control anywhere**  
Today: Opens the Supabase SQL editor and writes an UPDATE against platform_settings.  
Trigger: Any time the business needs tuning — after a bad AI reply, after crews complain the trip fee is low, after the auto-refund ceiling lets too much through.  
Decides: PlatformSettingsCard exposes margin_floor and surge_cap_pct only (settings-actions.ts:33). Not exposed: dispute_auto_refund_max (how many disputes escalate to him personally), dispute_response_hours, dispute_fix_days, crew_trip_fee, cancel_fee_pct, gap_sla_hours, lake_strike_limit, lake_demotion_cooldown_days, price_autoapply_max_pct, fuel_cost_per_mile, storage_perdiem_daily, and ai_autoreply_enabled — the last of which settings.ts:130 itself calls 'permission to speak in the company's voice'.  
Keep human: The clamps in getPlatformSettings already bound every value, so a form can't do damage a SQL editor couldn't. ai_autoreply_enabled in particular needs a switch he can reach from a phone: today the kill switch for the machine speaking as LakeLife is a database write.  
Saves: Every dial change becomes a tap instead of a laptop, a connection string and a hand-typed UPDATE against production.

**Month-end close ends at a CSV and a manual tick-list**  
Today: POSTs the ACH export, uploads it to the bank by hand, comes back to /ops and ticks each exported batch in PayoutQueue.tsx:93-99, or the next month's file re-emits them with decrypted routing numbers and pays every crew twice.  
Trigger: Last night of every month — runMonthlyPayoutBatches queues the batches, then stops.  
Decides: Nothing infers payment, and that is correct — a bank upload is not observable from here. But the digest already reports 'Crew month-end payouts: $X queued across N batches' and could equally carry the follow-up: how many exported batches are still unticked, and how old.  
Keep human: Never infer paid. But 'you have 3 batches exported 9 days ago and not marked paid' is a sentence on a screen, which is exactly the autonomy bar. Today he only sees that warning if he happens to open the Dispatch tab.  
Saves: One double-payment. The batch rows for the whole platform go through this one un-nagged checkbox.

**Crews with no bank on file are skipped in silence**  
Today: Nothing — he doesn't know. runMonthlyPayoutBatches (automation.ts:2588) does `if (!acct) continue; // no bank on file — keep accumulating, keep nudging`. There is no nudge.  
Trigger: Every month-end, for every crew whose payout_accounts row is missing.  
Decides: Whether to phone that crew before their balance becomes a grievance.  
Keep human: None — this is a count and a name. The digest's 'Money moved tonight' section says what went out and stays silent about what couldn't.  
Saves: A crew quietly accruing months of unpaid work, discovered when they stop taking jobs.

**No accountant export exists**  
Today: Nothing — there is no path. src/app/api has exactly two non-cron routes: /api/ics and /api/ops/payout-export. The park module has /park/statements for the park OWNER; LakeLife has nothing for itself.  
Trigger: Month, quarter, and 15 April.  
Decides: What he hands the CPA. Revenue, vendor cost, margin, tips passed through, refunds, trip fees, cancellation fees — every one of those already has a table.  
Keep human: Cash-vs-accrual has to be settled before anything is generated, or the first statement teaches the accountant a number that later changes. Until then even a raw CSV of invoices+payments+refunds+payouts for a date range beats what exists.  
Saves: A weekend per quarter, and the risk of filing off numbers reconstructed by hand.

**The stuck-household card names the person and withholds the way to reach them**  
Today: Reads 'The Haven · Lot 7 — R. Mueller · 4 tries · the code had expired', then goes somewhere else entirely to find a phone number he cannot get from /ops.  
Trigger: Anyone refused twice with an unresolved claim (claims-data.ts:33).  
Decides: Which call to make. The card even computes `reissue` — 'a fresh slip fixes this' — and offers no way to say so to anyone.  
Keep human: The comment at OpsStuckClaims.tsx:90-93 is right that ops must not reach into the park's roll. But a phone number and a one-tap 'ask the office to reissue Lot 7' note to the park owner are not housing decisions.  
Saves: Every household that gives up on the app and stays on paper.

**Manual assignment notifies two people over a channel that is dead**  
Today: Assigns a job at 9pm, sees no error, and both texts vanish. He phones the crew.  
Trigger: assignAndSchedule (actions.ts:153-165) — `void sendSms(...)` twice, results discarded, no email fallback.  
Decides: Whether the crew knows about tomorrow's job and whether the homeowner knows anyone is coming. Every account already has a verified email (rule 5); noteSettleFailure and the digest both prove the email rail works.  
Keep human: Don't duplicate on both channels once SMS is registered. But right now the one core ops move in the product tells nobody, and the return value that would have said so is thrown away.  
Saves: Two phone calls per manual assignment, all season.

**The intraday heartbeat exists only as a comment and a hand-run SQL statement**  
Today: Remembered it once. 0023_intraday_heartbeat.sql creates the extensions and leaves cron.schedule() to be applied out-of-band because the repo is public.  
Trigger: Every 30 minutes — rush fallbacks a customer pre-chose, and waitlist fills.  
Decides: Whether a rush customer who said 'cancel it if nobody claims' waits half an hour or all afternoon.  
Keep human: The secret genuinely can't live in the repo. But nothing anywhere checks that the schedule is still there — and this codebase already has a precedent (park-machine.ts:57-64: a rebuilt environment silently lost 0079). A last-seen-intraday-run stamp on /ops would cost one row.  
Saves: A silent regression that looks exactly like low demand.

**A crew going live is invisible to ops**  
Today: Notices when a needs-attention card stops saying 'recruiting is the unblock'.  
Trigger: finishOnboarding (vendor/onboarding-actions.ts:325) flips a crew to active with no notification to anyone; the digest reports lakes born but not crews arrived.  
Decides: Nothing urgent — but a new crew is the single event that unblocks stranded demand, and it is the moment to check their rates and their lakes before they take a job at a price he'd have argued with.  
Keep human: Genuinely low. This is an FYI line, not an approval gate — the self-serve go-live is the right design and should not become a queue.  
Saves: A first job priced wrong, and the awkward conversation after.

### The money itself

**Nothing produces a LakeLife financial extract for the accountant**  
Today: In April, ops opens the Supabase console and hand-assembles the year: invoices, payments, refunds, payouts, tips (payments.tip_job_id), early-pay fees (payout_batches.fee), trip fees funded by LakeLife, and park card fees. The only two exports in the product are the crew's own earnings CSV (src/app/vendor/earnings/export) and the park owner's receipts CSV (src/app/park/statements/export/route.ts) — neither is LakeLife's books.  
Trigger: A month, quarter or year close; or the accountant asking for one.  
Decides: Cash vs accrual basis; which of the eight money tables is in scope; and what a refunded, partially-refunded or credit-covered invoice counts as. Every one of those is already knowable from rows that exist.  
Keep human: The cash-vs-accrual question must be settled by a human before the first export is generated, not by the query — see the standing note in memory. Once an accountant files from a figure, changing its basis retroactively is a restatement.  
Saves: A multi-day manual close per period, four times a year plus year-end

**No 1099 data exists, for any payee**  
Today: To file 1099-NECs, ops opens each crew's uploaded W-9 PDF (vendors.w9_url, gated at ops/crews-actions.ts:32) and hand-keys the legal name and TIN — there is no TIN, EIN or legal-name column anywhere in the schema. Then they hand-total each crew's calendar year from `payouts` (which mixes kinds earning/trip/tip/adjustment) PLUS `referral_earnings` paid in cash batches. Two ledgers, no combined per-payee annual view.  
Trigger: Any payee crossing $600 in a calendar year — with 19 lots and a full season, that is most crews.  
Decides: Payee legal name, TIN, and box-1 total. The totals are fully derivable today; only the identity fields are missing from the schema.  
Keep human: The TIN itself must stay human-entered and encrypted at rest like the bank blobs — it is the same class of secret as routing/account, and openSecret already exists for it. Never OCR a W-9 into a tax filing.  
Saves: A day of PDF-opening plus every reconciliation error it causes

**Ops cannot see what LakeLife owes crews right now**  
Today: getPayoutQueue (src/app/ops/payout-data.ts:61) reads only payout_batches in status queued or exported. The entire month's accrued liability — payouts with status 'released' and batch_id null — plus every referral earning sitting at 'matured' appears on no ops screen. Individually a crew CAN see their own (bank-data.ts:38); ops cannot see the sum. On the 20th of the month, 'what do we owe' is a SQL query.  
Trigger: Continuous — the number changes on every settleJob, trip fee and tip.  
Decides: Nothing but display. The two sums are one query each and both already exist in per-crew form.  
Keep human: None — it is a read. But it must fail loudly rather than render $0.00, exactly as getPayoutQueue's own comment already argues for the batch total.  
Saves: Removes the only blind spot on the platform's largest recurring outflow

**Nothing chases an exported batch that was never marked paid**  
Today: markBatchesPaid (src/app/ops/payout-actions.ts:40) correctly requires a human — a bank upload is not observable from here. But nothing reminds them. A batch that is exported and never confirmed sits in status 'exported' forever: the ops queue counts it under 'already gone out', the crew's batch history shows a teal pill, and if the file was never actually uploaded the money simply never moved and nobody finds out.  
Trigger: A payout_batches row in status 'exported' with paid_at null for more than three days.  
Decides: Only whether to raise it. The confirmation stays a human act — the machine can ask, never answer.  
Keep human: Must never infer payment. Auto-stamping paid_at would strand real money owed to a crew with no trail, which is the exact failure the current design refuses.  
Saves: One caught month-end per year is the whole payroll

**The card cost of every service charge is recorded nowhere**  
Today: Every customer charge, tip and cancellation fee runs through LakeLife's merchant account at roughly 3%, and nothing writes it down. The park side already does this properly — park_payments.fee_amount, surfaced and explained on the owner's statement (receipts-helpers.ts:472-478). The service side has no equivalent, so the 30% on ops/page.tsx:134 is a gross margin that has never had the rail cost taken out.  
Trigger: Every captured payment. The processor returns the fee on the real adapter; today it is a known percentage of a known amount.  
Decides: A fee column on payments, and a net-of-rail line beside the margin figure.  
Keep human: Do not synthesise a fee before real processor keys exist — a computed 3% presented as fact is a number somebody will book. Until then it belongs in the margin panel as a stated assumption, not in the ledger.  
Saves: Nothing in labour; it changes whether the headline margin number is true

### Full-time lake resident

**Deciding who on a lake actually owns something that has to come out of the water**  
Today: Nobody decides — the send fans out to every property on the lake and a human fields the confused replies from residents with no dock.  
Trigger: Nightly, when a lake's pull_deadline equals today + 14 (src/lib/automation.ts:2227-2235).  
Decides: Whether this household hears about the fall pull at all. Every fact needed is already joined one table away: property_profile.pier_sections, .boat_lifts, .pwc_lifts, boats rows, and wanted_services. The query at line 2240-2243 selects none of them.  
Keep human: The filter must fail OPEN, not closed — somebody who has a pier but never told us during the wizard still needs the warning. Send when there is equipment OR the profile is silent; skip only when the profile positively says none of it exists.  
Saves: On a 60-home lake with maybe a third year-round non-waterfront, ~20 wrong emails per lake per autumn, plus the replies.

**Choosing a channel when the primary one is known to be dead**  
Today: Nobody. The proposal is queued to SMS, sendSms returns `queued`, and the fact that 0 of 81 messages delivered since July lives in an ops health widget nobody wires back to the send path.  
Trigger: Any customer-facing send where the type has an email address available and the SMS channel is unregistered — most sharply generateAutopilotProposals (automation.ts:2212), sendNightBeforeReminders (1066), completeJob (vendor/actions.ts:265), expireUnfilledJobs (1841, 1865, 1889) and the fill notice (1754).  
Decides: Which channel carries the message. The booking confirmation and the receipt already prove the pattern — read the pref, send SMS if allowed, send email if allowed, and treat a dead channel as not allowed.  
Keep human: The channel choice is safe to automate; what must stay human is the A2P registration itself and the decision to declare a channel dead. Do not let a transient Twilio error flip a whole customer base to email silently — the flip should be an explicit dial an ops person sets, and the digest should name it every night it is on.  

**Adding one service to a menu without re-walking the property wizard**  
Today: The customer walks the whole guided setup again — place, services, and every conditional step for the services they still have ticked — just to expose one new tile. That path is also where their geocode gets erased.  
Trigger: A signed-in homeowner with a complete profile wanting a service not in wanted_services.  
Decides: Which additional wizard steps are actually required. ProfileWizard already computes this exactly: `stepKeys` at lines ~156-165 derives the needed steps from the chosen service. A single-service add could append to wanted_services and ask only that service's own step — often zero steps, since Spring opening and Fall winterization need nothing beyond what a housekeeping-less profile already stores.  
Keep human: Nothing here is risky; it is arithmetic the wizard already does. The one thing to preserve is the `keep()` discipline — never write a field the customer was not shown, or you re-open the invented-pontoon bug the wizard comment documents.  

**Letting somebody cancel on the morning of, using arithmetic that already exists**  
Today: Ops, by conversation. cancellationQuote refuses anything that is not a future scheduled job (src/lib/cancellation.ts:91-97), so day-of is `not_cancellable` and the copy says "text or call us and we'll sort it out".  
Trigger: A cancel tapped on the job's own date, before the crew has started.  
Decides: Whether a fee applies and how much. `lateFee(feePct, customerPrice, vendorCost)` (cancellation.ts:61-71) already computes both the customer fee and the crew's share for exactly this shape — it was split out for the no-show path.  
Keep human: The machine cannot see whether the truck is already in the driveway. Keep it human once status is in_progress, or once tonight's route has been built and sent — but a 6am cancel on an 8am slot is a decision the existing dial can make, and today it produces a dead end instead.  

**Telling the customer when a season boundary is a guess**  
Today: An ops person must observe ice-out and type this year's hard-freeze estimate per lake. Until they do, effectiveSeason silently rolls last year's month/day forward and the customer calendar presents the result as settled fact.  
Trigger: Any render of the booking calendar or the public lake page for a lake whose stored dates predate the current year — `wasRolled` is already computed and already thrown away at src/lib/booking.ts:187-190.  
Decides: Only the wording, not the dates. "Provisional — last season's dates until we confirm this year's ice-out" versus a hard strike-through.  
Keep human: The DATE itself must stay human: ice-out is a physical observation and hard freeze is a judgement about weather. Never let the roll be presented as a confirmed date, and never let it silently move a booking somebody already made.  

### Marisol Ríos

**Handing the guest her own link**  
Today: Nobody, because it is not possible. The owner would have to read a 48-character hex token down the phone; no screen shows it to him.  
Trigger: A lot_reservations row reaching status approved or active — the exact moment the trg_mint_use_token trigger already writes use_token.  
Decides: Which channel: email it if park_renters.email is set (0132 already built one-shot email to an address of record), otherwise add it to the printable slip the rent module already produces, and put a QR on the arrival paperwork the way /fix already does per lot.  
Keep human: The link is a bearer capability. It must go only to the address or the hand of the party on the stay, never be forwarded automatically, and never ride SMS while A2P registration is incomplete.  
Saves: Turns a feature that currently cannot be used at all into one that works without a phone call per guest.

**Telling the owner who has the boat today**  
Today: He opens /park/amenities and reads down a list of every future booking to work out what is happening this morning.  
Trigger: Today's date, on the screen he already opens with coffee.  
Decides: Which units are out, to whom, from which lot, whether they ticked the rules, and what is still to collect. whoHasIt() in src/lib/amenities.ts:224 computes exactly this, is unit-tested at src/lib/amenities.test.ts:223, and has no caller — while five amenity actions call revalidatePath("/park/today") for a page that contains no amenity content whatsoever.  
Keep human: None. It is a read of his own park's data onto his own screen.  
Saves: Every handover morning, plus the ones he forgets.

**Chasing the boat money that was never collected**  
Today: Nobody. The line disappears from his screen the morning after the day and the money is never mentioned again by anything.  
Trigger: An amenity_booking whose last day has passed with collected < quoted_amount.  
Decides: Whether it goes on his Today list as "collect $150 from Lot N1 — Saturday's pontoon", and whether it should print on the guest's checkout paperwork before she drives away.  
Keep human: It must stay a prompt to a human, not a charge. LakeLife handles no cash and the guest pays the owner hand to hand — the software records the collection, it never makes it.  
Saves: Every uncollected boat day, which today is every boat day the owner does not happen to be looking at his screen on.

**Settling amenity bookings when a stay ends or shortens**  
Today: Nobody, and he has to notice first. The orphan booking keeps blocking the unit and keeps showing money owed by somebody who has left.  
Trigger: closeOutTenancy writing status='ended' and a shortened `during` (src/app/park/actions.ts:798), or any edit that narrows a stay.  
Decides: Cancel future amenity bookings on that stay with cancel_reason 'the stay ended', leave past ones intact and still collectable, and tell the owner what was released.  
Keep human: Past days must never be cancelled — that would erase money he is owed. Only days that now fall outside the shortened stay.  
Saves: Every early departure and every corrected checkout date.

**Asking ops for this year's ice-out before the season trades on a guess**  
Today: Nobody. `season_confirmed` is written at src/app/ops/actions.ts:225 and read by nothing — getLakeConditions (src/app/ops/data.ts:445) does not even select it, so the lake card renders last season's date in a date input with no indication of its age.  
Trigger: Today passing the rolled ice-out for a lake whose season_confirmed is false.  
Decides: Which lakes are selling water work against a provisional window, and which spring envelopes are therefore frozen out of birthSpringJobs while the storage meter runs.  
Keep human: It is a prompt, never a write. Nothing may invent an ice-out date — a guessed ice-out that opens the calendar puts a crew on ice.  
Saves: One prompt per lake per year, against a failure mode that costs a whole spring of splash jobs and accrues per-diem the customer never agreed to.

**Reconciling scheduled water jobs after a season date moves**  
Today: Nobody, in either direction. Ops saves a narrower window and the jobs outside it stay on the calendar and get routed.  
Trigger: updateLakeConditions writing a window that excludes dates it previously included.  
Decides: Which jobs now fall outside, and surfaces them on an ops list with the reschedule copy that already exists on the customer's requests page.  
Keep human: It must never auto-move a customer's date — a rescheduled visit is a promise being changed. Ops proposes, the customer picks. Auto-cancelling would strand a boat with no billing rail.  
Saves: Every early-freeze correction; the direction that puts a crew on a pier through ice.

**Re-announcing a pull deadline that moved after the notice went out**  
Today: Nobody. seasonal_notice_log's per-season claim is what makes the send exactly-once, and it also makes the correction impossible.  
Trigger: pull_deadline changing on a lake for which a seasonal notice has already been claimed this season year.  
Decides: A second, explicitly-a-correction email naming the old date and the new one, to exactly the households already told the old one.  
Keep human: It must be one correction per actual change, not a loop — key it on the deadline value, not just the season year, or a warm autumn with two revisions becomes three emails a week.  
Saves: One or two sends a year, against nineteen households holding a written LakeLife deadline that is no longer true.

### Park owner #2

**A park can only be created by an ops human typing into an internal form**  
Today: Ops opens /ops, looks the owner up by email (findUserByEmail), and hand-types name, address, lake, latitude and longitude. The owner must already have signed up as a LakeLife customer first, or createPark refuses with "No user with that id". There is no intake form, no queue, no record that he asked.  
Trigger: A stranger deciding he wants to use LakeLife  
Decides: Whether the park exists at all — every one of the twelve owner screens starts from a park_members lookup and shows "Park owners only" until this row exists.  
Keep human: Creating a park hands somebody a rent ledger for forty households; that gatekeeping is deliberate and should stay human. What should not be human is the lat/lng typing and the "go sign up first, then email me your address" round trip.  
Saves: An hour of ops time per park, and days of elapsed calendar per park

**Nothing raises the monthly charges — he has to remember, every month, forever**  
Today: Open /park/rent, click "Bill August 2026", read the preview, click "Raise them". If he forgets, the month simply has no bills: the ledger reads $0 billed, nobody is late, no reminder can fire, and the roll's owed tile falls back to a simulation.  
Trigger: The park's own rent_due_day, which is already a column, plus a cutover date that says the month is his  
Decides: Whether forty charges exist for the month  
Keep human: Raising forty real bills unattended is exactly the kind of write the park-autonomy rule says must stay draft. The automatable half is the NAG — a task on /park/today saying "August isn't billed yet" — not the run.  
Saves: One forgotten month is ~$5k that has to be reconstructed by hand

**Raising bills tells nobody, and the app knows exactly who it could tell**  
Today: After the run the screen says "Raising bills tells nobody. You hand them out, or post them, the way you do now." He then addresses forty envelopes. The system already holds each household's email (carried through from his sheet by the importer), each one's contact_pref, and the frozen statement lines for each bill.  
Trigger: A successful charge run  
Decides: Whether a household knows what they owe before they are called late  
Keep human: An automatic first-contact email to forty imported addresses on go-live day is a genuinely bad idea and the importer is right to default contact_pref to paper. What is missing is the reviewed batch: a "send these 23 statements, print these 17" screen with the same shape the reminder run already has.  
Saves: Forty envelopes a month, twelve months

**Nothing links a departing household to the deposit it is holding**  
Today: He ends the tenancy, then separately remembers there is a deposit, then finds it under Held money on /park/rent, then works out what to keep and types the reason.  
Trigger: endTenancy succeeding on a reservation whose renter has an unreturned deposit row  
Decides: Whether a statutory deposit return happens at all, and whether the reason is recorded while anybody remembers it  
Keep human: Deciding how much to keep must stay human — returnDeposit already refuses a partial return with no written reason, which is right. Only the prompt is automatable.  
Saves: Every move-out; the failure mode is a deposit dispute a year later with no note

**The accountant gets income and no expenses, and the file doesn't say so**  
Today: He downloads the receipts CSV, then separately re-keys every park_costs row — water, sewer, trash, grounds, tax, insurance — into his accountant's own system, because the statement is deliberately cash-in only.  
Trigger: Month, quarter or year end  
Decides: Whether the accountant's P&L is built from LakeLife data or from a shoebox  
Keep human: The module is right not to pretend it produces a P&L. But park_costs already carries category, period and amount paid, and an expense CSV alongside the receipts CSV asserts nothing new.  
Saves: A full evening per quarter, four times a year

### Seasonal lake homeowner

**Fall back to email when a text does not queue**  
Today: Nobody finds out. Every call site does `void sendSms(...)` and discards the return; ops learns from the Twilio log panel days later, and the customer learns never.  
Trigger: sendSms returning { queued: false } — or any send on a type whose recipient has a verified email.  
Decides: Which channel actually carried the message, and whether the promise on screen ('you'll hear from them shortly', 'we'll text you') is still true.  
Keep human: Nothing needs a human here. The addresses are already on file and every message body is already composed; the only judgement is whether an email restatement of an SMS is appropriate, and for booking confirmations it already is (book/actions.ts:470 sends both).  
Saves: Roughly 25-30 undelivered messages per household — every completion, reminder, flag, proposal and cancellation notice.

**Send Autopilot proposals by email and show them in the portal**  
Today: Nobody. The proposal exists as a row with a token and expires unseen 14 days later; the customer would have to be told by phone that their pier install needs confirming.  
Trigger: An autopilot_events row inserted with status 'proposed' — the loop at automation.ts:2205 already has the owner row, the service name, the property and the penciled date.  
Decides: Whether the season's visit is booked at the locked price, or silently skipped.  
Keep human: Booking still requires the customer's tap, so the machine decides nothing about money. A pending-proposal card on /book carries the same confirm/skip actions the token routes already implement.  
Saves: 7 proposals per enrolled household — the whole point of the feature.

**Treat a fall pull/removal as protective for the expiry decision**  
Today: Ops has to spot an unfilled fall pier removal on the board before the nightly cancels it. 0053's own comment says the fix was deferred.  
Trigger: expiryActionFor() at automation.ts:1828 — the job already carries service_id and frequency ('Removal (fall)', 'Pull (fall)'), and the lake already carries pull_deadline. The direction is knowable from the frequency string without a schema change.  
Decides: Cancel silently versus escalate loudly and keep the job open, which is exactly the fork the migration already built for winterization.  
Keep human: Escalating is the safe side — the job stays `requested` and stays on the ops board rather than being destroyed. What must stay human is deciding who actually goes and pulls it.  
Saves: 2 jobs per waterfront household, each one a pier or a lift left in the ice.

**Let a same-day cancellation resolve itself**  
Today: The customer is told to phone a number that is not printed anywhere; ops has to take the call, find the job and cancel it by hand.  
Trigger: A cancel attempt on a job whose date is today and whose status is 'scheduled' but not yet 'in_progress'. lateFee() (cancellation.ts:61) already computes the fee and the crew's share for exactly this shape.  
Decides: Whether the fee applies, and whether the crew's slot share releases.  
Keep human: A job already in_progress must stay a conversation — the crew is standing there and the arithmetic is not the question. Everything before the crew starts is the same policy the 48h/7d window already encodes.  

**Warn before the last card is removed, and promote a replacement**  
Today: Nobody. removePaymentMethod (payment-actions.ts:87) deletes and returns ok; nothing counts open jobs and nothing promotes another card to is_default.  
Trigger: A delete against payment_methods when the row is is_default, or when it is the only row and owner_jobs has open requested/scheduled visits.  
Decides: Whether the next completed visit settles or falls into noteSettleFailure's 'no card on file' branch — after the crew's payout has already released.  
Keep human: Removing a card must never be blocked; the decision is only whether to say 'you have 6 visits booked and no card on file' first, and which remaining card becomes default.  

**Show a job's cancellation reason on the customer's own screen**  
Today: The customer phones to ask why a booking reads 'Cancelled'.  
Trigger: jobs.cancel_reason, which is written at automation.ts:1851 and read by nothing (grep across src returns only writers).  
Decides: Nothing about money — only whether 'Cancelled' means 'you cancelled it', 'a crew never turned up' or 'we could not staff it and never charged you'.  
Keep human: None. It is a column with a writer and no reader.  

**Publish a delivery-truth signal into paged_at and the notice ledgers**  
Today: Ops reads the Twilio log manually via the SMS-health panel and correlates it back to rows by hand.  
Trigger: The Twilio status callback, or a delivery poll on the sid sendSms already returns.  
Decides: Whether waitlist_notice_log's one-lifetime warning claim (automation.ts:1871) and messages.paged_at (message-triage.ts:109) represent something that happened. Both currently claim the send before, and regardless of, delivery.  
Keep human: None — this only downgrades false certainty. The escalation decision that follows an undelivered page still belongs to a human.  

---

## Friction, by persona

### Two-truck mow-and-dock outfit invited by ops

- **The invite has no token, so signing in with the wrong address makes you a homeowner with no way back** — A two-truck outfit whose invite went to info@ and who signs up with their personal gmail lands on /book as a homeowner. Nothing on that screen mentions a crew invite. Ops can't re-issue: inviteCrew:52 now refuses with 'That email already has a homeowner account'. The crew's first impression of LakeLife is a booking page for services they sell.  
  *Fix:* Make the invite a link with a one-time token, so whichever address they sign in with claims the crew row — or, at minimum, when a signed-in user's account has no vendor row but an open invite exists for a similar address, say so on /portal instead of routing them to /book.
- **A week off in October cannot be blocked in August** — The only lever a crew has over their own calendar reaches about a week out. Anything further — a wedding, a fishing trip, closing week — has to be a phone call to ops, or the crew waits until the days fall inside the window and hopes nothing was booked in the meantime.  
  *Fix:* Let the grid jump forward by month (it already stores per-date rows and the write path is date-keyed), plus a 'block these dates' range control for a week or more.
- **There is no 'what needs me' surface anywhere in the crew app** — An open dispute, a held job, an expiring COI and a paused lake are each visible only on a page the crew has to already suspect. The dispute lives on /vendor/jobs/<id> for a job that has left the route; the hold lives on a card that vanished the next morning; the lake pause shows up as a chip that quietly un-ticked itself on /vendor/availability. VendorCalendar renders '· on hold' per day, which is the closest thing to an alarm and it is a five-word suffix.  
  *Fix:* One banner on /vendor: open disputes with their respond-by date, held jobs, and anything paused — the reads already exist (getCrewJobDetail's dispute query, vendor_lake_demotions, VendorDocs' expiry math).
- **The garagekeepers policy isn't in the onboarding checklist, so storage work is invisible until you go looking** — A dock crew that also winters boats never learns that isEligible (dispatch.ts:111) hard-gates every storage visit on an unexpired garagekeepers doc. They set storage rates on /vendor/rates under 'Winter & storage legs', see 'Rate set ✓', and are never routed a single storage job. The invite email lists two documents; uploadVendorDoc accepts three.  
  *Fix:* Add it to the checklist as an optional step — 'do you store boats over winter? then we need this second policy, a standard COI excludes property in your custody' — so the reason is on the screen where the decision gets made.
- **'Doesn't clear at your current rate' is a verdict with no lever next to it** — Rule 1 correctly refuses to show the crew the customer price, so the crew cannot tell whether they are 5% or 50% over. The fill-in path exists and is well built — but only after a job has aged past a day (open-data.ts:280), so on the day it matters the card is a dead grey button. The crew's rational move is to guess downward across their whole card, which is the one thing the anti-harvest anchor is designed to make irreversible.  
  *Fix:* Say what a crew can act on without revealing the price — 'this one doesn't clear today; it becomes a posted fill-in offer tomorrow if nobody takes it' — which is already exactly what the code does.
- **An early payout goes to 'queued' and stays there, with no cancel and no ETA** — The crew pays 2% on the earned portion at the moment they tap, then watches a pill that says 'queued' with no date attached until a human runs the export. There is no way to unwind the batch and get the fee back, and the copy above the button says 'Or wait for month-end — always free', which is the comparison they can no longer make.  
  *Fix:* Put the expected landing date on the batch row and say plainly when batches are executed — and until the banking layer exists, price the choice honestly ('funds move on the next banking run').

### Doris, 78, lot 14, eleven years on the pad, pays by cheque, landline only, no smartphone. She is the household this module says it exists for

- **Every door into her own record needs a smartphone she does not have** — The claim path is thoughtfully built for a 78-year-old in her kitchen — three fields, no countdown, a dignified way out — and every one of its entry points assumes a browser and a camera. Her realistic options are handing the slip to a relative (which detaches her file to somebody else's account) or declining. Roughly a quarter to a third of a park never converts; the code says so repeatedly and then routes the remaining sixty percent of features exclusively through the phone.  
  *Fix:* Accept that paper is the primary channel for this household rather than the fallback, and make each renter-facing capability answerable at the window: the office already has `logPaymentClaim` for "I already paid", `logRequest(source:'phone')` for a broken step, and a printable notice. What is missing is the office-side counterpart of the deposit view and the bill history, and a slip that can be handed to a named helper on purpose rather than by accident.
- **"The sticker on your pedestal opens a form — no login, no app" is the only instruction she is given about reporting a broken step** — She cannot scan a QR code. The office CAN file it for her — `logRequest` writes `source: "phone"` (request-actions.ts:204-210) and it lands in the same queue and on her own screen — but nothing on any resident-facing surface mentions ringing the office as a route, so she assumes there isn't one and mentions the step to a neighbour instead.  
  *Fix:* Add "or ring the office and they'll log it for you" to that empty state and to the sticker itself. Zero new machinery — the writer already exists and is already wired to the queue.
- **"I already paid this" is a phone call, permanently, because her half of the two-sided record is on a phone** — The design is right — the resident asserts, the owner confirms, and only the confirmation moves money — and the resident's assertion has exactly one door, which she can't open. So every disagreement about a cheque becomes a call to the office, where a person types it into `ClaimForm` and it is recorded as `asserted_by: 'renter'` from a browser that was not hers. That is the exact situation `sayIPaid` was written to end, still true for the households most likely to need it.  
  *Fix:* Print the claim as a tear-off on the monthly notice — a lot number, a month, four ticks (cash/cheque/transfer/other), a date line and a "who you handed it to" line — that the office keys in front of her and signs. It is the same shape as the receipt counterfoil that already exists for the other half of the transaction.
- **Tapping "I'd rather not do this" by accident has no way back** — The opt-out card replaces the form entirely and renders no control — not even a "actually, let me try again". On a borrowed phone, one mis-tap on the underlined full-width button directly below the submit button means reloading the page, which she will not think to do. She concludes she has done the wrong thing and stops.  
  *Fix:* Keep a quiet "take me back" on that card. The state is local, so it is one setState — and the card's whole point is that declining should not feel like failing, which a dead end undercuts.
- **A receipt exists only if the office prints it at the window, and can never be reprinted** — `recordPayment` correctly returns `renterEmail: null` for a paper household and hands back a fully-formed receipt with a signature counterfoil. But the receipt lives in the action's return value and on one screen; if the printer jams, or the owner clicks away, there is no path back to it. In March, when she wants to prove she paid January, the receipt number is on her screen (which she can't see) and in his ledger (which she can't read), and the only artefact is a counterfoil in a filing cabinet.  
  *Fix:* Make the receipt reprintable from the payment row on the Rent screen — every field it needs is already on `park_payments` and `park_charges`. And include the last three receipt numbers and amounts on the monthly printed notice, so the paper household carries a running statement rather than a stack of loose slips.

### Brendon

- **/ops is eighteen queries and a live Twilio call before anything paints** — On LTE, in a truck, the console he checks twenty times a day. Every one of those loaders is unbounded or near it: getJobBoard has no limit, getMarginByService has no limit, getMessageThreads has no limit, getOpsCalendar pulls 3000 rows.  
  *Fix:* He'd wait, or he'd stop opening it and rely on the digest — which is the one thing that doesn't carry most of the night.
- **The Complete bucket on the Jobs board grows forever** — By September the Jobs tab is a phone-length scroll of finished work he has to get past to reach 'Machine hunting'. There is no date filter and no collapse.  
  *Fix:* He uses the search box (JobSearch) for everything and stops using the board, which means he stops seeing the requested bucket he actually needed.
- **Escalation buttons have no pending state** — On a phone, a tap that doesn't visibly do anything gets tapped again. The second submit hits opsResolveEscalated, which correctly refuses ('Only escalated disputes land here — this one already resolved.') — and that message is then discarded by the action, so he sees nothing either time.  
  *Fix:* Reload the page and squint at whether the card is gone.
- **Waived and stand-down rows never leave the fee list** — Every visit to the Missed-visits card he re-reads decisions he already made, and the count in the heading (page.tsx:209) tells him there is work waiting when there isn't.  
  *Fix:* He learns to ignore the count, which is the same as losing the card.
- **Marking payouts paid is a per-row checkbox with no memory** — After each bank upload he must tick every batch individually. Past 100 combined queued+exported rows, older exported batches drop off the list entirely — but the export route (payout-export/route.ts:82-88) still pulls them into a redownload, so a batch he can no longer tick can still be re-emitted.  
  *Fix:* 'Select all exported' and a per-file record of which batch ids were in which download.
- **The Crews board doesn't show which lakes a crew serves** — When dispatch says 'No crew serves Pretty Lake yet', he has no way from /ops to check whether an existing crew simply hasn't ticked that lake — or was auto-demoted off it last night.  
  *Fix:* He'd add service_lakes and any live vendor_lake_demotions row to the crew card.
- **There is no ops link in the header** — From a job file, a park page, or anywhere else, getting back to the console is the browser back button or typing /portal.  
  *Fix:* Bookmark /ops, and lose it every time a link takes him elsewhere.
- **Ice-out and hard freeze are typed by hand, per lake, every spring** — Six date fields across three lakes, remembered by nobody, gating the entire spring water calendar. Nothing prompts him in March; nothing on /ops says a lake is still running on last year's rolled dates.  
  *Fix:* He'd want a March banner naming the lakes still unconfirmed — the data (lakes.season_confirmed) already exists and is written by updateLakeConditions:225.

### The money itself

- **A crew's statement cannot be tied to the deposit that lands in their bank** — The early-pay fee lives on payout_batches.fee (bank-actions.ts:172-176) and never appears on the statement or CSV. A crew who pulls early sees a $2,000.00 period total and a $1,960.00 deposit, with nothing on the document their bookkeeper reads explaining the $40. The month-end batch has no fee, so the discrepancy appears only in the months they pulled early — which is exactly the shape that reads as an error rather than a fee.  
  *Fix:* Ring the office and ask why the deposit is short, then reconcile from memory of the app's in-page 'Get it now' preview, which is the only place the fee was ever named.
- **"Nothing released to pull right now" is what a crew is told when a clawback exceeds their loose earnings** — The message continues '— payouts land here the moment a job's photos clear', which reads as 'you haven't finished any work'. A crew who has three finished jobs and one large refund adjustment is told, in effect, that their work is not on record. The rows are unclaimed and restored correctly; only the sentence is wrong.  
  *Fix:* Scroll their own Earnings list, find the 'Adjusted — a refund went back to the customer' line, and work it out themselves — or ring ops, who also have no screen showing the crew's net loose balance.
- **Ops decides a refund from a modal that cannot mention the tip on the same card statement** — A customer ringing about a $1,690 statement line is looking at $1,540 of service plus a $150 tip. Ops can see both and act on one. The remedy for the tip half — the crew handing it back — exists nowhere in the product and is not even describable to the customer as a process.  
  *Fix:* Explain on the phone that the tip is final by design (which is the correct policy, per 0098), and absorb the goodwill cost as a larger service refund — which then over-claws the crew, because defaultClawback is proportional to the refund amount.
- **The resident's only alternative to a 3% card fee is a phone call the app never mentions** — On $520 rent the fee is $15.60 a month, $187 a year. The screen names bank transfer as the free option and bank transfer does not exist. The one thing that genuinely is free — handing cash or a cheque to the office and then tapping 'I already paid this' (sayIPaid, pay-actions.ts:239) — is a separate control on the same page that the fee copy never connects to.  
  *Fix:* Pay the fee, or work out on their own that the 'I already paid this' flow plus a trip to the office is the free rail, and accept that their bill is not credited until the owner confirms collection.
- **The park owner has no view of money LakeLife is holding for him** — Once online rent is on, some of his rent is in his own hands (cash and cheque, recorded via claim-then-confirm) and some is in LakeLife's merchant account. His statement totals both as 'money received' with no split by rail, so he cannot answer the only question that matters mid-month: how much of this have I actually got.  
  *Fix:* Cross-reference the Method column in the receipts CSV against his own bank deposits, monthly, by hand — and until a remittance rail exists, chase LakeLife by phone for the card portion.

### Full-time lake resident

- **The homeowner's home screen is a booking menu with a referral pitch stapled to it** — Somebody who buys one job a year lands on a sales floor every single time they sign in — invite a crew, share your link, earn credit — with their one live request two taps away under "My requests". There is no dashboard that opens on "here is your dock pull, here is the crew, here is the date".  
  *Fix:* They stop signing in between bookings, which is exactly the person most at risk of missing the pull deadline.
- **There is no phone number anywhere, and the copy keeps telling them to phone** — On the day they need to change something — the one day self-serve cancel is refused — the screen instructs an action the product does not support, over a channel (SMS) that has never delivered a message. The control that would work, the per-job comment box, is a full page-scroll below on the same screen and is not named in the refusal.  
  *Fix:* Point the refusal at the job's own Comments box, or at Messages, by name. Failing that, put an email address in the sentence.
- **Housekeeping cannot be bought as a one-off** — A year-round resident wanting one clean before the holidays has to pick a cadence word that is false, then read "we'll line up the repeats with you once it's confirmed", then watch their /requests row say "Weekly" forever. Spring opening and Fall winterization both have a 'One-time' option; the two services a resident is most likely to buy once do not.  
  *Fix:* Add a 'One-time' frequency to Housekeeping and Lawn in the services table (rule 8 keeps it a data change), and let isRecurring drive the copy honestly.
- **The pier tile shows one price for a service that is two trips** — "Pier install / removal — $604" reads as in-and-out for $604. It is $604 each way. The wizard says "per trip" in its price hint (ProfileWizard PriceHint) but the booking screen — the one where money is committed — does not. Same shape for "Boat lift set / pull" at $495.  
  *Fix:* Put "per trip" next to the price on the tile, the way the wizard already does.
- **The entire pitch is written for somebody who isn't there** — The resident reads three cards about absence-management and one Autopilot card about setting a season and forgetting it, and has to work out for themselves that a single dock pull is a thing this product sells. Nothing on the front door speaks to "I live here and I need one job done".  
  *Fix:* They compare against a local dock company on price alone, because nothing on the page addresses their case.
- **The free-cancel window for water work is seven days, and nothing says so until you tap Cancel** — Booking a $604 pier removal three weeks out feels free to change. Cancelling six days before costs $151, and the first they hear of it is the confirm dialog after they have already decided.  
  *Fix:* One line in the booking modal: water work cancels free up to seven days out.
- **"Approval needed from a crew flag" is labelled Text-only but emails regardless** — Small, and in the customer's favour — the email is the only thing that actually arrives. But the settings screen shows one channel for a notification that uses two, and the switch they can see governs the channel that does not work.  
  *Fix:* Change the def to "Text + email" and gate the email send, so the screen describes what happens.

### Marisol Ríos

- **Nothing on the guest's page ever tells her the total** — Three boat days are three separate taps producing three separate rows, each reading "· $150.00". There is no sum anywhere. She reaches the office window with no idea whether she owes $150 or $450, and the owner is quoting from a different screen.  
  *Fix:* One line under the card: "$450.00 to settle at the office" — the numbers are already in view.mine.
- **Re-tapping a day she already has reads as a refusal** — A slow connection at the lake, she taps "Take it" twice. The second POST comes back ok:false with why = "You have it." and the page paints it in the amber failure box. The sentence she is shown after successfully booking a boat looks like the booking was rejected.  
  *Fix:* When the refusal reason is that she already holds the day, render it as the green confirmation it actually is.
- **She has no route to report that she hit something** — She dings the prop on a stump. Her only screen is /use, which links to nothing, and the sticker path has no category for the boat and is anchored to a lot rather than to a unit. The damage reaches the owner only if she finds him in person, and nothing on his side records that the pontoon needs looking at before the next guest books it.  
  *Fix:* A "something's wrong with it" link on each of her held rows, landing in the same park_requests queue with the unit named — and a blackout suggestion on the owner's side when one arrives.
- **Renaming an amenity leaves the guest reading the old name** — He renames "The pontoon" to "The 24' Bennington". Her card heading changes; her confirmation still says "The pontoon is yours on Saturday, August 15" (amenity-guest-server.ts:346) and her "What you have" row still says The pontoon. A guest who cannot say which boat she has is the phone call this whole feature exists to remove.  
  *Fix:* When an amenity has exactly one unit and that unit's label equals the old name, rename it in the same write.
- **"Took cash" is the only way money can be recorded** — collectAmenityMoney accepts cash, check, card, transfer and other (amenity-actions.ts:471), and the button passes cash unconditionally. A guest who writes a cheque for the boat is recorded as having paid cash, and the CPA statement's method column is wrong from the first boat day.  
  *Fix:* The same small method picker the rent ledger already uses.
- **The provisional season is never admitted to anyone outside ops** — BookingGrid receives season.start/season.end as bare strings (src/app/book/page.tsx:212) and paints a rolled guess as a white square with the tooltip "Available". The public lake page (src/app/lakes/[slug]/page.tsx:122) prints "Everything out of the water by November 12" off the raw column with the year stripped. A customer books a pier install against a window nobody has confirmed and is told nothing; ops, refusing the same date, is told "provisional dates, rolled from last season".  
  *Fix:* Pass wasRolled through to the grid and the lake page and say it in one line: "These are last season's dates until this year's ice-out is confirmed."
- **Fixture lakes are indistinguishable on the ops season editor** — 0124 fenced fixtures off every public surface but left them in the ops lake grid on purpose — without a badge. A card for a scratch lake sits between Big Long and Pretty looking identical, and the real ice-out gets typed into the wrong one; the lake that actually needed it stays provisional and its pull reminder never fires.  
  *Fix:* Render the pill. The boolean is already in the props.
- **The owner is never prompted to write the rules that print above the guest's button** — 0119 calls rules "the one thing on the guest's page we must never write for him" and ships no default. Left empty, Marisol's page shows a boat, a price and a Take it button with no mention of life jackets or a return time — and acknowledged_at is stamped anyway (amenity-guest-server.ts:324), recording that she agreed to nothing.  
  *Fix:* Refuse to switch an amenity on with empty rules, or say plainly on the toggle that guests will see no rules at all.

### Park owner #2

- **There is no way to find out LakeLife does this** — He can only arrive by knowing somebody. The park module — twelve screens, an importer, a ledger, a cost splitter — is invisible to everyone who doesn't already have it.  
  *Fix:* One section on the homepage and one public page describing park administration, with a form that captures name, park, lots and email into a table ops can work from.
- **"Get in touch" with nothing to get in touch with** — The one screen written for him tells him to do something the screen gives him no way to do — the same shape as the sign-out copy with no sign-out button.  
  *Fix:* A mailto or a two-field form on that card.
- **The importer insists he is taking the park over** — He has owned it eleven years. He picks whatever month he happens to be sitting there, and that guess becomes the recorded arrival date of forty households and the boundary of what LakeLife may bill.  
  *Fix:* Offer "I'm already the owner — start billing from" as the primary phrasing, with the takeover wording as the alternative. The date is the same field; the sentence around it is the whole difference.
- **The CSV his accountant opens carries none of the warnings the screen shows** — He forwards Q3.csv. The accountant sees rent only, with nothing saying deposits and amenity money were deliberately left out, and queries it a year later.  
  *Fix:* Prepend the exclusion lines as comment rows above the header, or emit them as a second sheet. The file is already the thing that leaves the building; the notes should travel with it.
- **No quarterly or annual fee can be charged to anybody** — An annual road assessment or a quarterly sewer district charge has no home. He has to divide it by twelve and quietly bill it as part of the monthly grounds fee, which makes his own coverage comparison harder to read and gives residents a line that doesn't match the notice he sends them.  
  *Fix:* Either a due_month on park_fees and a biller that reads it, or — cheaper and honest today — a sentence on the fee form saying only monthly fees can be billed, and pointing at the costs screen, which does handle an arbitrary billing period and splits it correctly.
- **A rent increase can only be a flat number, never a percentage** — Eleven years of grandfathering means forty different rents. "Everyone up 4%" is what he actually wants and cannot express; "everyone to $425" is what the form offers and would cut several rents while raising others.  
  *Fix:* A percentage mode beside the flat one, and a lot picker — loadTargets and scheduleReRate already accept a lotIds array; only the UI passes [] unconditionally.
- **Walking back to an older month is one click at a time** — Chasing a March balance in August is five clicks each way, and there is no list of months with anything still outstanding — the only "who still owes me" view is per-month.  
  *Fix:* A month picker, and an all-months arrears view keyed on balance > 0 rather than on period_month.

### Seasonal lake homeowner

- **Every 'call us' has no number and no link** — They go looking for a phone number, find none in TopBar, OwnerNav, the footer or any page, and either give up or reply to a LakeLife text that goes nowhere. Grep for tel: across src returns no customer-facing result; the only phone numbers in the repo are (260) 555-01xx placeholders in tests and input placeholders.  
  *Fix:* Point these four strings at /messages, which is a real tab that works and already threads to dispatch — or print an actual number. The current copy names two channels the product does not have.
- **Booking a season means eight separate modals** — This persona buys the whole chain. Spring open, pier install, lift set, mowing, housekeeping, boat out, winterize, lift pull, pier out, fall close: ten passes through the same modal, each with its own month navigation, its own frequency chips and its own confirm. The multi-date mode (line 301) helps within one service only; nothing spans services.  
  *Fix:* A season bundle — the same set of dates the Autopilot proposal engine already knows how to pencil (proposeAutopilotDate) — offered once, at booking time, as a reviewable list.
- **Two different referral numbers on two different screens, neither labelled** — earnedTotal is lifetime including already-spent credits (referral-data.ts:45 sums every non-void row). After the credits are applied to a bill, /book still says $150 earned while /billing says $0 available. getMyReferralTicker already computes `available` and `maturing` — neither is passed to the card.  
  *Fix:* Pass `available` to ShareLakeLife and label the two numbers: earned to date, spendable now.
- **Notification settings are hidden inside Property profile** — A customer trying to stop or start a notification has to guess that it lives under 'Property profile', a tab about square footage and pier sections. And when they get there the channel labels are wrong for two of the six types.  
  *Fix:* Correct NOTIF_DEFS to match what actually sends, then surface the page from the nav or from the account controls.
- **The photo minimum is loaded and never shown** — The card says 'Every LakeLife job is photo-verified before your crew can mark it done' without saying how many. When four photos arrive for a fall winterization the customer has no way to know the gate was four, so they cannot tell a complete job from a thin one — which is the judgement the 👍/👎 is asking them to make.  
  *Fix:* Print '4 of 4 required photos' next to the gallery. The number is already in the view model.
- **A crew flag arrives with the numbers, but the approval card shows them without the price** — submitFlag composes a fully priced sentence for the notification (vendor/actions.ts:410-425, via summariseCorrection + correctionMessage — '8 → 12, $796 instead of $604, about an hour and a quarter longer') and sends it by text and email. The screen they land on shows only the count. Having read the money in the email, they approve on a page that has forgotten it.  
  *Fix:* Compute the same summariseCorrection line in getOwnerFlags and render it on the card, so the decision screen carries what the notification promised.
- **'Dispatch usually replies same day' is a claim about a history that does not exist** — Nothing in sendOwnerMessage notifies ops at all — only the emergency branch of triageInboundMessage pages, and only by SMS. A non-emergency message waits until somebody opens the ops board. A customer who is told 'same day' and hears nothing for three days concludes the product is broken rather than that they should follow up.  
  *Fix:* Either email ops on inbound, or say what is actually true — 'we check this every morning'.
