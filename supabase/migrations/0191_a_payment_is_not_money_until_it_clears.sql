-- 0191 — A PAYMENT IS NOT MONEY UNTIL IT CLEARS.
--
-- Every stamp park_payments carries is a stamp for something going WRONG after
-- the fact: reversed_at (it never arrived), returned_at (it arrived and the
-- bank took it back), renter_confirmed_at (the household agrees). There was no
-- way to say the ordinary thing — that the money has been asked for and has
-- not landed yet. A payment was money the instant the row was written.
--
-- That is correct for every rail this park has ever used. Cash is in the
-- drawer. A cheque is in the office's hand, and a bounce is returned_at's job
-- weeks later. A card capture moved real money, and a chargeback is the same.
--
-- IT IS CATASTROPHIC FOR A BANK DEBIT, which is the rail the whole business
-- case rests on: ACH at ~0.8% capped against ~2.9% + 30c on a card, which on
-- The Haven's twenty lots is the difference between ~$230 and ~$3,848 a year.
-- An ACH debit SUCCEEDS and then reverses three to five business days later —
-- insufficient funds, account closed — long after the receipt said "Paid in
-- full".
--
-- PROVEN ON PRODUCTION BEFORE THIS MIGRATION EXISTED, in a rolled-back DO
-- block: one ACH row, initiated and nowhere near cleared, reported
--
--     bill_status=paid  paid_total=542.53  claim=matched
--
-- so a debit that had not cleared marked the bill paid AND conceded the
-- household's open "I paid this in cash" claim as matched — retiring their own
-- statement about money they had handed over, on the strength of money that
-- had not arrived. If it then bounced, receipt #1 said paid in full, the
-- disagreement was closed, and nothing in the product disagreed.
--
-- docs/processor-questions.md §1 names this as the actual build and whose it
-- is: "real ACH needs a pending -> cleared -> (or returned) state... That is
-- the actual build, it is ours and not the processor's, and it cannot be
-- designed until we know what they send us." The mechanism is ours and is
-- below. The POLICY — what a return does to a receipt, to standing, to a crew
-- already paid out of that money — is still deliberately unbuilt, because it
-- needs the processor's return codes and event names.
--
-- WHY A TIMESTAMP AND NOT A STATUS COLUMN. Four reasons, and the last is the
-- one that matters. (a) Every other lifecycle fact on this table is a one-way
-- timestamp, and 0173 freezes each one; a fifth of the same shape inherits
-- that discipline. (b) "When did it clear" is the question a settlement report
-- is reconciled against, and a status word cannot answer it. (c) A status text
-- would overlap reversed_at and returned_at — the same fact with two writers,
-- which is how 0188 got written. (d) A column with a default asserts a fact:
-- defaulting settled_at to now() would say every ACH row cleared the moment it
-- was keyed, which is the exact lie this migration exists to remove. So it is
-- stamped by a trigger from the rail, where the rule can be read.
--
-- NOTHING IN JANUARY CHANGES. Every rail that exists today settles on arrival,
-- so paid_total, the claim triggers and every screen behave exactly as they did
-- — and the backfill below stamps existing rows with when they were keyed,
-- not with now(), so no historical payment is re-dated.

-- ---------------------------------------------------- 1. the rail's own rule --
--
-- ONE HOME, so the database and the application cannot disagree about which
-- rails are provisional. IMMUTABLE so a CHECK can call it.
--
-- `ach` is the only rail that clears later. A cheque is NOT on this list and
-- that is deliberate: the office physically holds it, the existing model treats
-- it as arrived, and a bounce is returned_at. Moving cheques onto the
-- provisional rail would change what happens in January, which nothing here is
-- allowed to do.

create or replace function public.payment_settles_on_arrival(method text)
returns boolean language sql immutable as $$
  select coalesce(method, '') <> 'ach'
$$;

comment on function public.payment_settles_on_arrival(text) is
  'Which rails are money the moment they are recorded. Everything but ACH: '
  'cash is in the drawer, a cheque is in the hand, a card capture moved real '
  'money, and each of those has returned_at for the day it goes wrong.';

