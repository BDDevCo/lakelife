-- 0167 — MONEY ON ACCOUNT COMES OFF THE NEXT BILLS.
--
-- The owner's third decision, verbatim: "need it applied to the months if
-- there is a prepay." A household that pays a quarter ahead — $1,627.59 on
-- 28 December — is paid up for January, February and March, and every screen
-- has to say so the morning each of those bills is raised.
--
-- ============ WHAT THE LEDGER COULD SAY UNTIL NOW ============
--
-- 0102 gave money one anchor: `park_payments.charge_id`, exactly one bill or
-- none. A cheque taken before its bill existed sits with `charge_id null`
-- ("on account") and the office later moves the WHOLE row onto ONE bill by
-- setting that column. `applyOnAccount` refused to move $1,627.59 onto a
-- $542.53 bill — "it would strand the difference" — and it was right to,
-- because with one column there is nowhere for the other $1,085.06 to go.
-- Proven on production in a rolled-back block: the database itself accepted
-- the over-apply the door refused, and read `jan paid_total=1085.06 status=paid;
-- feb paid_total=0.00 status=open` — January "paid" with more than it was for,
-- February owed in full, and the resident's screen chasing her for money that
-- was in the office's own drawer. docs/park-owner-audit-findings.md names this
-- as finding 3 and it has been open since.
--
-- ============ WHICH DOLLARS PAID WHICH BILL ============
--
-- `park_payment_allocations` is the sketch in docs/park-module-phase2-design.md
-- (§ "park_allocations — which dollars paid which charge; every conservation
-- rule lives here"), built. One payment may now settle several bills, each
-- with its own row: $542.53 to January, $542.53 to February, $542.53 to
-- March, and the record of it survives every later act.
--
--   THE PAYMENT ROW DOES NOT MOVE. `charge_id` stays null on money on account
--   forever; an allocation is a separate fact about it. So every reader that
--   defined "on account" as `charge_id is null` keeps finding the row — what
--   changes is that "how much of it is still on account" is now a question
--   with an arithmetic answer, `park_payment_remaining`, rather than "all of
--   it". The view `park_on_account_payments` carries that answer beside the
--   row for every reader.
--
--   THE OLD DOOR IS CLOSED, at the database. Setting `charge_id` on a payment
--   that had none is refused by `guard_park_payment` now. Two ways of putting
--   the same money against a bill is the rule-in-one-doorway-of-three shape
--   this codebase keeps paying for, and the one column could never split.
--
--   THE RUN APPLIES IT — AND SO DOES RECORDING IT. Money on account settles
--   the household's OLDEST open bills first, the moment either side exists:
--   when a bill is raised for a household with money on account, the run
--   allocates from it oldest-money-first (applied_via 'run') until the bill
--   is settled or the money is gone; when money is recorded on account for a
--   household with an open bill, the office door allocates the same way
--   (applied_via 'office'). One helper in the app does both orderings. A
--   partial apply is the ordinary case rather than a refusal.
--
--   TAKING IT BACK OFF A BILL IS A CORRECTION WITH A REASON, the same class
--   as reversing a payment (0081). An allocation is never deleted and never
--   edited: it is REMOVED — `removed_at`, `removed_reason`, `removed_by` are
--   the only three columns that may ever change on a row, once, and the
--   reason is required. Every function and view below reads only live rows
--   (`removed_at is null`); the removed row stays as the record of where the
--   money had been and why it came off. The bill goes back to owing and the
--   money goes back on account, in the same statement, through the same
--   recompute.
--
--   `paid_total` COUNTS BOTH. `recompute_charge_paid` sums direct payments
--   (charge_id = the bill, less refunds) AND allocations from payments that
--   still stand. A reversed or bank-returned payment drops out of every bill
--   it had been put against, in one trigger, because the allocations are read
--   through the payment's own flags rather than deleted.
--
--   A REFUND IS LIMITED TO WHAT IS STILL UNAPPLIED. Money that has been put
--   against a bill is that bill's; sending it back to the card would leave the
--   bill reading paid with nothing behind it. `guard_park_refund`'s ceiling
--   becomes `amount − allocated`, and says so.
--
-- ============ WHAT THE DATABASE REFUSES ============
--
--   an allocation larger than what is left on the payment;
--   an allocation larger than what is left on the bill;
--   an allocation from a deposit (0102's rule, kept: held money never pays rent);
--   an allocation from a payment that already sits against a bill;
--   an allocation from a reversed or bank-returned payment;
--   an allocation onto a cancelled bill;
--   an allocation across parks, or across households;
--   editing an allocation in place — any column but the three removal
--     columns changing, a removal without a reason, or a second removal;
--   deleting an allocation row at all — it is removed, and stays as record;
--   moving a payment onto a bill by setting charge_id, the old door;
--   any client-role write to the table at all.
--
-- ============ WHAT THIS DELIBERATELY DOES NOT DO ============
--
-- It does not send anything, and it does not decide the rent-increase notice:
-- that is the owner's to give (decision 2) and no door here checks for it. It
-- does not net money on account out of any charge-side total — a bill with
-- unapplied money against it is still a bill until the money is applied,
-- which is exactly what the run and the recording door now do. And it does
-- not un-apply on its own: a removal is an office act with a reason
-- (`unapplyAllocation`), never a side effect of anything else.

-- ------------------------------------------------------------- 1. the table --

create table if not exists public.park_payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  -- Carried rather than joined, exactly as park_payments and park_refunds
  -- carry it. The read policy scopes on it; the guard refuses a row whose park
  -- disagrees with its payment's or its bill's.
  park_id     uuid not null references public.parks(id) on delete restrict,
  payment_id  uuid not null references public.park_payments(id) on delete restrict,
  charge_id   uuid not null references public.park_charges(id) on delete restrict,
  amount      numeric(10,2) not null check (amount > 0),
  applied_at  timestamptz not null default now(),
  -- Null for the run. The run is not a person, and pretending it was one
  -- would put a name on a decision nobody made.
  applied_by  uuid references public.users(id) on delete set null,
  applied_via text not null check (applied_via in ('run', 'office')),
  -- TAKEN BACK OFF THE BILL — the office's correction, with a reason (0081's
  -- shape for a payment; this is its shape for an allocation). A removed row
  -- counts toward nothing and is kept as the record. All three or none: a
  -- removal without a reason is refused here and by the guard, by name.
  removed_at     timestamptz,
  removed_reason text,
  removed_by     uuid references public.users(id) on delete set null,
  constraint park_payment_allocations_removal_has_reason
    check (removed_at is null or length(btrim(coalesce(removed_reason, ''))) > 0),
  constraint park_payment_allocations_reason_means_removed
    check (removed_reason is null or removed_at is not null)
);

