-- ============================================================
--  LakeLife — Seed the services + their pricing rules.
--  Pricing lives in DATA, not code (CLAUDE.md rule 8). Edit these
--  rows from Ops to change prices; the app and pricing engine follow.
--  Numbers mirror the prototype's pricing constants.
--
--  Run AFTER 0001/0002. Safe to re-run (upserts by name).
-- ============================================================

create unique index if not exists services_name_uidx on public.services (name);

insert into public.services
  (name, pricing_model, base, unit_rate, frequency_options, min_photos, is_water_work, band_pricing, active)
values
  -- Seasonal (flat)
  ('Spring opening', 'flat', 430, 0,
   array['One-time (spring)'], 3, false, null, true),
  ('Fall winterization', 'flat', 485, 0,
   array['One-time (fall)'], 4, false, null, true),

  -- Pier: base + rate × sections
  ('Pier install / removal', 'per_section', 220, 48,
   array['Install (spring)','Removal (fall)'], 2, true,
   '{"count_field":"pier_sections"}'::jsonb, true),

  -- Boat lift: rate × lifts (floored at 1, per prototype)
  ('Boat lift set / pull', 'per_section', 0, 495,
   array['Set (spring)','Pull (fall)'], 2, true,
   '{"count_field":"boat_lifts","min_count":1}'::jsonb, true),

  -- Jet ski winterize & store: rate × number of jet skis (PLACEHOLDER rate)
  ('Jet ski winterize & store', 'per_section', 0, 350,
   array['Winterize + store','De-winterize + launch'], 2, true,
   '{"count_field":"jet_skis"}'::jsonb, true),

  -- PWC lift set/pull: rate × number of PWC lifts (PLACEHOLDER rate)
  ('PWC lift set / pull', 'per_section', 0, 165,
   array['Set (spring)','Pull (fall)'], 2, true,
   '{"count_field":"pwc_lifts"}'::jsonb, true),

  -- Boat storage & winterize: rate × total feet
  ('Boat storage & winterize', 'per_foot', 0, 50,
   array['Winterize + store','De-winterize + launch'], 3, true, null, true),

  -- Water toys: base + per-lift + per-toy
  ('Water toy prep & storage', 'flat', 120, 0,
   array['Store (fall)','Deploy (spring)'], 1, true,
   '{"add":[{"field":"toy_lifts","rate":60},{"field":"toys_count","rate":15}]}'::jsonb, true),

  -- Lawn: band price
  ('Lawn mowing & trim', 'band', 0, 0,
   array['Weekly','Every 2 weeks'], 1, false,
   '{"small":65,"medium":85,"large":110}'::jsonb, true),

  -- Housekeeping: price by square-footage tier
  ('Housekeeping', 'per_sqft_band', 0, 0,
   array['Weekly','Every 2 weeks','Before each arrival'], 2, false,
   '{"tiers":[{"max":1800,"price":80},{"max":2800,"price":95},{"max":null,"price":120}]}'::jsonb, true)
on conflict (name) do update set
  pricing_model     = excluded.pricing_model,
  base              = excluded.base,
  unit_rate         = excluded.unit_rate,
  frequency_options = excluded.frequency_options,
  min_photos        = excluded.min_photos,
  is_water_work     = excluded.is_water_work,
  band_pricing      = excluded.band_pricing,
  active            = excluded.active;
