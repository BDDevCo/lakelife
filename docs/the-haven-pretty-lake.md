# The Haven @ Pretty Lake — the real park, and what it demands of the software

Park #1 is not a hypothetical. This is the acquisition the park module exists to
serve, and every assumption in that module should be checked against this page
before it is checked against anything I invented.

Source: the acquisition credit memorandum (Aug 7 2026) and the conventional
proforma, both in OneDrive under
`BD DevCo Asset Management / The Haven - Pretty Lake Mobile Homes`.

> ## ⚠ SUPERSEDED IN PART — read this first (added 2026-08-14)
>
> This page is the **credit memo and pro-forma**: what the deal was modelled to
> look like. The **due-diligence packet that arrived later carries the seller's
> actual handwritten rent roll**, and where the two disagree, the roll wins. It
> reconciles to the dollar ($6,700/mo total, $5,200/mo of lot rent), which is
> what makes it trustworthy.
>
> Corrections that matter, because code was written against the wrong ones:
>
> | This page says | The roll says |
> |---|---|
> | Lots numbered 1–21, with 22–25 "silent" | **21 lots numbered 1, 2, 6, 7, 9, 10, 11, 14–24, 26, 27, 28.** 3, 4, 5, 8, 12, 13 and 25 do not exist |
> | The park-owned double-wide is **lot 7** | It is **Lot 11** — a 2019 28×60 Shult |
> | That home rents at $1,200/mo | **$1,500/mo** |
> | Lot rent $650 / $500, 24 lots | Actual lot rents are roughly **$250–$300**; 19 of 21 lots pay, Lot 6 is vacant |
>
> The revenue table below is a PROJECTION — Airbnb mini-homes, twenty boat
> slips, RUBS, laundry — not a description of the park as it stands. Treat any
> number here as a target to be argued with, not a fact to build on.

---

## 1. What is being bought

| | |
|---|---|
| **Address** | 5000 S 925 E, Wolcottville, IN — LaGrange County |
| **Land** | ~3.96 ac across 7 parcels |
| **Frontage** | ~200 ft of sea-walled Pretty Lake frontage, 28-section dock |
| **Seller → Buyer** | Michael W. Reynolds → BD DevCo Asset Management, LLC |
| **Price** | $795,000, whole-business asset conveyance |
| **Diligence ends** | Nov 30 2026 |
| **CLOSING** | **Dec 15 2026** — adjusts to Seller's new-home closing; force-or-terminate past Jan 30 2027 |
| **Seller occupancy** | Rent-free to Jan 30 2027 → $800/mo Feb–Mar → $1,500/mo from Apr 1 → $200/day holdover |

**The cutover date is Dec 15 2026.** Not "this month". Every grandfathered
tenancy the importer writes starts there.

---

## 2. The rent roll as it actually stands

21 numbered lots. 19 pay. The arithmetic ties exactly.

| Lot | Rent | | Lot | Rent |
|---|---|---|---|---|
| 1 | $325 | | 12 | $300 |
| 2 | $250 | | 13 | $275 |
| **3** | — *silent* | | 14 | $300 |
| 4 | $275 | | 15 | $300 |
| 5 | $275 | | 16 | $250 |
| 6 | $275 | | 17 | $250 |
| **7** | park-owned double-wide | | 18 | $250 |
| 8 | $275 | | 19 | $250 |
| 9 | $275 | | 20 | $300 |
| 10 | $250 | | 21 | $250 |
| 11 | $275 | | **22–25** | — *silent* |

**$5,200/mo · $62,400/yr.** Ties to the credit memo's stated in-place rents.

Also on the sheet: a 24×24 pole barn / boat storage, and five "New Lot – Unit"
rows (four of which become the Airbnb mini-homes).

**THE ROLL NAMES NOBODY.** It is lots and rents. That single fact drove the
`namelessRoll` import mode — see §5.

Average in-place rent is **~$272** against a **~$420** market.

---

## 3. What it becomes

**Day one (Dec 15 2026):** every occupied lot re-rates $250–$325 → **$400**,
boat slips → **$100**.

**Month 6:** 10 premium lake-view lots → **$650**, 14 standard → **$500**; lot
count expands **20 → 24**.

