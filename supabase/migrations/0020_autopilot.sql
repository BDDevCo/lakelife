-- ============================================================
--  LakeLife — Delight layer, part 2: AUTOPILOT (§8d).
--  A PER-SERVICE toggle (never a bundle): the machine proposes each
--  season's visit, the customer one-taps confirm/skip from a text,
--  and their price is LOCKED at enrollment for the season.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- 1) Enrollments: one row per (property, service). locked_price is the
--    all-in customer price frozen at enrollment (the rate-lock perk) —
--    confirmed bookings are created at THIS price, not the current menu.
create table if not exists public.autopilot_enrollments (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  service_id   uuid not null references public.services(id) on delete cascade,
  locked_price numeric not null,
  active       boolean not null default true,
  enrolled_at  timestamptz not null default now(),
  unique (property_id, service_id)
);

-- 2) Events: each season's proposed visit. confirm_token is the unguessable
--    id in the one-tap text link (knowing it authorizes ONLY confirm/skip of
--    this one proposal — it can't read or change anything else).
create table if not exists public.autopilot_events (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.autopilot_enrollments(id) on delete cascade,
  proposed_date date not null,
  status        text not null default 'proposed'
                check (status in ('proposed', 'confirmed', 'skipped', 'expired')),
  confirm_token uuid not null default gen_random_uuid(),
  job_id        uuid references public.jobs(id) on delete set null,
  created_at    timestamptz not null default now()
);
create unique index if not exists autopilot_events_token on public.autopilot_events (confirm_token);
-- One OPEN proposal per enrollment at a time (proposed only).
create unique index if not exists autopilot_events_open
  on public.autopilot_events (enrollment_id) where status = 'proposed';

-- 3) RLS: owners may READ their own enrollments (to render their toggles);
--    events are server-managed (tokenized links + server actions), no client
--    reads needed. All client writes revoked (0009/0011 pattern) — enroll,
--    confirm, skip all go through server actions / the token route.
alter table public.autopilot_enrollments enable row level security;
alter table public.autopilot_events enable row level security;

drop policy if exists autopilot_enroll_owner_read on public.autopilot_enrollments;
create policy autopilot_enroll_owner_read on public.autopilot_enrollments
  for select using (
    public.ll_is_ops()
    or exists (select 1 from public.properties p
               where p.id = property_id and p.owner_id = auth.uid())
  );

drop policy if exists autopilot_events_ops_read on public.autopilot_events;
create policy autopilot_events_ops_read on public.autopilot_events
  for select using (public.ll_is_ops());

revoke insert, update, delete on public.autopilot_enrollments from authenticated, anon;
revoke insert, update, delete on public.autopilot_events from authenticated, anon;
grant select on public.autopilot_enrollments to authenticated;
grant select on public.autopilot_events to authenticated;
