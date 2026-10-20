-- 0199 — A RETURNED REFERRAL PAYOUT COULD NEVER BE PAID AGAIN.
--
-- From the money-rails audit, 17 October 2026. Two separate paths strand the
-- same money, and the reason both do is that the money had no way to name the
-- batch that was carrying it.
--
-- ============ A REFERRAL BATCH HAS NO `payouts` ROWS ============
--
-- A job payout is a `payouts` row that a batch claims by id, so freeing it is
-- one update: `batch_id = null`, and the next month-end run picks it up. That
-- is exactly what `markBatchesReturned` does, and its own comment calls it
-- "the half that lets the crew be paid again".
--
-- A REFERRAL batch is not shaped like that. The referral run creates a
-- `payout_batches` row with `kind = 'referral'` and **no payouts rows at
-- all** — the `referral_earnings` ARE the money, flipped from 'matured' to
-- 'paid' as they are gathered. So:
--
--   `markBatchesReturned` frees `payouts` where `batch_id` matches. For a
--   referral batch that matches NOTHING. The batch goes to 'failed', the
--   earnings stay 'paid', and the next run reads only `status = 'matured'`.
--   The money is never seen again, and the crew is told by nobody.
--
--   The nightly stranded-batch sweep does the same thing by cron: a referral
--   run that crashed mid-assembly leaves a 'building' batch, the sweep
--   unclaims `payouts` (none), deletes the batch, and leaves the earnings at
--   'paid' pointing at nothing.
--
-- ============ WHY A COLUMN AND NOT JUST A WIDER UPDATE ============
--
-- The obvious fix — on return, reopen every 'paid' earning for that batch's
-- payee — CANNOT BE WRITTEN, because nothing records which earnings went in
-- which batch. `referral_earnings` holds beneficiary, amount, status and two
-- timestamps. A payee with three months of successful payouts behind them has
-- older 'paid' rows that must stay paid, and nothing distinguishes them from
-- the ones in the batch that just bounced.
--
-- The unwind inside the referral run itself only works because it holds
-- `flippedIds` in memory for the length of one loop. The moment the process
-- ends, that knowledge is gone — which is precisely why the two paths above
-- could not do it.
--
-- ============ 'paid' IS REACHED TWO WAYS, SO THE LINK IS NULLABLE ============
--
-- A customer's earning that matures is settled as account CREDITS and set to
-- 'paid' with no batch anywhere (`CREDIT_SETTLED_STATUS` in automation.ts). So
-- "paid implies a batch" is false and the column must stay nullable. What IS
-- true, and what the CHECK enforces, is the other direction: a batch link only
-- means anything on a row that is paid. Status and link move together — the
-- shape 0181 uses for its three settlement columns, for the same reason: a
-- link with no payment behind it is a name attached to nothing.
--
-- ============ NOTHING TO BACKFILL ============
--
-- Checked on production before this was written: `referral_earnings` holds 0
-- rows and `payout_batches` holds 0 of kind 'referral'. So there is no
-- stranded money today — this closes the hole before the first referral is
-- ever earned, which is the only time it is free to close.

alter table public.referral_earnings
  -- ON DELETE SET NULL, because the stranded-batch sweep DELETES a batch that
  -- never finished assembling. The row must survive that; what must not
  -- survive it is the row still claiming to be paid, which is why the sweep is
  -- changed in the same commit to reopen the earning rather than rely on this.
  add column if not exists payout_batch_id uuid
    references public.payout_batches(id) on delete set null;

comment on column public.referral_earnings.payout_batch_id is
  'Which payout batch carried this earning out, so a returned or stranded '
  'batch can hand the money back to ''matured'' and let the next run pay it. '
  'NULL on an earning settled as account credits, which reaches ''paid'' with '
  'no batch at all.';

create index if not exists referral_earnings_batch_idx
  on public.referral_earnings (payout_batch_id)
  where payout_batch_id is not null;

-- A LINK ONLY MEANS ANYTHING ON A PAID ROW. Reopening therefore clears both at
-- once, and a row cannot sit at 'matured' still naming the batch that failed
-- to carry it.
alter table public.referral_earnings
  drop constraint if exists referral_earnings_batch_only_when_paid;
