-- 0169 — A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT.
--
-- Lot 9 pays January's $542.53 by cheque on the 5th and moves out on the
-- 27th. They were here 27 of 31 days — $472.53 — so $70.00 of what they paid
-- is theirs to have back. Until now the ledger had no shape for that. The
-- owner's decision (16 September 2026): "yes make me one".
--
-- ============ WHAT THE LEDGER COULD SAY UNTIL NOW ============
--
-- 0072 made a bill you have taken money for impossible to cancel —
-- `park_charges_paid_cannot_void`: status <> 'void' or paid_total = 0 — for a
-- reason that was right at the time: `voidCharge` set status 'void' with no
-- look at what was on the bill, and a cancelled paid bill dropped its cash
-- out of every accrual total while it sat in the bank. So the move-out door
-- read the standing of the January bill, found money TAKEN against it, and
-- did the only honest thing it could: it left the whole-month bill exactly as
-- it was and said the arithmetic in the toast — "$70.00 is theirs to have
-- back" — about money no row anywhere recorded as owed. The on-account view
-- did not list it (charge_id was set), the hand-back stamp refused it (0168
-- fenced the stamp to charge_id null), and the household's own page read
-- January as paid in full for a month they had left a week into.
--
-- The withdrawal doors had the same wall. A February bill raised early and
-- paid by cheque could not be withdrawn at all: "sort that payment out
-- first" — with no door that sorts it.
--
-- ============ THE MODEL ============
--
--   A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT, DERIVED. A payment
--   whose `charge_id` names a bill with status 'void' IS money on account.
--   Nothing is written to say so: the row keeps its charge_id, its receipt
--   number, its place in the sequence and its history; what changed is the
--   bill's status, and every reader that asks "is this on account" asks the
--   view, which now joins the bill. 0167's "the payment row does not move"
--   holds here in the strongest form — the row is not even re-pointed.
--
--   WHAT IS STILL HELD IS `park_payment_remaining`, UNCHANGED. Amount less
--   live allocations, less refunds, less what was handed back. A released
--   $542.53 with $472.53 put against the re-raised part month reads $70.00
--   remaining, and the hand-back ceiling, the refund ceiling, the held panel
--   and the resident's own page all read that one figure.
--
--   THE BILL'S paid_total IS 0 THE MOMENT IT IS VOID. `park_charge_paid_total`
--   returns 0 for a void bill, so `recompute_charge_paid` agrees, and the
--   BEFORE UPDATE guard below sets it on the same write that flips the
--   status — 0072's CHECK stays exactly as it is and passes because the money
--   is no longer the bill's. It is the household's, on account.
--
--   MONEY ON ACCOUNT MUST COME OFF FIRST. An allocation onto the bill from a
--   payment that still stands refuses the void by name. That money is a
--   separate fact about another payment (0167); it is taken back off the bill
--   with a reason (R3, `unapplyAllocation`) and returns to account through
--   the record, never through a void's side effect.
--
--   THE RELEASED ROW MAY BE ACTED ON LIKE ANY MONEY ON ACCOUNT. Put against
--   a bill (the allocation guard now refuses only a LIVE source bill), handed
--   back across the window (the stamp's fence is "the bill is live", not
--   "there is no bill"), refunded to the card up to its unapplied remainder,
--   or reversed — which un-applies it from every bill it settled (0167 § 7's
--   loop, unchanged).
--
-- ============ WHAT THE DATABASE REFUSES ============
--
--   cancelling a bill while money on account is against it (by name, with
--     the amount);
--   moving a payment's charge_id once it is set — the alternative model,
--     re-pointing the row, is closed at the database;
--   recording a NEW payment against a void bill (0081's rule, narrowed to
--     inserts and a changed charge_id: a released row may be updated);
--   handing back money against a LIVE bill (reverse it, or refund it);
--   an allocation from a payment against a LIVE bill (that bill's money);
--   everything 0167 and 0168 refuse, unchanged.
--
-- ============ WHAT THIS DELIBERATELY DOES NOT DO ============
--
-- It does not un-void: a void bill stays void, and `recompute_charge_paid`
-- keeps it so (0142). It does not decide whether the household is TOLD the
-- money is theirs, or when it goes back — the hand-back is an office act
-- with a reason (0168) and nothing here sends. It does not settle the
-- released money onto anything by itself: the re-raise (R1) and the office
-- door do that, through park_payment_allocations, as for any money on
-- account. And it does not touch `sync_charge_paid`, `recompute_charge_paid`
-- or `guard_park_refund` — § 7 says why each already does the right thing.

-- ------------------------------ 1. a void bill holds nothing --

-- 0167's body, wrapped: the same two sums for a live bill, 0 for a void one,
-- 0 for a bill that is not there (the coalesce 0167 relied on). Every reader
-- of "what is on this bill" — recompute, the allocation guard's ceiling —
-- goes through here, so none of them can count released money twice.

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
        ), 0)
      )::numeric(10,2)
    end
    from public.park_charges c
   where c.id = target
  ), 0)::numeric(10,2)