alter table public.park_payments
  add column if not exists settled_at timestamptz;

comment on column public.park_payments.settled_at is
  'When the money actually landed. NULL means asked for and not yet arrived, '
  'which only an ACH debit can be. Nothing counts toward a bill until this is '
  'set (park_charge_paid_total), and 0173 makes it one-way.';

-- ------------------------------------------- 2. the backfill, before the CHECK --
--
-- `created_at`, not now(). These payments DID settle, and they settled when
-- they were keyed — stamping them with this migration's clock would assert
-- that every payment the park has ever taken cleared in October 2026, which is
-- a worse untruth than the one being fixed. Production holds zero payment rows
-- today; this is for any environment that holds some.

update public.park_payments
   set settled_at = created_at
 where settled_at is null
   and public.payment_settles_on_arrival(method);

-- A rail that settles on arrival can never be unsettled. Written after the
-- backfill so it is true of every existing row.
alter table public.park_payments
  drop constraint if exists park_payments_arrival_rails_have_settled;
alter table public.park_payments
  add constraint park_payments_arrival_rails_have_settled
  check (settled_at is not null or not public.payment_settles_on_arrival(method));

-- ----------------------------------------------- 3. the stamp, from the rail --
--
-- Derived, never defaulted, and never left to the caller: six application doors
-- write this table and a seventh is coming for the processor. A caller that
-- forgot would silently create money; a caller that lied would un-fix this
-- migration. So the rail decides, and an insert that arrives already cleared on
-- a rail that cannot have cleared is refused by name — the same idiom as
-- "a payment does not arrive already handed back".

create or replace function public.stamp_payment_settlement()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if public.payment_settles_on_arrival(new.method) then
    new.settled_at := coalesce(new.settled_at, now());
  elsif new.settled_at is not null then
    raise exception
      'park_payments: a % payment has not cleared the moment it is keyed — record it, and stamp it settled when the bank says so',
      new.method;
  end if;
  return new;
end $$;

revoke all on function public.stamp_payment_settlement() from public, anon, authenticated;

drop trigger if exists trg_stamp_payment_settlement on public.park_payments;
create trigger trg_stamp_payment_settlement
  before insert on public.park_payments
  for each row execute function public.stamp_payment_settlement();

-- --------------------------------------- 4. what counts as money toward a bill --
--
-- THE ONE PLACE THE QUESTION IS ASKED, in two parallel clauses — a payment
-- straight against the bill, and money on account allocated to it. Both learn
-- the same word, because a reader that learned it and a writer that did not is
-- how 0188 happened.
--
-- Unchanged in every other respect from 0169's version: void is zero, refunds
-- come off the payment, and a reversed or returned payment counts for nothing.

create or replace function public.park_charge_paid_total(target uuid)
returns numeric language sql stable security definer set search_path to 'public'
as $$
  select coalesce((
    select case
      when c.status = 'void' then 0::numeric(10,2)
      else (
        coalesce((
          select sum(p.amount - coalesce((select sum(x.amount) from public.park_refunds x where x.payment_id = p.id), 0))
            from public.park_payments p
           where p.charge_id = target
             and p.reversed_at is null
             and p.returned_at is null
             and p.settled_at is not null
        ), 0)
        +
        coalesce((
          select sum(a.amount)
            from public.park_payment_allocations a
            join public.park_payments p on p.id = a.payment_id
           where a.charge_id = target
             and a.removed_at is null
             and p.reversed_at is null
             and p.returned_at is null
             and p.settled_at is not null
        ), 0)
      )::numeric(10,2)
    end
    from public.park_charges c
   where c.id = target
  ), 0)::numeric(10,2)
$$;

-- --------------------------------------------- 5. the bill hears about it --
--
-- THE HALF THAT WOULD HAVE BEEN FORGOTTEN. Without this the money clears and
-- the bill never notices: settled_at moves, nothing recomputes, and the
-- household stays in arrears for a debit that landed. Same shape as the
-- reversed/returned clause this sits beside, and the allocation loop below it
-- matters for exactly the same reason — a cleared payment's allocations are
-- money now.

