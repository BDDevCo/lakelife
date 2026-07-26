# The two-season audit — 1,000+ customers, run end to end

**Date:** 2026-07-26 · **Scope:** the whole platform · **Where it ran:** two
throwaway Supabase branches, never production.

Two independent simulations, because they catch different things:

- **The world.** 1,199 users, 1,227 properties, 34 crews, 6 lakes (3 born from
  demand mid-simulation), **10,184 jobs** across seasons 2025 and 2026, with
  referral chains five levels deep, HOAs, storage stays, disputes, refunds and
  payout batches. Built on an isolated branch and audited for what the database
  itself permits.
- **The engine.** **2.1 million** property-based cases driving the real pure
  engine functions — pricing, dispatch, fleet routing, the money ledger,
  referrals, and the season clock — with seeded randomness so every failure
  reproduces exactly. Committed as `src/sim/*.sim.test.ts`; they run in seconds
  and stay green as regression tests.

---

## The headline: the money is right, the rules are not enforced where we say

**Money conservation held perfectly.** Across $1,990,489.65 of captured customer
cash:

| Check | Result |
|---|---|
| billed − cash − credits | **$0.00** |
| crew clawback − (payout reductions + adjustments) | **$0.00** |
| Jobs below the margin floor | 0 |
| Completed jobs below the photo minimum | 0 |
| Crews assigned off-lake, off-capability, or on a lapsed COI | 0 |
| Credit overdrafts | 0 |
| LakeLife gross margin on collected revenue | $709,366.69 (**35.5%**) |

That is the engine doing its job at volume, and it is the most reassuring
result in this document.

**But the database permits what the app forbids.** Probing the schema inside a
rolled-back transaction, every one of these inserted with no constraint,
trigger, or check objecting:

- a job marked `complete` with **zero photos** on a service requiring four —
  **rule 2**, which CLAUDE.md says is "server-enforced"
- a water job dated three weeks past the lake's pull deadline — **rule 7**
- `margin` set to any number at all, unrelated to price minus cost
- `vendor_cost` greater than `customer_price` (negative margin) on an assigned job
- a job assigned to a **suspended** crew, and to a crew that does not serve that lake
- a $999,999 payout with no job attached
- a refund and clawback far exceeding the invoice
- a $50,000 referral accrual against a $250 lifetime cap
- **photos added to an already-paid job** — the evidence behind a released
  payout is mutable after settlement

Today the app code is careful and nothing bad has happened. But rules 1, 2 and 7
are described as enforced "at the API/RLS level, not just the UI," and in
practice they live in TypeScript. Any service-role script, any future endpoint,
any contractor with the service key can walk straight through them. Three
guards *are* done right — one captured payment per invoice, one open dispute per
job, no credit overdraft — and they are the pattern the rest should follow.

---

## Disaster recovery was broken. It is fixed, and the fix is verified.

The first branch build failed outright: migrations **0001–0017 were applied by
hand** before the tooling existed, so Supabase never recorded them, and any
replay starts at 0018 and dies on a function created back in 0002.

Replaying all 46 files manually then revealed something worse — **zero SQL
errors and a broken platform**:

| Problem | Consequence |
|---|---|
| Lake and service seeds lived outside the migration set | No lakes, half the menu missing |
| `0008` capacity backfill matched nothing | Every service stuck at the default |
| `0031` slug backfill matched nothing | Every public lake page 404s |
| `0042` `est_minutes` backfill matched nothing | The router has no time budget |
| **Storage buckets were in no migration at all** | **No photo can be uploaded → no job can complete → no crew can be paid** |

That last one is the sharp edge: a rebuilt LakeLife looks fine and cannot trade.

**Fixed in this commit:** `0047` folds the seeds in and re-issues the three
backfills; `0048` creates the two private buckets and asserts the
post-conditions; `0002` is now re-runnable (it was the one file that failed a
second pass); `0008`'s backfill no longer stomps operator-tuned dials on a
replay; `setup-all.sql` — which advertised "complete database setup" while
containing two migrations — is deleted in favour of `supabase/REBUILD.md`.

One thing still needs your hand, once, against production:

```bash
supabase migration repair --status applied 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017
```

It only writes to Supabase's bookkeeping table — no data, no re-runs.

---

## Bugs the engine simulation found

### Critical

**1. The season clock never rolls the year.** `dayStatus` compares dates against
a lake's single stored ice-out and pull-deadline. Those are one season's dates.
Come spring, **every lake is 100% off-season for water work until a human
re-enters both dates on every lake** — and nothing prompts it, warns, or shows
it. Land work (mowing, housekeeping) keeps flowing, which is exactly why it
would hide: revenue for pier installs, lift sets and openings simply stops
looking like anything is wrong.

**2. A lake born from demand cannot sell the thing it was born for.**
`findOrCreateLake` copies season dates from the newest confirmed lake. A lake
created in season 2 inherits season 1's window, so **0 of the next 200 days are
bookable for water work**. The customer who names a new lake to get their pier
installed is precisely the person who cannot book a pier install. In the
simulated world all three born lakes are still unconfirmed — the oldest for ten
months, governing 715 jobs.

