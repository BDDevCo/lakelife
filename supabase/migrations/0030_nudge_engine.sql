-- ============================================================
--  LakeLife — payout batch + nudge engine (owner direction,
--  2026-07-23): crews/HOAs paid month-end; the game lives in
--  EMAIL (SMS stays operational-only); every nudge kind is
--  frequency-capped per user and respects notification prefs
--  (type 'growth', channel 'email' — absence = opted in).
--  Run once. Safe to re-run.
-- ============================================================

-- The anti-spam ledger: one row per nudge sent; the engine refuses to
-- resend a kind inside its cooldown window. Ops-readable for audit.
create table if not exists public.nudge_log (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references public.users(id) on delete cascade,
  kind     text not null,
  sent_at  timestamptz not null default now()
);
create index if not exists nudge_log_lookup on public.nudge_log (user_id, kind, sent_at desc);

alter table public.nudge_log enable row level security;
drop policy if exists nudge_log_ops on public.nudge_log;
create policy nudge_log_ops on public.nudge_log for select using (public.ll_is_ops());
revoke insert, update, delete on public.nudge_log from authenticated, anon;
grant select on public.nudge_log to authenticated;

-- Dials: when a credit balance is worth bragging about, and how long each
-- nudge kind stays quiet after firing.
insert into public.platform_settings (key, value) values
  ('nudge_credit_threshold', '50'::jsonb),  -- "your credits cover a visit" trigger
  ('nudge_cooldown_days',    '30'::jsonb)   -- per-kind, per-user quiet period
on conflict (key) do nothing;
