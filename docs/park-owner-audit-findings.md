# The park owner's screens — what an audit found, and what is left

Seventeen findings survived an adversarial pass over the twelve `/park`
screens, judged against the month a real owner actually has to run: bill
nineteen households, take cash and cheques at the door, chase what's late,
pay the water bill, and hand something to the accountant.

Written 16 August 2026, verified against `main`.

## Already fixed, struck from the plan below

- **Phantom lots on import** — a bare-number roll created "LOT6" and "LOT19"
  beside the real 6 and 19, so 21 pads became 23 and every shared cost was
  divided by the wrong number. Fixed in `4dbad7a`.
- **The takeover month had nowhere to land** — the importer asked "which
  month do you take over?" and never wrote `parks.cutover_date`, leaving the
  go-live gate off for every park onboarded that way. Fixed in `4dbad7a`.
- **The seller's-arithmetic panel went blank** on a park with no lots yet —
  "no amounts on this list" while holding $8,500 of them. Fixed in `4dbad7a`.
- **Invisible form fields** across the park module, including the twelve on
  "Who lives here". Fixed in `e5fab6e`.
- **A1 — rows that didn't take are now NAMED**, and it was worse than
  reported: a row blocked between the read and the commit left `plan.ready`
  silently and was not counted as a failure at all. Staged the race; the
  receipt said "2 tenants are in ✓" with `failed: 0` and a household was gone
  without trace. Fixed in `1f04471`, persisted so it survives a reload.
- **A3 — the fee form no longer offers what the biller ignores**, and the
  coverage panel no longer credits income against a bill that is never
  raised. `1f04471`.
- **A4 — the add-a-tenant form stopped promising texts.** `1f04471`.
- **A5 — 28 controls (not 5) zoomed iOS on focus.** All fixed in `1f04471`;
  a test now fails if any control gets an inline size under 16px.

**Still open from section A: A2** — "Print a slip" is not drawn on reserved
rows, which is every row between import and closing, so the paper channel is
unreachable for exactly the households that have no email.

## How to read the rest

Ordered by when it bites, not by how hard it is. Section A is the closing
week; B is the first billing run; C can wait and says what makes it urgent;
D is explicitly not to be done, with the reason.

Two things in here are **features, not defects** — flagged as such in D1 and
C3. Those are Brendon's call, not the engineer's.

---

# LakeLife park module — one ranked plan

Verified against the working tree on `main`. Line numbers are from the files as they stand now.

---

## A. FIX BEFORE HE CLOSES — 15 Dec 2026

These all fire during the import / invite / closing-table week. If they are still there on 15 December he does the work and the software eats it.

### A1. Name the rows that didn't take
**Cost if unfixed:** households silently absent from the roll, never billed, never surfaced again — an empty lot and a lost household look identical on every screen. This is the single largest money hole in the list.
**Files:** `src/components/ParkImportRead.tsx`, and `commitImport` already returns the data (`src/app/park/import-actions.ts:417`, `:746`).

Edits:
1. `ParkImportRead.tsx` — near line 61, add state:
   ```ts
   type CommitFailure = { lot: string | null; name: string | null; message: string };
   const [failures, setFailures] = useState<CommitFailure[]>([]);
   ```
2. `ParkImportRead.tsx:102-108`, inside `commit()`, after the `if (!res.ok)` guard and before `toast(...)`:
   ```ts
   setFailures(res.failures ?? []);
   ```
3. `ParkImportRead.tsx:111` — `if (done) return <Receipt view={view} failures={failures} />;`
4. `ParkImportRead.tsx:661` — widen the signature: `function Receipt({ view, failures = [] }: { view: ReadView; failures?: CommitFailure[] })`
5. `ParkImportRead.tsx:686-694` — inside the existing `failed > 0` card, replace the paragraph *"Everything else went in. Open the rent roll to see where the gaps are."* with a list rendered from `failures` (`Lot {f.lot ?? "?"} — {f.name ?? "no name"} · {f.message}`), keeping the old sentence only as the fallback when `failures.length === 0` (i.e. the page was reloaded).

**Known limit of this edit:** the list lives in client state, so it survives `router.refresh()` but not a hard reload. Persisting it needs `counts` widened from `Record<string, number>` to `Record<string, unknown>` at `import-actions.ts:219` **and** `ParkImportRead.tsx:45`, plus `failures` added to the counts object at `import-actions.ts:696-701` and `:531`. Do that as a follow-up; do not let it block the state fix.

### A2. Draw the "Print a slip" button on reserved rows
**Cost if unfixed:** the bulk-invite result names the no-email households and tells him to use a button on their rows. Between import and 15 December every row is `reserved`, so no row has one — the paper channel, the only channel those households have, is unreachable exactly when he needs it.
**Files:** `src/components/ParkRentRoll.tsx:453`, `src/app/park/page.tsx:225-231`.

Edits:
1. `page.tsx`, in the row mapper after line 231, add the `next` twins of the current fields:
   ```ts
   nextRenterId: r.next?.renterId ?? null,
   nextRenter: r.next ? roll.renterNames.get(r.next.renterId) ?? "Renter" : null,
   nextClaimStatus: r.next?.renterId ? claimStatuses[r.next.renterId] ?? "none" : null,
   nextRenterEmail: r.next?.renterId ? contact.get(r.next.renterId)?.email ?? null : null,
   nextInvitedAt: r.next?.renterId ? contact.get(r.next.renterId)?.invitedAt ?? null : null,
   ```
   (and the matching optional fields on the row type this file exports).
2. `ParkRentRoll.tsx:453` — change the gate from `r.state === "occupied" && r.currentRenterId && slug` to `slug && (r.currentRenterId ?? r.nextRenterId)`, and pass `r.currentRenterId ?? r.nextRenterId`, `r.currentRenter ?? r.nextRenter ?? "This household"`, `r.claimStatus ?? r.nextClaimStatus ?? "none"`, and the email/invitedAt equivalents.

### A3. Stop the fee form offering settings the biller ignores
**Cost if unfixed:** he sets his rate structure in December. A $120/yr road fee on 19 lots reads "19 paying · $190.00/mo" on `/park/costs` and folds $190 into the coverage margin he uses to decide the rent — and twelve charge runs bill $0 of it. Same for anything marked short-term or opt-in (`lot_fee_assignments` has one reader and zero writers anywhere in `src`).
**Files:** `src/components/ParkFees.tsx:32-33`, `src/app/park/fee-helpers.ts:112-113`, `:120-124`.

Edits:
1. `ParkFees.tsx:32` → `const CADENCES: FeeCadence[] = ["monthly"];`
2. `ParkFees.tsx:33` → `const APPLIES: FeeAppliesTo[] = ["long_term", "all_lots"];`
3. `fee-helpers.ts:112-113` → `case "short_term": return 0;` and `case "opt_in": return 0;` with a comment naming the two reasons (`runCharges` passes `fees: []` for a short-term lot; nothing writes `lot_fee_assignments`).
4. `fee-helpers.ts:122` → replace `: fee.cadence === "annual" ? fee.amount / 12` with `: 0`, comment: `buildStatement` (`statement-helpers.ts:176`) drops every non-monthly cadence, so crediting one is income the biller will never raise.

