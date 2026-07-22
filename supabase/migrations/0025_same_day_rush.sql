-- ============================================================
--  LakeLife — SAME-DAY RUSH (owner design, 2026-07-22).
--  A customer can book TODAY before the cutoff at a rush premium;
--  the job NEVER auto-dispatches — it goes straight to the claim
--  board where crews already out on that lake pick it up at a
--  fill-in discount off their own rate. Urgency premium + fill-in
--  discount both widen the margin; claim = crew consent, so none
--  of the same-day auto-push hazards apply.
--  Run once. Safe to re-run.
-- ============================================================

-- 1) Rush flag + the customer's pre-chosen fallback if nobody claims
--    by the cutoff: roll to tomorrow at the STANDARD price, or cancel
--    free. Chosen at booking — no limbo, no ops.
alter table public.jobs
  add column if not exists is_rush boolean not null default false,
  add column if not exists rush_fallback text
    check (rush_fallback in ('roll', 'cancel'));

-- 2) The three dials (rule 8 — owner sets once, machine enforces):
--    same_day_surcharge_pct     — rush premium over menu price (0.25 = +25%)
--    same_day_fill_discount_pct — fill-in discount off the crew's rate (0.15)
--    same_day_cutoff_hour       — lake-time hour rush booking/claiming closes (14 = 2pm)
insert into public.platform_settings (key, value) values
  ('same_day_surcharge_pct',     '0.25'::jsonb),
  ('same_day_fill_discount_pct', '0.15'::jsonb),
  ('same_day_cutoff_hour',       '14'::jsonb)
on conflict (key) do nothing;
