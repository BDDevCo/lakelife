# LakeLife — Owner notes → decisions → roadmap (captured 2026-07-19, pre-token-reset)

Companion to dispatch-and-pricing-design.md. Owner's overnight notes triaged into
decisions, answers, and phased backlog. Build resumes Tue 7/22 after 7am.

## 1. Money flow (DECIDED, pending owner sign-off)
- LakeLife = merchant of record. Customer card charged by LakeLife (our name on
  statement). Charge on photo-verified completion (built).
- Vendor payouts: weekly batch (Friday). payout lifecycle: pending → in_batch → paid.
  Push for STRIPE CONNECT when processor talk happens: native batch transfers,
  platform fee retention, and 1099-K/1099-NEC generation for crews.
- Margin: menu price P (customer, single all-in) − crew self-set rate C = margin;
  floor 25%, target 30%. NOT "fee on top", NOT split-from-both-sides.
- Paper: customer gets LakeLife receipt (built). Crew gets weekly remittance
  statement (platform self-billing; they never invoice us). Vendor portal Earnings
  tab: pending/batch/paid + monthly/quarterly PDF ("send to your CPA" one-tap).

## 2. Cancellation & no-access policy (RECOMMENDED, owner to confirm numbers)
- Routine (mow/housekeeping): free >48h; <48h = 50% fee.
- Water work (pier/lift/storage moves): free >7 days; <7 days = 50%.
- Crew on site, cannot perform (boat absent, pier blocked, no access): 100% charge.
- Crew is paid their rate share of ANY fee collected (they burned the time).
- ToS pages needed: cancellation policy, platform-is-a-connector (IC crews), storage terms.

## 3. Freed-slot backfill
- v1: cancellation instantly reopens capacity on booking calendar (automatic with
  capacity-aware calendar from dispatch design).
- v2: waitlist — text customers with later bookings "a Wed slot opened — tap to
  move", first-tap wins, cascades.

## 4. Seasonal service mechanics
- Pier/boat/toys OUT services: two-phase booking. Reserve service now (no date);
  when ops sets the lake's fall window, customer gets "pick your date" text.
  Booking horizon = current season + reserve-next-season.
- STORAGE = separate add-on service, new pricing model seasonal_plus_perdiem:
  flat winterize + flat de-winterize + storage seasonal minimum (~3 months, charged
  at pull) + per-diem overage (billed at splash). Wizard adds: store-with-us vs
  self-store (+ where), splash-into-which-lake.

## 5. Customer portal UX
- Property NICKNAME bold at top (add nickname field + switcher shows it).
- Calendar view of upcoming services on My Requests.
- Personal-calendar export: per-account ICS feed URL (iPhone/Google/Android native).

## 6. Crew-facing
- Camera: DONE (photo input uses capture=environment → phone camera).
- Completion message to customer: crew first name + company + photo count +
  "reply here with any concerns" → routes to platform Messages (crew answers in
  their portal). DECISION (owner pushback accepted?): NO direct crew phone/email
  to customer — circumvention risk, score blindness; ToS handles liability posture.
- Earnings tab + CPA PDFs (see §1). Value prop: we automate their back office.

## 7. Data/AI (capture now, learn later)
- Migration adds: jobs.started_at (first photo upload stamps it), completed_at.
- Collect: actual duration per service type, route actuals vs estimate, crew rates
  vs booking volume across lakes (pricing intelligence), customer message sentiment.
- Later: duration-aware capacity (jobs/day by actual time, not fixed count),
  route learning, price benchmarking dashboards.

## 8. Growth modules (phased)
- Sales-rep referrals: NOW just add referral_code capture at signup so history
  exists; rep portal + commissions = phase 3.
- HOA per lake: logo on property portal (home feeling) + optional round-up
  donation = cheap, do early. HOA DUES COLLECTION = money transmission for third
  party — regulatory weight, PARKED.