**This edit breaks two tests that currently assert the old behaviour — update them in the same commit:** `fee-helpers.test.ts:48-49` (`spreads an annual fee across the year`) and `:176` (`opt_in` → 6). Flip both to assert 0 and rewrite the test names to say why.

### A4. The add-a-tenant form promises texts that cannot arrive
**Cost if unfixed:** he repeats it at the window — "give me your mobile and you'll get your receipt by text" — to nineteen households, in his first month, as their new landlord. SMS is dead (0 of 81, error 30034), and `buildTenant` (`park-helpers.ts:889`) writes `contact_pref: "paper"` unconditionally anyway. The Edit panel 120 lines down the *same screen* already says the true thing.
**Files:** `src/components/ParkRentRoll.tsx:668-670`, `src/app/park/park-helpers.ts:729-730`.

Edit: replace the paragraph at `ParkRentRoll.tsx:668-670` with the Edit panel's own wording (`ParkRentRoll.tsx:786-789`) — a number here is one the office can ring; nothing is sent to it. Fix the stale docstring on `TenantInput.mobile` at `park-helpers.ts:729-730` to match.

### A5. The paste box zooms iOS at the closing table
**Cost if unfixed:** `ParkImportPaste.tsx:9-15` says "He is on his phone, at a closing table, and it is loud." Line 71 sets `fontSize: 13`, beating both 16px guards in `globals.css:266-280` and `:284`; `layout.tsx:34-38` sets no `maximumScale`, so Safari zooms on focus and does not come back.
**Edit:** delete `fontSize: 13` from `ParkImportPaste.tsx:71`. **Keep the monospace family** — that is what aligns the pasted columns. Same one-word deletion at `ParkHeldMoney.tsx:202` (select), `ParkHeldMoney.tsx:336` (input), `ParkAmenities.tsx:180` (input), `ParkStatements.tsx:276` (input). If 13px is wanted on desktop, put it behind `@media (min-width: 640px)` in `globals.css`, not inline.
`ParkLots.tsx:736` is a **button**, not a field — leave it.

---

## B. FIX BEFORE THE FIRST BILLING RUN — 1 Jan 2027

### B1. `removeCost` deletes shares already billed to nineteen households
**Cost if unfixed:** one tap, no confirmation. He mistypes the water bill at $3,800, splits it, raises bills, spots it, hits Remove — the cost and all nineteen `lot_cost_shares` cascade away (`0064_cost_recovery.sql:98`), the nineteen bills keep charging the frozen line in `park_charges.lines`, and the real $380 vanishes from his cost-recovery figure. `voidCharge` (`ledger-actions.ts:665-679`) deliberately *releases* shares rather than destroying them; this path does the opposite.
**File:** `src/app/park/cost-actions.ts:360-368`.

Edit — inside `removeCost`, before the delete:
```ts
const { data: shares } = await admin
  .from("lot_cost_shares")
  .select("amount, billed_on_charge_id")
  .eq("cost_id", costId);
const billed = (shares ?? []).filter((s) => s.billed_on_charge_id);
if (billed.length) {
  const each = Number(billed[0].amount ?? 0).toFixed(2);
  return { ok: false, error:
    `${billed.length} ${billed.length === 1 ? "household has" : "households have"} already been billed $${each} each for this. Cancel or correct those bills first.` };
}
```
Do **not** add a release-on-delete path (see D4).

### B2. Money in the drawer is invisible to every screen that chases people
Two symptoms, one root: `recordOnAccount` writes `charge_id: null` on purpose (`money-actions.ts:109`) and only `getHeldMoney` ever reads it back. Group these; they are the same January week.

**B2a — Today says "Nothing has come in yet this month."** while $2,800 of January cheques sit recorded.
`today-actions.ts:187-192` scopes the month's cash to `.in("charge_id", allIds)`; `today-helpers.ts:85` prints the flat sentence.
**Edit:** in `getToday`, add a second read — `park_payments` where `park_id = parkId`, `charge_id is null`, `reversed_at is null`, `received_on` within the month — and bucket it the way `receipts-actions.ts:97-113` already does (**exclude `kind = 'deposit'` and `kind = 'amenity'`**, or held deposits and guest-boat money will read as rent). Surface it as its own sub-line in `moneyBlock`, not folded into the headline: *"plus $2,790 on account, not yet against a bill."*

**B2b — a household with money on account is chased for it.**
`ledgerState` (`ledger-helpers.ts:113`) never sees it; `planReminders` skips only `state === 'disputed'` (`reminder-helpers.ts:202`). Cheque taken 28 Dec for January → on 4 Jan Lot 7 reads "Late", ParkToday lists it in arrears, and the reminder run drafts a demand for money in his own drawer.
**Edits:** in `getLedger` (`ledger-actions.ts:717`, alongside the claims read at `:741-747`), load unapplied `park_payments` by `renter_id` and set a `hasMoneyOnAccount` flag on the row. Then:
- `reminder-helpers.ts:202` — add, immediately after the disputed skip: `if (r.hasMoneyOnAccount) { skippedHasMoneyOnAccount += 1; continue; }` and add the counter beside `skippedDisputed` at `:196`.
- Print *"money on account — apply it"* on the ledger row in `ParkRent.tsx` and in ParkToday's arrears list, pointing at the Apply control that already exists at `ParkHeldMoney.tsx:187-216`.

**Do NOT net it out of `summary.outstanding` or the roll's "Owed this month"** — see D3. Flagged as a conflict below.

### B3. The overpayment that breaks the three-number block
**Cost if unfixed:** `recordPayment` (`ledger-actions.ts:413-478`) — the cash-and-cheque path the office actually uses — never compares the amount against what is owing, while `applyOnAccount` refuses exactly that with a written rationale (`money-actions.ts:181-190`). A resident hands over $542.10 for January and February: $271.05 is stranded on January's settled charge, February shows unpaid, and `summarise` adds the overpayment into `collected` (`ledger-helpers.ts:204`) while dropping it from `outstanding` (`:205`) — so billed − in ≠ outstanding on the card at `ParkRent.tsx:122-124`. `creditCount` is computed at `:219` and has no reader anywhere in `src`.

