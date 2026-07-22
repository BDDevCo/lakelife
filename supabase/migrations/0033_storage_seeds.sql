-- ============================================================
--  LakeLife — storage & winterization seeds (phase S1).
--  EVERYTHING INACTIVE: the currently-deployed app lists services by
--  active=true with no kind filter, so components must stay invisible
--  until the kind-aware code + booking wizard deploy (S2 flips active).
--  Customer-side menu values below are the ILLUSTRATIVE numbers from
--  docs/storage-winterize-design.md §C (market mid-range + ~30%) —
--  the owner tunes them in the DB before activation (rule 8).
--  Run once. Safe to re-run (name-keyed upserts).
-- ============================================================

-- 1) Component + add-on service rows (kind gates them off menu tiles).
insert into public.services
  (name, pricing_model, base, unit_rate, frequency_options, min_photos, is_water_work, band_pricing, active, kind)
values
  -- winterize/de-winterize: per_foot generalizes flat (crew can rate base-only)
  ('Boat winterization (shop)',      'per_foot',              0, 12, array['One-time (fall)'],   2, false, null, false, 'component'),
  ('Spring de-winterize & test run', 'per_foot',              0,  9, array['One-time (spring)'], 2, false, null, false, 'component'),
  -- transport legs: flat per one-way move; water-gated (needs the lake open)
  ('Boat haul-out (we pick it up)',  'flat',                285,  0, array['One-time (fall)'],   2, true,  null, false, 'component'),
  ('Boat return & splash',           'flat',                285,  0, array['One-time (spring)'], 2, true,  null, false, 'component'),
  -- storage tiers (owner decision: outdoor-wrapped + indoor-cold at launch)
  ('Winter storage — outdoor',       'seasonal_plus_perdiem', 0, 43, array['Seasonal'],          1, false, '{"storage_type":"outdoor"}'::jsonb, false, 'component'),
  ('Winter storage — indoor',        'seasonal_plus_perdiem', 0, 64, array['Seasonal'],          1, false, '{"storage_type":"indoor"}'::jsonb, false, 'component'),
  -- add-ons
  ('Shrink wrap',                    'per_foot',              0, 26, array['One-time (fall)'],   1, false, null, false, 'addon'),
  ('Battery care (pull, tend, reinstall)', 'flat',           90,  0, array['Seasonal'],          1, false, null, false, 'addon'),
  ('Engine oil & filter change',     'flat',                180,  0, array['One-time (fall)'],   1, false, null, false, 'addon')
on conflict do nothing;

-- Re-runs: 'on conflict do nothing' has no unique key on name, so guard
-- against duplicates from a second run.
delete from public.services a using public.services b
 where a.kind in ('component','addon') and b.kind = a.kind
   and a.name = b.name and a.created_at > b.created_at;

-- 2) The three packages (INACTIVE until the wizard ships).
insert into public.service_packages (code, name, description, active, sort) values
  ('you_tow',      'You tow it to the shop',
   'Tow your boat in; we winterize it. Store it with us or take it home for the winter.', false, 1),
  ('we_haul',      'We pick it up',
   'We haul your boat off the lake, winterize it, and either bring it back to your place for the winter or store it at the shop and splash it for you in spring.', false, 2),
  ('storage_only', 'Winter storage only',
   'Already winterized? Tow it in and we''ll keep it safe until spring.', false, 3)
on conflict (code) do update set name = excluded.name, description = excluded.description, sort = excluded.sort;

-- 3) Component recipes. required = always in the package;
--    optional rows are the wizard's toggles (storage tiers: pick at most one).
with p as (select id, code from public.service_packages),
     s as (select id, name from public.services where kind in ('component','addon'))
insert into public.package_components (package_id, service_id, phase, required, default_on)
select p.id, s.id, x.phase, x.required, x.default_on
from (values
  -- you_tow: winterize required; storage tiers + wrap optional; spring legs optional
  ('you_tow',      'Boat winterization (shop)',            'fall',   true,  true),
  ('you_tow',      'Winter storage — outdoor',             'fall',   false, false),
  ('you_tow',      'Winter storage — indoor',              'fall',   false, false),
  ('you_tow',      'Shrink wrap',                          'fall',   false, false),
  ('you_tow',      'Spring de-winterize & test run',       'spring', false, true),
  ('you_tow',      'Boat return & splash',                 'spring', false, false),
  -- we_haul: haul + winterize required; then home-return (fall) OR storage + spring return
  ('we_haul',      'Boat haul-out (we pick it up)',        'fall',   true,  true),
  ('we_haul',      'Boat winterization (shop)',            'fall',   true,  true),
  ('we_haul',      'Boat return & splash',                 'fall',   false, false),  -- home-storage variant: return in fall
  ('we_haul',      'Winter storage — outdoor',             'fall',   false, true),
  ('we_haul',      'Winter storage — indoor',              'fall',   false, false),
  ('we_haul',      'Shrink wrap',                          'fall',   false, true),
  ('we_haul',      'Boat haul-out (we pick it up)',        'spring', false, false),  -- home-storage variant: fetch in spring
  ('we_haul',      'Spring de-winterize & test run',       'spring', false, true),
  ('we_haul',      'Boat return & splash',                 'spring', false, true),
  -- storage_only: a tier required (wizard enforces exactly one); optional vendor transport
  ('storage_only', 'Winter storage — outdoor',             'fall',   false, true),
  ('storage_only', 'Winter storage — indoor',              'fall',   false, false),
  ('storage_only', 'Boat haul-out (we pick it up)',        'fall',   false, false),
  ('storage_only', 'Boat return & splash',                 'spring', false, false)
) as x(pkg, svc, phase, required, default_on)
join p on p.code = x.pkg
join s on s.name = x.svc
on conflict (package_id, service_id, phase) do update
  set required = excluded.required, default_on = excluded.default_on;