**3. One truck busts its hours while its sibling sits empty.** `planFleetDay`
hands a whole lake cluster to the truck with the most room and never rebalances,
so a crew opens the morning to an over-hours route (62 per 1,000 customers per
season) while another of their own trucks got nothing.

**4. The referral payout batch silts up.** Customer credit earnings park at
`matured` forever and crowd crews and HOAs out of the batch's 500-row window —
so the people owed actual cash stop getting paid as the credit ledger grows.

### Serious

**5. ~455 phantom-priced tiles per 1,000 customers.** The `$0` guard only
protects pure-multiplier services. Anything with a `base` or `min_count` quotes
a real price to someone who owns none of it: pier install $220 with zero pier
sections, boat lift $495 with zero lifts, water toys $120 with no toys. Each one
booked is a crew driving to a property with nothing to do.

**6. A one-tap price raise can invert the ladder.** Margin Health proposes
raising the *middle* rung and checks only a 40% cap against that rung. Applying
it can make a **medium lawn cost more than a large one** ($118 vs $110) — and
the wizard shows all three side by side. 185 of 1,100 properties were exposed.

**7. Renaming a service in Ops breaks a booking rule.** Package legality is
keyed on the literal string `"Boat return & splash"`. Rename that row — a normal
edit, on a table rule 8 explicitly tells you to tune — and the storage rails
invert: a boat can be billed for winter storage *and* a trip home.

**8. Lake conditions accept impossible seasons.** Swap ice-out and freeze and the
lake's entire water calendar goes dark with no error. Leave ice-out blank and the
lower gate is skipped entirely — **a pier install becomes bookable in
mid-January**, under the ice. Rule 7 defeated by an empty field.

**9. A storage season-end of "April 31" gives a boat a free year.** The month and
day dials clamp independently, so (4, 31) is settable. The resulting string
sorts *before* May 1, rolling the due-out date forward a full year with the
per-diem meter reading zero.

**10. The nightly digest says "Quiet night" on the night payouts run.** The
digest has no section that can carry a payout batch, a matured referral credit,
a collected cancellation fee, or a reconciled refund. Month-end — the night the
largest sum of the month leaves the account — is the night most likely to read
as quiet.

---

## The answer to "where are humans still stuck?"

This was the real question, so here is the measured number rather than an
impression.

**About 1,000 ops actions per 1,000 customers per season — roughly one per
customer per year — and it scales linearly with customers.**

At today's size that is ~20 items a week: entirely manageable. At 10,000
customers it is ~200/week. At 100,000 it is a department. The platform is
genuinely zero-ops in its *automated* paths; the workload lives in the exceptions.

**The biggest drivers, per 1,000 customers per season:**

| Driver | Count | Who |
|---|---|---|
| No crew clears the 30% margin floor | 348 | ops |
| Referral money owed but no bank details on file | 141 | ops |
| Storage overstay — boat still in the barn, meter running | 134 | ops |
| No custody-qualified crew for a winter package | 88 | ops |
| Growth emails with no self-serve opt-out | 82 | ops |
| Disputes escalated past the crew | ~76 | ops |
| Lake cold start — nobody serves this water yet | 40 | ops |
| Credits re-granted by hand after a refund | 27 | ops |

**And the customer-facing friction, which matters more:**

- **393 per 1,000 customers are told "that day just filled up — pick another
  date."** In 93% of those cases *nothing was full*, and in 12% no crew will
  ever serve that lake and service, so no date will ever work. The booking is
  deleted and **ops never sees the demand**.
- **20% of all demand never found a crew**: 629 jobs had no eligible crew at
  all, 1,275 had one but every candidate was full. Worst: fall winterization
  (17.3% unfilled), spring opening (17.0%), boat lift set/pull (16.4%).
- **682 past-due unassigned requests** sitting with nothing escalating them.
- An HOA that books every unit on one day gets **27% of units crewed**, because
  capacity is per-crew-per-day and nothing batches an association.
- A skipped autopilot proposal **re-texts every night** — 171 texts from one skip.
- Crew concentration: the top 4 crews carry 3,756 jobs while **14 of 34 crews
  have zero**.

**What does *not* scale with customers** (good news — these stay flat):
confirming a new lake's season dates (~1.5/season), price suggestions above the
auto-apply cap (~15/season), and the annual season roll (one per lake).

---

## What I would fix first

1. **The season year-roll** (#1, #2, #8). It is an annual, silent, total stop on
   the highest-margin work, and it is three related defects in one area.
2. **The margin floor at 348 hits per 1,000 customers.** This is the single
   largest ops workload and it is really a pricing/recruiting signal — it wants
   a systemic answer, not a queue.
3. **Push rules 2 and 7 into the database.** Constraints and triggers, matching
   the three guards already done right, so the promise in CLAUDE.md is true.
4. **The "day just filled up" lie**, which deletes real demand and hides it.
5. **The digest's blind spot on money nights** — cheap to fix, and it is the one
   report you actually read.

None of these are shipped fixes yet; they are findings with reproductions. The
disaster-recovery work *is* shipped and verified.
