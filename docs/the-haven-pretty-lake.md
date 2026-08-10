# The Haven @ Pretty Lake — the real park, and what it demands of the software

Park #1 is not a hypothetical. This is the acquisition the park module exists to
serve, and every assumption in that module should be checked against this page
before it is checked against anything I invented.

Source: the acquisition credit memorandum (Aug 7 2026) and the conventional
proforma, both in OneDrive under
`BD DevCo Asset Management / The Haven - Pretty Lake Mobile Homes`.

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