**Month 12:** four Airbnb mini-homes online.

Stabilized revenue stack, for reference:

| Source | Units | Annual |
|---|---|---|
| Lot rent (10 @ $650 + 14 @ $500) | 24 lots | $162,000 |
| Park-owned double-wide | 1 home | $14,400 |
| Airbnb mini-homes | 4 homes | $112,000 |
| Boat slips @ $100/mo (~7-mo season) | 20 slips | $14,000 |
| Utility bill-back (RUBS) | pass-through | $16,000 |
| Laundry | — | $6,000 |
| **Fees & ancillary — explicitly "powered by LakeLife.ai"** | — | **$29,600** |
| | | **$354,000** |

---

## 4. What this park demands that the software does not yet do

Ordered by when it bites.

1. ~~**The day-one re-rate.**~~ **BUILT** (0061 + `rerate-helpers.ts`).
   Scheduled, not applied: `quoted_amount` moves only on the effective date,
   and the DATABASE refuses to apply any change that was never served or was
   served inside the notice period. Verified against these 19 lots —
   $5,200 → $7,600, largest jump +60%.
   **STILL NEEDS COUNSEL:** `parks.rent_notice_days` defaults to 30 as a
   conservative placeholder. Nobody has confirmed Indiana's actual requirement
   for a mobile-home community, and the software deliberately does not guess.

2. ~~**Mixed seasonality.**~~ **BUILT** (0063). A season can now live on the
   LOT: all-null inherits the park's, and a park with none is year-round. So
   the 21 pads stay year-round while the slips run Apr–Oct. An agreement ends
   at whichever comes first, the 3-month cap or the season close — a September
   slip stops on Nov 1 rather than running to December.

4. ~~**Boat slips as inventory.**~~ Unblocked by the above: a slip is a lot
   with `site_type='slip'` and its own season, priced from the rate card.
   **Still to do:** the 28-section dock → 20 rentable slips is a lot-generator
   run, and nobody has set the real slip numbers or the Apr–Oct dates yet.

3. **RUBS / utility bill-back.** $16,000/yr, entirely unbuilt.

5. **The park-owned double-wide (lot 7).** A home the park owns and rents at
   $1,200/mo — a *unit* tenancy, not a lot tenancy. Designed in phase 2, unbuilt.

6. **The fee stack** — pet, golf cart, boat rental, camp, insurance. $29,600/yr,
   and the memo sells it to the bank as a LakeLife.ai capability.

7. **Storage.** The 24×24 pole barn is boat storage — the storage module exists
   and its switch is off.

---

## 5. What the real roll already changed

Running this sheet through the importer was worth more than the eleven hundred
tests I had written against fixtures I invented. It produced **zero usable
rows**, for four separate reasons, every one a real bug:

- **`BARE_LOT_RE` did not accept the word "Lot".** Lots 3 and 22–25 are each
  written `Lot 3`, and the pattern only matched a bare `3`. **The walk list —
  the one output he could not produce himself — came back empty.**
- **No headerless inference.** The sheet's header is a merged label that does
  not survive a paste, so no column was ever mapped.
- **An unlabelled trailing total** (`5,200.00 $`) was not recognised, so the
  seller's own arithmetic was never checked.
- **A roll with no name column blocked every row.** The requirement "a lot and a
  name" was written assuming the sheet *has* names. When the whole sheet has
  none, 20 unanswerable questions is the same as importing nothing.

The last one became a product decision: **`namelessRoll` mode.** Lots and rents
go in, no tenant is invented, and every lot lands on the name-collection list.
That is exactly the shape of a proforma, and exactly what he has.

Pinned as a regression test in `src/app/park/haven-import.test.ts`, asserting
the total ties to $5,200/mo → $62,400/yr.

---

## 6. How tenancies are structured at The Haven (owner's rule, Aug 10 2026)

**No stay runs longer than three months.** Somebody may stay as long as they
like, but each further period is a **new three-month agreement**, executed on
its own. **If the periods are consecutive, no second deposit is collected.**

Built in 0062:

- `parks.max_agreement_months = 3` and `parks.deposit_amount` — both dials, both
  NULL-able, because a park that runs month-to-month is a normal park.
