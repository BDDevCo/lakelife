-- ============================================================================
-- 0057 — LOT TAXONOMY: what it IS, what it HAS, and what makes it WORTH MORE.
--
-- The owner described how a park owner actually classifies inventory: RV lots
-- with hookup variants, normal lots, DOUBLE-WIDE lots, and premium lots. Two
-- things were wrong with what we had.
--
-- 1. THERE WAS NO WAY TO SAY DOUBLE-WIDE. `mh_pad` collapsed single and double
--    into one type. They are materially different inventory — different width,
--    different rent, different homes fit — and the fit rules could not tell
--    them apart. A park with both was unrepresentable.
--
-- 2. HOOKUPS WERE ENCODED IN THE TYPE. `rv_full` and `rv_we` are not different
--    KINDS of lot; they are the same lot with different equipment. We already
--    have has_water, has_sewer and amperage columns saying exactly that, so the
--    type was duplicating them — and duplicated facts drift. An owner could set
--    site_type='rv_full' and has_sewer=false and we would happily store a lot
--    that claimed two contradictory things.
--
-- AND THE CORRECTION THAT MATTERS MOST: PREMIUM IS NOT A TYPE, IT IS AN
-- ATTRIBUTE. A premium lot is a double-wide that happens to be waterfront, or
-- an RV site on the corner with shade. Make it a type and "premium
-- double-wide" becomes inexpressible — you must pick one, and the model starts
-- lying. So it becomes a TIER that combines with any type, and the specific
-- reasons become FEATURES.
--
-- Three questions, in the order an owner can actually answer them:
--   WHAT IT IS      -> site_type   (rv_site | mh_single | mh_double | tent | slip)
--   WHAT IT HAS     -> has_water, has_sewer, amperage  (already existed)
--   WHAT IT'S WORTH -> tier + features
--
-- SAFE TO RESTRUCTURE: park_lots is EMPTY in production (verified) and
-- parks.active has never been true. The mapping below still runs, because a
-- rebuild replays this file against seeded data and a branch may hold rows.
-- ============================================================================

-- ---------------------------------------------------------------- tier ----
alter table public.park_lots
  add column if not exists tier text not null default 'standard';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'park_lots_tier_check') then
    alter table public.park_lots
      add constraint park_lots_tier_check check (tier in ('standard', 'premium'));
  end if;
end $$;

comment on column public.park_lots.tier is
  'What it is WORTH, independent of what it IS. premium combines with any '
  'site_type — a premium double-wide and a premium RV site are both sayable. '
  'Deliberately NOT a site_type value: making it one would force an owner to '
  'choose between "double-wide" and "premium" and the model would start lying.';

-- ------------------------------------------------------------ features ----
-- WHY it is premium, so the public page can say something better than
-- "premium" and the owner can remember their own reasoning next season.
alter table public.park_lots
  add column if not exists features text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'park_lots_features_check') then
    alter table public.park_lots
      add constraint park_lots_features_check
      check (features <@ array[
        'waterfront', 'water_view', 'corner', 'shade', 'pull_through',
        'extra_parking', 'concrete_pad', 'fenced', 'near_amenities', 'private'
      ]::text[]);
  end if;
end $$;

comment on column public.park_lots.features is
  'WHY a lot is worth more. An allowlist, not free text — a free-text field on '
  'a housing listing is where a fair-housing problem gets typed (0052 makes the '
  'same argument about decline reasons).';

-- ----------------------------------------------------------- site_type ----
-- Drop the old check before remapping, or the update fails on the first row.
alter table public.park_lots drop constraint if exists park_lots_site_type_check;

-- rv_full and rv_we differed ONLY by sewer, which has its own column. Collapse
-- them and push the fact where it belongs, preserving what each type asserted.
update public.park_lots set has_water = true,  has_sewer = true  where site_type = 'rv_full';
update public.park_lots set has_water = true,  has_sewer = false where site_type = 'rv_we';

update public.park_lots set site_type = 'rv_site'   where site_type in ('rv_full', 'rv_we');
-- Every existing pad becomes SINGLE-wide, which is the safe reading: a double
-- is the exception an owner re-tags deliberately, and guessing "double" would
-- silently widen inventory nobody measured.
update public.park_lots set site_type = 'mh_single' where site_type = 'mh_pad';
update public.park_lots set site_type = 'slip'      where site_type = 'slip_only';

alter table public.park_lots
  add constraint park_lots_site_type_check
  check (site_type in ('rv_site', 'mh_single', 'mh_double', 'tent', 'slip'));

alter table public.park_lots alter column site_type set default 'rv_site';

comment on column public.park_lots.site_type is
  'What the lot physically IS. Hookups are NOT encoded here — has_water, '
  'has_sewer and amperage carry those, because rv_full/rv_we were the same lot '
  'with different equipment and a duplicated fact drifts (site_type=rv_full '
  'with has_sewer=false was storable and meaningless).';

create index if not exists park_lots_tier_idx on public.park_lots(park_id, tier);


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int; bad int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='park_lots'
     and column_name in ('tier', 'features');
  if n <> 2 then raise exception '0057: expected tier and features, found %', n; end if;

  -- Nothing may be left on an old type name.
  select count(*) into bad from public.park_lots
   where site_type in ('rv_full', 'rv_we', 'mh_pad', 'slip_only');
  if bad > 0 then
    raise exception '0057: % lot(s) still carry a retired site_type', bad;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'park_lots_site_type_check') then
    raise exception '0057: the site_type check did not land — any string would be storable';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'park_lots_tier_check') then
    raise exception '0057: the tier check did not land';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'park_lots_features_check') then
    raise exception '0057: the features allowlist did not land — free text could reach a public listing';
  end if;

  raise notice '0057: lot taxonomy ready. What it is, what it has, what it is worth.';
end $$;