$$;

revoke all on function public.park_charge_paid_total(uuid) from public, anon, authenticated;

-- ------------------------------ 2. the guard on cancelling a bill --
--
-- BEFORE UPDATE, so the write that flips the status is the write that zeroes
-- paid_total, and 0072's CHECK — unchanged — passes on the same row. The
-- refusal names its rule and the amount, because the JavaScript door says
-- the same thing in a sentence first and the proof below matches on it.
--
-- Read through the payment's standing, as park_charge_paid_total reads: an
-- allocation from a cheque that has since bounced is a record, not money on
-- the bill, and must not block the void.
--
-- park_charges has one other trigger, park_charges_not_before_go_live, and
-- it is BEFORE INSERT only — nothing to order against.

create or replace function public.guard_park_charge_void()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare held numeric(10,2);
begin
  if new.status = 'void' and old.status <> 'void' then
    select coalesce(sum(a.amount), 0) into held
      from public.park_payment_allocations a
      join public.park_payments p on p.id = a.payment_id
     where a.charge_id = old.id
       and a.removed_at is null
       and p.reversed_at is null
       and p.returned_at is null;
    if held > 0 then
      raise exception 'park_charges: % of money on account is against this bill — take it off the bill first (with a reason), then cancel it', held;
    end if;
  end if;

  -- A VOID BILL HOLDS NOTHING — on the write that voids it, and on every
  -- later write (recompute's own included). Direct money against it is the
  -- household's now, on account, and the view says so.
  if new.status = 'void' then
    new.paid_total := 0;
  end if;

  return new;
end $$;

revoke all on function public.guard_park_charge_void() from public, anon, authenticated;

drop trigger if exists trg_guard_park_charge_void on public.park_charges;
create trigger trg_guard_park_charge_void
  before update on public.park_charges
  for each row execute function public.guard_park_charge_void();

-- ------------------------------ 3. the view lists released money --
--
-- Membership widens from "no bill" to "no bill, or the bill is void". The
-- seventeen columns 0168 left are unchanged in name, order and type —
-- CREATE OR REPLACE VIEW may only append — and `renter_id` now falls back to
-- the bill's household, so a payment recorded against a bill with no
-- renter_id of its own still reaches the household's row on every reader.
-- Three columns are appended so a screen can say where released money came
-- from without a second read.

create or replace view public.park_on_account_payments as
select p.id            as payment_id,
       p.park_id,
       coalesce(p.renter_id, c.renter_id) as renter_id,
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
       p.return_note as handed_back_note,
       c.id           as released_from_charge_id,
       c.period_month as released_from_month,
       c.voided_at    as released_on
  from public.park_payments p
  left join public.park_charges c on c.id = p.charge_id
 where p.kind = 'rent'
   and p.reversed_at is null
   and p.returned_at is null
   and (p.charge_id is null or c.status = 'void');

comment on view public.park_on_account_payments is
  'Money on account (0102: kind rent, no charge, still standing) or money '
  'released from a cancelled bill (0169: a payment against a bill with status '
  'void is money on account — derived, the row never moves; released_from_* '
  'names the bill, its month and the day it was cancelled) with how much of it '
  'has been put against bills (allocated), sent back through the processor '
  '(refunded), handed back across the window (handed_back, its day and its '
  'reason, 0168) and how much is still held (remaining, from '
  'park_payment_remaining). Readers that mean "still held" filter remaining > 0; '
  'the cash statement wants every row received in its window regardless.';

revoke all on public.park_on_account_payments from public, anon, authenticated;

-- ------------------------------ 4. released money can pay a bill --
--
-- Unchanged from 0167 § 5 apart from one branch: "already against a bill"
-- refused every payment with a charge_id, which now includes a released
-- row. A LIVE source bill's money is still that bill's; a void one's is the
-- household's. Everything else — deposit, kind, reversed, returned, park,
-- household, both ceilings, a cancelled target — reads exactly as before.

create or replace function public.guard_park_payment_allocation()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare pay record; ch record; src_st text; left_on_payment numeric(10,2); left_on_bill numeric(10,2);
begin
  -- THE ONLY UPDATE IS A REMOVAL, ONCE, WITH A REASON. Every other column is
  -- the record of what was applied and must read the same in a year. A
  -- removal on a reversed payment or a cancelled bill is allowed — the row
  -- already counts toward nothing, and refusing the correction would leave
  -- the office unable to say why it came off.
  if tg_op = 'UPDATE' then
    if new.id <> old.id
       or new.park_id <> old.park_id
       or new.payment_id <> old.payment_id
       or new.charge_id <> old.charge_id
       or new.amount <> old.amount
       or new.applied_at <> old.applied_at
       or new.applied_by is distinct from old.applied_by
       or new.applied_via <> old.applied_via then
      raise exception 'park_payment_allocations: an allocation is not edited — take it off the bill (with a reason) and apply again';
    end if;
    if old.removed_at is not null then
      raise exception 'park_payment_allocations: that allocation was already taken off its bill';
    end if;
    if new.removed_at is null then
      raise exception 'park_payment_allocations: an allocation is not edited — take it off the bill (with a reason) and apply again';
    end if;
    if length(btrim(coalesce(new.removed_reason, ''))) = 0 then
      raise exception 'park_payment_allocations: say why it is coming off the bill — the record has to carry the reason';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'park_payment_allocations: an allocation is never deleted — take it off the bill with a reason, and the row stays as the record';
  end if;

  -- A NEW ROW IS LIVE. Inserting one already removed would be a record of a
  -- correction to an application that never happened.
  if new.removed_at is not null or new.removed_reason is not null or new.removed_by is not null then
    raise exception 'park_payment_allocations: a new allocation cannot arrive already taken off its bill';
  end if;

  -- FOR UPDATE ON BOTH ROWS. Two allocations from the same payment submitted
  -- at once — the run and the office, say — would each read the same
  -- remainder and together apply more than there is. Locking the payment
  -- serialises them; locking the bill does the same for two payments landing
  -- on one bill.
  select p.id, p.park_id, p.renter_id, p.kind, p.charge_id, p.reversed_at, p.returned_at, p.amount
    into pay
    from public.park_payments p
   where p.id = new.payment_id
     for update;
  if not found then
    raise exception 'park_payment_allocations: no such payment';
  end if;

  if pay.kind = 'deposit' then
    raise exception 'park_payment_allocations: a deposit is held money — it cannot pay a bill';
  end if;
  if pay.kind <> 'rent' then
    raise exception 'park_payment_allocations: only rent on account can be put against a bill (this was %)', pay.kind;
  end if;
  -- A LIVE BILL'S MONEY IS THAT BILL'S (0169). A void bill's is released onto
  -- account, and this is the door it reaches the next bill through.
  if pay.charge_id is not null then
    select c.status into src_st from public.park_charges c where c.id = pay.charge_id;
    if src_st is distinct from 'void' then
      raise exception 'park_payment_allocations: that payment is against a live bill — it is that bill''s money';
    end if;
  end if;
  if pay.reversed_at is not null then
    raise exception 'park_payment_allocations: that payment was reversed — there is nothing to apply';
  end if;
  if pay.returned_at is not null then
    raise exception 'park_payment_allocations: the bank returned that payment — it never settled, so it cannot pay a bill';
  end if;
  if new.park_id <> pay.park_id then
    raise exception 'park_payment_allocations: the allocation and the payment belong to different parks';
  end if;

  select c.id, c.park_id, c.renter_id, c.status, c.amount
    into ch
    from public.park_charges c
   where c.id = new.charge_id
     for update;
  if not found then
    raise exception 'park_payment_allocations: no such bill';
  end if;
  if ch.status = 'void' then
    raise exception 'park_payment_allocations: that bill was cancelled — put the money against a live one';
  end if;
  if ch.park_id <> pay.park_id then
    raise exception 'park_payment_allocations: the payment and the bill belong to different parks';
  end if;
  -- SOMEBODY ELSE'S BILL. The ids come from a browser, and one household's
  -- cheque on another's rent is found only by the household who gets chased.
  if pay.renter_id is not null and ch.renter_id is not null and pay.renter_id <> ch.renter_id then
    raise exception 'park_payment_allocations: that money is a different household''s — it cannot pay this bill';
  end if;

  -- BOTH CEILINGS, LIVE. Read through the same two functions every other
  -- reader uses, not off paid_total — an AFTER trigger's write is not visible
  -- to a later row's BEFORE trigger in the same statement.
  left_on_payment := public.park_payment_remaining(pay.id);
  if new.amount > left_on_payment then
    raise exception 'park_payment_allocations: only % is left on that payment, and this would apply %', left_on_payment, new.amount;
  end if;
  left_on_bill := ch.amount - public.park_charge_paid_total(ch.id);
  if new.amount > left_on_bill then
    raise exception 'park_payment_allocations: that bill only has % left on it, and this would apply %', left_on_bill, new.amount;
  end if;

  return new;
end $$;

-- ------------------------------ 5. the hand-back stamp reaches a released row --
--
-- 0168 fenced the rent stamp to `charge_id is null` in a CHECK, which cannot
-- read the bill's status. The CHECK now fences on kind alone; whether the
-- bill is live is the guard's question (§ 6 iii), where it can be asked.
-- hand_back_has_a_reason and kept_deposit_has_a_reason are unchanged.

alter table public.park_payments drop constraint if exists park_payments_return_is_sane;
alter table public.park_payments add constraint park_payments_return_is_sane
  check (
    (returned_on is null and returned_amount is null)
    or (
      kind in ('deposit', 'rent')
      and returned_on is not null
      and returned_amount is not null
      and returned_amount > 0
      and returned_amount <= amount
    )
  );

-- ------------------------------ 6. the guard on a payment --
--
-- Unchanged from 0168 § 4 apart from four edits, each marked (0169):
--   (i)   0081's "that charge was voided" fires on an INSERT, or on an
--         UPDATE that changes charge_id — PROVEN on production that it fired
--         on every UPDATE, which would have refused a hand-back, a
--         reversal and a confirmation stamp on any released row;
--   (ii)  NEW: a charge_id, once set, never changes. The alternative model —
--         re-pointing the row to null on a void — is closed here; no writer
--         moves charge_id today (only billed_on_charge_id is ever updated).
--   (iii) the rent hand-back refuses money against a LIVE bill, by name,
--         instead of any bill;
--   (iv)  nothing else: card/ACH → processor; not standing; the ceiling via
--         park_payment_remaining; once; no reversal after a hand-back.

create or replace function public.guard_park_payment()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare st text; left_on_payment numeric(10,2);
begin
  if tg_op = 'UPDATE' and new.charge_id is not null and old.charge_id is null then
    raise exception 'park_payments: money on account is put against a bill through park_payment_allocations, not by moving the payment';
  end if;

  -- (0169 ii) THE ROW DOES NOT MOVE. Cancelling the bill releases its money
  -- onto account as a derived fact; the anchor is the record of what the
  -- money was taken for.
  if tg_op = 'UPDATE' and old.charge_id is not null and new.charge_id is distinct from old.charge_id then
    raise exception 'park_payments: a payment stays on the bill it was recorded against — cancelling the bill releases its money onto account, the row does not move';
  end if;

  -- 0081, narrowed (0169 i): a NEW payment against a void bill is refused; a
  -- payment already against one — released onto account — may be updated.
  select status into st from public.park_charges where id = new.charge_id;
  if (tg_op = 'INSERT' or new.charge_id is distinct from old.charge_id) and st = 'void' then
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
    -- (0169 iii) A LIVE bill's money is not handed back; a void bill's is on
    -- account and may be.
    if new.charge_id is not null and st is distinct from 'void' then
      raise exception 'park_payments: money against a live bill is not handed back — reverse it if the record is wrong, or refund it if it came by card';
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

-- ------------------------------ 7. what is unchanged, and why --
--
-- sync_charge_paid (0167 § 7): a reversal of a released row recomputes its
--   own bill — void, so 0 — and loops its live allocations, so the part
--   month it settled reopens in the same statement. Proven at step 13.
-- recompute_charge_paid (0167 § 4): reads § 1, so a void bill holds 0 on
--   every recompute, and keeps 'void' as its status (0142).
-- guard_park_refund (0167 § 10): the ceiling amount − allocated already caps
--   a released card row at its unapplied remainder. Proven at step 10.
-- park_payments_read (0167 § 11): a released row is reachable through its
--   charge or its own renter_id, as before.

-- ------------------------------------------------------ post-conditions ---
--
-- SHIP-TIME ASSERTIONS, NOT STANDING GUARDS. This block runs once, now, on a
-- fixture park, and rolls itself back by raising at the end. It walks the
-- case the model was built for — Lot 9, $542.53 paid straight against
-- January, moved out, the part month raised and settled from the released
-- money, $70.00 handed back — then the same bill paid by card and refunded,
-- a bill with money on account against it refused by name, and every rule
-- the header says still holds. Assertions match on the TEXT of the refusal,
-- for the reason 0142 gives.

do $$
declare
  lid uuid; pid uuid; lot uuid; lot2 uuid; ren uuid; ren2 uuid; res uuid; res2 uuid;
  jan uuid; part uuid; feb uuid; live uuid; d uuid; dpart uuid;
  other uuid; cbill uuid; cpart uuid;
  pay uuid; pay2 uuid; paylive uuid; payd uuid; card uuid; al uuid;
  n numeric; hb numeric; st text; m text; ok boolean; cnt integer; d1 date; t1 timestamptz; t2 timestamptz; rv uuid;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0169: no lake to hang a fixture on — post-conditions skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active, cutover_date)
    values ('0169 Proof', '1 Rd', '0169-proof', lid, 'mh', false, date '2020-01-01')
    returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid, '9', true, 'live') returning id into lot;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid, '10', true, 'live') returning id into lot2;
    insert into public.park_renters (park_id, display_name)
    values (pid, '0169 Household') returning id into ren;
    insert into public.park_renters (park_id, display_name)
    values (pid, '0169 Neighbour') returning id into ren2;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange(date '2020-01-01', null), 'monthly', 'active', 400)
    returning id into res;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot2, ren2, daterange(date '2020-01-01', null), 'monthly', 'active', 400)
    returning id into res2;

    -- 1. JANUARY, PAID STRAIGHT AGAINST IT. The bill reads paid; the payment
    --    is NOT money on account — a live bill's row is not in the view.
    --    renter_id is left null on the payment so step 2 proves the view
    --    fills it from the bill.
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, res, ren, to_char(current_date, 'YYYY-MM'), current_date, 542.53, 'open')
    returning id into jan;
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on)
    values (pid, null, jan, 542.53, 'check', current_date)
    returning id into pay;
    select paid_total, status into n, st from public.park_charges where id = jan;
    if n <> 542.53 or st <> 'paid' then raise exception '0169: January reads %/% after the cheque, expected 542.53/paid', n, st; end if;
    select count(*) into cnt from public.park_on_account_payments where payment_id = pay;
    if cnt <> 0 then raise exception '0169: a payment against a LIVE bill is listed as money on account'; end if;

    -- 2. THE VOID IS ACCEPTED, AND THE MONEY IS RELEASED. paid_total 0 on the
    --    same write; § 1 answers 0 on its own; the view lists the payment
    --    with the whole amount remaining, the month and the day it came from,
    --    and the household from the bill.
    update public.park_charges
       set status = 'void', voided_at = now(), void_reason = 'moved out on the 27th — billed again for the days they were here'
     where id = jan;
    select paid_total, status, voided_at into n, st, t1 from public.park_charges where id = jan;
    if n <> 0 or st <> 'void' then raise exception '0169: January reads %/% after the void, expected 0/void', n, st; end if;
    select public.park_charge_paid_total(jan) into n;
    if n <> 0 then raise exception '0169: park_charge_paid_total reads % for a void bill, expected 0', n; end if;
    select remaining, released_from_month, released_on, renter_id into n, m, t2, rv
      from public.park_on_account_payments where payment_id = pay;
    if n is null then raise exception '0169: the released payment is not in the view'; end if;
    if n <> 542.53 then raise exception '0169: remaining is % on the released payment, expected 542.53', n; end if;
    if m <> to_char(current_date, 'YYYY-MM') then raise exception '0169: released_from_month reads %', m; end if;
    if t2 is distinct from t1 then raise exception '0169: released_on (%) is not the bill''s voided_at (%)', t2, t1; end if;
    if rv is distinct from ren then raise exception '0169: the view did not take the household from the bill'; end if;

    -- 3. A NEW PAYMENT AGAINST THE VOID BILL IS STILL REFUSED (0081, kept).
    ok := false;
    begin
      insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on)
      values (pid, ren, jan, 1, 'cash', current_date);
    exception when others then ok := (sqlerrm like '%that charge was voided%');
    end;
    if not ok then raise exception '0169: a new payment was recorded against a void bill'; end if;

    -- 4. THE PART MONTH — same reservation, same month (0081's partial unique
    --    allows it) — takes $472.53 of the released money.
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, res, ren, to_char(current_date, 'YYYY-MM'), current_date, 472.53, 'open')
    returning id into part;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, pay, part, 472.53, 'office');
    select paid_total, status into n, st from public.park_charges where id = part;
    if n <> 472.53 or st <> 'paid' then raise exception '0169: the part month reads %/% after the allocation, expected 472.53/paid', n, st; end if;
    select remaining into n from public.park_on_account_payments where payment_id = pay;
    if n <> 70.00 then raise exception '0169: remaining is % after the part month, expected 70.00', n; end if;

    -- 5. NOT A PENNY MORE THAN IS LEFT ON IT — onto the next month's bill.
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, res, ren, to_char(current_date + 31, 'YYYY-MM'), current_date + 31, 542.53, 'open')
    returning id into feb;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, pay, feb, 70.01, 'office');
    exception when others then ok := (sqlerrm like '%only 70.00 is left on that payment%');
    end;
    if not ok then raise exception '0169: more than the remainder of a released payment was applied'; end if;

    -- 6. THE $70.00 GOES BACK ACROSS THE WINDOW: the ceiling, the reason,
    --    the stamp, the view, and never twice.
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 70.01, return_note = 'moved out' where id = pay;
    exception when others then ok := (sqlerrm like '%only 70.00 of that payment is still on account%');
    end;
    if not ok then raise exception '0169: a hand-back on a released row exceeded what was left'; end if;
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 70.00 where id = pay;
    exception when others then ok := (sqlerrm like '%park_payments_hand_back_has_a_reason%');
    end;
    if not ok then raise exception '0169: released money went back with no reason on the record'; end if;
    update public.park_payments
       set returned_on = current_date, returned_amount = 70.00, return_note = 'moved out; overpaid the part month'
     where id = pay;
    select remaining, handed_back, handed_back_on into n, hb, d1 from public.park_on_account_payments where payment_id = pay;
    if n <> 0 then raise exception '0169: remaining is % after the hand-back, expected 0', n; end if;
    if hb <> 70.00 or d1 <> current_date then raise exception '0169: the view reads handed_back %/% after the hand-back', hb, d1; end if;
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 1, return_note = 'again' where id = pay;
    exception when others then ok := (sqlerrm like '%already handed back on%');
    end;
    if not ok then raise exception '0169: released money was handed back twice'; end if;

    -- 7. A RELEASED ROW MAY BE UPDATED — 0081's branch is narrowed to inserts.
    update public.park_payments set note = 'confirmed at the window' where id = pay;
    select note into st from public.park_payments where id = pay;
    if st <> 'confirmed at the window' then raise exception '0169: an update on a released row did not land'; end if;

    -- 8. AND STILL CANNOT BE REVERSED ONCE HANDED BACK (0168, kept).
    ok := false;
    begin
      update public.park_payments set reversed_at = now(), reversed_reason = 'the cheque bounced' where id = pay;
    exception when others then ok := (sqlerrm like '%already handed back on%');
    end;
    if not ok then raise exception '0169: a handed-back released row was reversed'; end if;

    -- 9. MONEY ON ACCOUNT AGAINST THE BILL REFUSES THE VOID, BY NAME; taken
    --    off with a reason, the void goes through.
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot2, res2, ren2, to_char(current_date, 'YYYY-MM'), current_date, 542.53, 'open')
    returning id into other;
    insert into public.park_payments (park_id, renter_id, charge_id, kind, amount, method, received_on)
    values (pid, ren2, null, 'rent', 542.53, 'check', current_date)
    returning id into pay2;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, pay2, other, 542.53, 'run')
    returning id into al;
    ok := false;
    begin
      update public.park_charges set status = 'void', voided_at = now(), void_reason = 'raised twice' where id = other;
    exception when others then ok := (sqlerrm like '%542.53 of money on account is against this bill%');
    end;
    if not ok then raise exception '0169: a bill with money on account against it was cancelled'; end if;
    select paid_total, status into n, st from public.park_charges where id = other;
    if n <> 542.53 or st <> 'paid' then raise exception '0169: the refused void still changed the bill (%/%)', n, st; end if;
    update public.park_payment_allocations set removed_at = now(), removed_reason = 'the bill is being cancelled' where id = al;
    update public.park_charges set status = 'void', voided_at = now(), void_reason = 'raised twice' where id = other;
    select paid_total, status into n, st from public.park_charges where id = other;
    if n <> 0 or st <> 'void' then raise exception '0169: the void after the removal reads %/%', n, st; end if;
    select remaining into n from public.park_on_account_payments where payment_id = pay2;
    if n <> 542.53 then raise exception '0169: the removed allocation''s money is not back on account (%)', n; end if;

    -- 10. THE SAME BILL PAID BY CARD: released, the part month settled from
    --     it, and the $70.00 refunded — capped at the unapplied remainder.
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot2, res2, ren2, to_char(current_date + 31, 'YYYY-MM'), current_date + 31, 542.53, 'open')
    returning id into cbill;
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, reference, fee_amount)
    values (pid, ren2, cbill, 542.53, 'card', current_date, 'ch_mock_0169', 12)
    returning id into card;
    update public.park_charges set status = 'void', voided_at = now(), void_reason = 'moved out' where id = cbill;
    select paid_total, status into n, st from public.park_charges where id = cbill;
    if n <> 0 or st <> 'void' then raise exception '0169: the card-paid bill reads %/% after the void', n, st; end if;
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot2, res2, ren2, to_char(current_date + 31, 'YYYY-MM'), current_date + 31, 472.53, 'open')
    returning id into cpart;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, card, cpart, 472.53, 'office');
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
      values (card, pid, 70.01, 'a penny into the part month', 'rf_mock_0169a');
    exception when others then ok := (sqlerrm like '%only 70.00 of that payment is still unapplied%');
    end;
    if not ok then raise exception '0169: a refund reached released money that was on the part month'; end if;
    insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
    values (card, pid, 70.00, 'moved out; overpaid the part month', 'rf_mock_0169b');
    select remaining into n from public.park_on_account_payments where payment_id = card;
    if n <> 0 then raise exception '0169: remaining is % after the refund, expected 0', n; end if;
    select paid_total, status into n, st from public.park_charges where id = cbill;
    if n <> 0 or st <> 'void' then raise exception '0169: the refund''s recompute moved the void bill to %/%', n, st; end if;
    select public.park_charge_paid_total(cbill) into n;
    if n <> 0 then raise exception '0169: park_charge_paid_total reads % for the void card bill, expected 0', n; end if;
    select paid_total, status into n, st from public.park_charges where id = cpart;
    if n <> 472.53 or st <> 'paid' then raise exception '0169: the card part month reads %/%', n, st; end if;

    -- 11. A LIVE BILL'S MONEY IS STILL NOT HANDED BACK; card money still goes
    --     back through the processor, released or not.
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, res, ren, to_char(current_date + 62, 'YYYY-MM'), current_date + 62, 542.53, 'open')
    returning id into live;
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on)
    values (pid, ren, live, 542.53, 'cash', current_date)
    returning id into paylive;
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 1, return_note = 'x' where id = paylive;
    exception when others then ok := (sqlerrm like '%money against a live bill is not handed back%');
    end;
    if not ok then raise exception '0169: money against a live bill was handed back'; end if;
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 1, return_note = 'x' where id = card;
    exception when others then ok := (sqlerrm like '%goes back through the processor%');
    end;
    if not ok then raise exception '0169: a released card row was handed back by hand'; end if;

    -- 12. THE ROW DOES NOT MOVE.
    ok := false;
    begin
      update public.park_payments set charge_id = live where id = pay;
    exception when others then ok := (sqlerrm like '%a payment stays on the bill%');
    end;
    if not ok then raise exception '0169: a released payment was moved onto another bill'; end if;
    ok := false;
    begin
      update public.park_payments set charge_id = null where id = pay;
    exception when others then ok := (sqlerrm like '%a payment stays on the bill%');
    end;
    if not ok then raise exception '0169: a released payment was cut loose from its bill'; end if;

    -- 13. A RELEASED CASH ROW WITH NO HAND-BACK CAN BE REVERSED — and the
    --     part month it settled reopens (0167 § 7's loop) while the void
    --     bill stays void at 0.
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, res, ren, to_char(current_date + 93, 'YYYY-MM'), current_date + 93, 542.53, 'open')
    returning id into d;
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on)
    values (pid, ren, d, 542.53, 'cash', current_date)
    returning id into payd;
    update public.park_charges set status = 'void', voided_at = now(), void_reason = 'moved out' where id = d;
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, res, ren, to_char(current_date + 93, 'YYYY-MM'), current_date + 93, 472.53, 'open')
    returning id into dpart;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, payd, dpart, 472.53, 'office');
    select paid_total, status into n, st from public.park_charges where id = dpart;
    if n <> 472.53 or st <> 'paid' then raise exception '0169: the part month reads %/% before the reversal', n, st; end if;
    update public.park_payments set reversed_at = now(), reversed_reason = 'the cheque bounced' where id = payd;
    select paid_total, status into n, st from public.park_charges where id = dpart;
    if n <> 0 or st <> 'open' then raise exception '0169: the part month reads %/% after the released row bounced, expected 0/open', n, st; end if;
    select paid_total, status into n, st from public.park_charges where id = d;
    if n <> 0 or st <> 'void' then raise exception '0169: the void bill reads %/% after its released row bounced', n, st; end if;
    select count(*) into cnt from public.park_on_account_payments where payment_id = payd;
    if cnt <> 0 then raise exception '0169: a reversed released row is still listed as money on account'; end if;
    select count(*) into cnt from public.park_payment_allocations where payment_id = payd and removed_at is null;
    if cnt <> 1 then raise exception '0169: the reversal lost the record of where the released money had gone'; end if;

    -- 14. NO CLIENT ROLE WRITES A PAYMENT OR A BILL, EXECUTES THE VOID GUARD,
    --     OR READS THE VIEW DIRECTLY.
    if has_table_privilege('authenticated', 'public.park_payments', 'UPDATE')
       or has_table_privilege('authenticated', 'public.park_payments', 'INSERT')
       or has_table_privilege('authenticated', 'public.park_charges', 'UPDATE')
       or has_table_privilege('anon', 'public.park_payments', 'SELECT')
       or has_function_privilege('authenticated', 'public.guard_park_charge_void()', 'EXECUTE')
       or has_function_privilege('anon', 'public.guard_park_charge_void()', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.park_charge_paid_total(uuid)', 'EXECUTE')
       or has_table_privilege('authenticated', 'public.park_on_account_payments', 'SELECT') then
      raise exception '0169: a client role can write money, cancel a bill, run the void guard, or read the on-account view directly';
    end if;

    raise exception 'ROLLBACK_0169_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_0169_PROOF' then raise; end if;
  end;
end $$;
