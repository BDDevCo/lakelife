# LakeLife Spring Collection Addendum — DRAFT

For **spring 2027**: collecting a boat that wintered in somebody else's yard,
servicing it, and putting it back in the water.

---

## Read this before the document

**1. This is the season you are actually selling into.** 0147's header records
the call: the 2026 fall season is gone — boats come out 12–16 November and The
Haven does not close until 15 December — so the first season LakeLife can sell
is spring 2027. That is a *different product* from the winter storage addendum,
and this is its document. No custody, no season, no per-diem. Go to a yard,
collect a boat, service it, launch it.

**2. Nothing here is bookable yet, and nobody could serve it.** Both services
are `active = false`. Production holds three crew accounts and all three are
test fixtures, which dispatch excludes from every candidate list. Live: zero
collection jobs, zero jobs with a pickup address, zero release confirmations.

**3. It sits under the same unshipped agreement.** Section numbers marked
**[UA §n]** point at `docs/user-agreement-draft.md`, which no code renders and
nobody has accepted. Customers accept `tos-v3-beta` — five unnumbered sections
with no storage or transport section. These ship together or not at all.

**4. Conventions.** Plain text = checked against the code. **[DECISION — …]** =
your call, not a description. Nothing ships with a `[DECISION]` in it.

**The one that matters most is §8.** Nothing checks that a Crew towing your boat
is insured to tow it.

---

## 1. What this is

This addendum sits under the LakeLife User Agreement (the "**Terms**") and does
not replace or change them. Where they disagree, **the Terms control**.

It covers **spring collection work**: where your boat spent the winter somewhere
other than your own property, and a Crew collects it, services it, and returns
it to the water.

## 2. What you are buying

Two services. Once we switch them on, either can be bought on its own — you will
not need to have bought a winter package from us, and it will not matter who
stored your boat.

- **Spring de-winterize & test run** — we collect it and service it. Priced by
  the foot.
- **Boat return & splash** — we collect it and put it back in the water.

**Both are collections.** Each one asks where the boat is, and each one needs
you to have cleared it with whoever is holding it. Buying one does not commit
you to the other.

> **[DECISION — the two are gated differently and a customer will notice.]**
> *Boat return & splash* is water work, held behind your lake's ice-out date.
> *Spring de-winterize & test run* is not, so it can be booked for February. A
> customer could buy shop work the Platform schedules happily and a splash it
> will not schedule for two more months. That may be exactly right — shoulder-
> season shop work is real — but it should be a decision, and the booking screen
> should say so.

## 3. Your boat is not where you live

Every other service we sell happens at your property. These two do not, so we
have to ask.

**3.1 You tell us where the boat is.** An address — the marina, the storage lot,
the barn. We cannot book a collection without it.

**3.2 Pick it from the suggestions.** Choosing a suggested address gives us map
coordinates, which is what puts your Crew at the right gate. If the yard is not
in Google's list, there is a "Can't find it? Type it myself" option.

> **[DECISION — the address field is not fit to ask this question yet.]** Three
> things, all in one small component:
>
> 1. **Typing does nothing while the suggestion box is up.** Its change event
>    fires only when a suggestion is *selected*, so a customer who types the
>    marina's address and taps Confirm gets a disabled button and "Tell us where
>    the boat is" — with no indication why. The typed path exists but is behind
>    the "Can't find it?" link, which reads as a fallback rather than the fix.
> 2. **The field is labelled "Property address"** with a lot-number placeholder,
>    because the component takes no label. On the one screen where the whole
>    point is that this is *not* the customer's property.
> 3. A typed address stores no coordinates. Harmless today, but if you ever set
>    the distance dials, the booking action starts refusing typed addresses with
>    "Pick the boat's location from the suggestions rather than typing it" — so
>    fixing (1) becomes load-bearing.

**3.3 We look for a Crew near the boat.** When we are choosing between Crews who
can do the work, we prefer the one closest to where the boat actually is.

> **[DECISION — 3.3 is the strongest sentence the code supports, and it is
> weaker than it sounds.]** Distance is a *tiebreaker*, never a requirement: it
> is the third sort key when ranking Crews, and it is skipped entirely for a
> preferred Crew. The only hard geographic gate is the lake gate, and that reads
> the lake on the customer's **property** — not the yard. So nothing stops a
> Crew being sent a long way to a pickup, and nothing measures that distance
> against anything. See go-live: there is no distance cap anywhere.