comment on table public.park_payment_allocations is
  'Which dollars of a payment on account paid which bill. The payment row '
  'itself never moves (charge_id stays null); each allocation is a separate '
  'fact about it, so one payment can settle several months. recompute_charge_paid '
  'counts these toward paid_total for payments that still stand — a reversed '
  'or bank-returned payment drops out of every bill it was put against. '
  'Written only by the service role: the run (applied_via run) and the office '
  '(applied_via office). Never deleted and never edited: an office correction '
  'sets removed_at/removed_reason/removed_by once, and every reader ignores '
  'a removed row.';

-- ONE LIVE LINE PER PAYMENT AND BILL. The receipt reads "$542.53 to January
-- 2027", never two lines that have to be added up by the person holding it.
-- PARTIAL, on live rows only: an allocation taken off a bill and applied
-- again is the ordinary correction, and a table-level unique would refuse
-- the second application because the removed record is still there.
create unique index if not exists park_payment_allocations_live_line_idx
  on public.park_payment_allocations (payment_id, charge_id)
  where removed_at is null;

create index if not exists park_payment_allocations_charge_idx
  on public.park_payment_allocations (charge_id);
create index if not exists park_payment_allocations_park_idx
  on public.park_payment_allocations (park_id, applied_at desc);

-- ----------------------------------------------- 2. what is left on a payment --
--
-- ONE DEFINITION. Every reader that wants "how much of this is still on
-- account" — the held-money panel, the resident's own screen, the run, the
-- refund ceiling, the confirmation page — asks this function or the view
-- built on it. A second copy of the subtraction in JavaScript is the shape
-- this codebase keeps finding as a bug.
--
-- Deliberately silent about the payment's own status. A reversed payment has
-- a "remaining" too; whether it counts is the view's question (it filters
-- them) and the guard's (it refuses them first, by name).
--
-- LIVE ALLOCATIONS ONLY. A removed allocation (removed_at set) gave the money
-- back to the account; it is the record of a correction, not a claim on the
-- payment. Every sum over the table in this file carries the same filter.

create or replace function public.park_payment_remaining(p_payment uuid)
returns numeric language sql stable security definer set search_path to 'public'
as $$
  select greatest(
    0,
    p.amount
      - coalesce((select sum(a.amount) from public.park_payment_allocations a
                   where a.payment_id = p.id and a.removed_at is null), 0)
      - coalesce((select sum(r.amount) from public.park_refunds r where r.payment_id = p.id), 0)
  )::numeric(10,2)
    from public.park_payments p
   where p.id = p_payment
$$;

-- SERVICE ROLE ONLY, like recompute_charge_paid. A confirm token is printed on
-- paper; the payment id behind it must not answer "how much is left" to
-- whoever holds the paper. Every app read goes through the service client.
revoke all on function public.park_payment_remaining(uuid) from public, anon, authenticated;