create or replace function public.sync_charge_paid()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare target uuid;
begin
  perform public.recompute_charge_paid(coalesce(new.charge_id, old.charge_id));
  -- A payment moved from one charge to another has to settle BOTH. The old
  -- function only ever recomputed one of them.
  if tg_op = 'UPDATE' and new.charge_id is distinct from old.charge_id then
    perform public.recompute_charge_paid(old.charge_id);
  end if;
  -- MONEY ON ACCOUNT THAT HAD BEEN PUT AGAINST BILLS. Whether it still counts
  -- changed, so every bill it touched is recomputed. settled_at joins the list
  -- (0191): it is the one that turns money ON rather than off.
  if tg_op = 'UPDATE'
     and (new.reversed_at is distinct from old.reversed_at
          or new.returned_at is distinct from old.returned_at
          or new.settled_at is distinct from old.settled_at
          or new.amount is distinct from old.amount) then
    for target in
      select a.charge_id from public.park_payment_allocations a
       where a.payment_id = new.id and a.removed_at is null
    loop
      perform public.recompute_charge_paid(target);
    end loop;
  end if;
  return null;
end $$;

-- ------------------------------------- 6. a claim is conceded by money, not a try --
--
-- 0074's rule is that recording a payment against a disputed bill "closes the
-- disagreement by conceding it, not by overruling it". An ACH debit that has
-- been asked for is not a concession of anything: the household said they
-- handed over cash, and until the debit clears nobody has found that cash and
-- no other money has arrived either. Conceding on it would retire their
-- statement on the strength of a request.
--
-- So the trigger waits for the money, and now fires on settlement too — else a
-- claim conceded by an ACH would stay open for ever once it cleared.

create or replace function public.settle_claims_on_payment()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  -- Money on account settles nothing until it is against a bill.
  if new.charge_id is null then return null; end if;
  -- AND NOTHING IS CONCEDED BY A PAYMENT THAT HAS NOT LANDED (0191).
  if new.settled_at is null then return null; end if;

  update public.park_payment_claims
     set resolved_at = now(),
         resolution = 'matched',
         resolution_note = 'A payment was recorded against this bill.'
   where charge_id = new.charge_id
     and resolved_at is null;
  return null;
end $$;

drop trigger if exists trg_settle_claims_on_payment on public.park_payments;
create trigger trg_settle_claims_on_payment
  after insert or update of charge_id, settled_at on public.park_payments
  for each row execute function public.settle_claims_on_payment();

