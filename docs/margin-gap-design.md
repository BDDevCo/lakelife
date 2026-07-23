# Fill-In Rates — the zero-stranded-jobs margin mechanism
*2026-07-23 · owner decree: "no job ever un-awarded because of margin; 30% minimum,
hard stop." Three-lens adversarial design (economics · crew psychology · engine
mechanics). Status: DESIGNED, awaiting owner go.*

## The mechanism (v1)

**A job that fails dispatch on margin becomes a posted-price FILL-IN offer on the
crew claim board** — the exact consent pattern same-day rush already proved: a
fixed take-home, "first tap takes it," no negotiation, no ops. The owner's
sentence, shipped: the board header and weekly digest read *"5 jobs on your
lakes are offering fill-in rates right now."*

**The offer math (the part the panel rewrote):** naive T* = 70% of menu was
rejected as DOUBLY fatal — every crew could back-solve the menu price (÷0.70 =
rule 1 broken by arithmetic), and thin-market crews get a dominant strategy:
hike your card, let the job strand, harvest it at 70% (the floor becomes the
ceiling exactly where stranding happens). The fix stack:
1. **Crew-anchored**: offer_i = min(T*, crew i's trailing-90-day LOWEST card
   × 0.95). A card hike never raises your offer — hiking strictly loses.
   (Needs a small vendor_rate_history capture trigger.)
2. **Round DOWN to $5 + per-job jitter** on any menu-derived number — margin
   stays ≥ floor by construction and the ÷0.70 inversion breaks.
3. **Age gate**: gap rows appear only after a job survives ≥1 dispatch attempt
   AND 1 nightly sweep (rush exempt). Kills same-day harvest plays — and gives
   the customer scarcity offer (which exists from booking) a natural ~24h head
   start, per the economics lens's sequencing, with zero extra machinery.
4. **Gap-share signal**: a crew whose trailing-30d wins are >50% fill-ins shows
   on Margin Health — a stale card or a churn precursor, either way a signal.

**Framing (the psychology lens's fatal):** never "lower your rate." Fill-ins
are posted-price JOBS — same badge family as rush, never rendered next to the
crew's own card. Ship copy: *"Pier install — 4 sections · Big Turkey · $410
take-home · first tap takes it."* The rate-card conversation lives ONLY in the
private weekly digest: *"$1,340 of pier work on Big Long went past you last
month — retune in one tap"* (aggregate, never comparative; ≥$200/mo threshold;
30-day cooldown; growth rails).

**Money path:** claim writes vendor_cost = offer, margin = M − offer (≥ floor
by construction), stamps jobs.gap_claim for provenance. Rush×gap: T* computes
from the job's stored (already-premium) price; the fill-in discount is never
double-applied. Custody/package jobs remain never-claimable (typed on the
exact rate_too_high blocker, locked by tests). The claim's guarded UPDATE
becomes price-aware (.eq customer_price) — hardening an existing latent race
with scarcity-offer price bumps.

**Terminal valve (no silent stranding, ever):** offer unclaimed 72h (or pull
deadline − 96h, whichever first) → Margin Health ops alert. The MACHINE never
assigns below 30%; the logged human override remains for genuine emergencies.

**Root-cause loop (the honest fix):** Margin Health splits stranding by
etiology — *capacity-stranded* (profitable crews exist, calendars full → recruit)
vs *margin-stranded* (ZERO crews under floor → the MENU is mispriced or supply
is missing) — and auto-emits a **menu-price-up recommendation** when a
service×lake clears through fill-ins repeatedly. Chronic gap flow means the gap
price IS the market price; rule 8 makes the fix one DB dial.

## Launch order (hard sequencing from the mechanics lens)
1. Ship fill-in offers + digest + Margin Health etiology split (floor still 0.25).
2. Live-prove a real gap claim end-to-end.
3. Run the blast-radius report (which current crews/rates fall out at 0.30).
4. Pre-announce via digest to every affected crew with the one-tap retune.
5. Flip margin_floor → 0.30. Done: no job can strand on margin again.

## Deferred to v2 (deliberately)
- **Bundles** ("all 3, one tap" atomic claims) — psychology wants it, capacity
  math needs care; v1 aggregates the NUMBER, each job stays its own tap.
- **Top-up rule** (customer Δ landing after a gap claim raises the crew's
  take-home toward their card) — pure goodwill, costs only found money.
- **Flex window** (standing auto-accept −N%) — two lenses flagged it as the
  resentment engine / shadow-rate-card; only if board uptake proves too slow.
- **Retune reward** (2h exclusive first-look after a digest-prompted retune).

## Dials (all rule-8 DB settings)
margin_floor 0.30 (flip LAST) · gap_discount_pct 0.05 · gap round-down $5,
min offer $20 · age gate = survived one nightly · gap_sla_hrs 72 (compresses
near pull deadline) · digest_threshold $200/mo, cooldown 30d · gap-share
signal 50%.