**Edits:**
1. `ledger-actions.ts`, after the charge fetch at `:445-450`:
   ```ts
   const owing = Math.round((Number(charge.amount) - Number(charge.paid_total)) * 100) / 100;
   if (amount > owing) {
     return { ok: false, error:
       `That bill only has $${owing.toFixed(2)} left on it and this is $${amount.toFixed(2)} — it would strand the difference on a settled bill. Record the extra as money on account and put it against next month's.` };
   }
   ```
   (Reuse `applyOnAccount`'s sentence deliberately — one wording for one rule.)
2. `ParkRent.tsx:122-124` — add a fourth `<Row label="in credit" ... />` rendered when `s.creditCount > 0`, so the block reconciles when a legacy credit exists.

### B4. Put a "Take it back" door on the screen the money was keyed on
**Cost if unfixed:** he types $4,395 instead of $439.50. The row flips to "In credit +$3,955.50", the Record-payment button is gone (gated on `balance > 0`, `ParkRent.tsx:194`), and the household reads as paid ahead — so he does not chase real rent next month. `reversePayment` (`ledger-actions.ts:947`) is written, park-scoped and tested, with callers only at `ParkHeldMoney.tsx:341` (which by construction never sees charge-anchored rows) and `ParkStatements.tsx:282` — a screen that defaults to *last complete month*, so a payment keyed today is not even on it when he arrives.
**Edit:** on any ledger row with `paidTotal > 0`, render a "Take it back" ghost button opening the same required-reason prompt as `ParkStatements.tsx:270-290`. **Lift that prompt into a shared component — do not write a second reversal UI.** This is the identical pattern the codebase already fixed once for `resolvePaymentClaim` (see the comment at `ParkRent.tsx:203-210`).

### B5. "Sort it" on a rent-notice task lands on a screen with no notice control
**Cost if unfixed:** an undismissable red card every morning, and an increase that either starts illegally or silently doesn't. `today-helpers.ts:392` and `:402` both set `href: "/park/lots"`; the only controls that touch `lot_rent_changes` are `NoticeForm` and "Call it off" in `ParkReRate`, which renders **only** on `/park` (`page.tsx:283`). `/park/today/page.tsx:48-50` states the rule this breaks in its own comment.
**Edits:** change both hrefs to `"/park"`. Also fix the `notice_missed` detail at `today-helpers.ts:388-389` — *"Move the date or serve it now and start later"* names a control that does not exist; the only route is Call it off and schedule again, so say that.

### B6. The accountant's file counts bounced cheques as income
**Cost if unfixed:** the screen correctly reads $8,835 and strikes the reversed row through (`ParkStatements.tsx:191-203`); the file sums to $9,300, because `getStatement` returns `receipts: inWindow` with no reversed filter (`receipts-actions.ts:181-185`) and `HEADERS` (`receipts-helpers.ts:347-352`) has no reversal column. Screen and file disagree by exactly the amount nobody can explain a year later.
**Edits:**
1. `receipts-helpers.ts:347-352` — add `"Taken back"` and `"Why taken back"` to `HEADERS`, and write `r.reversedAt ?? ""` / `r.reversedReason ?? ""` in `receiptsCsv`. **Keep the rows** — the receipt-number sequence must stay unbroken, which is why they are partitioned rather than dropped.
2. `ParkStatements.tsx:227` — the label promises a row count the file will not match (`s.count` excludes reversed rows). Change to `Download the file for your accountant`.

### B7. Show the note that identifies each bill
**Cost if unfixed:** `source_note` is written on all three branches of `recordCost` (`cost-actions.ts:223, 261, 303`), selected and mapped to `CostRow.sourceNote` (`:447`), and its **only** use in any component is `rows.some((r) => r.sourceNote)` at `ParkCosts.tsx:422` — the condition on a paragraph promising him the note is kept. The promise appears on screen precisely because the note exists, and the note is the one thing not on screen. A resident asks what the $18.09 is; he goes to the paper invoice, every time.
**Edit:** in the bill row at `ParkCosts.tsx:395-419`, render `r.sourceNote` as a muted second line under the category. One line of JSX; the value is already on the row. (Putting it on the *resident's* bill line — `ledger-actions.ts:126` — is a separate decision; don't fold it in.)

---

## C. CAN WAIT — with the trigger that makes it urgent

**C1. Deposits returned and deposits kept are in no statement, ever.**
`getStatement`'s off-book query selects `"amount, kind, charge_id"` only (`receipts-actions.ts:91`); `returned_on` / `returned_amount` (written by `returnDeposit`, `money-actions.ts:315-320`) are never read on this path, under a sentence promising the statement reconciles to the bank (`receipts-helpers.ts:450`). Money **kept** out of a deposit is taxable park income appearing nowhere.
**Trigger:** the first deposit he returns or partly keeps — realistically the first move-out in 2027, or sooner if he takes deposits from new tenants.
**Edit when triggered:** second query in `getStatement` for deposits with `returned_on` inside the window; pass `depositsReturnedCents` and `depositsKeptCents` into `exclusionLines`; print returned as a named cash outflow and kept as its own income line labelled *not rent*. Must reach the export at `receipts-actions.ts:216` too, not just the screen.

**C2. Work booked on the park's own home never reaches `/park/costs`.**
`getBillableParkJobs` (`cost-actions.ts:505`) and `recordCost`'s job gate (`:181-190`) both scope to the single `parks.service_property_id`, but `0122`/`service-actions.ts:414-465` mints a *second* property for a park-owned home (The Haven's Lot 11) and points the booking cookie at it. So a job the park paid for is invisible, and `recordCost` actively refuses it with "That job isn't one of this park's."
**Trigger: this is latent until a job can reach `complete`/`paid`, which needs a crew.** No crew exists. Not a January defect.
**Edit when triggered:** build the id list as `parks.service_property_id` **plus** `park_lots.service_property_id where park_id = parkId and park_owned_home = true`, and use `.in("property_id", ids)` in both places. Label owned-home rows with the lot number. See D2 for the wrong version of this fix.

**C3. "N households haven't signed the new lease" can only be dismissed, never cleared.** — *partly a missing FEATURE; Brendon's call.*
`origin` is written at `import-actions.ts:614` (hard-coded `grandfathered`) and `onboard-actions.ts:214`, and **updated nowhere** in `src`. `renew-actions.ts:206` copies it forward, so a renewal keeps a household grandfathered for ever. The task (`today-helpers.ts:349-362`) points at `/park`, which has no lease-signing control.
**Trigger:** the day he gets the first signed 2027 lease back and wants the number to move.
**Note for Brendon:** the *defect* is `renewAgreement` propagating `grandfathered` (a one-line fix at `renew-actions.ts:206`). The *feature* is a "they've signed the new lease" tick on the rent-roll Edit panel. **The feature is not a two-line job:** migration `0065:151` exempts grandfathered rows from the park's `max_agreement_months` cap, so flipping `origin` alone will be **refused by the trigger** unless the same update rewrites `during` under the cap. Do not attempt it as a quick fix.

---

## D. DO NOT DO

**D1. Do not build the opt-in fee assignment UI or an annual-fee biller now.** Both are features, not defects — Brendon decides features. The annual biller additionally needs a new `due_month` column on `park_fees` (`0067_park_fees.sql:38` has none) plus lifting the `[all_lots, long_term]` filter at `ledger-actions.ts:72` and joining assignments per lot. A2's dropdown removal is the correct interim: an option the biller cannot bill should not be on the form.

**D2. Do not widen the park-jobs scope to `properties.eq("park_id", parkId)`.** That set includes **residents' own properties** — `0107`'s `park_site_visits` view uses exactly that scope deliberately, and it is why the visits board shows a resident's crew. Widening that far would put a household's private purchase on the park owner's "work you booked" list and hand him a button to bill it back to them, inverting the privacy rule the comment at `cost-actions.ts:491-494` exists to state.

**D3. Do not net on-account money out of `summary.outstanding` or the roll's "Owed this month".** Those totals are tied to charges and feed the CPA statement. A bill with unapplied money against it is genuinely unpaid; the fix is to *point at the Apply control*, not to fake the total. **Conflicts directly with B2b — apply B2b as written and reject any version that touches the totals.**

**D4. Do not add a release-on-delete path to `removeCost`.** Unlike voiding a bill, deleting the cost leaves nothing to re-bill against. Refuse the delete (B1); don't try to make it survivable.

**D5. Do not "fix" SMS anywhere in this module.** Standing constraint. A4 is a copy fix that removes a promise, not a channel fix.

---

## Conflicts and sequencing

- **B2b ↔ D3** — the same finding has a tempting wrong version. Ship B2b's flag-and-skip; reject any patch to `summarise`.
- **A3 ↔ D1** — mutually exclusive treatments of the same dropdown. A3 now, D1 only if Brendon asks for the feature.
- **A3 changes test expectations** at `fee-helpers.test.ts:48-49` and `:176`. Same commit, and rewrite the test names to state the new rule.
- **B3 and B4 touch adjacent code in `ParkRent.tsx`** — do B4's shared-prompt extraction first, then B3's fourth row, to avoid two passes over the same block.
- **A5 and B4** both touch `ParkStatements.tsx` (line 276 font-size; lines 270-290 prompt extraction). Do B4 first.

## Honest labels

- **C3** is 90% feature. **D1** is entirely feature. Everything in A and B is a defect — a value read and never written, a promise the code contradicts, or a total that stops adding up.
- Nothing in this list needs a payment processor, an SMS channel, a crew, or a redesign of `lakelife.html`.

---

## The raw findings, for reference

### 1. lot_fee_assignments is read and never written, so an "only who signs up" fee bills nobody, forever

`src/app/park/fee-actions.ts:84` · lens: no-writer · reported certain

**What he'd meet:** He creates a pet fee, an extra-vehicle fee or a storage fee as "only who signs up", it saves cleanly and appears in the fee list, and no resident is ever billed a cent of it — there is no screen anywhere that can sign anybody up. It also reads as $0 income in the "is my fee covering my costs" comparison on the same page, so it drags the coverage number down while collecting nothing. A $15 pet fee on four households is $720 a year he thinks he is charging and isn't.

**Skeptic checked:** Verified: `grep -rn lot_fee_assignments src` returns exactly one hit, the .select("fee_id") at fee-actions.ts:84. No insert or delete exists anywhere in src, and no screen offers a picker. Meanwhile ParkFees.tsx:33 lists opt_in in APPLIES and renders it in the "Who pays it" select, and 0067 permits it on park_fees.applies_to. Two independent failures follow: payersFor (fee-helpers.ts:113) returns counts.optedIn, permanently 0, so monthlyIncome is $0; and even if a row existed, the charge run drops it — feesFor at ledger-actions.ts:72 filters to ["all_lots","long_term"] and is the fee source for both the preview (151) and the run (277), as does page.tsx:89 for the roll's owed tile. Concrete: he saves "Pet fee, $15/month, only who signs up" for the four households with dogs; it appears in the list, nobody is ever billed, and $720 a year he believes he is charging never arrives. It also enters the coverage comparison at $0 income, pushing the "is my fee covering my costs" line further into the red on the same screen.

**Fix:** Smaller than proposed: drop "opt_in" from APPLIES at ParkFees.tsx:33 so the option cannot be chosen, and leave the schema alone. Building the assignment UI would also require lifting the ledger-actions.ts:72 filter and joining assignments per lot — a real slice, not a patch. An option the biller cannot bill should not be on the form until that slice is built.

### 2. Annual, short-term and opt-in fees are counted as income on the fee screen and are billed by nothing

`src/app/park/fee-helpers.ts:122` · lens: money-adds-up · reported certain

**What he'd meet:** He sets a $120-a-year road fee on 19 long-term lots. The fee screen shows '19 paying · $190.00/mo' and folds $190 into the margin that tells him his grounds fee covers water, sewer and trash. Twelve charge runs later he has billed $0 of it — $2,280 he believed he was collecting, and a coverage figure that told him he was in the black while he was $190 a month short. Same shape for anything he marks 'short-term' or 'opt-in'.

**Skeptic checked:** Reproduced. `monthlyIncome` (src/app/park/fee-helpers.ts:118-129) credits an annual fee at amount/12, `payersFor` (fee-helpers.ts:100-115) returns the short-term lot count for applies_to='short_term', and both feed `checkCoverage` via fee-actions.ts:101-102 and 111-118 — the panel that answers 'is my fee covering my costs?'. On the billing side `buildStatement` (statement-helpers.ts:176 `if (f.cadence !== "monthly") continue;`) drops every non-monthly fee, `feesFor` (ledger-actions.ts:72) keeps only all_lots/long_term, the identical filter is duplicated at page.tsx:88, and runCharges passes `fees: rental_mode === "short_term" ? [] : fees` (ledger-actions.ts:353). ParkFees.tsx:32-33 offers all four cadences and all four applies_to values with no warning anywhere in the row rendering (ParkFees.tsx:105-131). One correction to the finding: `lot_fee_assignments` genuinely has one read (fee-actions.ts:84) and zero writers in src, but because of that `optedIn` is always 0, so an opt_in fee inflates nothing — it is simply a fee he can create that will never be assigned and never billed. Also note park_fees has no due_month column (0067_park_fees.sql:38), so an annual fee has nowhere to record when it falls due. Concrete: a $120/yr road fee on 19 long-term lots reads '19 paying · $190.00/mo' on /park/costs and is folded into the coverage margin, while twelve charge runs bill $0 of it — $2,280 he believed he was collecting.

**Fix:** Two small changes, not a new biller. (1) Make the money screen stop crediting what cannot be billed: return 0 from `monthlyIncome` for any cadence `buildStatement` skips, and return 0 from `payersFor` for 'short_term' and 'opt_in' — the same reasoning the all_lots branch already applies. (2) Until a biller exists, drop 'annual', 'per_stay', 'one_time', 'short_term' and 'opt_in' from the ParkFees.tsx:32-33 dropdowns rather than offering settings nothing honours. Teaching the biller annual fees is a separate job that needs a due_month column on park_fees first.

### 3. Money on account never suppresses 'late' — a household whose cheque is in the drawer is counted in arrears and posted a demand

`src/app/park/reminder-helpers.ts:202` · lens: money-adds-up · reported certain

**What he'd meet:** Cheque taken 28 December for January rent, filed on account because that is what the screen tells him to do. On 4 January the bill is past due and past the lag, so /park/rent shows Lot 7 'Late', the roll counts it in 'Owed this month', ParkToday puts it in arrears, and the reminder run prints Lot 7 a letter asking for $271.05 that is already in his own drawer. That is the first conversation of the takeover month and it is the one the whole lag-days design exists to prevent.

**Skeptic checked:** Reproduced. `recordOnAccount` (money-actions.ts:86-135) deliberately writes charge_id: null, and nothing outside `getHeldMoney` (money-actions.ts:355-410) ever reads it back. `ledgerState` (ledger-helpers.ts:113-152) takes only the charge, today, lagDays and the open-claim flag; `planReminders` (reminder-helpers.ts:202) skips only state==='disputed'; the roll's own loop (page.tsx:151-160) and ParkToday's arrears (today-actions.ts:172-179) both read park_charges alone. The only place the money appears is the ParkHeldMoney panel further down /park/rent, which does carry a per-household Apply control (ParkHeldMoney.tsx:187-216) — so the mistake is recoverable, but nothing on the late row, the roll tile, the morning screen or the reminder plan mentions that the money is already in the office. This is the same failure mode the 'disputed' guard exists to prevent, written out in that guard's own comment. Concrete: the Millers' cheque taken 28 Dec for January rent, filed on account; on 4 Jan Lot 7 shows 'Late', ParkToday puts it in arrears, and the reminder run drafts them a letter for $271.05 that is in his own drawer.

**Fix:** Smaller than proposed. Do NOT net on-account money out of `summary.outstanding` or the roll's 'Owed this month' — those totals are tied to charges and feed the CPA statement, and a bill with unapplied money against it is genuinely unpaid. Instead: load unapplied park_payments (kind='rent', charge_id null, reversed_at null) by renter in `getLedger`, flag those rows, skip them in `planReminders` with a new skippedHasMoneyOnAccount count, and print 'money on account — apply it' on the row and in ParkToday's arrears list so the office is pointed at the Apply control it already has.

### 4. The accountant's statement promises it reconciles to the bank and omits every deposit that went back out

`src/app/park/receipts-actions.ts:91` · lens: money-adds-up · reported certain

**What he'd meet:** March: he returns $400 of a $500 deposit and keeps $100 for carpet. The March statement's notes say nothing about deposits at all (none were taken that month), the bank statement shows $400 leaving, and the $100 he kept — which is taxable income to the park — appears in no period on no screen ever. The CPA either queries it a year later or never finds it.

**Skeptic checked:** Reproduced. The off-book query at receipts-actions.ts:88-95 selects only 'amount, kind, charge_id' — returned_on/returned_amount are never read on this path, and the same query serves both the screen (receipts-actions.ts:120-127) and the export (:216). `exclusionLines` prints only deposits TAKEN (receipts-helpers.ts:455-463) directly under the sentence at receipts-helpers.ts:450 that says any such amounts are listed 'so this still reconciles to your bank'. `returnDeposit` (money-actions.ts:315-320) is the only writer of those columns and the only readers are getHeldMoney and the resident page. The sharper half is the retained portion: money kept out of a deposit is taxable income to the park and it appears in no statement for any period, on screen or in the export. Concrete: March, $400 of a $500 deposit returned and $100 kept for carpet — the March statement mentions deposits not at all, the bank shows $400 going out, and the $100 of income reaches the CPA only if somebody remembers the held-money panel.

**Fix:** In `getStatement`, run a second small query for deposits whose returned_on falls inside the window, and pass depositsReturnedCents and depositsKeptCents into `exclusionLines`. Print the returned amount as a named cash outflow (so the promise in the line at receipts-helpers.ts:450 is kept) and the kept amount as its own income line, labelled as not rent. Both belong in the export at receipts-actions.ts:216 too, not just on screen.

### 5. billed / in / outstanding stops adding up the moment somebody hands over a round-number cheque

`src/app/park/ledger-helpers.ts:205` · lens: money-adds-up · reported certain

**What he'd meet:** 19 bills at $271.05 = $5,149.95. Lot 3 hands over a round $300 (+$28.95); Lot 7 pays nothing. The card reads billed $5,149.95 · in $4,907.85 · outstanding $271.05 — and $5,149.95 − $4,907.85 = $242.10, not $271.05. The three numbers he is checking against his deposit slip are off by $28.95 and nothing on the screen names a credit.

**Skeptic checked:** Reproduced, and the real defect is bigger than the display arithmetic. `summarise` adds r.paidTotal into collected for every non-void row (ledger-helpers.ts:204) but only positive balances into outstanding (:205), and ParkRent.tsx:122-124 prints exactly those three as a reconciling block. `creditCount` (:186, :195, :219) has no reader anywhere in src outside its own definition and the tests. More importantly `recordPayment` (ledger-actions.ts:413-478) — the cash-and-cheque path the office actually uses — never compares the amount against what is owing, while `applyOnAccount` (money-actions.ts:181-193) refuses exactly that with a written rationale: an over-apply strands the excess on a settled charge with no way to move it to next month. So the resident who hands over $542.10 in January to cover January and February gets $271.05 trapped on January's charge, February shows unpaid, and the summary block silently stops reconciling. The per-row 'In credit' pill (ledger-helpers.ts:45, ParkRent.tsx:45) is the only signal, and no total names the amount.

**Fix:** Close the asymmetry first: in `recordPayment`, compare amount against (charge.amount − charge.paid_total) and, when it exceeds it, refuse with the same sentence `applyOnAccount` already uses — or better, offer to record the excess through `recordOnAccount` so it can be applied to next month's bill. Then show the fourth row when creditCount > 0 ('in credit $28.95') so billed − in + credit = outstanding on screen.

### 6. "Sort it" on a rent-notice deadline lands on Lots & rates, which has no notice control

`src/app/park/today-helpers.ts:392` · lens: dead-ends · reported certain

**What he'd meet:** He gets an overdue red card saying a household's new rent can't start on its date, taps Sort it, and arrives at a list of lot specs and rate cards with nothing about the rent change on it. The task is never dismissible (`canDismiss: false`), so it stays red every morning while he looks for a control that lives one tab away. Meanwhile the increase either starts illegally or silently doesn't start — on 19 households that is real money per month.

**Skeptic checked:** Reproduced. today-helpers.ts:392 and :402 both set href "/park/lots" for notice_missed and notice_cliff, both canDismiss:false. ParkToday.tsx:250 renders that href as the "Sort it" link. `grep -rn "ParkReRate|pendingReRates" src/` returns only rerate-actions.ts and src/app/park/page.tsx:283 — the panel lives on /park only. src/app/park/lots/page.tsx renders exactly ParkLots + AddLots, and grep for notice/rerate/effective in both components returns nothing. The only controls that can act on lot_rent_changes are NoticeForm (ParkReRate.tsx:238-277, recordNotice) and "Call it off" (ParkReRate.tsx:103-116, cancelReRate). The task is undismissable, so the red card stays every morning. /park/today/page.tsx:48-50 states the rule this breaks in its own comment.

**Fix:** Change both href values in today-helpers.ts (lines 392 and 402) to "/park". Note also that the notice_missed detail says "Move the date or serve it now and start later" — there is no date-move control anywhere; the only route is Call it off and schedule again, so the sentence should say that.

### 7. "Their rows have a Print a slip button" — before go-live, no row has one

`src/components/InviteEveryone.tsx:53` · lens: dead-ends · reported certain

**What he'd meet:** He imports The Haven's roll in the autumn, presses Invite them, and is handed a list like "Lot 3 — Ray Kastner · no email on file" with an instruction to use a button on that row. He scrolls to Lot 3, sees Reserved and no button, on any row. These are by definition the households with no email — the ones paper is the only channel to — so the whole paper path is unreachable until 15 December, and after cutover any household with a future start date is still stranded.

**Skeptic checked:** Reproduced. ClaimSlip is imported and rendered in exactly one place, ParkRentRoll.tsx:453-454, gated on `r.state === "occupied" && r.currentRenterId && slug`. park-helpers.ts:138-153 sets state "occupied" only when a held stay covers today, otherwise "reserved". import-actions.ts:605-615 inserts imported tenancies with status active but a `during` range starting at cutover, and src/app/park/page.tsx:268-269 says so in its own comment: "The Haven's whole roll is 'reserved' until the Dec 15 cutover". The InviteEveryone card is not state-gated — page.tsx:190-214 counts canReachNow/needPaperNow straight off park_renters, and page.tsx:277 renders it — so the panel and its instruction (InviteEveryone.tsx:52-55) appear precisely in the window where no row can show the button. The needSlips rows are by construction the no-email households (invite-actions.ts:307), the ones paper is the only channel to.

**Fix:** In ParkRentRoll.tsx:453, key the ClaimSlip on the household that holds the lot rather than on occupancy: render when `slug && (r.currentRenterId ?? r.nextRenterId)`, passing that id (page.tsx already has r.next — add nextRenterId/claimStatus/renterEmail/invitedAt for it alongside the current-row fields at page.tsx:225-231).

### 8. "Give us a number and they get rent receipts and freeze warnings by text" — the code hard-codes paper

`src/components/ParkRentRoll.tsx:669` · lens: dead-ends · reported certain

**What he'd meet:** He says it at the window, because the screen told him to: "give me your mobile and you'll get your receipt by text." Nineteen households are promised something that will never arrive, by the landlord, in his first month. When they ask why, the answer is that the software's own form was wrong.

**Skeptic checked:** Reproduced verbatim. ParkRentRoll.tsx:666-669 closes the add-a-tenant form with that promise under a field labelled "Best number (optional)". buildTenant (park-helpers.ts:875-890) writes `contact_pref: "paper"` unconditionally, with a comment saying it used to be `mobile ? "sms" : "paper"` and why that was wrong. The Edit panel on the same screen, ParkRentRoll.tsx:786-789, says the opposite out loud: "Texting isn't available yet, so a phone number here is one the office can ring." With SMS a dead channel, this is copy that makes the landlord promise residents something that cannot arrive.

**Fix:** Replace ParkRentRoll.tsx:667-668 with the Edit panel's wording — a number here is one the office can ring, nothing is sent to it. Fix the stale docstring on TenantInput.mobile (park-helpers.ts:729-730) too. Separately worth a look, though outside this finding: buildTenant writes the typed number to `mobile_e164`, the column that is supposed to mean "a number this person gave US and verified" — the import path deliberately routes pasted numbers to `phone_on_file_with_park` instead (import-actions.ts:583-587).

### 9. "3 rows didn't take" — and nothing anywhere says which three

`src/components/ParkImportRead.tsx:692` · lens: dead-ends · reported certain

**What he'd meet:** Closing day, 21 lines pasted, the receipt says three didn't take. He now has to diff the seller's spreadsheet against the rent roll by hand to find out who. If he doesn't, three households are simply not on the roll — they are never billed, and nothing on any screen will ever say so, because a lot with nobody on it looks exactly like a lot with nobody on it.

**Skeptic checked:** Reproduced, and the data loss is worse than a missing reader — it is thrown away twice. commitImport BUILDS the named list: failures.push({lot, name, message}) at import-actions.ts:558, 601, 631, 689, with messages like "Somebody's already on lot 7. Nothing was changed there." It returns them (line 716). The caller discards them: ParkImportRead.tsx:102-108 keeps only res.signal for a toast. The receipt then shows only the count, from persisted counts (ParkImportRead.tsx:686-694), and tells him to "Open the rent roll to see where the gaps are". Separately, commit_error is written per row (import-actions.ts:641), SELECTed in readBatch (line 253), and never mapped into the returned view — the `others` map at lines 322-329 takes lineNo/text/verdict/flags only, and failed rows carry verdict "import" so they are not in the "Lines we skipped" section either. A household missing from the roll looks exactly like an empty lot, so nothing will ever say so again.

**Fix:** Smaller than proposed: hold the commitImport result in state at ParkImportRead.tsx:102-108 and render `res.failures` on the Receipt — lot, name and message are already there. Map `commit_error` through readBatch as well only so the list survives a page reload (the receipt is re-rendered from the persisted batch, not from the action result).

### 10. "N households haven't signed the new lease" can only ever be dismissed, never cleared

`src/app/park/today-helpers.ts:359` · lens: dead-ends · reported likely

**What he'd meet:** He gets all nineteen households to sign the new lease in January, files the paperwork, and the morning screen still says nineteen households haven't signed — for ever, through every renewal. The only exit is "Don't mention it again", which also buries the line for the household who genuinely hasn't signed two years later. This is the takeover's headline open list, and it becomes a number he learns to ignore.

**Skeptic checked:** Reproduced. `origin` is written in exactly two places — import-actions.ts:614 (hard-coded "grandfathered") and onboard-actions.ts:214 (from the signed tick, and only on the onboarding path) — and updated nowhere: `grep -rn grandfathered src/` finds no UPDATE, and editTenancy (actions.ts:801+) touches the renter file and the money only. today-actions.ts:341-350 counts current stays with origin 'grandfathered' into holdoverLots, which today-helpers.ts:349-362 turns into the card pointing at /park, where no lease-signing control exists. renew-actions.ts:206 copies `origin: prior.origin ?? "application"` onto the successor, so even a renewal keeps a household grandfathered for ever. This is not only a stuck number: migration 0065 line 151 exempts grandfathered rows from the park's max_agreement_months cap, so the nineteen stay exempt after they have signed. The only exit is "Don't mention it again", which also buries the one household that genuinely has not signed.

**Fix:** Add a "they've signed the new lease" tick to the rent-roll Edit panel beside the confirmed-with-tenant tick, and have editTenancy flip origin to 'application'. It must rewrite `during` under the park's cap in the same update — the 0065 trigger applies the cap to any non-grandfathered row, so flipping origin alone will be refused for a tenancy still on the rolling horizon. Point the task's href at /park only once that control exists, and stop renewAgreement (renew-actions.ts:206) copying 'grandfathered' onto a successor.

### 11. The file the accountant gets counts bounced checks as income

`src/app/park/receipts-helpers.ts:361` · lens: the-real-month · reported certain

**What he'd meet:** A resident's $465 check bounces in March. Brendon reverses it — the screen correctly reads $8,835 and says so in 'Worth a look'. He clicks Download and forwards the file. The file sums to $9,300. His CPA books $465 of income the park never had, and the screen and the file disagree by exactly the amount nobody can explain a year later.

**Skeptic checked:** Reproduced end to end. summariseReceipts partitions reversed rows out of every on-screen total (receipts-helpers.ts:228-230), but getStatement returns `receipts: inWindow` built by `all.filter(receivedOn in window)` with no reversedAt filter (receipts-actions.ts:181-185), and the export route hands page.receipts straight to receiptsCsv (statements/export/route.ts:26). HEADERS (receipts-helpers.ts:347-352) carries Bill status (which does print CANCELLED for a void charge) but has NO reversal column, so a reversed payment is byte-for-byte an ordinary receipt in the file. The screen is careful about exactly this — ParkStatements.tsx:191-203 strikes the amount through and prints a 'taken back' pill — so screen and file genuinely disagree, and the disagreement is invisible in the file. Download label at ParkStatements.tsx:227 uses s.count, which excludes reversed rows, confirming the row-count mismatch.

**Fix:** Add a 'Taken back' column (and 'Why taken back') to HEADERS and write `r.reversedAt ?? ""` / `r.reversedReason ?? ""` in receiptsCsv. Keep the rows — the receipt-number sequence must stay unbroken, which is the stated reason they are partitioned rather than dropped. Also make the download label stop implying a row count that the file will not match: either say `Download the file for your accountant` or count page.receipts.length.

### 12. "Remove" on a cost silently deletes shares already billed to nineteen households

`src/app/park/cost-actions.ts:360` · lens: the-real-month · reported certain

**What he'd meet:** He enters the March water bill at $3,800 instead of $380, splits it, and raises April's bills — each of nineteen statements now carries a $180.95 "Water — your share" line, frozen into `park_charges.lines` and into `amount`. He spots the typo and hits Remove. The cost and all nineteen shares vanish; the nineteen bills keep charging for it, with nothing in the books behind them, and the $380 he really paid is gone from his own "is my fee covering my costs" figure.

**Skeptic checked:** Verified. removeCost (cost-actions.ts:360-368) is a bare `.delete().eq("id").eq("park_id")` with no share check; 0064_cost_recovery.sql:98 declares `cost_id ... references park_costs(id) on delete cascade`, so billed shares go with it. Nothing links a park_charges row back to the share — the bill's breakdown is a frozen `lines` JSON snapshot — so the resident charges survive with no cost record behind them, and the cost also vanishes from listCosts/recoveryByCategory, i.e. from his cost-recovery figure. The contrast is real and in the same codebase: voidCharge (ledger-actions.ts:665-679) deliberately RELEASES shares back to `billed_on_charge_id = null` rather than destroying them, with a comment explaining why. The data needed to refuse is already loaded — listCosts computes billedTotal from `billed_on_charge_id` (cost-actions.ts:419-429). Button fires on one tap, no confirmation (ParkCosts.tsx:409-419).

**Fix:** In removeCost, select the cost's lot_cost_shares first; if any row has billed_on_charge_id set, refuse with the count and the money — 'X households have already been billed $Y each for this. Cancel or correct those bills first.' Delete only when no share has reached a bill. (Don't add a release-on-delete path: unlike voiding a bill, deleting the cost leaves nothing to re-bill against.)

### 13. The note that identifies each bill is written, read, and never shown

`src/components/ParkCosts.tsx:422` · lens: the-real-month · reported certain

**What he'd meet:** He types "March water — Wolcottville Utilities, acct 4471" as the form's placeholder tells him to. A resident asks what the $18.09 line is. He opens /park/costs and sees three rows that all say "Water" with dates and dollars — and a sentence underneath promising him the note is kept, which appears on screen precisely because the note exists and is hidden. He goes to the paper invoice instead, every time.

**Skeptic checked:** Reproduced the grep. Outside tests, `sourceNote` appears in exactly two places: cost-actions.ts (written at :223/:261/:303, selected and mapped at :447) and ParkCosts.tsx:422 — where its ONLY use is `rows.some((r) => r.sourceNote)` as the condition on a paragraph that reads 'Every bill keeps the note you typed, so a resident asking "what is this $20?" has an answer with a date on it.' The bill row itself (ParkCosts.tsx:395-419) renders category, period, amount, carriedLine, Remove — no note. It also never reaches the resident: unbilledCostShares builds the line from COST_CATEGORY_LABEL alone (ledger-actions.ts:126). So the promise appears on screen precisely because the note exists, and the note is the one thing not on screen. This is the house bug class — written, read into a row, rendered by nothing — and 0064:74 even documents the intended content ('March water, Wolcottville Utilities, acct 4471').

**Fix:** Render `r.sourceNote` on the bill row — a muted second line under the category. One line of JSX; the value is already on CostRow. (Putting it on the resident's bill line is a separate, larger decision — don't fold it into this fix.)

### 14. A mis-keyed payment cannot be undone from the screen it was keyed on

`src/components/ParkRent.tsx:197` · lens: the-real-month · reported certain

**What he'd meet:** At the window he types $4,395 instead of $439.50. The receipt prints, the row flips to "In credit +$3,955.50", and every control next to it is either hidden or the wrong one. The only true statement on that screen is a credit that isn't real. To fix it he has to know to go to Statements, change the period off its December default to This month, find the row and click "Take it back" — none of which the screen he is looking at mentions.

**Skeptic checked:** Verified with two corrections to the evidence, neither fatal. ParkRent's ledger row offers 'Record payment' only when `r.state !== "void" && r.balance > 0` (ParkRent.tsx:194-200), so on an overpaid row (balance < 0, rendered as 'In credit +$3,955.50' at :189) the only remaining control is 'They say they paid'. reversePayment (ledger-actions.ts:947) has exactly two callers — ParkHeldMoney.tsx:341, which by construction only ever sees charge_id-null and deposit rows (getHeldMoney filters `.is("charge_id", null)` / `.eq("kind","deposit")`, money-actions.ts:372-376), and ParkStatements.tsx:282. So a payment against a bill is reversible only from /park/statements. CORRECTION: that screen does have a one-tap 'This month' chip (ParkStatements.tsx:71-72), so the path is 3 clicks, not the near-dead-end the finding implies — but the default really is last complete month (statements/page.tsx:16-19, :43), meaning a payment keyed today is not on screen when he arrives, and nothing on /park/rent points there. The consequence stands: the household reads as paid ahead, so next month he does not chase real rent. This is the same pattern the codebase already fixed once for resolvePaymentClaim (see the comment at ParkRent.tsx:203-210: written, guarded, tested, called from nowhere).

**Fix:** Smallest correct fix: on any ledger row with `paidTotal > 0`, show a 'Take it back' button that opens the same required-reason prompt ParkStatements uses and calls reversePayment. The server action is already written, park-scoped and tested — it only needs a door on this screen. Do not build a second reversal UI; lift the existing prompt into a shared component.

### 15. Today says "nothing has come in" while the January cheques are in the drawer

`src/app/park/today-actions.ts:187` · lens: the-real-month · reported certain

**What he'd meet:** Rent is due on the 5th. Six households pay in the first three days, before he has raised the bills, so the only place to record them is "money on account". On the morning of the 4th the screen he reads with coffee tells him nothing has come in this month, while roughly $2,800 of real cheques are recorded in the system and sitting in his drawer. It corrects itself only when he applies each payment to a bill.

**Skeptic checked:** Reproduced. getToday scopes the month's cash read as `.in("charge_id", allIds)` (today-actions.ts:186-193), and recordOnAccount writes `charge_id: null` deliberately (money-actions.ts:109). mtd.totalCents comes only from that charge-anchored set (today-actions.ts:216-217), and moneyBlock prints the flat sentence 'Nothing has come in yet this month.' with no qualification (today-helpers.ts:85-87). The same exclusion is handled honestly one screen over: getStatement runs a second read with `.is("charge_id", null)` and reports depositsReceivedCents / onAccountReceivedCents / amenityReceivedCents by name in the notes (receipts-actions.ts:88-113). The scenario is the ordinary one for January 2027 — cheques arriving before the month's bills are raised have nowhere to go but money-on-account, and ParkHeldMoney sits on /park/rent for exactly that. The morning screen then understates, or flatly denies, real cash.

**Fix:** Add a second read of park_payments for the park with `charge_id is null`, `reversed_at is null`, received_on inside the month, and surface it as its own sub-line rather than folding it into the headline — 'plus $2,790 on account, not yet against a bill'. Bucket it the way receipts-actions.ts already does: exclude `kind = 'deposit'` and `kind = 'amenity'`, or the guest-boat money and held deposits will read as rent that came in.

### 16. Work booked on the park's OWN home never appears on the costs screen — the scope is one property, not the park's properties

`src/app/park/cost-actions.ts:505` · lens: park-scoping · reported likely

**What he'd meet:** Brendon books the $185 winterization or a clean-between-tenants on Lot 11, the home the park owns and rents out, and pays LakeLife for it. /park/costs never offers it under "work you booked" — the list is silently short, with no line saying anything was excluded. He retypes the amount by hand or forgets it; either way the cost carries no source_job_id, so 0111's one-cost-per-job unique index cannot stop him entering the same job twice, and the CPA statement for the month is missing money he actually spent.

**Skeptic checked:** Verified on both sides. src/app/park/cost-actions.ts:504-513 derives the whole scope from `parks.service_property_id` and lists jobs with `.eq("property_id", propertyId)`; recordCost repeats the identical single-property rule at cost-actions.ts:178-190 and returns "That job isn't one of this park's." Meanwhile service-actions.ts:414-425 mints a SECOND property for a park-owned home with `park_id: parkId`, links it at park_lots.service_property_id (line 465), and focusOwnedHome (service-actions.ts:485-500) points the booking cookie at it so the park books LakeLife work there. So a job the PARK paid for, on a home the PARK owns, is invisible to the costs screen and actively refused by recordCost with a message that says it belongs to someone else. Concrete: Lot 11 is The Haven's park-owned home; he books the $185 mobile-home winterization (the exact service 0110 added and enableHomeServices seeds into wanted_services), it completes, and /park/costs shows nothing under work he booked — no line saying anything was left out. He retypes $185 by hand, the row carries no source_job_id, and 0111's one-cost-per-job unique index therefore cannot stop him entering the same job again next month. Two corrections to the finding. (a) It is latent until a job can actually reach complete/paid, which needs a crew — so this is a 2027 defect, not a January-week-one one; the severity is one missing line and a misleading refusal, not lost money on day one. (b) Its proposed fix is wrong and would be worse than the bug.

**Fix:** Do NOT widen to `properties.eq("park_id", parkId)` as proposed — that set includes RESIDENTS' own properties (0107's park_site_visits view uses exactly that scope, deliberately, and it is why the visits board shows a resident's crew). Widening that far would put a household's private purchase on the park owner's "work you booked" list and hand him a button to bill it back to them, inverting the privacy rule the cost-actions.ts:491-494 comment exists to state. The correct set is the park's OWN properties only: parks.service_property_id plus the service_property_id of park_lots where park_id = parkId AND park_owned_home = true. Use that id list with `.in("property_id", ids)` in both getBillableParkJobs (cost-actions.ts:505) and recordCost's sourceJobId gate (cost-actions.ts:181), and label owned-home rows with the lot number so he can see whose cost it is.

### 17. The paste box whose own comment says "He is on his phone, at a closing table" sets 13px, defeating the iOS-zoom guard written for it

`src/components/ParkImportPaste.tsx:71` · lens: owner-on-a-phone · reported certain

**What he'd meet:** He taps the box at the closing table, Safari zooms to ~1.4x and does not come back. The 12-row paste preview — the only chance to see whether the seller's columns landed in the right places before he commits 21 lots — is then read through a viewport showing about two-thirds of its width, with the horizontal scroll he now has to fight sideways. Getting the roll wrong here is what the whole importer exists to prevent.

**Skeptic checked:** Verified exactly. ParkImportPaste.tsx:9-15 states the intent verbatim ('He is on his phone, at a closing table, and it is loud'), and line 71 sets `fontSize: 13` inline, which beats both `.ll-field textarea{font-size:16px}` (globals.css:266-280, whose own comment says '16px minimum: anything smaller makes iOS Safari zoom in on focus') and the standalone `select, textarea{font-size:16px}` guard at line 284. src/app/layout.tsx:34-38 sets width=device-width, initialScale:1 and no maximumScale, so zoom-on-focus is live and Safari does not restore the scale on blur. This is a self-documented rule broken on the one screen whose comment names the phone. Two claims I am trimming: the box itself is fine (the .ll-field wrapper gives it a proper border — unlike finding 1's victims), and the '12-row preview' lives on the next route, so the harm is the zoom he then has to pinch out of while checking 21 lots, not a mangled preview.

**Fix:** Delete `fontSize: 13` from ParkImportPaste.tsx:71, keeping the monospace family — that is what aligns the pasted columns. If 13px is wanted on a desktop, put it behind `@media (min-width: 640px)` in globals.css rather than inline. The same one-word override appears at ParkLots.tsx:736, ParkHeldMoney.tsx:202/336 and ParkAmenities.tsx:180; fixing them is the same edit.

