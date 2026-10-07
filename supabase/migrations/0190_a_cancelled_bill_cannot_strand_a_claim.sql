-- 0190 — A CANCELLED BILL CANNOT STRAND A CLAIM.
--
-- A household says "I paid this" and it is recorded (0074): two statements,
-- one from each side, and the ledger believes only both. Cancelling the bill
-- took the household's statement off the table for good.
--
-- WHY THERE IS NO WAY BACK. ledgerState returns 'void' before 'disputed'
-- (ledger-helpers:402), and "Say what you found" — the only control that
-- reaches resolvePaymentClaim — renders on a DISPUTED row (ParkRent:313). So
-- the claim has no answering door. Every other way in is shut too: a void
-- row's balance is forced to 0 so Record-payment is gated out (ParkRent:298),
-- openBillsFor filters status='open' so neither the POS nor the settlement
-- door can pay it (lib/allocations:293), the two settle triggers (0103, 0167)
-- therefore cannot fire, 0173 refuses to bring the bill back ("Raise the
-- month again instead"), and no ops screen reads park_payment_claims at all.
-- The claim stays open forever, out of arrears, while the nightly's
-- claim_ageing finding (reconcile-helpers:231, urgent) says "those bills sit
-- out of your arrears until you settle them" — about a row that offers
-- nothing to settle it with, and a bill that holds nothing. Meanwhile the
-- month bills AGAIN (the run filters void), so the household who said "I paid
-- $542.53 on 3rd January" reads plainly late on the fresh bill while their
-- recorded statement sits where nobody can see or close it.
--
-- THE REPO ALREADY GUARDED THE OTHER DIRECTION, TWICE. A resident filing a
-- claim on a cancelled bill is refused by name (parks/pay-actions:335), and
-- lib/confirm-server:635 names this exact state in its comment — "a claim
-- against a cancelled bill is one the rent screen never lists while the
-- machine counts it toward the chase". Nobody guarded the reverse.
--
-- HERE, not in each door, because this is the one doorway all four writers of
-- status='void' pass through: voidCharge (ledger-actions:1472), the run's own
-- roll-back (ledger-actions:561), and voidUnpaidChargesFor (charge-edits:331)
-- reached from signing and move-out. Every one of those callers already prints
-- a refused void in the database's own words via dbSaid, so the signing and
-- move-out doors inherit a correct sentence with no caller changed. Putting a
-- second application-level claim read in charge-edits.ts is how
-- the-rule-in-one-doorway-of-three got written.
--
-- THE MONTH IS DELIBERATELY NOT IN THIS SENTENCE. Each caller already prefixes
-- the month it is talking about, and a month a person reads is "January 2027".
--
-- NOT AUTO-RESOLVED, and that is the one product decision available here. The
-- software could close the claim itself on the void, but 'withdrawn' would
-- assert a household withdrew a statement they never withdrew, and a new
-- resolution value would make the software answer a two-sided question on
-- their behalf — the exact thing 0074 and ledger-helpers:383-401 forbid ("A
-- claim is NOT proof… it does not go away on its own"). The owner answers it,
-- then cancels.

create or replace function public.guard_park_charge_void()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare held numeric(10,2); unanswered int;
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

    -- THE HOUSEHOLD'S OWN STATEMENT. Only a live bill carries the control that
    -- answers it, so the bill stays live until somebody has answered.
    select count(*) into unanswered
      from public.park_payment_claims cl
     where cl.charge_id = old.id
       and cl.resolved_at is null;
    if unanswered > 0 then
      raise exception 'park_charges: that household has said they paid this bill and nobody has answered yet — answer that first ("Say what you found" on its row), then cancel it';
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

-- The trigger binds by function name and is unchanged from 0169; recreated so
-- a fresh database built from migrations alone ends up with it either way.
drop trigger if exists trg_guard_park_charge_void on public.park_charges;
create trigger trg_guard_park_charge_void
  before update on public.park_charges
  for each row execute function public.guard_park_charge_void();

-- ----------------------------------------------------- the proof, rolled back --
--
-- A real park, lot, tenancy, household and January bill, the way 0169 and 0173
-- prove their own guards: everything inside one DO block that raises at the
-- end, so nothing survives. Both directions are collapsed — an UNANSWERED
-- claim must block the void, and an ANSWERED one must not — because a guard
-- that refused every cancellation would pass a test that only checked the
-- first.
--
-- THIS BLOCK WAS RUN AGAINST PRODUCTION BEFORE THE FIX ABOVE EXISTED, and it
-- reported `blocked=f status_after=void`: the cancellation of a bill carrying
-- an unanswered claim went through with no complaint. That is the defect
-- demonstrated rather than read, and it is why this proof is worth keeping.
--
-- A tenancy is one `during` daterange, not a start and an end, and
-- lot_reservations reaches its park through park_lot_id only.

do $$
declare
  pid uuid; lot uuid; res uuid; ren uuid; chg uuid; cl uuid;
  ok boolean; after_status text;
begin
  insert into public.parks (name, slug, cutover_date)
  values ('0190 proof', '0190-proof-' || gen_random_uuid()::text, date '2026-12-01')
  returning id into pid;

  insert into public.park_lots (park_id, lot_number, site_type, lifecycle)
  values (pid, '7', 'mh_single', 'live') returning id into lot;

  insert into public.park_renters (park_id, display_name)
  values (pid, '0190 proof household') returning id into ren;

  insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
  values (lot, ren, daterange(date '2027-01-01', date '2027-02-01', '[)'), 'monthly', 'active')
  returning id into res;

  insert into public.park_charges
    (park_id, park_lot_id, renter_id, reservation_id, period_month, due_on, amount, status)
  values (pid, lot, ren, res, '2027-01', date '2027-01-01', 542.53, 'open')
  returning id into chg;

  insert into public.park_payment_claims (charge_id, claimed_amount, claimed_paid_on, asserted_by)
  values (chg, 542.53, date '2027-01-03', 'renter') returning id into cl;

  -- 1. THE VOID IS REFUSED, BY NAME, AND THE BILL IS UNTOUCHED.
  ok := false;
  begin
    update public.park_charges
       set status = 'void', voided_at = now(), void_reason = 'raised twice'
     where id = chg;
  exception when others then
    ok := (sqlerrm like '%said they paid this bill and nobody has answered%');
  end;
  if not ok then
    raise exception '0190 FAILED: a bill carrying an unanswered claim was cancelled, or refused with the wrong sentence';
  end if;
  select status into after_status from public.park_charges where id = chg;
  if after_status <> 'open' then
    raise exception '0190 FAILED: the refused void still changed the bill to %', after_status;
  end if;

  -- 2. AN ANSWERED CLAIM DOES NOT STAND IN THE WAY. The branch collapsed the
  --    other way: without this, a guard that blocked EVERY cancel would have
  --    passed step 1.
  update public.park_payment_claims
     set resolved_at = now(), resolution = 'not_found',
         resolution_note = 'Checked the drop box and the bank — nothing from lot 7.'
   where id = cl;

  update public.park_charges
     set status = 'void', voided_at = now(), void_reason = 'raised twice'
   where id = chg;
  select status into after_status from public.park_charges where id = chg;
  if after_status <> 'void' then
    raise exception '0190 FAILED: an answered claim still blocked the cancellation';
  end if;

  raise exception '0190 proof complete — rolling back';
exception when others then
  if sqlerrm <> '0190 proof complete — rolling back' then
    raise;
  end if;
end $$;