-- ----------------------------------------------- 3. the view every reader uses --
--
-- The rows 0102 called "money on account" — rent with no bill, still standing
-- — with how much of each is applied and how much is left. Readable by the
-- service role only: a view owned by postgres bypasses park_payments' row
-- policy, and every app read of it goes through the service client anyway.

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
       public.park_payment_remaining(p.id) as remaining
  from public.park_payments p
 where p.kind = 'rent'
   and p.charge_id is null
   and p.reversed_at is null
   and p.returned_at is null;

comment on view public.park_on_account_payments is
  'Money on account (0102: kind rent, no charge, still standing) with how much '
  'of it has been put against bills (allocated) and how much is still held '
  '(remaining, from park_payment_remaining). Readers that mean "still held" '
  'filter remaining > 0; the cash statement wants every row received in its '
  'window regardless.';

revoke all on public.park_on_account_payments from public, anon, authenticated;

-- -------------------------------------------- 4. paid_total counts both kinds --
--
-- The live figure, in one place, so the allocation guard below and the
-- recompute cannot disagree about what a bill has against it. Direct payments
-- (charge_id = the bill) net of their refunds, plus allocations from payments
-- that still stand. A refund on an ON-ACCOUNT payment is not subtracted here:
-- guard_park_refund caps it at the unapplied remainder, so it never reaches
-- money that is on a bill.

