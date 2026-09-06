-- 0155 — A RETURN IS NOT A REFUND, AND A SURCHARGE CAN GO BACK ALONE.
--
-- Two things that break on the day LAKELIFE_PAYMENTS_LIVE is set to true.
--
-- ============ 1. A WRONGLY SURCHARGED HOUSEHOLD CANNOT BE MADE WHOLE ============
--
-- 0142 shipped `park_refunds.amount check (amount > 0)`. Verified on
-- production before this was written:
--
--   park_refunds_amount_check | CHECK ((amount > (0)::numeric))
--
-- The card surcharge is separate money, charged ON TOP of the rent and
-- deliberately never folded into `amount` (0109). It follows that returning it
-- on its own is a real and ordinary act: the rent was right, the 3% was not.
-- Network rules forbid surcharging a DEBIT card in every state, so the first
-- time this is needed it will be needed for a rule we broke, on a household
-- who did nothing wrong.
--
-- With `amount > 0` there is no way to do it. The office would have to send
-- back rent nobody disputed just to reach the fee — a second error to undo the
-- first. So the floor moves to zero and the REAL rule is stated instead: a
-- refund has to move some money.
--
--   check (amount >= 0 and amount + fee_amount > 0)
--
-- `refundCents` (app/park/refund-helpers.ts) already asks the processor for
-- `amount + fee_amount` as one figure, because that is how the money left, so
-- nothing about the processor call changes.
--
-- ============ 2. AN ACH RETURN HAS NO LAWFUL DOOR INTO THE LEDGER ============
--
-- An ACH debit succeeds, and three to five business days later the bank pulls
-- it back — insufficient funds, a closed account, an unauthorised debit. The
-- money that arrived is gone again, and nothing about that is our decision.
--
-- Everything in this ledger today assumes a payment is final the moment it is
-- recorded. The three acts we have are all wrong for it:
--
--   A REVERSAL says it never happened. 0142 makes the database refuse this for
--   card and ACH, and rightly: the money DID move, and the household's own
--   statement shows both legs.
--
--   A REFUND says we are sending it back. Doing that here sends money OUT a
--   second time, out of the park's own account, against a debit that never
--   settled.
--
--   DELETING THE ROW makes it vanish, taking the receipt number with it.
--
-- So a return is a THIRD act, and it gets its own two columns. A returned
-- payment stays on the record, keeps its receipt, and stops counting.
--
-- ============ WHAT THIS DELIBERATELY DOES NOT DECIDE ============
--
-- Nothing here says what a return means for the resident: whether their
-- receipt is withdrawn, whether the reopened bill is late from its original
-- due date, whether a returned payment costs them a fee or their standing to
-- pay online again. Those are the owner's decisions and they are not encoded
-- anywhere in this file. This builds the MECHANISM — the money stops counting,
-- the record survives, and a refund against it is refused.
--
-- ============ NOTHING IN THE APP WRITES `returned_at` YET ============
--
-- There is no processor webhook endpoint in this repo (src/app/api holds cron,
-- ics, ops and verify, and nothing else). The writer is the webhook that does
-- not exist. That is the honest state, and it is why the column is nullable
-- with no default and no app path to it — but every READER is in place, so the
-- day the webhook lands nothing else has to be remembered. The reverse order —
-- a writer with no readers — is how this codebase produced a dozen columns
-- that changed nothing.
--
-- ============ `returned_at` IS NOT `returned_on` ============
--
-- park_payments already carries `returned_on` / `returned_amount` /
-- `return_note` from 0102 and 0103. Those are a SECURITY DEPOSIT going back to
-- a departing tenant: the park choosing to hand money over. `returned_at` is
-- the bank taking money back without asking. One letter apart, opposite
-- directions, and both live on the same row. Every reader of either has been
-- checked (app/park/money-actions.ts).

-- ------------------------------------------ 1. the surcharge floor moves --

alter table public.park_refunds
  drop constraint if exists park_refunds_amount_check;

alter table public.park_refunds
  add constraint park_refunds_amount_check
  check (amount >= 0 and amount + fee_amount > 0);

comment on column public.park_refunds.amount is
  'Rent returned, in dollars. May be 0 when only the card surcharge is going '
  'back — a debit-card surcharge applied in error is returned on its own, and '
  'the rent it sat on top of is untouched. The row still has to move money: '
  'amount + fee_amount > 0.';

-- ------------------------------------------------- 2. the bank took it back --

