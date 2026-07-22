-- ============================================================
--  LakeLife — Phase C: pricing levers move to the DATABASE (rule 8).
--  platform_settings holds the owner-tunable dials the dispatch engine
--  reads: the margin floor (min share of the menu price LakeLife keeps)
--  and the surge cap (max scarcity uplift over menu price the machine
--  may OFFER a customer — never applied without their accept).
--  Set once by the owner; the machine decides forever after.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Seed the two dials with today's effective values (idempotent).
insert into public.platform_settings (key, value) values
  ('margin_floor',  '0.25'::jsonb),
  ('surge_cap_pct', '0.25'::jsonb)
on conflict (key) do nothing;

-- Margin policy is OPS-ONLY information (rule 1: vendors never see margin;
-- customers never see it either). RLS: ops may read; nobody else. The engine
-- reads via the service role, which bypasses RLS.
alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_ops_read on public.platform_settings;
create policy platform_settings_ops_read on public.platform_settings
  for select using (public.ll_is_ops());

-- Belt & braces: no client may ever write settings (0009/0011 pattern) —
-- changes go through the ops server action (service role) only.
revoke insert, update, delete on public.platform_settings from authenticated, anon;
grant select on public.platform_settings to authenticated;
