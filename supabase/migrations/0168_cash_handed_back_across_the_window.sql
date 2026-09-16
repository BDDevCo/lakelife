-- 0168 — CASH HANDED BACK ACROSS THE WINDOW IS ITS OWN RECORD.
--
-- A household leaves with money of theirs still on account. Lot 9 pays $600
-- by cheque on 5 January for a $542.53 bill; the $57.47 sits on account; they
-- move out on the 27th and January was their last month. Nothing will ever
-- bill for them again, the office hands the $57.47 back across the window —
-- and the ledger has no way to write that down.
--
-- ============ WHAT THE LEDGER COULD SAY UNTIL NOW ============
--
-- Three acts existed for money going out, and every one is wrong for this:
--
--   A REVERSAL (0081) says the money never arrived. reversePayment takes both
--   halves of the cheque back — the $542.53 against January and the $57.47 on
--   account — because it is one cheque (0167 § 20). January reads outstanding
--   again on Today, on the roll and on the resident's own page, for a
--   household who paid it and has gone. The standing rule is that money
--   received stays the row it was; this is the only path the screen offered.
--
--   A REFUND (0142, 0155) goes back through the processor. guard_park_refund
--   refuses anything but card and ACH by name, and its own comment says why:
--   "Cash and cheques are handed back across a window by a person. That is a
--   different act with a different record." This is that record.
--
--   A DEPOSIT'S RETURN (0102, 0103) is exactly the right shape — a stamp on
--   the row: returned_on, returned_amount, return_note — and
--   park_payments_return_is_sane fences it to kind = 'deposit'. Verified on
--   production in a rolled-back block before this was written: a hand-back
--   stamped on a rent row is refused by that CHECK, a park_refunds row for it
--   is refused by guard_park_refund, and only the reversal is accepted.
--
-- ============ THE STAMP, WIDENED TO RENT ON ACCOUNT ============
--
-- The deposit's three columns carry the hand-back on a rent row too, under
-- the same rules the deposit has and three of its own:
--
--   ONLY MONEY ON ACCOUNT. A rent row against a bill (charge_id set) is that
--   bill's money; its exits are the reversal and, for card money, the refund.
--
--   ONLY CASH, CHEQUE, A BANK PUSH OR "OTHER". Card and ACH money goes back
--   through the processor that took it (0142); a hand-back stamped on a card
--   row would be the park's own money going out a second time.
--
--   NEVER MORE THAN IS STILL ON ACCOUNT. The ceiling is park_payment_remaining
--   — what is left after live allocations and refunds — read under the row
--   lock the UPDATE already holds. $57.47 of a $600 split can go back; $600
--   cannot, because $542.53 of it is January's.
--
--   ONCE. A second stamp is refused. A wrong hand-back is a correction with a
--   reason, the way every other correction here is, and there is none yet: a
--   hand-back recorded wrongly is handled at the window and named in a note.
--
--   A REASON, ALWAYS. 0103 asked for one only when part of a deposit was
--   KEPT — the rest of a deposit going back is its ordinary end. A rent
--   hand-back is never ordinary: the household is owed nothing by default, so
--   the note says why the money went back ("moved out 27 January; nothing
--   more bills"). The kept-deposit rule is scoped to deposits so the two
--   cannot be confused: on a $600 split, handing back the $57.47 on account
--   is not keeping $542.53 of anything.
--
--   AND A HANDED-BACK PAYMENT CANNOT BE REVERSED. Reversal says the money
--   never arrived; the record says some of it went back out. The ledger
--   would hold both facts. Refused for deposits and rent alike (the JS door
--   already refused the deposit case; the database did not).
--
-- ============ ONE CHANGE THAT FLOWS TO EVERY READER ============
--
-- park_payment_remaining subtracts what was handed back. That is the one
-- definition of "what is left on a payment" (0167 § 2), and every reader
-- asks it: the held-money panel's bold figure, the resident's on-account
-- card, refundableOn's ceiling, undoImport's held count, the cash statement's
-- "still held", the run's and every payment door's settlement plan, and the
-- allocation guard's ceiling. Nothing in JavaScript subtracts. The view
-- carries the stamp beside the row as `handed_back`, `handed_back_on` and
-- `handed_back_note`, so a screen can say "$57.47 went back to them on
-- January 28, 2027 — moved out; nothing more bills" from the database's own
-- columns: a reason the form demands and no screen reads back is the
-- deposit's old defect, not repeated here.
--
-- ============ PROVEN BEFORE IT SHIPPED ============
--
-- The whole of sections 1–4 was run on production (15 September 2026) inside
-- one DO block against The Haven's real Lot 9 — the walked case, a $600
-- cheque split $542.53 against January and $57.47 on account — and rolled
-- back by raising at the end. Every refusal below fired by name; the
-- hand-back landed with remaining 0.00, handed_back 57.47 and its note on
-- the view; January stayed paid at 542.53; a second stamp, a reversal of
-- either half and a card hand-back were refused; a deposit behaved exactly
-- as before. The post-conditions at the foot repeat that proof on a fixture
-- park each time this file is applied.
--
-- ============ WHAT THIS DELIBERATELY DOES NOT DO ============
--
-- It does not decide whether the resident is TOLD the money is owed back to
-- them, or whether a park may hold money on account against damages the way
-- it may keep part of a deposit. Neither has a door here; both are the
-- owner's. It sends nothing. And it does not touch guard_park_refund: card
-- and ACH money cannot be handed back, so the refund ceiling never meets a
-- returned_amount.

-- ------------------------------------------------ 1. the stamp widens --

alter table public.park_payments drop constraint if exists park_payments_return_is_sane;
alter table public.park_payments add constraint park_payments_return_is_sane
  check (
    (returned_on is null and returned_amount is null)
    or (
      (kind = 'deposit' or (kind = 'rent' and charge_id is null))
      and returned_on is not null
      and returned_amount is not null
      and returned_amount > 0
      and returned_amount <= amount
    )
  );

-- KEEPING PART OF A DEPOSIT needs a reason (0103) — deposits only now.
alter table public.park_payments drop constraint if exists park_payments_kept_deposit_has_a_reason;
alter table public.park_payments add constraint park_payments_kept_deposit_has_a_reason
  check (
    returned_on is null
    or kind <> 'deposit'
    or returned_amount = amount
    or coalesce(btrim(return_note), '') <> ''
  );

-- HANDING RENT BACK needs a reason, whatever the amount.
alter table public.park_payments drop constraint if exists park_payments_hand_back_has_a_reason;
alter table public.park_payments add constraint park_payments_hand_back_has_a_reason
  check (
    returned_on is null
    or kind <> 'rent'
    or coalesce(btrim(return_note), '') <> ''
  );

comment on column public.park_payments.returned_on is
  'The day the park handed money back across the window: a deposit (0102) or '
  'rent on account (0168). NOT returned_at, which is the bank pulling a card or '
  'ACH payment back. Written once; a handed-back payment cannot be reversed.';

-- ------------------------------ 2. what is left subtracts the hand-back --

create or replace function public.park_payment_remaining(p_payment uuid)
returns numeric language sql stable security definer set search_path to 'public'
as $$
  select greatest(
    0,
    p.amount
      - coalesce((select sum(a.amount) from public.park_payment_allocations a
                   where a.payment_id = p.id and a.removed_at is null), 0)
      - coalesce((select sum(r.amount) from public.park_refunds r where r.payment_id = p.id), 0)
      - coalesce(p.returned_amount, 0)
  )::numeric(10,2)
    from public.park_payments p
   where p.id = p_payment
$$;

revoke all on function public.park_payment_remaining(uuid) from public, anon, authenticated;

-- --------------------------------- 3. the view carries the stamp too --
--
-- Columns are appended (CREATE OR REPLACE VIEW may only add at the end), so
-- every existing select by name reads exactly what it read before.

create or replace view public.park_on_account_payments as
select p.id            as payment_id,
       p.park_id,
       p.renter_id,
       p.amount,
       p.received_on,
       p.created_at,
       p.method,
       p.reference,
       p.receipt_no,
       p.note,
       p.idempotency_key,
       coalesce((select sum(a.amount) from public.park_payment_allocations a
                  where a.payment_id = p.id and a.removed_at is null), 0)::numeric(10,2) as allocated,
       coalesce((select sum(r.amount) from public.park_refunds r where r.payment_id = p.id), 0)::numeric(10,2) as refunded,
       public.park_payment_remaining(p.id) as remaining,
       coalesce(p.returned_amount, 0)::numeric(10,2) as handed_back,
       p.returned_on as handed_back_on,
       p.return_note as handed_back_note
  from public.park_payments p
 where p.kind = 'rent'
   and p.charge_id is null
   and p.reversed_at is null
   and p.returned_at is null;

comment on view public.park_on_account_payments is
  'Money on account (0102: kind rent, no charge, still standing) with how much '
  'of it has been put against bills (allocated), sent back through the '
  'processor (refunded), handed back across the window (handed_back, its day '
  'and its reason, 0168) and how much is still held (remaining, from '
  'park_payment_remaining). Readers '
  'that mean "still held" filter remaining > 0; the cash statement wants every '
  'row received in its window regardless.';

revoke all on public.park_on_account_payments from public, anon, authenticated;

-- ------------------------------------------ 4. the guard on the stamp --
--
-- Unchanged from 0167 apart from the two hand-back blocks. A CHECK cannot
-- read the allocations, so the ceiling lives here; every refusal names its
-- rule because the JavaScript door says the same thing in a sentence first
-- and the post-conditions below match on the text.

create or replace function public.guard_park_payment()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare st text; left_on_payment numeric(10,2);
begin
  if tg_op = 'UPDATE' and new.charge_id is not null and old.charge_id is null then
    raise exception 'park_payments: money on account is put against a bill through park_payment_allocations, not by moving the payment';
  end if;

  -- unchanged from 0081
  select status into st from public.park_charges where id = new.charge_id;
  if st = 'void' then
    raise exception 'park_payments: that charge was voided — record the payment against a live one';
  end if;

  -- A HAND-BACK IS AN ACT ON MONEY THAT ARRIVED. A row cannot arrive already
  -- handed back, and the stamp is written once.
  if tg_op = 'INSERT' and (new.returned_on is not null or new.returned_amount is not null) then
    raise exception 'park_payments: a payment does not arrive already handed back';
  end if;
  if tg_op = 'UPDATE'
     and old.returned_on is not null
     and (new.returned_on is distinct from old.returned_on
          or new.returned_amount is distinct from old.returned_amount) then
    raise exception 'park_payments: that money was already handed back on % — a hand-back is recorded once', old.returned_on;
  end if;
  if tg_op = 'UPDATE' and new.returned_on is not null and old.returned_on is null and new.kind = 'rent' then
    if new.charge_id is not null then
      raise exception 'park_payments: money against a bill is not handed back — reverse it, or refund it if it came by card';
    end if;
    if new.method in ('card', 'ach') then
      raise exception 'park_payments: a % payment goes back through the processor — refund it, do not hand it back', new.method;
    end if;
    if new.reversed_at is not null or new.returned_at is not null then
      raise exception 'park_payments: that payment is not standing — there is nothing of theirs to hand back';
    end if;
    -- THE CEILING, LIVE: what is still on account after allocations and
    -- refunds, read off the row as it stands before this update lands.
    left_on_payment := public.park_payment_remaining(new.id);
    if new.returned_amount > left_on_payment then
      raise exception 'park_payments: only % of that payment is still on account, and this would hand back %', left_on_payment, new.returned_amount;
    end if;
  end if;

  if tg_op = 'UPDATE' and new.reversed_at is not null and old.reversed_at is null then
    -- THE LIE 0142 EXISTS TO END. Reversing says the money never arrived. On a
    -- card or ACH payment it demonstrably did, and the office would be told
    -- "taken back" while the cardholder's statement disagrees.
    if new.method in ('card', 'ach') then
      raise exception 'park_payments: a % payment moved real money — refund it, do not reverse it', new.method;
    end if;
    -- And a payment some of which has already gone back cannot also be
    -- declared never to have happened; the ledger would hold both facts.
    if exists (select 1 from public.park_refunds r where r.payment_id = new.id) then
      raise exception 'park_payments: part of that payment has already been refunded — a reversal would contradict the refund record';
    end if;
    -- Same fact, the other door out: money handed back across the window
    -- demonstrably arrived. Deposits and rent alike.
    if old.returned_on is not null then
      raise exception 'park_payments: % of that payment was already handed back on % — a reversal would contradict the record', old.returned_amount, old.returned_on;
    end if;
  end if;

  return new;
end $$;

-- ------------------------------------------------------ post-conditions ---
--
-- SHIP-TIME ASSERTIONS, NOT STANDING GUARDS. This block runs once, now, on a
-- fixture park, and rolls itself back. It proves the rules bite on real rows
-- — the walked case: a $600 cheque split $542.53 against January and $57.47
-- on account, the household gone — and that nothing about a deposit moved.
-- Assertions match on the TEXT of the refusal, for the reason 0142 gives.

do $$
declare
  lid uuid; pid uuid; lot uuid; ren uuid;
  jan uuid; feb uuid; acct uuid; direct uuid; dep uuid; card uuid; quarter uuid;
  n numeric; hb numeric; st text; ok boolean; cnt integer; d date;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0168: no lake to hang a fixture on — post-conditions skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active, cutover_date)
    values ('0168 Proof', '1 Rd', '0168-proof', lid, 'mh', false, date '2020-01-01')
    returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid, '9', true, 'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid, '0168 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange(date '2020-01-01', null), 'monthly', 'active', 400);
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date, 'YYYY-MM'), current_date, 542.53, 'open')
    returning id into jan;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date + 31, 'YYYY-MM'), current_date + 31, 542.53, 'open')
    returning id into feb;

    -- THE SPLIT recordPayment writes: $542.53 against January, $57.47 on account.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, idempotency_key)
    values (pid, ren, jan, 542.53, 'check', current_date, '0168-split')
    returning id into direct;
    insert into public.park_payments (park_id, renter_id, charge_id, kind, amount, method, received_on, idempotency_key)
    values (pid, ren, null, 'rent', 57.47, 'check', current_date, '0168-split:onaccount')
    returning id into acct;
    select remaining into n from public.park_on_account_payments where payment_id = acct;
    if n <> 57.47 then raise exception '0168: remaining is % before the hand-back, expected 57.47', n; end if;

    -- 1. A PAYMENT DOES NOT ARRIVE ALREADY HANDED BACK.
    ok := false;
    begin
      insert into public.park_payments (park_id, renter_id, charge_id, kind, amount, method, received_on, returned_on, returned_amount, return_note)
      values (pid, ren, null, 'rent', 10, 'cash', current_date, current_date, 10, 'born returned');
    exception when others then ok := (sqlerrm like '%does not arrive already handed back%');
    end;
    if not ok then raise exception '0168: a payment arrived already handed back'; end if;

    -- 2. MORE THAN IS ON ACCOUNT IS REFUSED, BY THE CEILING.
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 57.48, return_note = 'moved out' where id = acct;
    exception when others then ok := (sqlerrm like '%only 57.47 of that payment is still on account%');
    end;
    if not ok then raise exception '0168: a hand-back exceeded what was on account'; end if;

    -- 3. NO REASON, NO HAND-BACK — even for the whole amount.
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 57.47 where id = acct;
    exception when others then ok := (sqlerrm like '%park_payments_hand_back_has_a_reason%');
    end;
    if not ok then raise exception '0168: rent went back with no reason on the record'; end if;

    -- 4. THE BILL'S HALF CANNOT BE HANDED BACK.
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 1, return_note = 'x' where id = direct;
    exception when others then ok := (sqlerrm like '%money against a bill is not handed back%' or sqlerrm like '%park_payments_return_is_sane%');
    end;
    if not ok then raise exception '0168: money against a bill was handed back'; end if;

    -- 5. THE HAND-BACK LANDS: remaining 0, the view says what went back and when,
    --    January still reads paid, and the allocation ceiling now finds nothing.
    update public.park_payments
       set returned_on = current_date, returned_amount = 57.47, return_note = 'moved out; nothing more bills'
     where id = acct;
    select remaining, handed_back, handed_back_on into n, hb, d from public.park_on_account_payments where payment_id = acct;
    if n <> 0 then raise exception '0168: remaining is % after the hand-back, expected 0', n; end if;
    if hb <> 57.47 or d <> current_date then raise exception '0168: the view reads handed_back %/% after the hand-back', hb, d; end if;
    select paid_total, status into n, st from public.park_charges where id = jan;
    if n <> 542.53 or st <> 'paid' then raise exception '0168: January reads %/% after the on-account half went back', n, st; end if;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, acct, feb, 0.01, 'office');
    exception when others then ok := (sqlerrm like '%only 0.00 is left on that payment%');
    end;
    if not ok then raise exception '0168: handed-back money was put against a bill'; end if;

    -- 6. ONCE. A second stamp is refused by name.
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 1, return_note = 'again' where id = acct;
    exception when others then ok := (sqlerrm like '%already handed back on%');
    end;
    if not ok then raise exception '0168: rent was handed back twice'; end if;

    -- 7. A HANDED-BACK PAYMENT CANNOT BE REVERSED — the statement reversePayment
    --    issues over both halves of the split reaches neither.
    ok := false;
    begin
      update public.park_payments set reversed_at = now(), reversed_reason = 'the cheque bounced'
       where id in (direct, acct) and park_id = pid and reversed_at is null;
    exception when others then ok := (sqlerrm like '%already handed back on%');
    end;
    if not ok then raise exception '0168: a handed-back payment was reversed'; end if;
    select count(*) into cnt from public.park_payments where id in (direct, acct) and reversed_at is not null;
    if cnt <> 0 then raise exception '0168: the refused reversal still reached % row(s)', cnt; end if;

    -- 8. PART OF A CHEQUE GOES BACK, THE REST STAYS FOR THE NEXT BILL.
    insert into public.park_payments (park_id, renter_id, charge_id, kind, amount, method, received_on)
    values (pid, ren, null, 'rent', 600, 'cash', current_date)
    returning id into quarter;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, quarter, feb, 542.53, 'office');
    update public.park_payments set returned_on = current_date, returned_amount = 40, return_note = 'overpaid; $40 back' where id = quarter;
    select remaining into n from public.park_on_account_payments where payment_id = quarter;
    if n <> 17.47 then raise exception '0168: remaining is % after a partial hand-back, expected 17.47', n; end if;

    -- 9. CARD MONEY IS NOT HANDED BACK — it is refunded through the processor.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, reference, kind)
    values (pid, ren, null, 100, 'card', current_date, 'ch_mock_0168', 'rent')
    returning id into card;
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 100, return_note = 'x' where id = card;
    exception when others then ok := (sqlerrm like '%goes back through the processor%');
    end;
    if not ok then raise exception '0168: a card payment was handed back by hand'; end if;

    -- 10. A DEPOSIT IS EXACTLY AS IT WAS: returned in full with no note, part
    --     kept only with a reason, and a returned deposit cannot be reversed.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren, null, 500, 'cash', current_date, 'deposit')
    returning id into dep;
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 300 where id = dep;
    exception when others then ok := (sqlerrm like '%park_payments_kept_deposit_has_a_reason%');
    end;
    if not ok then raise exception '0168: part of a deposit was kept with no reason'; end if;
    update public.park_payments set returned_on = current_date, returned_amount = 500 where id = dep;
    select returned_amount into n from public.park_payments where id = dep;
    if n <> 500 then raise exception '0168: a full deposit return with no note was refused'; end if;
    ok := false;
    begin
      update public.park_payments set reversed_at = now(), reversed_reason = 'typo' where id = dep;
    exception when others then ok := (sqlerrm like '%already handed back on%');
    end;
    if not ok then raise exception '0168: a returned deposit was reversed'; end if;

    -- 11. NO CLIENT ROLE READS THE VIEW OR THE REMAINDER DIRECTLY (0167's rule, kept).
    if has_table_privilege('authenticated', 'public.park_on_account_payments', 'SELECT')
       or has_function_privilege('authenticated', 'public.park_payment_remaining(uuid)', 'EXECUTE') then
      raise exception '0168: a client role can read the on-account view or remainder directly';
    end if;

    raise exception 'ROLLBACK_0168_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_0168_PROOF' then raise; end if;
  end;
end $$;