alter table public.referral_earnings
  add constraint referral_earnings_batch_only_when_paid
  check (payout_batch_id is null or status = 'paid');

-- ---------------------------------------------------------------------------
-- POST-CONDITIONS — every probe rolls back
-- ---------------------------------------------------------------------------
do $$
declare
  uid uuid; vid uuid; batch uuid; earn uuid; ok boolean; n integer; t text := '';
  st text; link uuid;
begin
  select id into uid from public.users where role = 'ops' order by created_at limit 1;
  if uid is null then
    raise notice '0199: no user to probe with';
    return;
  end if;

  -- (a) NOTHING IS STRANDED TODAY. If this ever fails, a backfill is needed
  --     and this migration is not enough on its own.
  select count(*) into n from public.referral_earnings where status = 'paid';
  if n <> 0 then
    raise notice '0199: % earning(s) are already paid and carry no batch link — check whether any are stranded', n;
  end if;

  begin
    insert into public.payout_batches (user_id, kind, status, gross, fee, net)
    values (uid, 'referral', 'building', 0, 0, 0) returning id into batch;

    insert into public.referral_earnings (beneficiary, kind, amount, status, accrued_at, matured_at)
    values (uid, 'crew_referral', 25.00, 'matured', now(), now()) returning id into earn;
    t := t || '[a matured earning created] ';

    -- (b) THE LINK AND THE STATUS MOVE TOGETHER. A link on a matured row is
    --     refused, which is what stops a reopened earning still naming the
    --     batch that dropped it.
    ok := false;
    begin
      update public.referral_earnings set payout_batch_id = batch where id = earn;
    exception when check_violation then ok := true;
    end;
    t := t || format('[b link on a matured row refused=%s] ', ok);
    if not ok then raise exception '0199: a matured earning was allowed to name a batch'; end if;

    -- (c) PAID WITH ITS BATCH IS ACCEPTED, in one write.
    update public.referral_earnings
       set status = 'paid', payout_batch_id = batch
     where id = earn and status = 'matured';
    select status, payout_batch_id into st, link from public.referral_earnings where id = earn;
    t := t || format('[c paid with batch=%s] ', link is not null);
    if st <> 'paid' or link is null then raise exception '0199: the flip did not record its batch'; end if;

    -- (d) THE RETURN PATH CAN NOW FIND ITS OWN MONEY — which was the whole
    --     defect. Scoped by the batch, so another month's paid rows are safe.
    declare older uuid; begin
      insert into public.referral_earnings (beneficiary, kind, amount, status, accrued_at, matured_at)
      values (uid, 'crew_referral', 99.00, 'matured', now(), now()) returning id into older;
      update public.referral_earnings set status = 'paid' where id = older;  -- credit-settled: no batch

      update public.referral_earnings
         set status = 'matured', payout_batch_id = null
       where payout_batch_id = batch and status = 'paid';

      select status into st from public.referral_earnings where id = earn;
      t := t || format('[d returned earning reopened=%s] ', st);
      if st <> 'matured' then raise exception '0199: a returned earning was not reopened'; end if;

      select status into st from public.referral_earnings where id = older;
      t := t || format('[d credit-settled row untouched=%s] ', st);
      if st <> 'paid' then raise exception '0199: an unrelated paid earning was reopened'; end if;
    end;

    -- (e) AND A DELETED BATCH DOES NOT TAKE THE EARNING WITH IT.
    update public.referral_earnings set status = 'paid', payout_batch_id = batch where id = earn;
    delete from public.payout_batches where id = batch;
    select count(*) into n from public.referral_earnings where id = earn;
    select payout_batch_id into link from public.referral_earnings where id = earn;
    t := t || format('[e earning survives a deleted batch=%s link=%s] ', n = 1, coalesce(link::text, 'null'));
    if n <> 1 then raise exception '0199: deleting a batch deleted the money'; end if;
    if link is not null then raise exception '0199: the link outlived its batch'; end if;

    raise notice '0199 PROBE_ROLLBACK: %', t;
    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  select count(*) into n from public.referral_earnings;
  if n <> 0 then raise exception '0199: % probe earning(s) survived', n; end if;

  raise notice '0199: a referral earning now names the batch carrying it, so a returned or stranded batch can hand the money back.';
end $$;