- SEO: per-lake landing pages ("pier installation Big Long Lake"), sitemap,
  metadata. Next.js already SSR/SEO-native. Phase with marketing.

## 8b. Sales rep program (DESIGNED — owner to confirm numbers)
- Two bounty types: homeowner referrals + crew referrals. Single-level ONLY (no MLM).
- Golden rules: commission accrues ONLY on collected money (never signups);
  paid out of margin (customer price untouched); trailing 12 months then sunsets.
- Recommended: homeowner = 5% of that customer's collected spend for 12 months
  (≈1/6 of margin at 30%). Crew referral = $250 flat after crew's 10th completed
  job (milestone = quality gate).
- Payouts: monthly, 30-day maturation (refund/dispute clawback pre-payout). Same
  batch rails + remittance statements as crews; Stripe Connect handles rep 1099s.
- Rep portal v1 (tiny, reuses patterns): users.role='rep'; one page = big referral
  link + QR, funnel (taps→signups→activated→active), earnings
  (accruing/maturing/paid + statements), PRIVATE standing only (no leaderboard).
- Mechanics: referral_code at signup attributes the USER (all their properties/jobs);
  commission ledger accrues inside settleJob when invoice → paid; self-referral
  blocked; ops can void attribution. Rep agreement doc needed (comp terms, brand
  rules, clawback, IC status).
- HOA AMBASSADOR VARIANT (possibly the best growth wedge): HOA signs as rep,
  5% flows to lake association as donation (payout_to: hoa flag). "Neighbors who
  join fund the fireworks." HOA markets the platform; dodges dues-collection
  regulation entirely.

## 8c. Differentiation & margin strategy (agreed thinking 2026-07-19; zero-employee filter)
DESIGN FILTER: nothing ships that needs a human to operate. Org ceiling: owner +
seasonal ops + fractional bookkeeper/lawyer (max 5).
- MOAT (in order): (1) per-lake route density; (2) Property Dossier — "CarFax for
  the lake home", photos/conditions accrue per property, TRANSFERS ON HOME SALE
  (realtor channel: churn event → acquisition channel); (3) AUTOPILOT annual plan —
  subscribe the season (open/mow/close/winterize/store auto-booked yearly, one
  confirm-text per event). Autopilot = headline product.
- Customer onboarding: address-first magic (public county assessor/parcel data
  pre-fills sqft/lot/shoreline → one-tap confirm); neighbor social proof (never
  discounts); realtor dossier transfer; HOA ambassadors.
- Vendor onboarding: back-office-as-product + INSTANT PAY (same-day payout after
  photo verification for 1.5% fee; weekly batch free) — crews evangelize, pure
  margin, 0 humans.
- Margin levers ranked: instant-pay fee; photo-AI inspection → one-tap repair
  upsell (every visit = inspection; also auto photo-QA + chargeback evidence
  packs); crunch-window pricing (UN-PARK for fall pull season: menu +15%, crew
  rates unchanged); AI concierge drafting all Messages; duration-learning →
  tighter capacity; payment float.
- KILL LIST: no custom quotes ever (algorithmic pricing only; crew-proposed
  repair prices auto-marked-up, one-tap approve); no published phone number
  (Messages + AI only); no manual dispatch (policy); Autopilot customers see one
  status card, not a booking grid.

## 9. Build sequence when tokens reset (Tue)
1. Dispatch engine + capacity calendar + crew rates (dispatch-and-pricing-design.md
   §G — the big one, agents).
2. Money UX: vendor Earnings tab + weekly batch model + remittance statements.
3. Customer: nicknames, services calendar + ICS feed.
4. Policy: cancellation fees in booking flow + ToS pages + blocked-arrival flow
   (crew taps "couldn't perform" with photo proof → fee + reschedule).
5. Storage service model + two-phase fall booking.
6. Timestamps migration (started_at/completed_at) — ride along with #1's migration.
7. Referral code capture + HOA logo field per lake.
