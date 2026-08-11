-- ============================================================================
-- 0071 — OVERDUE REMINDERS, AND THE PEOPLE YOU CANNOT EMAIL.
--
-- "Overdue reminders to all parties." Three parties, and they are not alike:
--
--   THE RESIDENT who owes — the one the reminder is for.
--   THE PARK OWNER — a digest, not twenty separate alerts.
--   OPS — only when something is stuck, not routinely.
--
-- ---------------------------------------------------------------------------
-- THE PART THAT MATTERS MOST: 25-35% OF A PARK NEVER GOES DIGITAL.
--
-- `park_renters.contact_pref` defaults to 'paper' for exactly that reason
-- (0055). If a reminder system can only send email and SMS, then the paper
-- residents — often the older, longest-standing, most at-risk households —
-- are the only ones who never get reminded, and the first thing they hear
-- about arrears is something far worse than a reminder.
--
-- So a PAPER reminder is a first-class outcome. It produces a printable notice
-- and is logged exactly like a sent one, because "we told them" has to be
-- answerable the same way regardless of how.
-- ---------------------------------------------------------------------------
--
-- EXACTLY ONCE. A resident chased three times for one bill stops reading
-- anything from the park, and the one they stop reading is the freeze warning.
-- The unique index below is the whole guarantee.
--
-- SMS IS BLOCKED UNTIL A2P 10DLC REGISTRATION CLEARS. That is recorded as a
-- REFUSAL WITH A REASON rather than a silent skip, so the owner can see that
-- four people would have been texted and were not.
-- ============================================================================

create table if not exists public.park_reminders (
  id         uuid primary key default gen_random_uuid(),
  park_id    uuid not null references public.parks(id) on delete cascade,
  charge_id  uuid not null references public.park_charges(id) on delete cascade,

  -- Who it went to.
  party      text not null check (party in ('resident', 'owner', 'ops')),
  channel    text not null check (channel in ('email', 'sms', 'paper', 'none')),

  -- What actually happened. `blocked` is a real outcome, not an error: SMS
  -- before A2P, or a resident who asked for no contact at all.
  outcome    text not null default 'sent'
               check (outcome in ('sent', 'printed', 'blocked', 'failed')),
  reason     text,

  -- WHAT WE SAID, kept verbatim. A resident disputing a late fee is entitled
  -- to see the notice they were sent, and "we emailed you" is not evidence.
  body       text,

  sent_at    timestamptz not null default now(),
  sent_by    uuid references public.users(id) on delete set null,

  constraint park_reminders_blocked_has_reason
    check (outcome not in ('blocked', 'failed') or reason is not null)
);

comment on table public.park_reminders is
  'One reminder, one charge, one party. `body` is kept verbatim because "we '
  'emailed you" is not evidence and a disputed late fee needs the notice.';

-- EXACTLY ONCE per charge per party. A partial index on the outcomes that
-- actually reached somebody: a BLOCKED attempt must not stop a later real one
-- once A2P clears or an address is added.
create unique index if not exists park_reminders_once_idx
  on public.park_reminders (charge_id, party)
  where outcome in ('sent', 'printed');

create index if not exists park_reminders_park_idx
  on public.park_reminders (park_id, sent_at desc);


-- ---------------------------------------------------------------- rls -------
alter table public.park_reminders enable row level security;

drop policy if exists park_reminders_read on public.park_reminders;
create policy park_reminders_read on public.park_reminders
  for select to authenticated
  using (
    public.ll_manages_park(park_id)
    or public.ll_is_ops()
    -- A resident may read what was sent to them about their own bill.
    or exists (
      select 1
        from public.park_charges c
        join public.park_renters pr on pr.id = c.renter_id
       where c.id = park_reminders.charge_id
         and pr.user_id = auth.uid()
    )
  );

revoke all on public.park_reminders from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.park_reminders from authenticated;
grant select on public.park_reminders to authenticated;


-- ------------------------------------------------------ post-conditions -----
do $$
begin
  if to_regclass('public.park_reminders') is null then
    raise exception '0071: park_reminders missing';
  end if;

  -- The guarantee that stops somebody being chased three times.
  if not exists (
    select 1 from pg_indexes
     where schemaname='public' and indexname='park_reminders_once_idx'
  ) then
    raise exception '0071: a resident could be reminded twice for one bill';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'park_reminders_blocked_has_reason'
  ) then
    raise exception '0071: a blocked reminder could carry no explanation';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public' and table_name='park_reminders' and grantee='anon'
  ) then
    raise exception '0071: anon holds a grant on reminders';
  end if;

  raise notice '0071: reminders reach paper residents too, and only once each.';
end $$;