## 4. Clearing the collection with whoever has your boat

**A yard does not hand a $40,000 boat to a stranger with a trailer.** Somebody
has to have told them we are coming, and the only person who can is you.

**4.1 What we ask for.** A name to ask for at the gate, a number to ring before
setting off, and your confirmation that **you have told them** a Crew is
collecting on your behalf. We cannot book a collection without that
confirmation.

**4.2 What we do not do.** We do not contact the yard. We do not hold an
authorisation, take a release form, or collect anybody's signature. We record
what you told us and pass your Crew the name and number you gave. Your Crew will
still ask at the gate.

**4.3 The name and number are optional; the confirmation is not.** Not every
barn has a front desk. If you give us no number, your Crew's screen says "No
number on file for them" — a fact they can plan around, rather than discover
after a forty-minute drive.

## 5. If nobody hands the boat over

Your Crew arrives and whoever has the boat will not release it — the office is
shut, the person you spoke to is off, nobody knows anything about it.

**5.1 They will not take the boat any other way.** The visit ends there and is
recorded as a missed one, not as work done.

**5.2 Nothing is charged on the spot.** Nobody is billed by a Crew tapping a
button on a doorstep, and the email we send you says so.

**5.3 Pick another day within seven days — that is the only thing that closes
it.** Re-booking in your portal is what clears it; ringing or emailing us is not
the same. If nothing is booked by that date, a fee under our cancellation policy
is put in front of our team for a decision. A person chooses whether to charge
it or waive it, and nothing reaches your card until they do.

**5.4 Your Crew is paid for the trip either way.** They drove out and hitched up
nothing; that trip is real work. LakeLife funds it unless a fee has actually
been collected from you, in which case their share comes from that.

> **[DECISION — a refused release is being treated exactly like a locked front
> door, and it may not be the same thing.]** This reuses the driveway recovery
> written for "the crew couldn't get in": a reschedule window, then a proposed
> fee of 25% — about $71 on a $285 splash. Fair when the obstacle was the
> customer's own locked house.
>
> A yard is somebody else. A customer can have done everything §4 asks — told
> the marina, given a name and a number, ticked the box honestly — and still be
> refused because the office was shut. Charging them reads very differently from
> charging somebody who forgot to unlock a gate.
>
> The Crew's $35 is not in question; they made the trip. The question is who
> carries it when the customer did everything right and the yard did not. Charge
> as now, waive when a release confirmation is on file, or split it.
>
> Two smaller things in the same paragraph: there is **no reminder** before the
> seven days lapse, and the reschedule card offers **only** a date picker — no
> "leave it", no reply box. A customer who wants to cancel rather than rebook
> has no button for it.

## 6. Being there

**You do not need to be at the yard** — the person who has to act is whoever is
holding your boat.

**But do answer the door for the visit itself.** These two services are set up
so that if a Crew cannot find anybody to deal with, at either end, the visit is
recorded as a missed one rather than done-and-billed — and that starts the clock
in §5.3.

> **[DECISION — one flag is doing two jobs, and it costs the customer at the
> wrong end.]** The release flag correctly makes "the yard would not release it"
> a no-show. But it is a property of the *service*, and the crew's arrival sheet
> reads it wherever they are: the "doing it as booked" button is shown only when
> the service needs neither interior access nor a release, so on a collection it
> never appears at all.
>
> So a Crew who collected the boat cleanly at the yard, drove to the property,
> and found nobody home has exactly one button — **Record a no-show** — for a
> splash that needs nobody home. That puts the customer on a reschedule clock and
> a possible 25% fee for a visit that could have been completed.
>
> This wants a second flag, or the release check scoped to the pickup leg. Until
> then §6 has to warn people, which is why it is worded as it is. Note this also
> fires on package spring visits, where LakeLife's own Crew is holding the boat.

## 7. What it costs

**7.1 The price you are shown is the price you pay.** Each service is priced on
the menu, in full, before you book.

