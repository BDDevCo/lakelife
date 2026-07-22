-- ============================================================
--  LakeLife — Delight layer, part 1: cancellation policy dials,
--  cancelled job status, property nicknames, and the per-account
--  calendar-feed token.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- 1) Jobs can now end life as 'cancelled' (fee-cancels keep the row for
--    billing history; free cancels still delete). ADD VALUE is idempotent-safe
--    via the duplicate guard.
do $$ begin
  alter type job_status add value if not exists 'cancelled';
exception when duplicate_object then null; end $$;

-- 2) Cancellation dials (owner-tunable, rule 8 — join margin_floor/surge in
--    platform_settings). Beta posture per owner 2026-07-22: 25% late fee.
--      cancel_fee_pct        — fee as a share of the all-in price
--      cancel_routine_hours  — routine services: free until this many hours out
--      cancel_water_days     — water work: free until this many days out
insert into public.platform_settings (key, value) values
  ('cancel_fee_pct',       '0.25'::jsonb),
  ('cancel_routine_hours', '48'::jsonb),
  ('cancel_water_days',    '7'::jsonb)
on conflict (key) do nothing;

-- 3) Property nickname ("The Cabin", "Mom & Dad's") — pure delight, shown bold
--    in the switcher. Owner-editable via server action; no client write grant
--    needed (0009/0011 pattern: server actions verify ownership, service role
--    writes).
alter table public.properties add column if not exists nickname text;

-- 4) Per-account calendar-feed token: an unguessable id that lets the owner's
--    phone calendar subscribe to their LakeLife schedule WITHOUT a login
--    session (calendar apps can't log in). Knowing the token only ever reveals
--    that account's own scheduled services — never prices, crews, or codes.
alter table public.users add column if not exists ics_token uuid not null default gen_random_uuid();
create unique index if not exists users_ics_token on public.users (ics_token);
