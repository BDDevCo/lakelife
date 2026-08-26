-- 0142 — A REFUND THAT REACHES THE CARD.
--
-- Money could go out of a household's account six ways and come back none.
--
-- `reversePayment` (ledger-actions.ts) stamps `reversed_at`, drops the amount
-- out of `sync_charge_paid`'s sum, and tells the office "$542.53 taken back".
-- It calls no processor. For a cheque that bounced that sentence is true — the
-- money never really arrived. FOR A CARD PAYMENT IT IS A LIE: the money moved,
-- the cardholder still has none of it back, and the ledger now says otherwise.
-- The product's own note says so out loud, at pay-actions.ts:79-82.
--
-- The other half of the gap is that the existing `refunds` table cannot hold
-- this. `refunds.invoice_id` is NOT NULL (0043) and points at the SERVICE
-- ledger — invoices, jobs, crew clawbacks. Rent is the park's money and 0108
-- deliberately built no bridge between the two. Widening `refunds` would be
-- that bridge. So park money gets its own record, exactly as park payments do.
--
-- ============ A REVERSAL AND A REFUND ARE DIFFERENT ACTS ============
--
-- A REVERSAL says *this never happened*: a bounced cheque, a payment keyed
-- against the wrong household, a typo at the window. Nothing leaves anybody's
-- account, because nothing arrived.
--
-- A REFUND says *it happened, and we are sending it back*. Real money moves,
-- outward, through the processor that took it.
--
-- Card and ACH payments are recorded by a machine and carry a processor
-- reference — 0108 refuses one without. They cannot be un-happened. So this
-- migration makes the database refuse to reverse them, and gives them the only
-- honest alternative instead.
--
-- ============ THE SURCHARGE IS SEPARATE MONEY ============
--
-- `park_payments.amount` is the rent. `fee_amount` is the card surcharge,
-- charged ON TOP and deliberately never folded into `amount` so that
-- paid_total and the arrears maths keep meaning what they meant before online
-- payments existed (0109). It follows that giving the rent back and giving the
-- surcharge back are two decisions, and the office makes the second one per
-- refund. There is no default, because a default here would assert a policy
-- nobody has set — and The Haven's `card_fee_pct` is 0.00 today, so any
-- default would go untested until the first park that charges one.
--
-- ============ NOTHING HERE MOVES MONEY BY ITSELF ============
--
-- A row in this table is a RECORD of a refund the processor already made. It
-- is refused without a processor reference, for the same reason 0108 refuses a
-- card payment without one: a money movement nobody can trace is not a record,
-- it is a rumour.

-- --------------------------------------------------------- 1. the record --

create table if not exists public.park_refunds (
  id             uuid primary key default gen_random_uuid(),
  payment_id     uuid not null references public.park_payments(id) on delete restrict,
  -- Carried rather than joined, exactly as park_payments carries park_id
  -- (0102). The read policy scopes on it, and the guard below refuses a row
  -- whose park disagrees with its payment's.
  park_id        uuid not null references public.parks(id) on delete restrict,
  amount         numeric(10,2) not null check (amount > 0),
  -- How much of the card surcharge went back with it. Zero is the common case
  -- and an explicit one: it means the office was asked and said no.
  fee_amount     numeric(10,2) not null default 0 check (fee_amount >= 0),
  reason         text not null check (btrim(reason) <> ''),
  -- The processor's own reference for the money going OUT. Not nullable: see
  -- the header. A row exists only once the money has actually left.
  processor_ref  text not null check (btrim(processor_ref) <> ''),
  idempotency_key text,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now()
);

comment on table public.park_refunds is
  'Money returned to a household through the processor that took it. One row '
  'per refund, append-only in practice: a refund is an EVENT, and a partial '
  'refund followed by another is two events, not an edited one. Rent money '
  'only — the service side has its own ledger in public.refunds, and 0108 '
  'keeps the two apart on purpose.';

comment on column public.park_refunds.fee_amount is
  'How much of park_payments.fee_amount (the card surcharge) was returned '
  'alongside the rent. Defaults to 0 and is set per refund by the office. '
  'There is no park-level policy column on purpose: a default would claim a '
  'decision nobody made.';

create index if not exists park_refunds_payment_idx on public.park_refunds(payment_id);
create index if not exists park_refunds_park_idx    on public.park_refunds(park_id, created_at desc);