> **[DECISION — 7.1 is true only while the distance dials are 0.]** The booking
> screen shows the menu price. The transport surcharge is added by the booking
> action *after* that screen. Today both dials are 0, so the two figures are the
> same and 7.1 is honest. The day you set a per-mile rate, a customer is quoted
> $285, taps a button that says $285, and is billed $285 plus a tow nobody showed
> them. Either fold the tow into the figure the booking screen displays, or do
> not set the dial. **This is a launch blocker, not a footnote.**

**7.2 Distance.** *Not drafted — see below.*

> **[DECISION — do not publish a distance clause yet, in either direction.]**
> The radius and the per-mile rate are both **0**, so *Boat return & splash* is
> a flat $285 to anywhere. Two traps:
>
> - Describing a radius and a per-mile rate describes a mechanism that is
>   switched off.
> - Promising "$285 to anywhere" outlives the dial that exists precisely so you
>   can change it — 0149 carries the exact UPDATE that switches it on.
>
> And when you do set it: the miles are **yard-to-your-property** — the length
> of the tow, not how far the Crew travels — and they are straight-line, which
> runs 20–30% short of road miles. The customer-facing sentence has to describe
> *that* number, not one they would measure themselves.

**7.3 When you pay.** When the visit is complete and photo-verified, on the card
on file — the same as every other job.

## 8. What LakeLife checks — and what it does not

**8.1 What we check.** A Crew cannot go live without an insurance certificate
and a W-9 on file, and without giving us an expiry date for the certificate that
has not passed. That expiry is re-checked every time a job is routed or claimed,
and a lapsed one stops both.

**8.2 What we do not do.** Nobody at LakeLife opens either document, verifies
the numbers on it, or confirms what the cover actually is — the expiry date is
typed in by the Crew. We do not perform the work, supervise a Crew, or inspect
anybody's truck or trailer. We do not value your boat.

> **[DECISION — THE BIG ONE. Nothing checks that a Crew towing your boat is
> insured to tow it.]** This is the most important thing in the document and it
> is a gap, not a feature.
>
> These two services carry `takes_custody = false` — correctly; a collection is
> not six months of holding a boat. But that flag is what runs the insurance
> gate. A storage Crew must show a garagekeepers/bailee policy before a boat is
> routed to them. **A collection Crew must show nothing beyond the general
> certificate every Crew already has** — and 0145's header states plainly that a
> standard liability certificate *excludes damage to property in the vendor's
> care, custody and control*, which is exactly what a boat on their trailer is.
>
> So the chain is: your boat, a stranger's trailer, a public road, and no
> verified coverage for the boat itself. Live, not one Crew has any custody or
> transport policy on file.
>
> **The fix is the shape of a column that already exists.** Decide whether an
> on-hook / in-tow policy is required before a collection can be routed. If yes,
> it is a document kind plus an expiry, beside the two policies you already
> date-check. If no, that is a legitimate choice — but it is yours, and §8.2 has
> to say so to the customer in plain words.
>
> Until it is decided, **this addendum must not use the word "insured" about a
> collection.** The live Terms promise nothing about transport, which is
> currently accurate and worth keeping that way.

> **[DECISION — and a collection can be self-claimed by a stranger Crew.]** The
> fix that landed today stops an uninsured Crew claiming a *storage* job off the
> open board, because that check keys on `takes_custody`. These are not custody,
> so the board will offer them. Once active, a Crew nobody chose can take a
> $40,000 boat on a trailer for an afternoon — and the claim board has no
> geographic gate at all, so not even the lake check applies.
>
> If the answer is "routed only", it is **two** lines in each of the two callers:
> the condition, *and* the `services(...)` select that has to fetch the column
> the condition tests. A condition widened without its select compiles, reads
> `undefined`, and silently does nothing — the exact hole the claim-board fix
> closed this morning.

## 9. The record

**9.1 Photographs.** Your Crew photographs the job, and the photographs are in
your portal.

> **[DECISION — there is no condition record on this path, and this is the path
> where the boat moves.]** The named walk-around built in 0146 — port side,
> starboard, bow, stern, hull, engine, interior, each stored under its shot name
> with an author and a fingerprint — went only to the custody services. Neither
> collection service has a list, so the requirement is **two photographs,
> unnamed, taken at any point in the visit**. Nothing requires either to be of
> the boat at the yard, before it was winched on. Nothing records *which* of your
> boats was collected — there is no boat reference on any job.
>
> "That gouge wasn't there in October" is the argument this path invites, and it
> is the one path with no answer to it.

