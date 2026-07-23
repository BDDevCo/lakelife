-- ============================================================
--  LakeLife — storage S4 review fixes (DB side).
--  1) Exactly-one live spring job per season envelope: the nightly
--     birth is check-then-insert; overlapping runs (manual + cron)
--     could otherwise birth twins that both bill. Cancelled jobs are
--     excluded so a legitimately cancelled penciled date can re-birth.
--  2) The overstay per-diem gets its own line-item service, so a
--     splash bill's job_items always sum to the job price and the
--     meter shows as its own honest line. Priced by the DIALS at
--     settle time — base 0 here is not a price, it's a placeholder
--     (kind=addon, inactive: never a menu tile, never bookable).
--  Run once. Safe to re-run.
-- ============================================================

create unique index if not exists jobs_one_live_spring_per_group
  on public.jobs (group_id)
  where phase = 'spring' and status <> 'cancelled';

insert into public.services
  (name, pricing_model, base, unit_rate, frequency_options, min_photos, is_water_work, band_pricing, active, kind)
select 'Storage overstay (per-diem)', 'flat', 0, 0, array['Seasonal'], 0, false, null, false, 'addon'
where not exists (select 1 from public.services where name = 'Storage overstay (per-diem)');