-- A retried submit must not send the money twice. Same shape as 0081's key on
-- park_payments and 0043c's on refunds.
create unique index if not exists park_refunds_idempotency_idx
  on public.park_refunds (idempotency_key) where (idempotency_key is not null);

-- ------------------------------------------------- 2. what it may not be --

create or replace function public.guard_park_refund()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare pay record; given numeric(10,2); given_fee numeric(10,2);
begin
  -- FOR UPDATE IS LOAD-BEARING, NOT DECORATION. Two refunds submitted at the
  -- same moment would each read the same "already given back" total, each pass
  -- the ceiling check below, and together hand back more than was ever taken.
  -- Locking the payment row makes the second one wait and then see the first.
  select p.id, p.park_id, p.amount, p.fee_amount, p.method, p.reversed_at
    into pay
    from public.park_payments p
   where p.id = new.payment_id
     for update;
  if not found then
    raise exception 'park_refunds: no such payment';
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

drop trigger if exists trg_guard_park_refund on public.park_refunds;
create trigger trg_guard_park_refund
  before insert or update on public.park_refunds
  for each row execute function public.guard_park_refund();

-- ------------------------------- 3. the balance has to know about it too --
--
-- `sync_charge_paid` summed payments and ignored refunds, because refunds did
-- not exist. Left alone, a refunded household's bill would still read PAID.
--
-- The maths moves into one function both triggers call, so the payment side
-- and the refund side can never drift into two different answers about the
-- same charge — the failure this codebase keeps finding as "a rule enforced by
-- a trigger reading a column nothing writes".

