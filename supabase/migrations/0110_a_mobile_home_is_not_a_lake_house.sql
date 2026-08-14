-- 0110 — A MOBILE HOME IS NOT A LAKE HOUSE, AND THE PARK OWNS THE PIER.
--
-- Brendon, on what a lot renter should actually be offered: "a lot renter
-- wouldn't have pier install, that is provided by the park. they would have
-- winterization/dewinterization for their mobil home, spring cleaning /
-- periodical cleaning, boat winterization, boat storage, boat dewinterization."
--
-- 0109 seeded a new lot with lawn and housekeeping, which was too narrow in one
-- direction and wrong in another:
--
--   * IT MISSED THE BOATS. These are lake parks. A resident on a lot may well
--     own a boat, and boat work is priced per FOOT off `boats` — so it already
--     prices correctly for whoever has one and prices to $0 (and vanishes from
--     the menu) for whoever does not. No new machinery, they were simply not
--     on the list.
--   * IT OFFERED A LAKE HOUSE'S SEASONS. "Fall winterization" is $485 and
--     "Spring opening" is $430 — a lake property with a boat, a dock and a
--     house water system. A mobile home's winterize is a different, smaller
--     job, and quoting the lake-house price for it is not a rounding error.
--
-- PIER IS THE PARK'S. It was already unbookable from a lot — `serviceApplies`
-- prices it at $0 with no pier sections — but it is worth writing down WHY,
-- because the reason is ownership rather than arithmetic: the pier belongs to
-- the park, and a resident cannot buy work on somebody else's structure.
--
-- ============ THESE TWO PRICES ARE PLACEHOLDERS ============
--
-- $185 and $165 are mine, not Brendon's. They are marked here and the booking
-- screen shows the number before anything is scheduled, but NOTHING SHOULD BE
-- SOLD at them until he sets his own.

insert into public.services
  (name, pricing_model, base, unit_rate, frequency_options, min_photos,
   is_water_work, band_pricing, park_only, active, needs_interior_access, kind)
values
  -- Blow the lines, antifreeze the traps, check the skirting and the heat
  -- tape. Interior access, so 0089's no-show rules apply.
  ('Mobile home winterization', 'flat', 185, 0,
   array['One-time (fall)'], 3, false, null, false, true, true, 'standalone'),
  ('Mobile home de-winterization', 'flat', 165, 0,
   array['One-time (spring)'], 2, false, null, false, true, true, 'standalone')
on conflict (name) do update
  set base = excluded.base,
      pricing_model = excluded.pricing_model,
      min_photos = excluded.min_photos,
      needs_interior_access = excluded.needs_interior_access,
      active = excluded.active;

comment on table public.services is
  'Every sellable service and the rule that prices it. Three audiences now: '
  'park_only services belong to a park''s own grounds; the mobile-home '
  'seasonal pair belongs to a lot; everything else is a lake property. A lot '
  'and a lake house are told apart by what the RESIDENT''S profile carries, '
  'not by a flag — which is why boat work needs no special casing at all.';

do $$
declare n int;
begin
  -- 1. THE PAIR EXISTS, IS SELLABLE, AND CARRIES A REAL PHOTO GATE.
  select count(*) into n from public.services
   where name in ('Mobile home winterization','Mobile home de-winterization')
     and active = true and min_photos >= 2 and park_only = false;
  if n <> 2 then
    raise exception '0110: the mobile-home seasonal pair is not sellable (got %)', n;
  end if;

  -- 2. IT IS NOT A PARK SERVICE. A lot resident buys it for their own home;
  --    it must never appear on the park's grounds menu beside a 21-lot mow.
  select count(*) into n from public.services
   where name like 'Mobile home %' and park_only = true;
  if n > 0 then raise exception '0110: a mobile-home service leaked onto the park grounds menu'; end if;

  -- 3. IT COUNTS NOTHING, so it applies to any property that is offered it —
  --    which is exactly why wanted_services, not pricing, is what keeps it off
  --    a lake house. Asserted so a later "improvement" to band_pricing cannot
  --    quietly make it price to $0 and vanish.
  select count(*) into n from public.services
   where name like 'Mobile home %' and band_pricing is not null;
  if n > 0 then
    raise exception '0110: a mobile-home service grew a counted field and will now price to zero for everyone';
  end if;

  -- 4. THE LAKE-HOUSE SEASONS ARE UNTOUCHED. This migration adds a smaller
  --    job; it does not reprice anybody's lake house.
  select count(*) into n from public.services
   where (name = 'Fall winterization' and base <> 485)
      or (name = 'Spring opening' and base <> 430);
  if n > 0 then raise exception '0110: the lake-house seasonal prices moved'; end if;
end $$;