## 10. If something is wrong

Tell us as soon as you see it, through your portal. Questions about the work, or
about damage, are between you and your Crew **[UA §4, §16]**; our part is the
record — the photographs, the dates, and who was there — and we will give you all
of it.

> **[DECISION — same as the storage addendum: there is no damage path.]** No
> damage record, no claim record, no claim workflow. The only mechanism is the
> thumbs-down on a completed job, whose refund can never exceed the money taken
> on that job. §10 promises a record, which we have, and not a remedy, which we
> do not.

## 11. Changes

Rates and distances published on the Platform can change.

> **[DECISION — do not carry the storage addendum's price promise onto this
> path.]** The winter addendum can honestly say a booked season is priced at
> what you were quoted, because a package envelope stores the quote and the
> spring settle trues the legs back to it. **A solo collection has no envelope.**
> There is no stored quote and nothing to true back to, so a booked-price
> guarantee here would be a sentence with no machinery. Either say nothing, or
> build the equivalent first.

---

## Before this can go live

**Ordered by what would hurt most.**

1. **Decide the transport insurance question (§8).** Everything below is smaller
   than this one.

2. **Decide whether a collection can be self-claimed** or is routed only — and
   if routed only, remember it is the condition *and* the select, in both
   callers.

3. **Neither service can appear on a customer's booking menu, whatever it
   prices to.** `/book` shows only services already in a customer's
   `wanted_services`, and that list can only ever be filled from a hardcoded
   ten-service picker in the profile wizard which names neither collection
   service — and the wizard refuses to advance with nothing ticked, so the
   fall-back-to-everything branch never runs. **This is the change that actually
   opens the door.** It is not the $0 problem in item 4; it hides *Boat return &
   splash* at a flat $285 just as completely.

4. **`Spring de-winterize & test run` also prices to $0 for most customers.**
   It is per-foot with a base of 0, and boat lengths are only ever collected
   behind the *Boat storage & winterize* tick in the profile wizard. A customer
   who never ticked that has no boat on file, so it prices to nothing and is
   filtered off the booking menu — *but not off the public lake pages*, which
   carry no such filter and would advertise it at "from $9 per boat foot" to
   people whose own menu cannot show it.

5. **Fix the pickup address field (§3.2)** — typing, and the "Property address"
   label.

6. **Scope the release flag to the pickup leg (§6),** or add a second flag, so a
   Crew who collected the boat cleanly is not forced to record a no-show because
   nobody was home for the splash.

7. **Fold the tow into the price the booking screen shows (§7.1)** before ever
   setting a per-mile rate.

8. **Decide whether a refused release should be fee-eligible (§5),** and add a
   reminder before the seven days lapse and a way to decline rather than rebook.

9. **Autopilot can create a collection with no pickup address and no release
   confirmation.** The pickup and release checks live in the booking action;
   the Autopilot confirm route inserts a job directly, with five columns and
   neither check. Autopilot is offered for every priced tile.

10. **Give both services a named shot list** — starting with the boat at the
    yard, before it moves — and raise the photo minimum to match. Be clear what
    that buys: the list **prompts and labels; it does not require.** Nothing
    checks a named slot was filled and nothing records where a photo was taken.
    A yard shot becomes a real requirement only with the slot enforcement 0146
    deliberately deferred, which is a bigger item than "give them a list".

11. **A make-it-right visit re-uses the original release confirmation.** The
    correction clone copies `release_confirmed_at` forward, so the Crew's screen
    says "the owner says they've told them you're collecting it" about a
    conversation held for a *different date*. Copying the pickup address is right
    — the boat has not moved. Copying the customer's statement is not. (0151's
    own header lists the fields the clone carries and does not name this one, so
    the migration's record of its own change is a field short.)

12. **Decide the de-winterize / splash season mismatch (§2).**

13. **Neither service is active, and every Crew in production is a fixture.**
    Nothing above reaches a customer until both change.

Not blocking, but worth knowing: there is **no cap on distance** and no
equipment record anywhere. A Crew's capability is a service name ticked from a
list; the crew-units table holds no trailer, tow rating or hull limit. A 28-foot
tri-toon sixty miles away is indistinguishable, to every check in the system,
from a 16-foot fishing boat down the road.