create or replace function public.recompute_charge_paid(target uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare total numeric(10,2); owed numeric(10,2); cur_status text;
begin
  -- Previously expressed as an UPDATE ... WHERE id = NULL, which matched no
  -- rows. Same outcome, without taking a lock to discover it.
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
     and p.reversed_at is null;

  update public.park_charges
     set paid_total = total,
         status = case
                    when cur_status = 'void' then 'void'
                    when total >= owed then 'paid'
                    else 'open'
                  end
   where id = target;
end $$;

-- SECURITY DEFINER FUNCTIONS ARE EXECUTABLE BY PUBLIC UNLESS SAID OTHERWISE.
-- This one writes to park_charges, so left at the default it is a money-
-- touching entry point reachable through PostgREST by anon. Recomputing is
-- derived and idempotent, so the blast radius is small — but "small" is not a
-- reason to leave a door open. Only the triggers need it.
revoke all on function public.recompute_charge_paid(uuid) from public, anon, authenticated;

create or replace function public.sync_charge_paid()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  perform public.recompute_charge_paid(coalesce(new.charge_id, old.charge_id));
  -- A payment moved from one charge to another has to settle BOTH. The old
  -- function only ever recomputed one of them.
  if tg_op = 'UPDATE' and new.charge_id is distinct from old.charge_id then
    perform public.recompute_charge_paid(old.charge_id);
  end if;
  return null;
end $$;

create or replace function public.sync_charge_paid_from_refund()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare target uuid;
begin
  select p.charge_id into target
    from public.park_payments p
   where p.id = coalesce(new.payment_id, old.payment_id);
  perform public.recompute_charge_paid(target);
  return null;
end $$;

drop trigger if exists trg_sync_charge_paid_from_refund on public.park_refunds;
create trigger trg_sync_charge_paid_from_refund
  after insert or delete or update on public.park_refunds
  for each row execute function public.sync_charge_paid_from_refund();

-- --------------------------- 4. a card payment may not be un-happened -----
--
-- Extends the guard that already runs BEFORE INSERT OR UPDATE on this table
-- rather than adding a second one beside it. A guard somebody has to remember
-- to also-check is a guard the next migration forgets, and two BEFORE triggers
-- on one table run in a name order nobody should have to reason about.

create or replace function public.guard_park_payment()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare st text;
begin
  -- unchanged from 0081
  select status into st from public.park_charges where id = new.charge_id;
  if st = 'void' then
    raise exception 'park_payments: that charge was voided — record the payment against a live one';
  end if;

  if tg_op = 'UPDATE' and new.reversed_at is not null and old.reversed_at is null then
    -- THE LIE THIS MIGRATION EXISTS TO END. Reversing says the money never
    -- arrived. On a card or ACH payment it demonstrably did, and the office
    -- would be told "taken back" while the cardholder's statement disagrees.
    if new.method in ('card', 'ach') then
      raise exception 'park_payments: a % payment moved real money — refund it, do not reverse it', new.method;
    end if;
    -- And a payment some of which has already gone back cannot also be
    -- declared never to have happened; the ledger would hold both facts.
    --
    -- UNREACHABLE TODAY, ON PURPOSE. Only card and ACH can be refunded, and the
    -- branch above already refuses to reverse those — so nothing can currently
    -- arrive here. It is written for the day somebody widens the method rule,
    -- which is exactly when it stops being obvious. The post-conditions do not
    -- claim to exercise it, because they cannot.
    if exists (select 1 from public.park_refunds r where r.payment_id = new.id) then
      raise exception 'park_payments: part of that payment has already been refunded — a reversal would contradict the refund record';
    end if;
  end if;

  return new;
end $$;

-- --------------------------------------------------- 5. who may read it ---

alter table public.park_refunds enable row level security;

drop policy if exists park_refunds_read on public.park_refunds;
create policy park_refunds_read on public.park_refunds
  for select using (
    public.ll_manages_park(park_id)
    or public.ll_is_ops()
    or exists (
      select 1
        from public.park_payments p
        join public.park_renters pr on pr.id = p.renter_id
       where p.id = park_refunds.payment_id
         and pr.user_id = auth.uid()
    )
  );

-- RLS ALONE IS NOT ENOUGH. Supabase grants the client roles table-level DML by
-- default, so a table with a SELECT-only policy and no revoke is still
-- writable through PostgREST by anyone who can authenticate. Every write here
-- goes through the service role in a server action.
revoke insert, update, delete on public.park_refunds from authenticated, anon;
grant select on public.park_refunds to authenticated;

-- ------------------------------------------------------ post-conditions ---
--
-- SHIP-TIME ASSERTIONS, NOT STANDING GUARDS. This block runs once, now, and
-- cannot police the next migration. It proves the rules bite on real rows and
-- then rolls itself back so production is left holding nothing.
--
-- Several assertions match on the TEXT of the refusal. That is deliberate: a
-- bare "it was refused" passes when some unrelated constraint refuses first,
-- which is how a test ends up proving nothing. Each one below names the rule
-- it means to exercise.

do $$
declare
  lid uuid; pid uuid; lot uuid; ren uuid; res uuid; ch uuid;
  pay_card uuid; pay_cash uuid; rf uuid; n numeric; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0142: no lake to hang a fixture on — post-conditions skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active, cutover_date)
    values ('0142 Proof', '1 Rd', '0142-proof', lid, 'mh', false, date '2020-01-01')
    returning id into pid;

    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid, '1', true, 'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid, '0142 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange(date '2020-01-01', null), 'monthly', 'active', 400)
    returning id into res;

    -- period_month is TEXT matching ^\d{4}-\d{2}$; park_charge_not_before_go_live
    -- appends '-01' to it, so a date here becomes '2020-01-01-01' and is
    -- refused. park_lot_id and due_on are both NOT NULL. Dates are derived from
    -- today because park_payments_received_on_is_sane pins received_on to
    -- within 730 days of created_at — a fixed past date ages into a failure.
    insert into public.park_charges
      (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date, 'YYYY-MM'), current_date, 400, 'open')
    returning id into ch;

    -- A card payment that really moved money, with the surcharge on top.
    insert into public.park_payments
      (park_id, renter_id, charge_id, amount, method, received_on, reference, kind, fee_amount)
    values (pid, ren, ch, 400, 'card', current_date, 'ch_mock_0142', 'rent', 12)
    returning id into pay_card;

    -- 1. THE BILL READS PAID.
    select paid_total into n from public.park_charges where id = ch;
    if n <> 400 then raise exception '0142: paid_total is % after a full payment, expected 400', n; end if;

    -- 2. A CARD PAYMENT CANNOT BE REVERSED.
    ok := false;
    begin
      update public.park_payments set reversed_at = now(), reversed_reason = 'x' where id = pay_card;
    exception when others then ok := (sqlerrm like '%refund it%');
    end;
    if not ok then raise exception '0142: a card reversal was not refused by the new guard'; end if;

    -- 3. A REFUND MAY NOT EXCEED WHAT WAS TAKEN.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
      values (pay_card, pid, 400.01, 'too much', 'rf_mock_0142');
    exception when others then ok := (sqlerrm like '%give back%');
    end;
    if not ok then raise exception '0142: an over-large refund was not refused by the ceiling'; end if;

    -- 4. NOR MAY IT RETURN MORE SURCHARGE THAN WAS CHARGED.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, fee_amount, reason, processor_ref)
      values (pay_card, pid, 1, 12.01, 'too much fee', 'rf_mock_0142b');
    exception when others then ok := (sqlerrm like '%card fee%');
    end;
    if not ok then raise exception '0142: a fee refund larger than the fee charged was accepted'; end if;

    -- 5. A PARTIAL REFUND REOPENS THE BILL BY EXACTLY ITS AMOUNT.
    insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
    values (pay_card, pid, 142.53, 'grounds fee did not apply', 'rf_mock_0142c')
    returning id into rf;
    select paid_total into n from public.park_charges where id = ch;
    if n <> 257.47 then raise exception '0142: paid_total is % after a 142.53 refund, expected 257.47', n; end if;
    if (select status from public.park_charges where id = ch) <> 'open' then
      raise exception '0142: the bill still reads paid after money went back';
    end if;

    -- 6. TWO PARTIALS MAY NOT TOGETHER EXCEED THE PAYMENT.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
      values (pay_card, pid, 257.48, 'the rest and a penny', 'rf_mock_0142d');
    exception when others then ok := (sqlerrm like '%give back%');
    end;
    if not ok then raise exception '0142: two partials were not refused by the ceiling'; end if;

    -- 7. CASH CANNOT BE REFUNDED THROUGH A PROCESSOR, BUT CAN STILL BE REVERSED.
    --    Both acts survive, each for the money it actually fits.
    insert into public.park_payments
      (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren, ch, 50, 'cash', current_date, 'rent')
    returning id into pay_cash;
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
      values (pay_cash, pid, 10, 'over the counter', 'rf_mock_0142e');
    exception when others then ok := (sqlerrm like '%only a card or ACH%');
    end;
    if not ok then raise exception '0142: a cash payment was refunded through the processor'; end if;
    -- but it CAN still be reversed, which is the whole point of keeping both acts
    update public.park_payments set reversed_at = now(), reversed_reason = 'miskeyed' where id = pay_cash;
    if (select reversed_at from public.park_payments where id = pay_cash) is null then
      raise exception '0142: a cash payment could no longer be reversed';
    end if;

    -- 8. A REFUND AGAINST A REVERSED PAYMENT IS REFUSED, BY THE REVERSAL RULE.
    --    Only card and ACH can be refunded and neither can be reversed, so this
    --    rule is defence in depth and is reachable only on cash — where the
    --    method rule would ALSO refuse. A bare "it was refused" would therefore
    --    pass without ever exercising it. Assert which rule spoke.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
      values (pay_cash, pid, 10, 'after the fact', 'rf_mock_0142f');
    exception when others then ok := (sqlerrm like '%reversed%');
    end;
    if not ok then raise exception '0142: a reversed payment was not refused by the reversal rule'; end if;

    -- 9. A REFUND WITH NO PROCESSOR REFERENCE IS NOT A RECORD.
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
      values (pay_card, pid, 1, 'untraceable', '   ');
    exception when others then ok := (sqlerrm like '%processor_ref%');
    end;
    if not ok then raise exception '0142: a refund with no processor reference was accepted'; end if;

    -- 10. THE CLIENT ROLES HOLD NO WRITE GRANT.
    if has_table_privilege('authenticated', 'public.park_refunds', 'INSERT')
       or has_table_privilege('anon', 'public.park_refunds', 'INSERT') then
      raise exception '0142: a client role can insert refunds directly';
    end if;

    -- 11. NOR CAN ONE CALL THE RECOMPUTE BY HAND.
    if has_function_privilege('anon', 'public.recompute_charge_paid(uuid)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.recompute_charge_paid(uuid)', 'EXECUTE') then
      raise exception '0142: a client role can execute recompute_charge_paid';
    end if;

    raise exception 'ROLLBACK_0142_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_0142_PROOF' then raise; end if;
  end;
end $$;
