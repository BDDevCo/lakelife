-- 0151 — THE OWNER SAYS THEY HAVE CLEARED IT.
--
-- 0150 made a refused release END the visit honestly: no-show, not
-- proceed-and-bill. This is the other half — the part that stops the crew
-- driving out to a gate nobody is expecting them at.
--
-- A yard does not hand a $40,000 boat to a stranger with a trailer. Somebody
-- has to have told them we are coming, and the only person who can is the
-- person who put the boat there.
--
-- ============ LAKELIFE IS NOT A PARTY TO THIS ============
--
-- Courier, not witness — the standing decision. We do not contact the yard, we
-- do not hold an authorisation, we do not collect a signature on an agreement
-- between a customer and their marina, and we never claim anybody agreed to
-- anything. What we can honestly record is what the CUSTOMER told us, and pass
-- to the crew the name and number they gave us.
--
-- So this is three plain facts on the job:
--
--   pickup_contact       who to ask for at the gate
--   pickup_phone         a number to ring before driving out
--   release_confirmed_at when the customer said they had arranged it
--
-- `release_confirmed_at` is a TIMESTAMP, not a boolean, for the same reason
-- every other consent here is: "they ticked it" is worth much less six months
-- later than "they ticked it at 14:12 on 3 March".
--
-- ============ THE TICK STARTS EMPTY ============
--
-- A pre-ticked box that asserts a fact about the world is how 19 leases got
-- written that nobody had signed. This one starts unticked, the booking is
-- refused until it is ticked, and the refusal is server-side because the form
-- can be bypassed.
--
-- ============ WHY NO TRIGGER ============
--
-- A constraint refusing any needs_release job without a confirmation would be
-- stronger, and it would break two paths that have nothing to do with booking:
--
--   · `src/lib/disputes.ts` clones a job to make a MAKE-IT-RIGHT visit. It
--     carries no confirmation because the customer is not booking anything —
--     we are going back to fix our own work. A trigger would refuse to create
--     the correction visit for a botched splash.
--   · `src/app/a/[token]/confirm/route.ts` creates jobs from an autopilot
--     enrolment, which never runs the booking form at all.
--
-- The booking ACTION is the authority instead, exactly as it is for the pickup
-- spot in 0148. Same seam, same reason.
--
-- WHAT THE CLONE DOES CARRY, as of this migration's commit: the correction
-- visit copies pickup_address / lat / lng / contact / phone from the job it is
-- putting right. It was copying property_id and service_id and nothing about
-- where the boat is — so a make-it-right on a collection sent the crew to the
-- customer's house, where there is no boat. That is fixed in the same change.

-- ------------------------------------------------------ 1. the columns ---

alter table public.jobs
  add column if not exists pickup_contact text,
  add column if not exists pickup_phone text,
  add column if not exists release_confirmed_at timestamptz;

comment on column public.jobs.pickup_contact is
  'Who the crew should ask for at the yard holding the boat — a marina name, a '
  'person, a neighbour. The customer''s words, passed through. Optional: not '
  'every barn has a front desk.';

comment on column public.jobs.pickup_phone is
  'A number to ring before driving out. Optional, and its absence is shown to '
  'the crew as such rather than hidden — "no number on file" is a fact worth '
  'having before a 40-minute drive.';

comment on column public.jobs.release_confirmed_at is
  'When the customer confirmed they had told the holder that our crew is '
  'collecting. THEIR statement, recorded — never our authorisation, and never '
  'evidence the holder agreed to anything (courier, not witness). Required at '
  'booking for a needs_release service; enforced in the booking action, not by '
  'a trigger, because correction visits and autopilot create jobs too.';

-- ---------------------------------------------------- 2. the tripwires ---

do $$
declare n integer;
begin
  -- 1. THE COLUMNS LANDED. A missing one reads downstream as "never
  --    confirmed", which is indistinguishable from a customer who was asked
  --    and said no.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'jobs'
     and column_name in ('pickup_contact', 'pickup_phone', 'release_confirmed_at');
  if n <> 3 then
    raise exception '0151: % of the 3 release columns exist', n;
  end if;

  -- 2. NULLABLE, ALL THREE. Every job that is not a collection has nothing to
  --    say here, and a NOT NULL would refuse every mow on the platform.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs'
       and column_name in ('pickup_contact', 'pickup_phone', 'release_confirmed_at')
       and is_nullable = 'NO'
  ) then
    raise exception '0151: a release column is NOT NULL — every non-collection booking would fail';
  end if;

  -- 3. NOTHING IS RETROSPECTIVELY CONFIRMED. No job may arrive already
  --    carrying somebody's word that they cleared it.
  select count(*) into n from public.jobs where release_confirmed_at is not null;
  if n <> 0 then
    raise exception '0151: % jobs already claim a confirmed release', n;
  end if;

  -- 4. THE SERVICES THAT NEED ONE STILL DO. This migration is the capture side
  --    of 0150; if that flag has gone, this collects a fact nobody asks for.
  select count(*) into n from public.services where needs_release;
  if n <> 2 then
    raise exception '0151: % services need a release, expected 2 — 0150 has been undone', n;
  end if;
end $$;