-- ------------------------------------------------- 7. the stamp is one-way --
create or replace function public.park_payment_is_the_row_it_was()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare moved text;
begin
  -- WHAT ARRIVED. Named one at a time, because "the ledger refused it" is not
  -- a sentence anybody in an office can act on — `dbSaid` strips the table
  -- prefix and shows the rest, so each of these reaches the screen as English.
  moved := case
    when new.amount          is distinct from old.amount          then 'the amount'
    when new.received_on     is distinct from old.received_on     then 'the day it arrived'
    when new.method          is distinct from old.method          then 'how it was paid'
    when new.kind            is distinct from old.kind            then 'what it was for'
    when new.reference       is distinct from old.reference       then 'the cheque or transfer reference'
    when new.note            is distinct from old.note            then 'the note that went on the receipt'
    when new.fee_amount      is distinct from old.fee_amount      then 'the card fee'
    when new.park_id         is distinct from old.park_id         then 'the park it belongs to'
    when new.receipt_no      is distinct from old.receipt_no      then 'the receipt number'
    when new.drop_slip_no    is distinct from old.drop_slip_no    then 'the drop-slip number'
    when new.confirm_token   is distinct from old.confirm_token   then 'the confirmation link'
    when new.idempotency_key is distinct from old.idempotency_key then 'the key that stops it being keyed twice'
    -- CREATED_AT IS FROZEN BECAUSE A CHECK CONSTRAINT MEASURES AGAINST IT.
    -- park_payments_received_on_is_sane pins received_on to a window either
    -- side of created_at. A lone move of created_at is already refused (it
    -- breaks the pair from the other side), but a rule that holds only while
    -- nobody takes two steps is not a rule; freezing both ends it.
    when new.created_at      is distinct from old.created_at      then 'when it was keyed'
    when new.id              is distinct from old.id              then 'the row''s own id'
    else null
  end;
  if moved is not null then
    raise exception
      'park_payments: % of a payment is not edited — money received stays the row it was. Take it back (it never arrived), hand it back, or refund it, and record what really happened as its own row',
      moved;
  end if;

  -- THE THREE THE DATABASE ITSELF NULLS. Deleting a household file, a user
  -- account or an amenity booking sets these to NULL by FK, and that write
  -- must not be refused — but pointing the money at a DIFFERENT household is
  -- exactly the edit this table exists to prevent.
  if new.renter_id is distinct from old.renter_id and new.renter_id is not null then
    raise exception 'park_payments: whose money this is was settled when it was recorded — it is not moved to another household';
  end if;
  if new.recorded_by is distinct from old.recorded_by and new.recorded_by is not null then
    raise exception 'park_payments: who took this money in is part of the record — the only hand that changes it is the database''s, when that account is deleted';
  end if;
  if new.amenity_booking_id is distinct from old.amenity_booking_id and new.amenity_booking_id is not null then
    raise exception 'park_payments: the booking this money was for is part of the record — it is not moved to another booking';
  end if;

  -- ---- THE FIVE STAMPS. Nothing, then something, once, for ever. ----------

  -- A REVERSAL SAYS THE MONEY NEVER ARRIVED, AND CANNOT BE UNSAID. This is the
  -- hole that mattered most: an allocation survives a reversal as record, so
  -- clearing reversed_at made every bill that cheque had settled read paid
  -- again, and nobody would ever be chased for it.
  if old.reversed_at is not null then
    if new.reversed_at     is distinct from old.reversed_at
    or new.reversed_reason is distinct from old.reversed_reason
    or new.reversed_by     is distinct from old.reversed_by then
      raise exception
        'park_payments: that payment was taken back on % — a reversal is recorded once. Unsaying it would make every bill it had settled read paid again',
        to_char(old.reversed_at, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.reversed_at is null
    and (new.reversed_reason is distinct from old.reversed_reason
      or new.reversed_by     is distinct from old.reversed_by) then
    raise exception 'park_payments: that is a reason for a reversal that has not happened — take the payment back, or leave the row alone';
  end if;

  -- MONEY HANDED BACK ACROSS THE WINDOW (0168). The existing guard already
  -- refuses a second hand-back; the note that says WHY was left changeable,
  -- and in six months that note is the only record of the reason.
  if old.returned_on is not null then
    if new.returned_on     is distinct from old.returned_on
    or new.returned_amount is distinct from old.returned_amount
    or new.return_note     is distinct from old.return_note then
      raise exception
        'park_payments: % of that payment was handed back on % — a hand-back is recorded once, the reason it carries included',
        coalesce(old.returned_amount::text, 'some'), to_char(old.returned_on, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.returned_on is null and new.return_note is distinct from old.return_note then
    raise exception 'park_payments: that is a reason for a hand-back that has not happened — record the hand-back itself, or leave the row alone';
  end if;

  -- THE BANK SAID IT NEVER SETTLED (0155). No door writes this yet; the one
  -- that is coming writes it once, and no later hand turns a returned ACH back
  -- into money the park has.
  if old.returned_at is not null then
    if new.returned_at  is distinct from old.returned_at
    or new.return_code  is distinct from old.return_code then
      raise exception
        'park_payments: the bank returned that payment on % — a return is recorded once, and it cannot be unsaid',
        to_char(old.returned_at, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.returned_at is null and new.return_code is distinct from old.return_code then
    raise exception 'park_payments: a return code with no return behind it — record the return itself, or leave the row alone';
  end if;

  -- THE HOUSEHOLD SAID THEY HANDED IT OVER. Their word about their own money;
  -- the office does not get to take it back or restate how it was given.
  if old.renter_confirmed_at is not null then
    if new.renter_confirmed_at  is distinct from old.renter_confirmed_at
    or new.renter_confirmed_via is distinct from old.renter_confirmed_via then
      raise exception
        'park_payments: the household confirmed that payment on % — their confirmation is theirs, and it is recorded once',
        to_char(old.renter_confirmed_at, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.renter_confirmed_at is null
    and new.renter_confirmed_via is distinct from old.renter_confirmed_via then
    raise exception 'park_payments: a how with no confirmation behind it — record the confirmation itself, or leave the row alone';
  end if;

  -- IT CLEARED (0191). THE FIFTH STAMP, AND THE ONLY ONE THAT IS GOOD NEWS:
  -- the money is really in the account. One-way like the other four, and for
  -- the same shape of reason the reversal clause gives — un-settling a payment
  -- would make every bill it had settled read unpaid again, and the household
  -- would be chased for money the park has already been handed.
  if old.settled_at is not null then
    if new.settled_at is distinct from old.settled_at then
      raise exception
        'park_payments: that payment cleared on % — settlement is recorded once, and unsaying it would put the household back in arrears for money the park has',
        to_char(old.settled_at, 'FMDDth FMMonth YYYY');
    end if;
  -- AND MONEY THAT DID NOT STAND CANNOT ALSO HAVE CLEARED. A reversal says it
  -- never arrived and a bank return says it arrived and went back; either way
  -- the ledger must not hold "it cleared" beside them.
  elsif new.settled_at is not null
    and (new.reversed_at is not null or new.returned_at is not null) then
    raise exception 'park_payments: that payment did not stand — it cannot also have cleared';
  end if;

  return new;
end $$;

comment on function public.park_payment_is_the_row_it_was() is
  'Freezes everything a payment records about what arrived, and makes each of '
  'its five stamps — settlement, reversal, hand-back, bank return, household '
  'confirmation — one-way. charge_id is left to guard_park_payment, which has '
  'the better sentence for it.';

-- ------------------------------------------------- the proof, rolled back --
--
-- A real park, lot, tenancy, household, bill and an open cash claim, the way
-- 0169, 0173 and 0190 prove their own guards: everything inside one DO block
-- that raises at the end, so nothing survives.
--
-- COLLAPSED BOTH WAYS throughout. A change that simply stopped all money
-- counting would pass step 2 on its own, so step 1 proves cash still works and
-- step 3 proves the money arrives when it clears. The "before" numbers quoted
-- in the header came from this same block run against production with none of
-- the above in place: bill_status=paid, paid_total=542.53, claim=matched.

do $$
declare
  pid uuid; lot uuid; res uuid; ren uuid; chg uuid; cl uuid; pay uuid;
  st text; paid numeric; claim_res text; settled timestamptz; ok boolean;
begin
  insert into public.parks (name, slug, cutover_date)
  values ('0191 proof', '0191-proof-' || gen_random_uuid()::text, date '2026-09-01')
  returning id into pid;
  insert into public.park_lots (park_id, lot_number, site_type, lifecycle)
  values (pid, '7', 'mh_single', 'live') returning id into lot;
  insert into public.park_renters (park_id, display_name)
  values (pid, '0191 proof household') returning id into ren;
  insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
  values (lot, ren, daterange(date '2026-10-01', date '2026-11-01', '[)'), 'monthly', 'active')
  returning id into res;
  insert into public.park_charges
    (park_id, park_lot_id, renter_id, reservation_id, period_month, due_on, amount, status)
  values (pid, lot, ren, res, '2026-10', date '2026-10-01', 542.53, 'open')
  returning id into chg;

  -- 1. CASH IS STILL MONEY THE MOMENT IT IS KEYED. If this breaks, January
  --    breaks: every dollar at The Haven arrives as cash or a cheque.
  insert into public.park_payments (park_id, charge_id, renter_id, amount, method, received_on)
  values (pid, chg, ren, 542.53, 'cash', current_date) returning id into pay;
  select status, paid_total into st, paid from public.park_charges where id = chg;
  select settled_at into settled from public.park_payments where id = pay;
  if st <> 'paid' or paid <> 542.53 or settled is null then
    raise exception '0191 FAILED: cash no longer settles on arrival (status=%, paid=%, settled=%)', st, paid, settled;
  end if;

  -- Reset to an open bill for the ACH half.
  update public.park_payments set reversed_at = now(), reversed_reason = 'proof reset' where id = pay;
  select status, paid_total into st, paid from public.park_charges where id = chg;
  if st <> 'open' or paid <> 0 then
    raise exception '0191 FAILED: the reset did not reopen the bill (status=%, paid=%)', st, paid;
  end if;

  -- The household says they handed over cash, and nobody has answered.
  insert into public.park_payment_claims (charge_id, claimed_amount, claimed_paid_on, asserted_by)
  values (chg, 542.53, current_date - 3, 'renter') returning id into cl;

  -- 2. AN ACH DEBIT, ASKED FOR AND NOT LANDED. This is the whole migration.
  insert into public.park_payments (park_id, charge_id, renter_id, amount, method, reference, received_on)
  values (pid, chg, ren, 542.53, 'ach', 'ach-proof-001', current_date) returning id into pay;
  select status, paid_total into st, paid from public.park_charges where id = chg;
  select resolution into claim_res from public.park_payment_claims where id = cl;
  select settled_at into settled from public.park_payments where id = pay;
  if settled is not null then
    raise exception '0191 FAILED: an ACH debit was stamped as cleared on arrival';
  end if;
  if st = 'paid' or paid <> 0 then
    raise exception '0191 FAILED: an uncleared ACH debit still paid the bill (status=%, paid=%)', st, paid;
  end if;
  if claim_res is not null then
    raise exception '0191 FAILED: an uncleared ACH debit conceded the household''s claim as %', claim_res;
  end if;

  -- 3. AND WHEN THE BANK SAYS IT CLEARED, the money arrives — the bill is paid
  --    and the disagreement closes, both without anybody touching them.
  update public.park_payments set settled_at = now() where id = pay;
  select status, paid_total into st, paid from public.park_charges where id = chg;
  select resolution into claim_res from public.park_payment_claims where id = cl;
  if st <> 'paid' or paid <> 542.53 then
    raise exception '0191 FAILED: a cleared ACH debit did not reach the bill (status=%, paid=%)', st, paid;
  end if;
  if claim_res is distinct from 'matched' then
    raise exception '0191 FAILED: a cleared ACH debit did not answer the claim (resolution=%)', coalesce(claim_res, 'still open');
  end if;

  -- 4. SETTLEMENT IS RECORDED ONCE.
  ok := false;
  begin
    update public.park_payments set settled_at = now() + interval '1 day' where id = pay;
  exception when others then ok := (sqlerrm like '%settlement is recorded once%');
  end;
  if not ok then raise exception '0191 FAILED: a settled payment was re-stamped'; end if;

  -- 5. AND AN ACH ROW CANNOT ARRIVE ALREADY CLEARED.
  ok := false;
  begin
    insert into public.park_payments (park_id, charge_id, renter_id, amount, method, reference, received_on, settled_at)
    values (pid, chg, ren, 1.00, 'ach', 'ach-proof-002', current_date, now());
  exception when others then ok := (sqlerrm like '%has not cleared the moment it is keyed%');
  end;
  if not ok then raise exception '0191 FAILED: an ACH row was accepted as already cleared'; end if;

  raise exception '0191 proof complete — rolling back';
exception when others then
  if sqlerrm <> '0191 proof complete — rolling back' then
    raise;
  end if;
end $$;
