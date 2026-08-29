# LakeLife Winter Storage Addendum — DRAFT

**Version string:** `storage-terms-v1-beta` — the value
`src/app/book/storage/actions.ts:187` already writes onto every storage
envelope. Until this document exists, that string points at nothing.

---

## Read this before the document

**1. This addendum has nothing to sit under yet.** It is written to sit beneath
the numbered User Agreement in `docs/user-agreement-draft.md` — the one with
§10 "Boat storage and winterization". **That agreement is not in force.** No
code renders it and nobody has accepted it. What customers actually accept is
`tos-v3-beta` (`src/lib/tos.ts:42`): five short, unnumbered sections in
`src/lib/terms-content.ts` — *What LakeLife is · Who you're agreeing with ·
What LakeLife verifies · If you run a park · If you rent a lot* — with no
storage section at all.

So every "§10.1", "§6", "§16" below points at a document in a docs folder. The
two ship together or neither ships. Section numbers in this draft are marked
**[UA §n]** to keep that visible; when the numbered agreement goes live, check
every one.

**2. The product this describes is not bookable.** Production holds **zero
active service packages**, zero season envelopes and zero stays. The three
custody services a customer *can* buy today are standalone menu items that
create no custody record at all. Most of §3, §5, §6 and §8 is therefore true of
nothing purchasable right now. See **Before this can go live**.

**3. Two conventions.**

- Plain text = checked against the code, not the design doc.
- **[DECISION — …]** = a business call only you can make. These are proposals,
  not descriptions. Nothing should ship with a `[DECISION]` still in it.

Per the storage design §E.3 (your decision, 2026-07-22) there is to be **no
service-specific attorney language**: one master agreement, LakeLife as
third-party administrator, custody as Customer ↔ Crew. So this document says
how a season *runs*. It does not characterise the bailment, allocate liability,
or create a remedy.

---

## 1. What this is

This addendum sits under the LakeLife User Agreement (the "**Terms**"), which
you accepted before your first booking. It does not replace the Terms or change
them. Where this addendum and the Terms disagree, **the Terms control** — and
boat storage is governed by **[UA §10]**.

What it does is tell you how a winter actually runs: the dates, the hand-offs,
the photographs, and the money. You accept it when you book storage.

## 2. Your boat is held by your Crew, not by LakeLife

Your boat is in the care, custody and control of the **storing Crew**
**[UA §10.1]**. LakeLife stores no boats. We own no building, no yard and no
rack, and at no point does your boat pass into our hands. Every storage
building on this Platform belongs to an independent Crew.

Your Service Agreement for storage — like every other on the Platform — is
between **you and that Crew** **[UA §4]**.

Once your fall visit is assigned you are told **which company** is holding your
boat. It shows on the job in your portal and on your boat's status card, along
with the day it went in, your season end, and your spring quote.

## 3. Your season

Your included season runs from the day your boat goes in until the **season
end**, currently **31 May**.

Precisely: your season end is the first 31 May falling on or after the day your
boat went in. A boat taken in on 15 October 2026 is included through 31 May
2027.

> **[DECISION — snapshot the season end at intake.]** The season-end date is a
> platform setting read *fresh every time a bill is worked out*
> (`automation.ts:556`, `:3155`, `package-data.ts:163`). It is stored on
> neither the envelope nor the stay — I checked the columns. Moving that dial
> therefore re-dates the season for every boat already in a barn and re-rates
> every meter already running. Either snapshot it onto the stay at intake, or
> this section has to warn customers their season end can move after they book.
> The first is much better.

## 4. The fall visit

**4.1 You pick the day.** You choose your fall date when you book, at least a
day out — storage runs are planned, not same-day.

**4.2 Water work has a deadline.** If your fall visit includes work on the
water — hauling the boat off your pier or lift — it must happen before your
lake's posted pull deadline, set from that lake's estimated hard freeze. Shop
work is not water work and is not bound by that date. If you pick a date past
the deadline, the booking is refused when you make it and tells you the
deadline, rather than failing later.

**4.3 Custody begins when the visit is complete.** Your boat is recorded as in
storage when the fall visit is completed and photo-verified — not when you
booked it, and not when the Crew set off.

**4.4 You do not have to be there.** Nobody has to let a Crew in to take a boat
off a lift, so if no one answers the door the work goes ahead as booked and is
billed as booked. Your Crew is not permitted to record it as a missed visit.
The same is true in the spring.

## 5. The winter

