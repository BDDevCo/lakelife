# Storage & Winterization — Service Design Brainstorm

*2026-07-22 · four-perspective research synthesis · rev 2: owner killed at-dock winterization — all winterize legs are shop-based (operations taxonomy, Midwest market
rates, platform modeling, custody risk). Status: BRAINSTORM — owner decisions pending
(§F). Nothing here is built.*

---

## A. The core insight: sell LEGS, not scenarios

The owner sketched three delivery scenarios (mobile round-trip / full-service valet /
customer-tow-to-shop) and suspected more existed. Research found **14** — but every one
of them decomposes into the same ~8 building blocks:

| Component (leg) | What it is | Pricing shape |
|---|---|---|
| `winterize` | Engine + systems winterization AT THE SHOP — owner decision (2026-07-22): no at-dock/mobile winterization; the boat always comes to a facility | flat by engine type (crew's rate card) |
| `haul_out` | Vendor retrieves boat (ramp float-on or lift-off) and transports one way | flat per one-way leg (+ tri-toon surcharge) |
| `return_delivery` | Vendor transports back and splashes/sets on lift, one way | flat per one-way leg |
| `storage_season` | Winter custody at the vendor's facility | **seasonal_plus_perdiem**: per-foot × boat length for the season + per-diem overage |
| `de_winterize` | Spring recommission (batteries, unfog, impeller, test-run) | flat by engine type |
| `shrink_wrap` | Wrap (fall) — removal/disposal is a spring line | per foot |
| add-ons | batteries, oil change, gear lube, ballast/freshwater systems, detail, rodent packs, trailer storage… | flat / per foot |

**Why legs win:** crews price only the legs they can physically do — a shop with no
hydraulic trailer never sees a haul job, a farmer's barn with no mechanic never sees a
winterize, and the pier/lift contractors *already on our platform* own shore equipment
but aren't mechanics. Legs ARE the capability flags: no rate card for `haul_out` →
dispatch can never send you a haul. And the platform can **compose vendors** — a hauler moves the boat, a shop
winterizes it, a barn owner stores it — into a full-service product *none of them could
sell alone*. Real shops do this informally by subcontracting; a platform that does it
automatically is a structural moat and pure zero-ops.

Asymmetric hybrids (vendor hauls in fall / customer retrieves in spring, and the
reverse) fall out for free when transport is priced **per leg, not round trip**.

## B. The customer menu (4 tiles, everything else is a toggle)

Fourteen scenarios cannot be fourteen tiles — and with all winterization at the shop,
the menu is really TWO AXES the wizard walks: *who moves the boat* (each direction
separately) and *where it winters*. Four tiles cover everything:

1. **You tow it to the shop** — shop winterizes. Toggle A: *tow it home and store it
   yourself* (very common in rural Indiana — pole barns everywhere; zero storage
   revenue, great throughput and spring-upsell surface) or *store it at the shop*
   (outdoor-wrapped / indoor tier). Spring toggle: DIY / recommission-and-you-pick-up /
   we-deliver-and-splash.
2. **We pick it up** — vendor hauls from your lift or shore, shop winterizes.
   Toggle A: *back to your place for the winter* (the owner's original scenario A —
   haul, winterize, return; spring is the mirror: pick up, de-winterize, splash) or
   *store at the facility* (the full valet). This is the ONLY option for lift-kept
   pontoons with no trailer — which is most boats on these lakes.
3. **Storage only** — boat arrives already winterized (you tow in). Opens the platform
   to non-marine vendors (barns, lots). Proof-of-winterization or freeze-damage waiver
   at intake.
4. **Spring-only recommission / splash** — DIY winterizers and boats bought over the
   winter; the ice-out upsell text to every fall winterize-only customer.

PWC variant of 1–3 with per-unit pricing and a multi-unit discount (2–3 per household
is normal here). Shrink-wrap-only exists as an add-on booked alone.

**Later gold (not launch):** mid-winter care subscription (battery tending + photo
report — our photo-proof DNA, works for home-stored boats too); winter repair/upgrade
work sold into stored boats (the industry's single biggest off-season revenue stream);
summer trailer storage (May–Oct, the inverse season — lake lots have no trailer
parking); lift & canopy offsite storage (extension of lift pull/set).

## C. What the rates look like (Midwest market reference, sourced)

Crews set their own rates per leg, exactly like today. These are the ranges their
numbers should land in (sources: Larsen Marine 2025 price guide, Midwest Winterizing,
Timber Marine, Just Add Water Indianapolis, Manitowoc Marina, Torresen, others):

| Leg | Market range (vendor-side) | Notes |
|---|---|---|
| Winterize (shop) — outboard | $109–$340 /engine | engine count & HP drive price, not boat length; twin ≈ +80% |
| Winterize — sterndrive (I/O) | $200–$520 /engine | |
| Winterize — inboard/V-drive (ski/wake) | $252–$650 /engine | ballast systems extra; 2–3× a pontoon's labor |
| Winterize — PWC | $100–$300 /unit | multi-unit discount ~10% |
| Shrink wrap | $16–$30 /ft | pontoons bill one tier higher; spring removal/disposal ~$75 if separate |
| Storage — outdoor lot | $12–$40 /ft/season | |
| Storage — indoor cold | $38–$56 /ft/season | sells out by Labor Day |
| Storage — indoor heated | $7.30–$15 /sqft (LOA×beam)/season | rare on our lakes; later |
| Haul / one-way local transport (<20 mi) | $150–$350 /leg | tri-toon +$40–75; trailer rental $50–85 if boat has none |
| De-winterize / spring commissioning | $99–$400 | often discounted for storage customers as bundle bait |
| Launch/splash à la carte | $25–$160 | |
| Oil & filter add-on | $94–$300 /engine | |
| Overstay per-diem | $10/day (or $30/mo) after ~May 1 | market norm |

**Season definition (market norm):** one flat price covers roughly **Oct 1 – May 31**
regardless of exact dates; per-foot-per-season is the dominant unit at inland yards.
Monthly billing is a self-storage pattern, not a marina pattern — don't adopt it.

### Illustrative all-in menu math (22-ft pontoon, single 115hp outboard — NOT owner-confirmed numbers)

| Package | Crew-side legs (mid-range) | Customer all-in @ ~30% |
|---|---|---|
| You tow in, winterize, tow home | 180 wtr = $180 | ≈ **$255** (fall) |
| …+ spring recommission (you tow in) | + 130 dewtr = $310 | ≈ **$445** (billed $255 fall / $190 spring) |
| We pick up, winterize, return to your place; spring mirror (owner's A) | fall: 200 haul + 180 wtr + 150 return = $530 · spring: 200 + 130 + 150 = $480 | ≈ **$1,445/yr** (billed ≈$755 fall / ≈$690 spring) |
| Full-service valet w/ outdoor wrapped storage (B) | 200 haul + 180 wtr + 396 wrap + 660 storage + 130 dewtr + 150 return = $1,716 | ≈ **$2,450/season** |
| You-tow + indoor cold storage (C) | 180 + 990 + 130 = $1,300 | ≈ **$1,860/season** |
| Storage only (outdoor, wrapped elsewhere) | $660 | ≈ **$945/season** |
| Spring-only recommission + splash | $150–$280 | ≈ **$215–$400** |

Advertised full-package market comps for 20–24 ft run **$1,500–$2,600/season** — the
valet tier at ~$2,450 is inside the band. (Side note: our current flat menu — Fall
winterization $485 / Spring opening $430 — prices ABOVE the mobile market mid-range;
margin room is real, but watch the Margin Health tab once crews rate-card these legs.)

## D. How it fits the platform (recommended architecture)

**Option 3 of 3 evaluated: package = bundle of component services, ONE JOB PER VISIT.**
The other options (SKU-per-scenario; one service with JSONB option matrices) both break
at least one hard rule or the rate-card contract. Option 3 keeps all four hard rules
enforced by EXISTING machinery:

- **Rule 1 (vendors never see customer prices):** `vendor_rates` keeps its per-service
  shape; per-component line items inherit the same ops-only cost pattern.
- **Rule 8 (pricing in DB):** components and packages are rows;
  `seasonal_plus_perdiem` is one new pricing_model value + one `priceService` case.
- **Rule 2 (photo gate):** each visit is its own job → fall intake and spring splash
  are each independently photo-gated and independently settled. `settleJob` unchanged.
- **Winterize is shop-only** (owner decision): mobile-only techs without a facility
  have no winterize rate and thus never match; the hauler/trailer pool becomes the
  scarce resource that gates the fall funnel — watch it on Margin Health.
- **Dispatch:** a crew is eligible for a visit only if `service_types` covers every
  component on it with a positive rate — components ARE capabilities, no new
  vocabulary to drift.

Schema (summary; full detail in the research file): `services.kind`
(standalone/component/addon), `service_packages` + `package_components(phase)`,
`job_groups` (the season envelope linking fall→spring, pinned `storing_vendor`),
`jobs.group_id/phase/price_finalized`, `job_items` line items, `storage_stays` ledger
(intake_at/out_at/included_days), `vendors.storage_capacity_feet + storage_types`
(storage capacity is a seasonal FEET pool, not a daily slot count).

**Billing = split, riding the existing trust promise:** Invoice #1 at fall completion
(fall legs + the storage seasonal minimum — custody has begun; that IS the work).
Invoice #2 at spring splash (spring legs + per-diem overage beyond included days).
"Never charged until the work is complete" holds per visit. Boat does not splash while
a balance is outstanding — that's the market-universal rule and our only leverage
short of Indiana's slow lien process.

**Dispatch specifics:** spring legs of a stored boat pre-assign to the storing vendor
(the boat is physically in their barn — no re-dispatch); spring jobs are born dateless
("reserved") and get a date when ice-out opens the window, riding the same per-lake
gates as today; the fall pull-deadline backstops the fall crunch; sequencing becomes
first-class — lift/pier set must precede redelivery.

## E. What custody changes (the risk digest)

The first service where a vendor holds a $30k–$150k asset for six months. The rails
that must exist at launch:

1. **Insurance gate:** a standard COI is *worthless* here — general liability excludes
   damage to property in the vendor's care/custody/control. Storage legs unlock only
   with a **garagekeepers/bailee** COI on file; transport legs want on-hook coverage.
   Same zero-ops auto-gate as today's COI (present + unexpired), same
   onboarding-agreement authenticity posture.
2. **Condition reports, not just photo counts:** typed intake/outtake photo checklists
   at every custody handoff (at-dock, on-trailer, racked, splashed) + customer
   e-acknowledgment. Kills "that gouge wasn't there in October." This is our
   photo-verified DNA turned into the differentiator: *photo-verified custody*.
3. **Storage agreement e-sign** at booking (versioned): freeze-damage waiver if
   winterized elsewhere, valuables-removed acknowledgment, fuel/battery/propane intake
   checklist, abandonment terms, per-diem terms. One attorney pass with the referral
   terms hour.
4. **No cold claims on custody:** storage-bearing jobs are dispatch/preferred-only —
   a stranger crew must not win custody of a boat via first-tap.
5. **Access & release flow:** mid-winter "I sold it / need my gear" requests get a
   logged release-authorization (who, to whom, photo) — never informal.

## F. Decisions the owner must make

1. ~~At-dock winterization~~ — **DECIDED (2026-07-22): none. All winterization at the
   shop; customer tows or vendor hauls.**
2. **Storage tiers at launch:** outdoor-wrapped + indoor-cold (recommended) — heated
   later?
3. **Seasonal minimum shape:** per-foot × length (market norm, recommended) — and the
   included window (recommend Oct 1 – May 31 to absorb the lift-set dependency) —
   confirm against roadmap's "~3 months at pull" note.
4. **Per-diem:** flat $/day (recommend, ~$10 market) vs per-foot/day; platform dial or
   crew-set; who keeps it (recommend margin-weighted like everything else).
5. **Insurance strictness:** hard gate on garagekeepers doc-on-file before storage
   legs unlock (recommended) vs agreement-clause-only.
6. **Split-vendor composition (hauler + shop + barn) at launch,** or single-vendor
   packages first and compose in v2? (Recommend v2.)
7. **Owner's storage rates** — plug real vendor quotes into §C's reference table as
   they arrive.

*Full agent outputs (14 scenarios with steps/constraints, 20+ add-ons, 6 vendor
archetypes, 22 risks with mitigations, complete schema/dispatch deltas): session
research archive; regenerate on demand.*
