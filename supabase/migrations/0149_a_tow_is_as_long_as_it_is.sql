-- 0149 — A TOW IS AS LONG AS IT IS.
--
-- `Boat return & splash` is a flat $285 to anywhere. Against the rates in
-- docs/storage-winterize-research.json that is wrong in BOTH directions, which
-- is what a flat price does to a distance job:
--
--     tow      market (transport + launch)     ours
--     5 mi     ~$256                           $285   +$29 over
--     15 mi    ~$331                           $285   −$46 under
--     25 mi    ~$349                           $285   −$64 under
--
-- Short hauls are uncompetitive against Timber's $150; long hauls thin the
-- margin until no crew claims them, which is the real failure — not a bad
-- deal, but a job that sits on the board forever.
--
-- ============ THE SHAPE (owner's decision, 29 Aug 2026) ============
--
-- Pointe Marine's, from the research: ONE all-in price covering everything
-- inside a radius, then a per-mile rate on the excess only. Chosen over the
-- 1-10 / 11-20 banding because it is the one a customer can be told in a
-- sentence, and because it has no band edges to argue about.
--
--   billingNorms[7]: "Transport is billed per one-way move in distance bands
--   (1-10 mi / 11-20 mi / 20+ mi at $3.50-3.60 per extra mile) ... storage
--   customers often get free transport within ~20 miles as a bundle perk."
--
-- ============ WHY NOT A PRICING MODEL ============
--
-- Because distance is not a property of the PROPERTY. Every pricing_model we
-- have — flat, per_section, per_foot, band, per_sqft_band — reads the profile,
-- and the profile cannot know where a boat spent a winter. `priceService` has
-- 25 call sites (menus, tiles, the crew's rate card, margin health, autopilot)
-- and not one of them has a pickup address. Threading a distance through it
-- would price 24 of them at zero miles.
--
-- That is exactly how 0115 put three money bugs live from a single change. So
-- transport is a SEPARATE additive function, `transportFee`, that a caller
-- with a distance opts into. Every existing call site returns precisely what
-- it returned yesterday.
--
-- ============ THE DIALS SHIP AT ZERO ============
--
-- `per_mile_beyond = 0` is the inert state and it is what goes live here: no
-- rate, no radius, and the service prices as the flat $285 it always has.
-- Nothing about any booking changes today.
--
-- The numbers are the owner's and are not invented here (standing rule: an
-- unpriced service is the safe state). When he has a crew's real rate, ONE
-- update switches it on — the research's own numbers would be:
--
--   update public.services
--      set band_pricing = coalesce(band_pricing, '{}'::jsonb)
--                       || '{"included_miles": 20, "per_mile_beyond": 3.60}'::jsonb
--    where name = 'Boat return & splash';
--
-- MILES ARE STRAIGHT-LINE (`milesBetween`, great-circle) — roughly 20-30%
-- shorter than the road. The radius is therefore generous by construction: a
-- boat 22 road-miles away often measures 17 and tows free. That is a decision,
-- not an oversight — it errs toward the customer and away from an argument,
-- and Directions API mileage can replace it if the give-away ever matters.

-- --------------------------------------------------- 1. the dials, at 0 ---

-- Written explicitly rather than left absent so the keys EXIST to be found:
-- a dial nobody can see is a dial nobody sets. Both zero = inert.
update public.services
   set band_pricing = coalesce(band_pricing, '{}'::jsonb)
                    || '{"included_miles": 0, "per_mile_beyond": 0}'::jsonb
 where needs_pickup_spot;

-- ---------------------------------------------------- 2. the tripwires ---

do $$
declare n integer;
begin
  -- 1. THE DIALS EXIST ON EVERY COLLECTION SERVICE. Absent keys read as 0 too,
  --    but an absent key is invisible to whoever comes to set the price.
  select count(*) into n
    from public.services
   where needs_pickup_spot
     and band_pricing ? 'per_mile_beyond'
     and band_pricing ? 'included_miles';
  if n <> 2 then
    raise exception '0149: % of the 2 collection services carry the transport dials', n;
  end if;

  -- 2. NOTHING IS PRICED BY DISTANCE YET. This migration must not change a
  --    single quote. If this ever fires, a rate was set by something other
  --    than the owner deciding to set it.
  select count(*) into n
    from public.services
   where coalesce((band_pricing->>'per_mile_beyond')::numeric, 0) > 0;
  if n <> 0 then
    raise exception '0149: % services already bill by distance — this migration ships inert', n;
  end if;

  -- 3. A RATE WITHOUT A PICKUP SPOT IS UNCHARGEABLE. Distance is measured from
  --    the pickup, so a service that never asks where the boat is could never
  --    compute one — it would quote the base and silently tow for free.
  if exists (
    select 1 from public.services
     where coalesce((band_pricing->>'per_mile_beyond')::numeric, 0) > 0
       and not needs_pickup_spot
  ) then
    raise exception '0149: a service bills by distance but never asks where the boat is';
  end if;

  -- 4. THE OTHER SERVICES ARE UNTOUCHED. band_pricing carries live pricing for
  --    lawns, housekeeping and engines; this migration writes two keys onto two
  --    rows and must not have disturbed anything else.
  select count(*) into n
    from public.services
   where band_pricing ? 'per_mile_beyond' and not needs_pickup_spot;
  if n <> 0 then
    raise exception '0149: % non-collection services gained transport dials', n;
  end if;
end $$;
