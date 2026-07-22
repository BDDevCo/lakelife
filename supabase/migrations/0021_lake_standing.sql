-- ============================================================
--  LakeLife — Phase E: self-healing lake standing.
--  (1) No-shows now carry the LAKE they happened on; a crew that keeps
--      ghosting one lake self-evicts from that lake (auto-demotion with a
--      cooldown) — no human suspends anyone.
--  (2) Dials for the demotion rule live in platform_settings (rule 8).
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- 1) Where did the miss happen? Stamp the lake on each no-show.
alter table public.vendor_no_shows
  add column if not exists lake_id uuid references public.lakes(id) on delete set null;

-- Backfill existing rows from their property.
update public.vendor_no_shows ns
   set lake_id = p.lake_id
  from public.properties p
 where ns.property_id = p.id
   and ns.lake_id is null;

-- 2) Demotions: one row per (vendor, lake) — re-demotion refreshes the row.
--    While cooling down, the crew can't claim jobs on that lake and can't
--    re-add it to their service area; the clock runs out on its own.
create table if not exists public.vendor_lake_demotions (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors(id) on delete cascade,
  lake_id     uuid not null references public.lakes(id) on delete cascade,
  strikes     integer not null default 0,
  demoted_at  timestamptz not null default now(),
  unique (vendor_id, lake_id)
);

alter table public.vendor_lake_demotions enable row level security;

-- A crew may see its own pauses (the board explains why a job is locked);
-- ops sees all. Writes are server-only (nightly sweep, service role).
drop policy if exists vendor_lake_demotions_access on public.vendor_lake_demotions;
create policy vendor_lake_demotions_access on public.vendor_lake_demotions for select
  using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

revoke insert, update, delete on public.vendor_lake_demotions from authenticated, anon;
grant select on public.vendor_lake_demotions to authenticated;

-- 3) The dials (owner sets once; the machine enforces forever):
--    lake_strike_limit — strikes-minus-completions on ONE lake that trigger
--    the auto-demotion (default 2).
--    lake_demotion_cooldown_days — how long the pause lasts (default 30).
insert into public.platform_settings (key, value) values
  ('lake_strike_limit',            '2'::jsonb),
  ('lake_demotion_cooldown_days',  '30'::jsonb)
on conflict (key) do nothing;
