-- 0092 — A FEE IN FLIGHT HAS A NAME.
--
-- `chargeProposedFee` shipped tonight writing only `recovery_state =
-- 'fee_charged'` and telling ops "Fee of $151.00 recorded." Nothing was ever
-- billed. The row left the queue, every screen read "charged" forever, and
-- `raiseTripFees` treated that state as COLLECTED CASH — so it also understated
-- how much LakeLife was funding out of its own pocket.
--
-- The fix charges the card for real, which needs an intermediate state: two
-- ops tabs and two clicks must be settled BEFORE any money moves, and the only
-- safe way to do that is to claim the row first and charge second.
--
--   fee_proposed  --claim-->  fee_charging  --charged-->  fee_charged
--                                  |
--                                  +--declined--> fee_proposed (back on the queue)
--
-- A stuck `fee_charging` is deliberately NOT auto-resolved. It means a charge
-- was attempted and the process died mid-flight, which is exactly the case a
-- person must look at — the alternative is a sweep that either double-charges
-- a card or writes off money nobody checked.

alter table public.jobs drop constraint if exists jobs_recovery_state_is_known;
alter table public.jobs add constraint jobs_recovery_state_is_known
  check (recovery_state is null or recovery_state in
    ('awaiting_customer','rescheduled','fee_proposed','fee_charging','fee_charged','fee_waived'));

comment on column public.jobs.recovery_state is
  'Where an unworked visit has got to: awaiting_customer -> rescheduled | '
  'fee_proposed -> fee_charging -> fee_charged | fee_waived. '
  'fee_charging means a card charge is IN FLIGHT — it is a claim, held for the '
  'moment between deciding and knowing. A row stuck there needs a human.';

do $$
declare ok boolean; jid uuid;
begin
  select id into jid from public.jobs limit 1;
  if jid is null then return; end if;

  update public.jobs set recovery_state = 'fee_charging' where id = jid;
  update public.jobs set recovery_state = 'fee_proposed', fee_proposed_amount = 10 where id = jid;
  update public.jobs set recovery_state = 'fee_charged' where id = jid;
  update public.jobs set recovery_state = 'fee_waived' where id = jid;

  ok := false;
  begin
    update public.jobs set recovery_state = 'charged_probably' where id = jid;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0092: an unknown recovery_state was accepted'; end if;

  update public.jobs set recovery_state = null, fee_proposed_amount = null where id = jid;
end $$;