alter table public.park_payments
  add column if not exists returned_at timestamptz,
  add column if not exists return_code text;

comment on column public.park_payments.returned_at is
  'The bank pulled this money back after it had settled — an ACH return or a '
  'card chargeback. NOT returned_on, which is a security deposit the park '
  'handed back to a departing tenant. A returned payment keeps its row and its '
  'receipt number and stops counting toward anything: recompute_charge_paid '
  'excludes it, getHeldMoney excludes it, and guard_park_refund refuses a '
  'refund against it. Written only by a processor webhook; no app path exists '
  'to it today.';

comment on column public.park_payments.return_code is
  'The processor''s own reason code for the return (ACH returns carry one — '
  'R01 insufficient funds, R02 account closed, R10 unauthorised). Free text '
  'because the vocabulary belongs to the processor and we have not chosen one '
  'yet. Meaningless without returned_at, which the constraint below enforces.';

-- A code with no return is a fact about nothing. The reverse is allowed: some
-- processors report a return without a code, and refusing the row would mean
-- losing the return itself over a missing label.
alter table public.park_payments
  drop constraint if exists park_payments_return_code_needs_a_return;
alter table public.park_payments
  add constraint park_payments_return_code_needs_a_return
  check (return_code is null or returned_at is not null);

-- ONLY THE MONEY THAT CANNOT BE REVERSED. Cash, cheques and hand-to-hand
-- transfers already have an honest act — `reversed_at` — and 0142 leaves it
-- open to them precisely because nothing left anybody's account. Card and ACH
-- are the two the database refuses to reverse, so they are exactly the two
-- that need a third word for this.
alter table public.park_payments
  drop constraint if exists park_payments_only_electronic_is_returned;
alter table public.park_payments
  add constraint park_payments_only_electronic_is_returned
  check (returned_at is null or method in ('card', 'ach'));

-- Small and partial: the answer to "what has come back" is a handful of rows
-- out of every payment the park has ever taken.
create index if not exists park_payments_returned_idx
  on public.park_payments (park_id, returned_at desc)
  where (returned_at is not null);

-- RLS IS NOT THE GRANT. Supabase hands the client roles table-level DML by
-- default, and `returned_at` REDUCES a bill's paid_total — a resident who
-- could write it could erase their own rent. park_payments carries only SELECT
-- for anon and authenticated today; this states it rather than assuming it,
-- and is a no-op when it is already true.
revoke insert, update, delete on public.park_payments from authenticated, anon;

-- --------------------------- 3. returned money stops counting on a bill ----
--
-- Unchanged from 0142 apart from one line. A returned payment is dropped from
-- the sum exactly as a reversed one is, so the charge goes back to `open` and
-- the arrears figure, the statement and the overdue list all move together —
-- there is no second number here to get out of step with the first.

