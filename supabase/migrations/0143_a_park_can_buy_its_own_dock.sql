-- 0143 — A PARK CAN BUY ITS OWN DOCK.
--
-- Asked: "how is a park owner supposed to book services needed for the park to
-- operate?" The answer today is that he mostly cannot. His whole menu is three
-- rows.
--
-- ============ THE FENCE WAS RIGHT IN ONE DIRECTION ONLY ============
--
-- `getPricedServices` (src/app/profile/data.ts) selects the menu with
-- `.eq("park_only", isGrounds)` — one boolean, two menus that never overlap.
-- Its own comment states the intent:
--
--   "so a lake homeowner is never offered a 21-lot mow and a park is never
--    offered a pier."
--
-- The first half is the reason the fence exists and it must keep holding. The
-- second half was collateral, and it is wrong: The Haven has a 28-SECTION
-- VINYL DOCK. Its owner pays $1,680 a season to put it in and take it out, and
-- the product he is building to run the park cannot see the service.
--
-- Nor is this only the pier. A grounds property is a real address with real
-- things at it — a pole barn, an office, a park-owned home on Lot 11 — and the
-- equality fence hides the entire 25-service catalogue from all of it.
--
-- ============ WHY NOT JUST LET PRICING DECIDE ============
--
-- Because pricing only fences one way, which is exactly what that comment
-- says. A park service counts `lots`, which a lake house has none of, so it
-- prices to $0 and vanishes on its own. But `serviceApplies` (pricing.ts:170)
-- returns TRUE for any rule that counts nothing — so flat-priced lake-house
-- services like "Fall winterization" ($485) would leak straight onto a park's
-- grounds menu at a lake-house price. Dropping the fence entirely trades one
-- wrong menu for another.
--
-- So the opening is NAMED rather than inferred: a column that says which
-- general services a park may buy, with a writer and a reader.
--
-- ============ WHAT THIS DOES NOT DO ============
--
-- It does not let a park set its own PRICE on a general service.
-- `setParkServiceRate` still refuses anything that is not `park_only` — its
-- price is LakeLife's. Worth him knowing: at 28 sections the retail pier is
-- $220 + 28 x $48 = $1,564 a visit, $3,128 for the season, against the $1,680
-- he pays now. Whether a park gets a negotiated rate on retail work is a
-- business decision, not a schema one, and it is not made here.

-- ------------------------------------------------- 1. the named opening ----

alter table public.services
  add column if not exists park_bookable boolean not null default false;

comment on column public.services.park_bookable is
  'Whether a PARK may buy this against its grounds property. Independent of '
  'park_only: that flag means "only a park may buy it" (a 21-lot mow), this '
  'one means "a park may ALSO buy it" (the park''s own dock). Default false, '
  'so the lake-house catalogue stays invisible to parks until somebody says '
  'otherwise service by service. The reverse fence is unchanged — a lake house '
  'still sees only park_only = false, and must never be offered a 21-lot mow.';

-- The work a lakefront park does on its OWN waterfront. All three are gated a
-- second time by `serviceApplies`: they count pier_sections / boat_lifts /
-- pwc_lifts, so a park with no dock still sees nothing. Flagging them costs
-- nothing and saves a migration the day a park has a lift.
update public.services
   set park_bookable = true
 where name in ('Pier install / removal', 'Boat lift set / pull', 'PWC lift set / pull');

-- ------------------------------- 2. the grounds has to know what is there --
--
-- A per_section service prices off `property_profile.pier_sections`, and the
-- grounds property has no profile row at all — so the count reads 0,
-- serviceApplies is false, and the pier would still not appear even with the
-- fence open. The 28 sections have lived in a park_costs note; they belong on
-- the property.

insert into public.property_profile (property_id, pier_sections)
select p.service_property_id, 28
  from public.parks p
 where p.slug = 'the-haven'
   and p.service_property_id is not null
on conflict (property_id) do update
   set pier_sections = excluded.pier_sections
 where public.property_profile.pier_sections = 0;

-- ------------------------------------------------------ post-conditions ----
--
-- SHIP-TIME ASSERTIONS. They run once and cannot police the next migration.
-- The fence itself lives in TypeScript, so what can be checked here is the
-- DATA the fence reads; `profile-fence.test.ts` asserts the query shape.

do $$
declare n int; sections int;
begin
  -- 1. THE DEFAULT IS CLOSED. A new service is not park-buyable by accident.
  if (select count(*) from public.services where park_bookable is null) > 0 then
    raise exception '0143: park_bookable is nullable — a null is neither open nor shut';
  end if;

  -- 2. EXACTLY THE THREE INTENDED SERVICES ARE OPEN.
  select count(*) into n from public.services where park_bookable;
  if n <> 3 then
    raise exception '0143: % services are park_bookable, expected 3', n;
  end if;
  if not exists (
    select 1 from public.services where park_bookable and name = 'Pier install / removal'
  ) then
    raise exception '0143: the pier — the service this migration exists for — is not open';
  end if;

  -- 3. THE TWO FLAGS ARE DIFFERENT AXES AND MUST NOT OVERLAP. A park_only
  --    service is already on the park menu; flagging it park_bookable too
  --    would put it in the menu query twice.
  if exists (select 1 from public.services where park_only and park_bookable) then
    raise exception '0143: a service is both park_only and park_bookable — pick one';
  end if;

  -- 4. THE REVERSE FENCE IS UNTOUCHED. Every park_only service is still
  --    park_only, so no lake house gains a 21-lot mow from this migration.
  select count(*) into n from public.services where park_only;
  if n <> 3 then
    raise exception '0143: % park_only services, expected the 3 grounds services', n;
  end if;

  -- 5. THE HAVEN'S GROUNDS KNOWS IT HAS A DOCK — without which the fence
  --    opening changes nothing, because the pier would price to 0.
  select pp.pier_sections into sections
    from public.property_profile pp
    join public.parks pk on pk.service_property_id = pp.property_id
   where pk.slug = 'the-haven';
  if sections is null then
    raise notice '0143: no Haven grounds profile — skipped (park or property missing)';
  elsif sections <> 28 then
    raise exception '0143: the Haven grounds has % pier sections, expected 28', sections;
  end if;
end $$;
