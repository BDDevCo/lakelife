-- 0078 — HIS DECISIONS ABOUT THE TO-DO LIST, AND HIS OWN LIST.
--
-- Generated tasks are DERIVED, never stored: the schema already holds every
-- dated obligation, and a stored copy would drift from it. What it does not
-- hold is his decisions ABOUT them, which is all park_task_states is.
--
-- A SNOOZE AND A DISMISSAL ARE DIFFERENT THINGS. Putting something off is not
-- deciding against it, and the constraint refuses a row that does neither.
create table if not exists public.park_task_states (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete cascade,
  task_key text not null,
  snoozed_until date,
  dismissed_at timestamptz,
  dismissed_reason text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint task_state_is_a_decision
    check (snoozed_until is not null or dismissed_at is not null)
);

create unique index if not exists park_task_states_key_idx
  on public.park_task_states (park_id, task_key);

-- Half of what happens at a park is somebody telling him in the driveway. The
-- property tax, the insurance binder, the licence renewal -- none of those have
-- a derivable column anywhere and never will. Deliberately minimal: no due
-- date, no assignee, no recurrence. A work-order product for a 200-lot operator
-- is not what a 21-lot park needs.
create table if not exists public.park_notes (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 400),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

create index if not exists park_notes_open_idx
  on public.park_notes (park_id, created_at desc) where done_at is null;

alter table public.park_task_states enable row level security;
alter table public.park_notes enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.park_task_states from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.park_notes from anon, authenticated;
revoke select on public.park_task_states from anon;
revoke select on public.park_notes from anon;

drop policy if exists park_task_states_read on public.park_task_states;
create policy park_task_states_read on public.park_task_states
  for select using (public.ll_manages_park(park_id) or public.ll_is_ops());

drop policy if exists park_notes_read on public.park_notes;
create policy park_notes_read on public.park_notes
  for select using (public.ll_manages_park(park_id) or public.ll_is_ops());