create or replace function public.park_charge_paid_total(target uuid)
returns numeric language sql stable security definer set search_path to 'public'
as $$
  select (
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
$$;

revoke all on function public.park_charge_paid_total(uuid) from public, anon, authenticated;

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

  total := public.park_charge_paid_total(target);

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

-- ------------------------------------------------- 5. the guard on an allocation --
--
-- Every refusal names its rule, because the JavaScript door says the same
-- thing in a sentence first and the post-conditions below match on the text.
-- A bare "it was refused" passes when some unrelated constraint refuses first.

create or replace function public.guard_park_payment_allocation()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare pay record; ch record; left_on_payment numeric(10,2); left_on_bill numeric(10,2);
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
  if pay.charge_id is not null then
    raise exception 'park_payment_allocations: that payment is already against a bill';
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

drop trigger if exists trg_guard_park_payment_allocation on public.park_payment_allocations;
create trigger trg_guard_park_payment_allocation
  before insert or update or delete on public.park_payment_allocations
  for each row execute function public.guard_park_payment_allocation();

-- -------------------------------------- 6. the bill follows the allocation --
--
-- On INSERT the bill takes the money; on UPDATE — which the guard above
-- allows only as a removal — the bill gives it back. Same recompute, so the
-- bill, the arrears figure and the view's `remaining` move together.

create or replace function public.sync_charge_paid_from_allocation()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  perform public.recompute_charge_paid(coalesce(new.charge_id, old.charge_id));
  return null;
end $$;

drop trigger if exists trg_sync_charge_paid_from_allocation on public.park_payment_allocations;
create trigger trg_sync_charge_paid_from_allocation
  after insert or update on public.park_payment_allocations
  for each row execute function public.sync_charge_paid_from_allocation();

-- ------------------------- 7. a reversed or returned payment un-applies itself --
--
-- Unchanged from 0142 apart from the loop. The allocations are not deleted:
-- they are the record of where the money had gone, and recompute reads them
-- through the payment's own flags. So a bounced quarter-ahead cheque reopens
-- January, February and March in one statement, and the receipt still says
-- where it had been.

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
  -- changed, so every bill it touched is recomputed.
  if tg_op = 'UPDATE'
     and (new.reversed_at is distinct from old.reversed_at
          or new.returned_at is distinct from old.returned_at
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

-- ------------------------------------------------ 8. the old door is closed --
--
-- Unchanged from 0142 apart from the first branch. `applyOnAccount` used to
-- move a whole payment onto one bill by writing charge_id; that door refused
-- an over-apply in JavaScript and the database accepted it (proven on prod,
-- rolled back). Allocations are the one way now, and a payment that already
-- has them could otherwise be counted twice by being moved.

create or replace function public.guard_park_payment()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare st text;
begin
  if tg_op = 'UPDATE' and new.charge_id is not null and old.charge_id is null then
    raise exception 'park_payments: money on account is put against a bill through park_payment_allocations, not by moving the payment';
  end if;

  -- unchanged from 0081
  select status into st from public.park_charges where id = new.charge_id;
  if st = 'void' then
    raise exception 'park_payments: that charge was voided — record the payment against a live one';
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
    -- Unreachable today (only card and ACH can be refunded, and neither can
    -- be reversed); kept for the day the method rule widens.
    if exists (select 1 from public.park_refunds r where r.payment_id = new.id) then
      raise exception 'park_payments: part of that payment has already been refunded — a reversal would contradict the refund record';
    end if;
  end if;

  return new;
end $$;

-- -------------------------------- 9. a claim settled by money on account --
--
-- 0103 settles an open "I paid this" claim when a payment lands against the
-- bill, keyed on park_payments.charge_id — which an allocation never touches.
-- Same act, same answer: putting the household's own money on account against
-- the bill they disputed closes the disagreement by conceding it.

create or replace function public.settle_claims_on_allocation()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  update public.park_payment_claims
     set resolved_at = now(),
         resolution = 'matched',
         resolution_note = 'Money on account was put against this bill.'
   where charge_id = new.charge_id
     and resolved_at is null;
  return null;
end $$;

drop trigger if exists trg_settle_claims_on_allocation on public.park_payment_allocations;
create trigger trg_settle_claims_on_allocation
  after insert on public.park_payment_allocations
  for each row execute function public.settle_claims_on_allocation();

-- ------------------------------ 10. a refund reaches only what is unapplied --
--
-- Unchanged from 0155 apart from the ceiling. Money that has been put against
-- a bill is that bill's; the processor sending it back would leave the bill
-- reading paid with nothing behind it. The sentence keeps 0142's wording when
-- nothing is allocated, and says where the rest is when something is.

create or replace function public.guard_park_refund()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare pay record; given numeric(10,2); given_fee numeric(10,2); allocated numeric(10,2);
begin
  -- FOR UPDATE IS LOAD-BEARING, NOT DECORATION. Two refunds submitted at the
  -- same moment would each read the same "already given back" total, each pass
  -- the ceiling check below, and together hand back more than was ever taken.
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

  select coalesce(sum(a.amount), 0) into allocated
    from public.park_payment_allocations a
   where a.payment_id = new.payment_id
     and a.removed_at is null;

  if allocated > 0 and given + new.amount > pay.amount - allocated then
    raise exception 'park_refunds: that would give back %, and only % of that payment is still unapplied — % of it is against bills', given + new.amount, pay.amount - allocated, allocated;
  end if;
  if given + new.amount > pay.amount then
    raise exception 'park_refunds: that would give back %, and only % was taken', given + new.amount, pay.amount;
  end if;
  if given_fee + new.fee_amount > coalesce(pay.fee_amount, 0) then
    raise exception 'park_refunds: that would give back more card fee than was charged';
  end if;

  return new;
end $$;

-- ---------------------------------------- 11. who may read; nobody writes --

alter table public.park_payment_allocations enable row level security;

drop policy if exists park_payment_allocations_read on public.park_payment_allocations;
create policy park_payment_allocations_read on public.park_payment_allocations
  for select to authenticated using (
    public.ll_manages_park(park_id)
    or public.ll_is_ops()
    or exists (
      select 1
        from public.park_payments p
        join public.park_renters pr on pr.id = p.renter_id
       where p.id = park_payment_allocations.payment_id
         and pr.user_id = auth.uid()
    )
  );

-- RLS ALONE IS NOT ENOUGH. Supabase grants the client roles table-level DML by
-- default; an allocation moves a bill to paid, so a resident who could write
-- one could settle her own rent. Every write goes through the service role.
revoke all on public.park_payment_allocations from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.park_payment_allocations from authenticated;
grant select on public.park_payment_allocations to authenticated;

-- A RESIDENT CAN READ HER OWN MONEY ON ACCOUNT. 0070's policy reached a
-- payment only THROUGH its charge, and money on account has none — so her own
-- quarter-ahead cheque was invisible to her JWT, and the allocation policy
-- above (which joins the payment) would have been too. Widened with an OR:
-- everything the old clause admitted is still admitted.
drop policy if exists park_payments_read on public.park_payments;
create policy park_payments_read on public.park_payments
  for select to authenticated
  using (
    exists (
      select 1 from public.park_charges c
       where c.id = park_payments.charge_id
         and (
           public.ll_manages_park(c.park_id)
           or public.ll_is_ops()
           or exists (
             select 1 from public.park_renters pr
              where pr.id = c.renter_id and pr.user_id = auth.uid()
           )
         )
    )
    or public.ll_manages_park(park_id)
    or public.ll_is_ops()
    or exists (
      select 1 from public.park_renters pr
       where pr.id = park_payments.renter_id and pr.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------ post-conditions ---
--
-- SHIP-TIME ASSERTIONS, NOT STANDING GUARDS. This block runs once, now, and
-- cannot police the next migration. It proves the rules bite on real rows —
-- the owner's own example, $1,627.59 ahead against three months of $542.53 —
-- and then rolls itself back so production is left holding nothing.
--
-- Assertions match on the TEXT of the refusal, for the reason 0142 gives.

do $$
declare
  lid uuid; pid uuid; lot uuid; ren uuid; ren2 uuid;
  jan uuid; feb uuid; mar uuid; apr uuid; other uuid; dead uuid;
  ahead uuid; dep uuid; card uuid; cheque uuid;
  n numeric; st text; ok boolean; cnt integer; msg text;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0167: no lake to hang a fixture on — post-conditions skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active, cutover_date)
    values ('0167 Proof', '1 Rd', '0167-proof', lid, 'mh', false, date '2020-01-01')
    returning id into pid;

    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid, '7', true, 'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid, '0167 Household') returning id into ren;
    insert into public.park_renters (park_id, display_name)
    values (pid, '0167 Neighbour') returning id into ren2;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange(date '2020-01-01', null), 'monthly', 'active', 400);

    -- Three months of $542.53 — $400 rent plus the $142.53 Grounds fee — and a
    -- fourth that the money must NOT reach. Months derived from today because
    -- park_payments_received_on_is_sane pins received_on near created_at.
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date, 'YYYY-MM'), current_date, 542.53, 'open')
    returning id into jan;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date + 31, 'YYYY-MM'), current_date + 31, 542.53, 'open')
    returning id into feb;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date + 62, 'YYYY-MM'), current_date + 62, 542.53, 'open')
    returning id into mar;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren, to_char(current_date + 93, 'YYYY-MM'), current_date + 93, 542.53, 'open')
    returning id into apr;

    -- $1,627.59 ahead, on account: the row recordOnAccount writes.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren, null, 1627.59, 'check', current_date, 'rent')
    returning id into ahead;

    -- 1. NOTHING IS ON ANY BILL YET, AND ALL OF IT IS STILL ON ACCOUNT.
    select paid_total, status into n, st from public.park_charges where id = jan;
    if n <> 0 or st <> 'open' then
      raise exception '0167: money on account reached a bill on its own (%/%)', n, st;
    end if;
    select remaining into n from public.park_on_account_payments where payment_id = ahead;
    if n <> 1627.59 then raise exception '0167: remaining is % before any allocation, expected 1627.59', n; end if;

    -- 2. THE RUN SETTLES JANUARY, FEBRUARY AND MARCH EXACTLY.
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, ahead, jan, 542.53, 'run');
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, ahead, feb, 542.53, 'run');
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, ahead, mar, 542.53, 'run');
    for st in select c.status from public.park_charges c where c.id in (jan, feb, mar) loop
      if st <> 'paid' then raise exception '0167: a settled month still reads %', st; end if;
    end loop;
    select sum(paid_total) into n from public.park_charges where id in (jan, feb, mar);
    if n <> 1627.59 then raise exception '0167: the three months hold % between them, expected 1627.59', n; end if;
    select remaining into n from public.park_on_account_payments where payment_id = ahead;
    if n <> 0 then raise exception '0167: remaining is % after three months, expected 0', n; end if;

    -- 3. A FOURTH MONTH GETS NOTHING — the payment is spent.
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, ahead, apr, 0.01, 'run');
    exception when others then ok := (sqlerrm like '%only 0.00 is left on that payment%');
    end;
    if not ok then raise exception '0167: a spent payment was applied to a fourth month'; end if;
    select paid_total, status into n, st from public.park_charges where id = apr;
    if n <> 0 or st <> 'open' then raise exception '0167: April moved to %/%', n, st; end if;

    -- 4. THE OLD DOOR IS CLOSED: the payment cannot be moved onto a bill.
    ok := false;
    begin
      update public.park_payments set charge_id = apr where id = ahead;
    exception when others then ok := (sqlerrm like '%not by moving the payment%');
    end;
    if not ok then raise exception '0167: a payment on account could still be moved onto a bill by setting charge_id'; end if;

    -- 5. A REVERSAL EMPTIES ALL THREE, AND THE ALLOCATIONS SURVIVE AS RECORD.
    update public.park_payments set reversed_at = now(), reversed_reason = 'the cheque bounced' where id = ahead;
    for st in select c.status from public.park_charges c where c.id in (jan, feb, mar) loop
      if st <> 'open' then raise exception '0167: a month still reads % after its money bounced', st; end if;
    end loop;
    select sum(paid_total) into n from public.park_charges where id in (jan, feb, mar);
    if n <> 0 then raise exception '0167: % still sits on the three months after the reversal', n; end if;
    select count(*) into cnt from public.park_payment_allocations where payment_id = ahead;
    if cnt <> 3 then raise exception '0167: the reversal deleted the record of where the money had gone (% rows)', cnt; end if;
    select count(*) into cnt from public.park_on_account_payments where payment_id = ahead;
    if cnt <> 0 then raise exception '0167: a reversed payment still reads as money on account'; end if;

    -- 6. A REVERSED PAYMENT CANNOT BE APPLIED, BY NAME.
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, ahead, apr, 1, 'office');
    exception when others then ok := (sqlerrm like '%was reversed%');
    end;
    if not ok then raise exception '0167: a reversed payment was applied'; end if;

    -- 7. A PARTIAL APPLY IS THE ORDINARY CASE, AND THE BILL'S CEILING HOLDS.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren, null, 700, 'cash', current_date, 'rent')
    returning id into cheque;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, cheque, jan, 542.53, 'office');
    select paid_total, status into n, st from public.park_charges where id = jan;
    if n <> 542.53 or st <> 'paid' then raise exception '0167: January reads %/% after a hand apply', n, st; end if;
    select remaining into n from public.park_on_account_payments where payment_id = cheque;
    if n <> 157.47 then raise exception '0167: remaining is % after a partial apply, expected 157.47', n; end if;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, cheque, jan, 0.01, 'office');
    exception when others then ok := (sqlerrm like '%that bill only has 0.00 left on it%' or sqlerrm like '%park_payment_allocations_live_line_idx%');
    end;
    if not ok then raise exception '0167: a settled bill took more money'; end if;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, cheque, feb, 157.48, 'office');
    exception when others then ok := (sqlerrm like '%only 157.47 is left on that payment%');
    end;
    if not ok then raise exception '0167: a penny more than the remainder was applied'; end if;
    -- and the remainder itself lands, leaving February part-paid
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, cheque, feb, 157.47, 'office');
    select paid_total, status into n, st from public.park_charges where id = feb;
    if n <> 157.47 or st <> 'open' then raise exception '0167: February reads %/% after the remainder, expected 157.47/open', n, st; end if;

    -- 8. A DEPOSIT NEVER PAYS A BILL — 0102's rule, kept.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren, null, 500, 'cash', current_date, 'deposit')
    returning id into dep;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, dep, feb, 100, 'office');
    exception when others then ok := (sqlerrm like '%a deposit is held money%');
    end;
    if not ok then raise exception '0167: a deposit paid a bill'; end if;

    -- 9. ANOTHER HOUSEHOLD'S MONEY CANNOT PAY THIS BILL.
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren2, to_char(current_date, 'YYYY-MM'), current_date, 100, 'open')
    returning id into other;
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren2, null, 50, 'cash', current_date, 'rent')
    returning id into card;   -- reused as the neighbour's cash for a moment
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, card, apr, 50, 'office');
    exception when others then ok := (sqlerrm like '%a different household%');
    end;
    if not ok then raise exception '0167: one household''s money paid another''s bill'; end if;

    -- 10. A CANCELLED BILL TAKES NOTHING.
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status, voided_at, void_reason)
    values (pid, lot, ren2, to_char(current_date + 31, 'YYYY-MM'), current_date + 31, 100, 'void', now(), 'raised twice')
    returning id into dead;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, card, dead, 50, 'office');
    exception when others then ok := (sqlerrm like '%that bill was cancelled%');
    end;
    if not ok then raise exception '0167: a cancelled bill took money'; end if;

    -- 11. A PAYMENT ALREADY AGAINST A BILL CANNOT ALSO BE ALLOCATED.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren2, other, 100, 'cash', current_date, 'rent')
    returning id into card;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, card, apr, 1, 'office');
    exception when others then ok := (sqlerrm like '%already against a bill%');
    end;
    if not ok then raise exception '0167: a payment against a bill was also allocated'; end if;

    -- 12. AN ALLOCATION IS NOT EDITED.
    ok := false;
    begin
      update public.park_payment_allocations set amount = 1 where payment_id = cheque and charge_id = feb;
    exception when others then ok := (sqlerrm like '%not edited%');
    end;
    if not ok then raise exception '0167: an allocation was edited in place'; end if;

    -- 13. A REFUND REACHES ONLY WHAT IS UNAPPLIED. A card payment on account
    --     (a resident paying ahead online — payRent cannot write this today,
    --     but the rail can), $600, with $542.53 put against April.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, reference, kind)
    values (pid, ren, null, 600, 'card', current_date, 'ch_mock_0167', 'rent')
    returning id into card;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, card, apr, 542.53, 'office');
    ok := false;
    begin
      insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
      values (card, pid, 57.48, 'a penny into April', 'rf_mock_0167a');
    exception when others then ok := (sqlerrm like '%still unapplied%');
    end;
    if not ok then raise exception '0167: a refund reached money that was on a bill'; end if;
    insert into public.park_refunds (payment_id, park_id, amount, reason, processor_ref)
    values (card, pid, 57.47, 'the rest back', 'rf_mock_0167b');
    select paid_total, status into n, st from public.park_charges where id = apr;
    if n <> 542.53 or st <> 'paid' then raise exception '0167: April moved to %/% when the unapplied rest was refunded', n, st; end if;
    select remaining into n from public.park_on_account_payments where payment_id = card;
    if n <> 0 then raise exception '0167: remaining is % after the unapplied rest went back, expected 0', n; end if;

    -- 14. A CLAIM ON THE BILL IS SETTLED BY THE ALLOCATION (0103's rule, second door).
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
    values (pid, lot, ren2, to_char(current_date + 62, 'YYYY-MM'), current_date + 62, 25, 'open')
    returning id into dead;
    insert into public.park_payment_claims (charge_id, asserted_by, note)
    values (dead, 'renter', 'I paid ahead');
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, kind)
    values (pid, ren2, null, 25, 'cash', current_date, 'rent')
    returning id into cheque;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, cheque, dead, 25, 'office');
    select resolution into st from public.park_payment_claims where charge_id = dead;
    if st is distinct from 'matched' then
      raise exception '0167: the claim on a bill settled from money on account still reads %', coalesce(st, 'open');
    end if;

    -- 15. NO CLIENT ROLE CAN WRITE AN ALLOCATION, AND RLS IS ON.
    if has_table_privilege('authenticated', 'public.park_payment_allocations', 'INSERT')
       or has_table_privilege('authenticated', 'public.park_payment_allocations', 'UPDATE')
       or has_table_privilege('authenticated', 'public.park_payment_allocations', 'DELETE')
       or has_table_privilege('anon', 'public.park_payment_allocations', 'SELECT')
       or has_table_privilege('authenticated', 'public.park_on_account_payments', 'SELECT')
       or has_function_privilege('authenticated', 'public.park_payment_remaining(uuid)', 'EXECUTE') then
      raise exception '0167: a client role can write an allocation, or read the on-account view or remainder directly';
    end if;
    if not (select relrowsecurity from pg_class where oid = 'public.park_payment_allocations'::regclass) then
      raise exception '0167: row level security is off on park_payment_allocations';
    end if;
    -- A stranger with a JWT reads nothing. postgres bypasses RLS, so the check
    -- runs as the client role; SET LOCAL is undone with this sub-transaction.
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000167', true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    set local role authenticated;
    select count(*) into cnt from public.park_payment_allocations where park_id = pid;
    reset role;
    if cnt <> 0 then raise exception '0167: a stranger''s JWT can read % allocation(s)', cnt; end if;

    -- 16. THE VIEW STILL LISTS MONEY ON ACCOUNT THE OLD PREDICATE FOUND —
    --     neither of the household's two standing cheques is missing.
    select count(*) into cnt from public.park_on_account_payments where park_id = pid and renter_id = ren;
    if cnt <> 2 then raise exception '0167: the view lists % of the household''s 2 standing on-account rows', cnt; end if;

    -- 17. TAKING IT BACK OFF THE BILL. The $700 cash cheque put $542.53 on
    --     January by hand (step 7). Removed with a reason: January owes again,
    --     the money is back on account, the row is still there as the record.
    select id into ahead from public.park_payment_allocations
     where payment_id = (select p.id from public.park_payments p where p.park_id = pid and p.amount = 700)
       and charge_id = jan;
    update public.park_payment_allocations
       set removed_at = now(), removed_reason = 'applied to the wrong month'
     where id = ahead;
    select paid_total, status into n, st from public.park_charges where id = jan;
    if n <> 0 or st <> 'open' then raise exception '0167: January still reads %/% after its money was taken back off it', n, st; end if;
    select remaining into n from public.park_on_account_payments
     where payment_id = (select p.id from public.park_payments p where p.park_id = pid and p.amount = 700);
    if n <> 542.53 then raise exception '0167: remaining is % after the removal, expected 542.53 (157.47 is still on February)', n; end if;
    select count(*) into cnt from public.park_payment_allocations where id = ahead and removed_at is not null;
    if cnt <> 1 then raise exception '0167: the removed allocation is not on the record'; end if;

    -- 18. A REMOVAL NEEDS A REASON, HAPPENS ONCE, AND CHANGES NOTHING ELSE.
    ok := false;
    begin
      update public.park_payment_allocations set removed_at = now(), removed_reason = '  '
       where payment_id = cheque and charge_id = dead;
    exception when others then ok := (sqlerrm like '%say why it is coming off the bill%' or sqlerrm like '%park_payment_allocations_removal_has_reason%');
    end;
    if not ok then raise exception '0167: an allocation came off a bill with no reason'; end if;
    ok := false;
    begin
      update public.park_payment_allocations set removed_at = now(), removed_reason = 'twice' where id = ahead;
    exception when others then ok := (sqlerrm like '%already taken off its bill%');
    end;
    if not ok then raise exception '0167: an allocation was taken off its bill twice'; end if;
    ok := false;
    begin
      update public.park_payment_allocations set removed_at = now(), removed_reason = 'and shrink it', amount = 1
       where payment_id = cheque and charge_id = dead;
    exception when others then ok := (sqlerrm like '%not edited%');
    end;
    if not ok then raise exception '0167: a removal also edited the amount'; end if;
    ok := false;
    begin
      delete from public.park_payment_allocations where id = ahead;
    exception when others then ok := (sqlerrm like '%never deleted%');
    end;
    if not ok then raise exception '0167: an allocation row was deleted'; end if;
    ok := false;
    begin
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via, removed_at, removed_reason)
      values (pid, cheque, apr, 1, 'office', now(), 'born removed');
    exception when others then ok := (sqlerrm like '%already taken off its bill%' or sqlerrm like '%cannot arrive already taken off%');
    end;
    if not ok then raise exception '0167: a new allocation arrived already removed'; end if;

    -- 19. AND THE SAME MONEY CAN GO BACK ON THE SAME BILL — the removed line
    --     does not block a second, live one (the unique index is partial).
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
    values (pid, (select p.id from public.park_payments p where p.park_id = pid and p.amount = 700), jan, 542.53, 'office');
    select paid_total, status into n, st from public.park_charges where id = jan;
    if n <> 542.53 or st <> 'paid' then raise exception '0167: January reads %/% after the money went back on it', n, st; end if;
    select count(*) into cnt from public.park_payment_allocations
     where payment_id = (select p.id from public.park_payments p where p.park_id = pid and p.amount = 700) and charge_id = jan;
    if cnt <> 2 then raise exception '0167: expected the removed line and the live one (2), found %', cnt; end if;

    -- 20. ONE CHEQUE, TWO ROWS, TAKEN BACK TOGETHER. recordPayment writes
    --     $600 on a $542.53 bill as the bill's share and $57.47 on account,
    --     under one key and key + ':onaccount'. reversePayment now reverses
    --     BOTH in one UPDATE. Proved here on the rows themselves: the bill
    --     the direct half was against reopens, the bill the on-account half
    --     had been put against reopens, the view stops listing the on-account
    --     half, and its allocation stays as the record of where it had gone
    --     — while a reader joining through the payment's standing (the
    --     void door, the resident's screen) no longer counts that line.
    declare split_bill uuid; split_next uuid; split_direct uuid; split_acct uuid;
    begin
      insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
      values (pid, lot, ren2, to_char(current_date + 124, 'YYYY-MM'), current_date + 124, 542.53, 'open')
      returning id into split_bill;
      insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, status)
      values (pid, lot, ren2, to_char(current_date + 155, 'YYYY-MM'), current_date + 155, 542.53, 'open')
      returning id into split_next;
      insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, idempotency_key)
      values (pid, ren2, split_bill, 542.53, 'check', current_date, '0167-split')
      returning id into split_direct;
      insert into public.park_payments (park_id, renter_id, charge_id, kind, amount, method, received_on, idempotency_key)
      values (pid, ren2, null, 'rent', 57.47, 'check', current_date, '0167-split:onaccount')
      returning id into split_acct;
      insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_via)
      values (pid, split_acct, split_next, 57.47, 'run');
      select paid_total, status into n, st from public.park_charges where id = split_bill;
      if n <> 542.53 or st <> 'paid' then raise exception '0167: the split''s bill reads %/% before the reversal', n, st; end if;
      select paid_total into n from public.park_charges where id = split_next;
      if n <> 57.47 then raise exception '0167: the next bill reads % before the reversal, expected 57.47', n; end if;

      -- The exact statement reversePayment issues: both ids, park-scoped,
      -- only rows still standing, one reason, one timestamp.
      update public.park_payments
         set reversed_at = now(), reversed_reason = 'the cheque bounced'
       where id in (split_direct, split_acct) and park_id = pid and reversed_at is null;
      get diagnostics cnt = row_count;
      if cnt <> 2 then raise exception '0167: the reversal reached % row(s) of the split, expected 2', cnt; end if;

      select paid_total, status into n, st from public.park_charges where id = split_bill;
      if n <> 0 or st <> 'open' then raise exception '0167: the split''s bill reads %/% after the reversal', n, st; end if;
      select paid_total, status into n, st from public.park_charges where id = split_next;
      if n <> 0 or st <> 'open' then raise exception '0167: the bill the on-account half had reached reads %/% after the reversal', n, st; end if;
      select count(*) into cnt from public.park_on_account_payments where payment_id = split_acct;
      if cnt <> 0 then raise exception '0167: the view still lists the reversed on-account half'; end if;
      select count(*) into cnt from public.park_payment_allocations where payment_id = split_acct and removed_at is null;
      if cnt <> 1 then raise exception '0167: the allocation of a reversed payment is not on the record (found %)', cnt; end if;
      -- Through the payment's standing — the filter park_charge_paid_total
      -- applies and the void door now reads with — the line counts for nothing.
      select count(*) into cnt
        from public.park_payment_allocations a
        join public.park_payments p on p.id = a.payment_id
       where a.charge_id = split_next and a.removed_at is null
         and p.reversed_at is null and p.returned_at is null;
      if cnt <> 0 then raise exception '0167: a reversed payment''s allocation still reads as money on the bill through the join'; end if;
      -- And the same statement a second time reaches nothing: never twice.
      update public.park_payments
         set reversed_at = now(), reversed_reason = 'again'
       where id in (split_direct, split_acct) and park_id = pid and reversed_at is null;
      get diagnostics cnt = row_count;
      if cnt <> 0 then raise exception '0167: a split was reversed twice (% rows)', cnt; end if;
      select reversed_reason into st from public.park_payments where id = split_acct;
      if st <> 'the cheque bounced' then raise exception '0167: the on-account half''s reason reads %', st; end if;
    end;

    raise exception 'ROLLBACK_0167_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_0167_PROOF' then raise; end if;
  end;
end $$;
