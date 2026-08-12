-- 0090 — THE CREW GETS PAID FOR THE TRIP.
--
-- 0089 left an asymmetry sitting in the open and said so out loud: the crew
-- drove to the lake in every branch, and in three of them they got nothing.
-- A stand-down, a waived fee, a reschedule. Brendon: "yes add a trip fee for
-- the crew."
--
-- THE RULE, IN ONE LINE: for a documented trip that produced no work, the crew
-- is never paid less than the trip fee.
--
--   owed = max(trip fee, their share of any fee the customer actually paid)
--
-- One number to reason about, and it behaves correctly at both ends. A small
-- job whose 25% share comes to $15 still pays the crew the full trip fee. A
-- large one whose share is $100 pays the $100 — the trip fee is a FLOOR, not
-- a cap, and never docks a crew who was already made whole.
--
-- WHO FUNDS IT, WHICH IS THE PART THAT MATTERS:
--
--   The customer's fee, when one is collected. Their door, their trip.
--
--   LAKELIFE, otherwise. If ops waived the fee, we chose that. If the crew was
--   stood down, OUR profile said eight sections when there were twelve — the
--   crew's fuel paid for our bad record. Putting that cost on us is not
--   generosity, it is the only place it can sit without being unfair, and it
--   is the pressure that keeps profiles honest: bad data now costs the party
--   who owns the data. The nightly digest reports that share separately for
--   exactly that reason.
--
-- THIS ACCRUES UNATTENDED, and that is deliberate under the autonomy rule.
-- The worst case if it fires wrongly is that we pay a crew a trip fee they
-- did not earn — small, clawback-able, and invisible to the customer. That is
-- a very different thing from putting money on somebody's card, which is why
-- the customer-facing half of 0089 still waits for a person.

-- ------------------------------------------------------------- the dial ----
-- Flat to start. If travel turns out to vary enough between lakes to matter,
-- that is a second column, not a rewrite.
insert into public.platform_settings (key, value) values
  ('crew_trip_fee', '35'::jsonb)
on conflict (key) do nothing;

-- --------------------------------------------------- a third kind of pay ----
-- Rides the rails that already exist: `status='released'` with a null
-- `batch_id` is what the month-end sweep picks up, so a trip fee reaches the
-- crew through the same batch as their job earnings with no new plumbing.
alter table public.payouts drop constraint if exists payouts_kind_check;
alter table public.payouts add constraint payouts_kind_check
  check (kind in ('earning', 'adjustment', 'trip'));

alter table public.payouts drop constraint if exists payouts_amount_sign;
alter table public.payouts add constraint payouts_amount_sign
  check ((kind in ('earning', 'trip') and amount >= 0)
      or (kind = 'adjustment' and amount <= 0));

-- ------------------------------------------------- one trip, one payment ----
alter table public.job_visit_attempts
  add column if not exists trip_fee_payout_id uuid references public.payouts(id) on delete set null;

comment on column public.job_visit_attempts.trip_fee_payout_id is
  'The payout raised for THIS attempt. Set once; the accrual only ever looks '
  'for attempts where it is null, which is what stops a retried sweep or a '
  'double-tap paying the same trip twice. A job attempted, rescheduled and '
  'attempted again is TWO trips and is paid twice, correctly — so the guard '
  'is per attempt, never per job.';

-- `payouts_one_earning_per_job` is deliberately untouched: it constrains
-- kind='earning' only, so trip rows never collide with a job's real pay.

-- ------------------------------------------------------ post-conditions ----
do $$
declare n int; ok boolean; pid uuid; jid uuid; vid uuid;
begin
  select count(*) into n from public.platform_settings where key = 'crew_trip_fee';
  if n <> 1 then raise exception '0090: the crew_trip_fee dial is missing'; end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='job_visit_attempts'
     and column_name='trip_fee_payout_id';
  if n <> 1 then raise exception '0090: job_visit_attempts.trip_fee_payout_id missing'; end if;

  select id into jid from public.jobs limit 1;
  select id into vid from public.vendors limit 1;
  if jid is null or vid is null then return; end if;

  insert into public.payouts (vendor_id, job_id, amount, original_amount, status, kind)
  values (vid, jid, 35, 35, 'released', 'trip') returning id into pid;

  ok := false;
  begin
    insert into public.payouts (vendor_id, job_id, amount, original_amount, status, kind)
    values (vid, jid, -35, -35, 'released', 'trip');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0090: a negative trip fee was accepted'; end if;

  -- A SECOND trip on the same job must be allowed: a job can be attempted,
  -- rescheduled, and attempted again, and each trip is real.
  ok := true;
  begin
    insert into public.payouts (vendor_id, job_id, amount, original_amount, status, kind)
    values (vid, jid, 35, 35, 'released', 'trip');
  exception when unique_violation then ok := false;
  end;
  if not ok then
    raise exception '0090: a second trip payout on one job was refused — a job can be attempted twice';
  end if;

  ok := false;
  begin
    insert into public.payouts (vendor_id, job_id, amount, original_amount, status, kind)
    values (vid, jid, 10, 10, 'released', 'nonsense');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0090: an unknown payout kind was accepted'; end if;

  delete from public.payouts where kind = 'trip' and job_id = jid;
end $$;