**5.1 Your spring visit comes back to the same Crew.** It is pre-assigned to
whoever is holding your boat, because that is where the boat physically is.

> **[DECISION — 5.1 has a hole and 5.2 below cannot be written yet.]** If the
> storing Crew has been benched or its certificate has lapsed by ice-out,
> `birthSpringJobs` correctly notices, texts ops — and then falls straight
> through to `autoAssignJob` (`automation.ts:3098`), pre-assigning the splash
> to a Crew that does not physically have the boat. The comment three lines
> above says "leave the job requested"; the code does not. Fix the fall-through
> before publishing 5.1.

**5.2 If your Crew stops working with us mid-winter.** *Not drafted.*

> **[DECISION — what we owe a customer whose Crew fails mid-winter.]** Ops can
> bench a Crew with a barn full of boats and see nothing: `suspendCrew`
> (`ops/crews-actions.ts:72`) writes one column, never looks at
> `storage_stays`, and no screen lists what a Crew is holding. There is also no
> way to move a stay from one Crew to another — see 5.3. On the current posture
> the honest sentence is "we will help you get it back, we hold every record,
> and the claim is yours." Anything warmer than that needs machinery first.

**5.3 Getting to your boat mid-winter.** There is no self-service way to
retrieve a boat, or anything in it, between the fall and spring visits. If you
sell the boat, need gear out of it, or want it back early, message us from your
portal and we will arrange it with your Crew.

> **[DECISION — there is no release mechanism for anyone, not just customers.]**
> `storage_stays` flips to `released` in exactly one place: inside `settleJob`,
> on a completed spring visit (`automation.ts:604`). There is no ops action, no
> Crew action and no admin path — the ops Storage panel is read-only. So the
> only way a boat leaves storage in this system is a completed spring visit.
> Design §E.5 called for a logged release authorisation — who released it, to
> whom, with a photo, "never informal" — and none of it was built. 5.3 is
> honest (it promises a conversation, not a mechanism), but it is the weakest
> paragraph here and the first one a customer selling a boat in February will
> test.

**5.4 Where your boat is.** You are told the company holding it. We do not
publish a Crew's address, and there is no way to visit your boat through the
Platform. If you want to see it, ask us and we will ask your Crew.

> **[DECISION — can a customer visit, and does the boat stay put?]** Neither
> has an answer in the code. The customer sees a company name and nothing else,
> and nothing pins the boat to a named building or would record a move between
> a Crew's own sites. A marina would say "by appointment". Do not promise the
> boat stays where it was first put until something records where that was.

## 6. The spring visit

**6.1 You do not pick a spring date when you book.** You choose your spring
*work* and we hold its price. The date comes later, because it depends on the
ice.

**6.2 How the date gets set.** Once your lake's ice-out is recorded, we create
your spring visit dated **fourteen days after ice-out** — breathing room for
pier and lift work — and message you the penciled date by text and email.

**6.3 Moving it.** Message us from your portal and we will move it. While your
boat is in a barn you cannot cancel and rebook it yourself: the Cancel button
will refuse, because a boat in storage is a release conversation, not a booking
change.

> **[DECISION — our own text message tells people to do the refused thing.]**
> The penciled-date SMS (`automation.ts:3119`) reads "Need a different day?
> Just cancel and rebook from your requests page, or message us from your
> portal." `cancelRequest` (`requests/actions.ts:186`) hard-refuses any job
> whose group has a boat in storage. It offers the working path second, so it
> is not a dead end — but it leads with the one that fails. Fix the SMS in the
> same commit that publishes this.

**6.4 The price we quoted is the price you pay.** Your spring work is billed at
the figure quoted when you booked in the fall, even if the published menu has
moved over the winter. The booking-time promise wins.

## 7. Photographs

**7.1 A named walk-around.** When your boat goes in, the Crew works a named
list of shots — for a boat: port side, starboard side, bow, stern, hull, engine
and interior. Each photograph is stored against the shot it belongs to, so the
record can answer "show me the engine" rather than offering seven pictures and
a shrug.

**7.2 What is kept with each photograph.** Who uploaded it, a SHA-256
fingerprint of the image file so it can be shown to be unaltered, and the date
the uploading device reported for the file. That device date sits *beside* the
upload time and can legitimately differ from it — a Crew photographs at the
dock and uploads from the truck.

**7.3 You see them.** The photographs are in your portal under their shot
names, and they are shown to you when we ask whether the visit went well.

