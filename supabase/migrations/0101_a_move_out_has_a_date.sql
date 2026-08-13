-- 0101 — A MOVE-OUT HAS A DATE.
--
-- `endTenancy` wrote `{ status }` and nothing else. The tenancy's date range
-- was never trimmed, and the charge run bills only `approved` or `active` —
-- so a household leaving on 20 August had exactly two possible outcomes, and
-- both are wrong:
--
--   BILLED THE WHOLE MONTH, with no way back. Voiding the charge makes the
--   month permanently unbillable, because the tenancy is now 'ended' and drops
--   out of every future run. The corrected 20-day bill can never be raised.
--
--   NEVER BILLED AT ALL for the twenty days they lived there, with nothing on
--   any screen saying so. No task, no nightly finding, no arrears — the money
--   simply is not there and nobody is told.
--
-- This is the only defect on the park gap list that DESTROYS money rather than
-- merely failing to collect it, and at 21 lots the first turnover is a matter
-- of weeks.
--
-- The arithmetic already existed: `buildStatement` prorates from the stay
-- range and has since it was written (statement-helpers.ts — `days` over
-- `daysInMonth`). Nothing ever trimmed the range to feed it.
--
-- ALSO HERE: notice to vacate, so "who is leaving" is answerable BEFORE the
-- day it happens rather than on it. A park owner with two weeks' warning can
-- show the lot; one with none has a vacancy he learns about from a departing
-- truck.

alter table public.lot_reservations
  -- The LAST DAY THEY LIVED THERE. Distinct from the range end, which is
  -- exclusive: somebody whose last day is 20 August has `during` ending on
  -- the 21st. Storing the human date separately means no screen has to know
  -- that, and "left 20 August" is never off by one.
  add column if not exists moved_out_on date,
  -- Notice given, and the day they SAY they are going. Expected, not actual —
  -- people change their minds, and the actual is `moved_out_on` above.
  add column if not exists notice_given_on date,
  add column if not exists expected_move_out date;

comment on column public.lot_reservations.moved_out_on is
  'The last day the household actually lived here. Set together with trimming '
  '`during`, and the flag that makes an ended tenancy billable for its final '
  'part-month: the charge run bills an ended stay ONLY when this is set, so a '
  'tenancy ended by the old one-click path can never start billing again.';

comment on column public.lot_reservations.expected_move_out is
  'What they told us when they gave notice. Never used to bill — the bill '
  'follows `moved_out_on` and the trimmed range, because people leave on a '
  'different day than they said.';

-- A move-out before the tenancy began is a typo, not a fact.
alter table public.lot_reservations drop constraint if exists lot_res_move_out_is_within;
alter table public.lot_reservations add constraint lot_res_move_out_is_within
  check (moved_out_on is null or moved_out_on >= lower(during));

-- Notice cannot be given for a day before the notice itself.
alter table public.lot_reservations drop constraint if exists lot_res_notice_before_leaving;
alter table public.lot_reservations add constraint lot_res_notice_before_leaving
  check (expected_move_out is null or notice_given_on is null
         or expected_move_out >= notice_given_on);

create index if not exists lot_res_leaving_idx
  on public.lot_reservations (expected_move_out)
  where expected_move_out is not null and status in ('approved', 'active');

-- ------------------------------------------------------ post-conditions ----
do $$
declare lot uuid; rid uuid; ok boolean; lo date; hi date;
begin
  select id into lot from public.park_lots limit 1;
  if lot is null then return; end if;

  begin
    insert into public.lot_reservations (park_lot_id, during, status, quoted_amount)
    values (lot, daterange('2026-01-01','2027-01-01','[)'), 'active', 500)
    returning id into rid;

    -- 1. THE POINT: trimming to a 20 August move-out leaves 20 days in August.
    update public.lot_reservations
       set during = daterange(lower(during), date '2026-08-21', '[)'),
           moved_out_on = date '2026-08-20',
           status = 'ended'
     where id = rid;

    select lower(during), upper(during) into lo, hi from public.lot_reservations where id = rid;
    if hi <> date '2026-08-21' then
      raise exception '0101: the range was not trimmed (upper = %)', hi;
    end if;
    -- August days covered = 21 - 1 = 20.
    if (least(hi, date '2026-09-01') - greatest(lo, date '2026-08-01')) <> 20 then
      raise exception '0101: expected 20 billable days in August, got %',
        (least(hi, date '2026-09-01') - greatest(lo, date '2026-08-01'));
    end if;

    -- 2. A move-out before the tenancy started is refused.
    ok := false;
    begin
      update public.lot_reservations set moved_out_on = date '2025-12-31' where id = rid;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0101: a move-out before the start was accepted'; end if;

    -- 3. Notice for a day before the notice was given is refused.
    ok := false;
    begin
      update public.lot_reservations
         set notice_given_on = date '2026-08-01', expected_move_out = date '2026-07-01'
       where id = rid;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0101: notice to leave BEFORE the notice was accepted'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