- `lot_reservations.agreement_chain_id` + `agreement_seq` — consecutive
  agreements share a chain. **The chain, not the agreement, is the unit that
  matters**: it is what the deposit attaches to and what "how long have they
  been here" means.
- `check (agreement_seq = 1 or deposit_amount is null)` — a renewal cannot
  record a second deposit. The owner's rule is a database constraint, not a
  code path.
- The one-tap renewal writes a **successor row**, not a wider date range.
  Widening would destroy the discrete signed period the whole structure exists
  to produce.

**Consecutive** is precise: the next agreement starts the day the last one ends.
A gap means they left — new chain, seq 1, deposit due again.

**The 19 sitting tenants are exempt.** They were inherited month-to-month and
the importer writes them on a rolling one-year horizon; the cap applies to new
agreements only. **Converting them to three-month agreements is an open
decision** — it is a change to their arrangement and would carry its own notice.
Nobody has decided it.

### For counsel, alongside the notice-period question

Serial short agreements are a recognised structure and are also something some
jurisdictions look through. Somebody on their **eighth consecutive three-month
agreement has in practice lived here two years**, and may be treated as a
long-term tenant whatever each agreement says. Rather than hide that,
`agreement_seq` makes it visible, and past twelve months the app says so plainly
and points at the attorney. **LakeLife takes no position on whether the
structure achieves what it intends** — that is a legal question, not a software
one.

---

## 7. Reminders, and the one-click accountant statement (Aug 11 2026)

### Overdue reminders — built

`park_reminders` (migration 0071) records **every attempt to tell somebody**,
not just the successful ones. Rows carry a party (`resident` / `owner` / `ops`),
a channel (`email` / `sms` / `paper` / `none`) and an outcome
(`sent` / `printed` / `blocked` / `failed`), and a partial unique index on
`(charge_id, party) where outcome in ('sent','printed')` means **nobody is
chased twice for the same bill**.

Three rules did most of the work:

1. **Paper is a real outcome.** A quarter to a third of a park never goes
   digital, and those are usually the longest-standing households. The screen
   states the paper count out loud, and **the send button stays locked until the
   notices have actually gone to the printer** — otherwise the log would say
   "reminded" for people nobody ever told.
2. **An unusable channel is never the end of the road.** Texting is off until
   A2P 10DLC clears, so an SMS resident falls through to email, and with no
   email, to print. The only household the planner gives up on is one that
   asked not to be contacted — that gets "call in instead", and the block is
   recorded with its reason rather than silently skipped. (An earlier version
   blocked SMS outright; the screen then told the owner to "post or hand it
   over" with no way to do so, which is how the gap was found.)
3. **The digest goes to whoever is NOT at the screen.** Whoever clicked is
   reading the result already; it is the absent owner of a manager-run park who
   needs the summary. One owner row per chased charge, so "was the owner told
   about lot 3?" has an answer per household.

Nothing is on a cron. Chasing a household for money is the most consequential
message a park sends, and firing it unattended is how somebody who paid on
Tuesday gets a demand on Wednesday.

### The accountant statement — NOT YET BUILT, and deliberately so

The owner's standing ask: **one button that produces month / quarter / year
statements for the CPA.** Recorded here so it shapes what gets built rather
than being retrofitted.

The ledger already has clean period boundaries for it:

| source | gives the accountant |
| --- | --- |
| `park_charges` (frozen `lines` snapshot, `period_month`) | revenue **as billed**, split by line — rent vs each fee |
| `park_payments` (`received_on`, `method`) | cash **actually collected**, and in what form |
| `park_costs` + `lot_cost_shares` | expenses, and how much of each was recovered |

Two things that must be true before it is worth building:

- **Billed and collected are different numbers and must never be merged.** A
  charge raised in August and paid in October belongs to August on an accrual
  statement and to October on a cash one. The statement has to say which basis
  it is on, out loud, on the page.
- **A voided charge is not revenue.** `summarise()` already excludes it; the
  statement must too, and should show voids separately so a year with many of
  them is visible rather than netted away.

Open question for the owner: does the CPA want **cash basis, accrual, or both
side by side**? That answer changes the shape of the output, so it is worth
asking before building rather than after.