> **[DECISION — §7 describes the right thing on the wrong path, twice.]**
>
> *(a) The list is on the standalone services, not the packages.* A package
> visit is given no named list at all (`job-detail-data.ts:222`, `:239` — it is
> deliberately emptied for a package, because two legs of one visit could both
> want an "overall" shot and merging them would tick one leg off with the
> other's photograph). Packages are the only path that creates a custody
> record. So today the walk-around and the custody ledger never meet. The fix
> is per-leg lists on a package visit, not a merged one.
>
> *(b) There is no return walk-around.* Migration 0146 seeds shot lists at
> intake only; "Boat return & splash" has a bare count of 2 and no named shots.
> A condition baseline with no closing comparison proves what a boat looked
> like going in and nothing about coming out — half of what design §E.2 asked
> for. Until there is a return list, neither this addendum nor the booking
> checkbox may say "at every hand-off". **The checkbox says it today.**
>
> *(c) And the gate is a count, not the list.* 0146 left slot enforcement out
> deliberately (no offline support in the crew app). Seven photographs of one
> fender still clears a seven-photograph gate. §7.1 above is worded to describe
> what the Crew is *asked* to shoot, not what is *enforced* — keep it that way.

## 8. What you owe, and when

**8.1 Nothing at booking.** Booking storage does not charge your card.

**8.2 The fall visit.** Charged when the fall visit is complete and
photo-verified, on the card on file. The seasonal storage minimum is part of
that charge — you are not billed monthly through the winter.

**8.3 The spring visit.** Charged when your spring visit is complete and
photo-verified. Where your package includes the trip home, that trip is part of
that visit; where it does not, you collect the boat from your Crew and the
charge still falls at completion.

**8.4 Past the season end.** If your boat is still in storage after your season
end, storage accrues at a posted daily rate — currently **$10 per day** — for
each whole day past it. It is not compounded: it is the same daily rate however
long the overstay runs.

**8.5 We tell you while it runs.** While the daily rate is running and you have
no spring visit booked, we message you **once a week**, by text and email, with
the total so far.

> **[DECISION — the meter has no end, no bill, and no button. Do not ship 8.4
> and 8.5 as they stand.]** Three separate problems, all verified:
>
> 1. **A stored boat may never get a spring visit at all.** A spring leg is not
>    required in order to store a boat: `validateSelection` never demands one,
>    and the "Winter storage only" package's single spring row ships
>    `default_on = false`. With no spring legs, `birthSpringJobs` bails
>    (`automation.ts:2907`), so no spring job is ever born — and the per-diem
>    is *only ever computed inside a spring settle*. The stay never closes, the
>    Crew's yard feet are held forever, the weekly texts run forever, and the
>    money can never be billed.
> 2. **"Pick your splash day" names a control that does not exist.** The weekly
>    text says to pick a day from the requests page; the status card there is
>    text only, and there is no path anywhere in the app to add spring work to
>    a booked envelope.
> 3. **No cap, no lien, no abandonment path.** Nothing in the codebase mentions
>    either. You need an answer for the boat nobody ever comes back for.

**8.6 If a payment does not go through.** Your Crew is paid for work they have
done whether or not our charge succeeds, so an unpaid bill is between you and
us. If your card is declined we will email you and the amount sits on your
Billing page until it is settled. We do not add interest or a late fee.

> **[DECISION — does an unpaid balance hold the boat?]** Two live surfaces
> already tell customers it does: the booking checkbox and the booking
> confirmation email both say **"balance due before spring splash"**. Nothing
> enforces it — `birthSpringJobs` and `settleJob` never read an invoice — and
> there is no lien or abandonment mechanism in the product. Either build the
> gate those two sentences already promise, or delete the promise from both.
> Since LakeLife never has possession, the honest version is probably that the
> *Crew* may decline to release under its own lien rights, which belongs in the
> Terms with counsel, not here.

## 9. Cancelling

**9.1 Before a Crew is assigned.** Free.

**9.2 After a Crew is assigned, before the visit.** Free if you cancel outside
the window for that work — **seven days** where the fall visit takes the boat
off the water, **48 hours** where it does not. Inside the window, a
cancellation fee of **25%** applies. Your fall visit carries the whole season's
storage minimum, so cancelling it late is not a small charge.

**9.3 Once your boat is in storage.** You cannot cancel it yourself; message us
(§5.3, §6.3).

> **[DECISION — what an early release costs.]** Nothing in the code answers it,
> because nothing can release a boat early at all. The two candidates are a
> pro-rata refund of the unused season or nothing at all on the grounds that
> the minimum is earned in full at intake. This is a business call and I will
> not invent it. Whatever you choose needs to be a sentence here *and*, at some
> point, a button — today ops has no way to close a stay.

## 10. What LakeLife checks, and what it does not

We are a third-party administrator. Our role in your storage season is to run
the rails and to check documents.

**10.1 What we check.** Before storage work is routed to a Crew, that Crew must
have on file an unexpired general certificate of insurance **and** an unexpired
garagekeepers/bailee policy — the coverage that applies to property in a
business's own care, which an ordinary liability certificate excludes. A Crew
must also have declared enough unused space for the length being stored, and
where a package names indoor or outdoor storage, a building of that type.

**10.2 What we do not do.** We do not perform storage, supervise a Crew, or
inspect a building. We do not value your boat, and we never see the limit on
your Crew's policy — there is no field in our records for one.

> **[DECISION — 10.1 currently claims more than the software does, in four
> ways, and the live Terms already claim it too.]** Every one must be closed or
> the paragraph reworded, because `src/lib/terms-content.ts:71` tells every
> customer today that "storage crews additionally carry custody coverage":
>
> 1. **Nobody opens the document.** The Platform checks a file was uploaded,
>    that it is a document type, and that it is under 10MB. The expiry date is
>    **typed in by the Crew** (`onboarding-actions.ts:397` says so itself).
> 2. **It is checked once and never again.** `sendCoiRevalidations`
>    (`automation.ts:2058`) reads `coi_expiry` only — `garagekeepers_expiry`
>    appears nowhere in it. A custody policy lapsing in January produces no
>    reminder to the Crew, no alert to ops, and no flag on the stay. The
>    sticky-custody health check at ice-out has the same blind spot.
> 3. **The claim board bypasses it entirely** — see go-live item 1.
> 4. **A Crew activates itself.** No human approves a Crew; activation needs a
>    certificate, a W-9, a trade list, a lake list and a capacity number.
>    Nothing about custody is among them.

> **[DECISION — tell customers to keep their own cover.]** Proposed for §10.2:
> *"Keep your own boat insurance in force through the winter. We check that
> your Crew carries custody coverage and that it has not expired — we never see
> the limit on it, so we cannot tell you whether it would cover your boat. Your
> own policy is the one you control."* This is a customer obligation, not a
> description of the build, which is why it is a decision. It is also the
> ordinary term of every storage yard in the Midwest, and its absence is the
> biggest gap in this document for somebody leaving a $40,000 boat with a
> stranger.

## 11. Before your fall visit

> **[DECISION — this whole section is proposed, not described.]** The software
> knows nothing about boat preparation: no checklist, no acknowledgment, no
> declared value, no inventory. These are the ordinary terms of Midwest winter
> storage and what a Crew will expect, but every line is a business decision,
> and none is enforceable by the Platform.

Please, before the Crew arrives:

- **Take your belongings out.** Electronics, tools, fishing gear, water toys,
  paperwork, anything of value. Personal property left aboard is not part of
  what is stored and is not documented in the condition photographs.
- **Take out anything that can freeze or spoil** — drinks, food, extinguishers
  past date, any container of liquid.
- **Tell us about anything already wrong.** Existing damage, a soft spot, a
  cracked cleat, a temperamental engine. It goes on the record at the start,
  where it helps you.
- **Say if the boat cannot be moved normally** — a dead battery, a seized
  trailer wheel, a jammed lift.

> **[DECISION — fuel, batteries and covers.]** Who is responsible for fuel
> stabiliser, battery removal, and a cover or shrink-wrap: you, or the
> winterization service you bought? The menu has separate services for some of
> this. Tell me the split and I will write it — it is a menu decision and I
> cannot read it out of the code.

> **[DECISION — and who pays for a wasted trip to an immovable boat.]** There
> is a good rule for this and it is unreachable for boats. When a Crew arrives
> and cannot do the booked job, the owner is asked, nothing is charged for the
> visit, and LakeLife pays the Crew's $35 trip fee out of its own pocket
> because our record was wrong (`recovery.ts:196`). But an at-arrival flag
> requires a corrected *count* (`vendor/actions.ts:384`), and the correctable
> list is pier sections, lifts, jet skis and lawn band — there is no boat
> length and no "it will not move". A Crew standing at a dead pontoon has no
> button. Either the flag gains a countless "cannot proceed" reason, or §11's
> request that you warn us is the only protection there is and this document
> should say so.

## 12. If something is wrong

Tell us as soon as you see it, through your portal. Damage questions are
between you and your Crew; our part is the record — the photographs, the dates,
and who was there — and we will give you all of it.

> **[DECISION — there is no damage path.]** Across 82 tables there is no damage
> record, no claim record and no claim workflow. The only mechanism that exists
> is the thumbs-down on a completed job, which opens a service-quality dispute
> whose refund can never exceed the money captured on that one job — a
> four-figure gelcoat claim would be answered by refunding a storage fee. §12
> is written narrowly on purpose: it promises a record, which we have, and not
> a remedy, which we do not. To promise more, the machinery has to exist.

## 13. Changes

Rates and dates published on the Platform can change. A season you have already
booked is priced at what you were quoted (§6.4).

> **[DECISION — this is false for two numbers until they are snapshotted.]**
> The season end and the daily overstay rate are re-read fresh at settle time
> and are on no column of `storage_stays` or `job_groups`. A change to either
> re-dates and re-rates boats already in barns. §3 and §8.4 admit this inside
> their decision boxes; §13 asserts the opposite in plain text, which is the
> version a customer would quote back. Fix the code or reword all three.

If this addendum is materially updated, you will be asked to accept the new
version before your next storage booking.

---

## Before this can go live

Ordered by what would hurt most. The first is a live defect and is not an
addendum problem at all.

1. **Close the claim-board custody hole.** A Crew with no garagekeepers policy
   can claim a boat today, on all three bookable custody services. The rule
   exists — `canClaim` refuses `input.storage` — but neither caller passes it
   (`open-data.ts:255`, `open-actions.ts:244`), so the branch is dead code and
   the board's only custody filter is "no package envelope", which all three
   satisfy. Same defect 0145 fixed for auto-dispatch, in the larger doorway.

2. **Decide what the three standalone custody services are.** "Boat storage &
   winterize", "Jet ski winterize & store" and "Water toy prep & storage" are
   active and bookable, and none creates a custody record: no stay, no intake
   timestamp, no season end, no meter, no spring visit, no hold on the Crew's
   space — all gated on a package envelope (`book/dispatch.ts:633`) they never
   have. There are **zero active packages**. So §3, §5, §6 and §8 are currently
   true of nothing a customer can buy. Either these three create stays, or they
   come off the menu until packages ship.

3. **Fix the checkbox and the confirmation email.** The only place a customer
   ever meets "the winter storage terms" is one label with no link and no
   document behind it (`StoragePackageWizard.tsx:288`), and it asserts two
   things that are not true: *"condition photos at every hand-off"* (intake
   only) and *"balance due before spring splash"* (nothing gates it). The
   booking confirmation email repeats both. Fix them in the same commit that
   publishes this, and make the checkbox link to it.

4. **A stored boat with no spring leg can never be billed or released.** See
   §8.5's decision box. This one silently holds a Crew's yard space forever.

5. **Give a package visit its walk-around, per leg,** and **add a return
   walk-around.** Intake has a list; outtake has nothing; and the path that
   holds boats has neither.

6. **Fix the benched-Crew fall-through** in `birthSpringJobs`
   (`automation.ts:3098`), which hands the splash to a Crew that does not have
   the boat. And give ops a way to see what a Crew is holding before benching
   it — and a way to move a stay.

7. **Snapshot the season end and the daily rate** onto the stay at intake, so
   moving a dial cannot re-date and re-rate boats already in barns.

8. **Revalidate `garagekeepers_expiry`,** in `sendCoiRevalidations` and in the
   ice-out sticky-custody check — or say in §10 that we check it once and never
   again. Note the live Terms already promise custody coverage today.

9. **Give the acceptance somewhere to go.** `acceptances.document_kind` is a
   five-value CHECK with no storage value, so this addendum can be shown but
   not recorded — the exact failure 0139 was written to end. Needs a migration
   and a pinned text digest, like every other document.

10. **Fix the penciled-date SMS,** which leads with the one action the server
    refuses for a boat in storage.

11. **Answer the open decisions:** early-release cost, fuel/battery/cover
    split, personal property, customer's own insurance, visiting the boat, and
    what an unpaid balance does.

Not blocking, but worth knowing: the space a booking reserves is the **sum of
every boat registered at the property**, not the one being stored
(`book/dispatch.ts:494`). There is no per-boat selection anywhere in the
booking flow, and the stay's label concatenates the whole fleet. Any future
term turning on "your boat" in the singular — a declared value, a per-boat
release — has nothing in the data to attach to.
