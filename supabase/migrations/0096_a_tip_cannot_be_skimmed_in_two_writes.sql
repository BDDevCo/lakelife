-- 0096 — A TIP CANNOT BE SKIMMED IN TWO WRITES.
--
-- 0091's trigger checks that a tip payout equals `jobs.tip_amount` at the
-- moment the payout is written. It never looks at the job again, so the guard
-- is defeatable by reversing the order:
--
--   1. write the payout for the full $50   -> passes
--   2. raise jobs.tip_amount to $80        -> nothing re-checks the payout
--
-- The customer is charged $80, the crew keeps $50, and every screen agrees
-- because each write was individually legal. The same hole in reverse lets a
-- tip be lowered after payout.
--
-- So the job side is guarded too: once a tip is recorded it is IMMUTABLE,
-- including back to null. That is also just true of the thing itself — a
-- thank-you already given is not a number somebody gets to revise, and a
-- genuine correction is a refund, with its own record, not an edit.

create or replace function public.guard_tip_is_immutable()
returns trigger language plpgsql as $function$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if old.tip_amount is null then return new; end if;          -- the first answer
  if new.tip_amount is not distinct from old.tip_amount then return new; end if;

  raise exception
    'jobs: a tip is not editable once given (% -> %). Refund it if it was wrong — an edit would leave the payout behind.',
    old.tip_amount, new.tip_amount;
end $function$;

drop trigger if exists trg_guard_tip_is_immutable on public.jobs;
create trigger trg_guard_tip_is_immutable
  before update on public.jobs
  for each row execute function public.guard_tip_is_immutable();

-- ------------------------------------------------------ post-conditions ----
-- The proof writes real rows, so it runs inside a SUBTRANSACTION rolled back
-- by a sentinel exception. A post-condition that leaves a tipped job behind in
-- production would be a worse bug than the one it proves fixed. (The first
-- draft of this block was refused by its own new trigger while cleaning up,
-- which is how the pattern got here.)
do $$
declare jid uuid; vid uuid; ok boolean;
begin
  select id into jid from public.jobs where tip_amount is null limit 1;
  select id into vid from public.vendors limit 1;
  if jid is null or vid is null then return; end if;

  begin
    update public.jobs set tip_amount = 50, tipped_at = now() where id = jid;
    insert into public.payouts (vendor_id, job_id, amount, original_amount, status, kind)
    values (vid, jid, 50, 50, 'released', 'tip');

    ok := false;
    begin
      update public.jobs set tip_amount = 80 where id = jid;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0096 FAIL: a tip was raised after its payout'; end if;

    ok := false;
    begin
      update public.jobs set tip_amount = 20 where id = jid;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0096 FAIL: a tip was lowered after payout'; end if;

    ok := false;
    begin
      update public.jobs set tip_amount = null, tipped_at = null where id = jid;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0096 FAIL: a tip was erased after payout'; end if;

    -- Unrelated updates to the same row must still work, or the guard is a wall.
    update public.jobs set slot = slot where id = jid;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