create or replace function public.recompute_charge_paid(target uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare total numeric(10,2); owed numeric(10,2); cur_status text;
begin
  if target is null then return; end if;

  select c.amount, c.status into owed, cur_status
    from public.park_charges c where c.id = target
    for update;
  if not found then return; end if;

  select coalesce(sum(p.amount - coalesce(r.given_back, 0)), 0) into total
    from public.park_payments p
    left join lateral (
      select sum(x.amount) as given_back
        from public.park_refunds x
       where x.payment_id = p.id
    ) r on true
   where p.charge_id = target
     and p.reversed_at is null
     -- THE BANK TOOK IT BACK. Without this the bill still reads PAID while the
     -- park's own account is short the money, and nobody finds out until a
     -- statement is reconciled by hand.
     and p.returned_at is null;

  update public.park_charges
     set paid_total = total,
         status = case
                    when cur_status = 'void' then 'void'
                    when total >= owed then 'paid'
                    else 'open'
                  end
   where id = target;
end $$;

revoke all on function public.recompute_charge_paid(uuid) from public, anon, authenticated;

-- A returned payment must also make the charge recompute when the webhook
-- stamps it. `sync_charge_paid` already fires on UPDATE of park_payments and
-- calls the function above, so no new trigger is needed — this comment exists
-- so the next person does not add a second one beside it.

-- ------------------------------- 4. and cannot be refunded on top of that --
--
-- Unchanged from 0142 apart from one field and one branch. The order matters:
-- a returned payment reads as "the bank took it back", never as "you have
-- already had it all", which is what the ceiling below would otherwise say
-- once recompute has moved the numbers around.

create or replace function public.guard_park_refund()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare pay record; given numeric(10,2); given_fee numeric(10,2);
begin
  -- FOR UPDATE IS LOAD-BEARING, NOT DECORATION. Two refunds submitted at the
  -- same moment would each read the same "already given back" total, each pass
  -- the ceiling check below, and together hand back more than was ever taken.
  -- Locking the payment row makes the second one wait and then see the first.
  select p.id, p.park_id, p.amount, p.fee_amount, p.method, p.reversed_at, p.returned_at
    into pay
    from public.park_payments p
   where p.id = new.payment_id
     for update;
  if not found then
    raise exception 'park_refunds: no such payment';
  end if;

  -- A RETURN IS NOT A REFUND. The debit never settled, so there is nothing of
  -- theirs to send back — this would be the park's own money going out.
  if pay.returned_at is not null then
    raise exception 'park_refunds: the bank returned that payment — it never settled, so it cannot also be refunded';
  end if;

  if pay.reversed_at is not null then
    raise exception 'park_refunds: that payment was reversed — it is recorded as never having arrived, so there is nothing to send back';
  end if;

  if new.park_id <> pay.park_id then
    raise exception 'park_refunds: the refund and the payment belong to different parks';
  end if;

  -- Cash and cheques are handed back across a window by a person. That is a
  -- different act with a different record, and routing it through a processor
  -- reference it does not have would put a fiction in the ledger.
  if pay.method not in ('card', 'ach') then
    raise exception 'park_refunds: only a card or ACH payment can be refunded through the processor (this one was %)', pay.method;
  end if;

  select coalesce(sum(r.amount), 0), coalesce(sum(r.fee_amount), 0)
    into given, given_fee
    from public.park_refunds r
   where r.payment_id = new.payment_id
     and r.id <> new.id;

  if given + new.amount > pay.amount then
    raise exception 'park_refunds: that would give back %, and only % was taken', given + new.amount, pay.amount;
  end if;
  if given_fee + new.fee_amount > coalesce(pay.fee_amount, 0) then
    raise exception 'park_refunds: that would give back more card fee than was charged';
  end if;

  return new;
end $$;

-- ------------------------------------------------------ post-conditions ---
--
-- SHIP-TIME ASSERTIONS, NOT STANDING GUARDS. This block runs once, now, and
-- cannot police the next migration. It proves the rules bite on real rows and
-- then rolls itself back so production is left holding nothing.
--
-- Several assertions match on the TEXT of the refusal, for the reason 0142
-- gives: a bare "it was refused" passes when some unrelated constraint refuses
-- first, which is how a test ends up proving nothing.

do $$
declare
  lid uuid; pid uuid; lot uuid; ren uuid; ch uuid; ch2 uuid;
  pay_card uuid; pay_ach uuid; pay_cash uuid; n numeric; st text; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0155: no lake to hang a fixture on — post-conditions skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active, cutover_date)
    values ('0155 Proof', '1 Rd', '0155-proof', lid, 'mh', false, date '2020-01-01')
    returning id into pid;

    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid, '1', true, 'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid, '0155 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange(date '2020-01-01', null), 'monthly', 'active', 400);

    -- Dates come from today because park_payments_received_on_is_sane pins
    -- received_on to within 730 days of created_at; a fixed past date ages
    -- into a failure. period_month is TEXT, '^\d{4}-\d{2}$'.
    insert into public.park_charges
      (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date, 'YYYY-MM'), current_date, 400, 'open')
    returning id into ch;

    -- park_payments_fee_is_sane: a surcharge exists only on a CARD payment.
    -- An ACH debit never carries one, so the two halves of this migration are
    -- proved on two different payments.
    insert into public.park_payments
      (park_id, renter_id, charge_id, amount, method, received_on, reference, kind, fee_amount)
    values (pid, ren, ch, 400, 'card', current_date, 'ch_mock_0155', 'rent', 12)
    returning id into pay_card;

    -- 1. THE BILL READS PAID, AS IT DID BEFORE.
    select paid_total, status into n, st from public.park_charges where id = ch;
    if n <> 400 or st <> 'paid' then
      raise exception '0155: paid_total/status is %/% after a full payment, expected 400/paid', n, st;
    end if;

    -- 2. A FEE-ONLY REFUND IS ACCEPTED, AND LEAVES THE RENT ALONE.
    insert into public.park_refunds (payment_id, park_id, amount, fee_amount, reason, processor_ref)
    values (pay_card, pid, 0, 12, 'surcharged a debit card in error', 'rf_mock_0155a');
    select paid_total, status into n, st from public.park_charges where id = ch;
    if n <> 400 or st <> 'paid' then
      raise exception '0155: a fee-only refund moved the bill to %/%, expected 400/paid', n, st;
    end if;

    -- 3. BUT A REFUND THAT MOVES NOTHING IS STILL REFUSED.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, fee_amount, reason, processor_ref)
      values (pay_card, pid, 0, 0, 'nothing at all', 'rf_mock_0155b');
    exception when others then ok := (sqlerrm like '%park_refunds_amount_check%');
    end;
    if not ok then raise exception '0155: a refund of nothing was accepted'; end if;

    -- 4. AND SO IS A NEGATIVE ONE — a charge wearing a refund's clothes.
    --    fee_amount 0, deliberately: with a fee on it the trigger's fee
    --    ceiling refuses first (all $12 has already gone back at step 2) and
    --    this would pass without ever reaching the constraint it names.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, fee_amount, reason, processor_ref)
      values (pay_card, pid, -1, 0, 'a charge in disguise', 'rf_mock_0155c');
    exception when others then ok := (sqlerrm like '%park_refunds_amount_check%');
    end;
    if not ok then raise exception '0155: a negative refund was accepted'; end if;

    -- 5. A SECOND BILL, PAID BY ACH — the money the bank takes back.
    insert into public.park_charges
      (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date + 40, 'YYYY-MM'), current_date + 40, 400, 'open')
    returning id into ch2;
    insert into public.park_payments
      (park_id, renter_id, charge_id, amount, method, received_on, reference, kind)
    values (pid, ren, ch2, 400, 'ach', current_date, 'ch_mock_0155ach', 'rent')
    returning id into pay_ach;
    select paid_total, status into n, st from public.park_charges where id = ch2;
    if n <> 400 or st <> 'paid' then
      raise exception '0155: an ACH debit left the bill at %/%, expected 400/paid', n, st;
    end if;

    -- 6. FOUR DAYS LATER THE BANK RETURNS IT, AND THE BILL STOPS READING PAID.
    update public.park_payments
       set returned_at = now(), return_code = 'R01'
     where id = pay_ach;
    select paid_total, status into n, st from public.park_charges where id = ch2;
    if n <> 0 or st <> 'open' then
      raise exception '0155: paid_total/status is %/% after a bank return, expected 0/open', n, st;
    end if;

    -- 7. AND IT CANNOT ALSO BE REFUNDED.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, fee_amount, reason, processor_ref)
      values (pay_ach, pid, 100, 0, 'refunding a return', 'rf_mock_0155d');
    exception when others then ok := (sqlerrm like '%never settled%');
    end;
    if not ok then raise exception '0155: a returned payment was refunded'; end if;

    -- 8. A RETURN CODE WITHOUT A RETURN IS NOT A FACT.
    insert into public.park_payments
      (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren, ch2, 50, 'cash', current_date, 'rent')
    returning id into pay_cash;
    ok := false;
    begin
      update public.park_payments set return_code = 'R01' where id = pay_cash;
    exception when others then ok := (sqlerrm like '%return_code_needs_a_return%');
    end;
    if not ok then raise exception '0155: a return code was accepted with no return'; end if;

    -- 9. CASH IS NOT RETURNED BY A BANK — it is reversed, which still works.
    ok := false;
    begin
      update public.park_payments set returned_at = now() where id = pay_cash;
    exception when others then ok := (sqlerrm like '%only_electronic_is_returned%');
    end;
    if not ok then raise exception '0155: a cash payment was marked bank-returned'; end if;
    update public.park_payments set reversed_at = now(), reversed_reason = 'miskeyed'
     where id = pay_cash;
    if (select reversed_at from public.park_payments where id = pay_cash) is null then
      raise exception '0155: a cash payment could no longer be reversed';
    end if;

    -- 10. NO CLIENT ROLE CAN STAMP A RETURN BY HAND.
    if has_table_privilege('authenticated', 'public.park_payments', 'UPDATE')
       or has_table_privilege('anon', 'public.park_payments', 'UPDATE') then
      raise exception '0155: a client role can update park_payments and so can erase its own rent';
    end if;

    raise exception 'ROLLBACK_0155_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_0155_PROOF' then raise; end if;
  end;
end $$;
