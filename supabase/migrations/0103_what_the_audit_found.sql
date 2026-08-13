-- 0103 — three things 0102 broke or left open, found by auditing it.

-- 1. A ROUTE AROUND 0072. That migration made park_payments.charge_id RESTRICT
--    so money could not be destroyed "by any path, including one nobody has
--    written yet". 0102 then added park_id ON DELETE CASCADE, and a cascade
--    from `parks` clears the payment row before the charge cascade ever
--    reaches the RESTRICT — so deleting a park would silently take every
--    receipt with it. Proven against production in a rolled-back probe.
alter table public.park_payments drop constraint if exists park_payments_park_id_fkey;
alter table public.park_payments add constraint park_payments_park_id_fkey
  foreign key (park_id) references public.parks(id) on delete restrict;

-- 2. A PAID BILL THAT STILL READS "DISPUTED". `settle_claims_on_payment` was
--    INSERT ONLY, which was complete while every payment arrived with its
--    charge already attached. 0102 made money arrive first and get applied
--    later by an UPDATE, so applying a household's cheque to the very bill
--    they had disputed left the claim open and the row reading disputed —
--    and 'disputed' outranks the balance on that screen by design.
create or replace function public.settle_claims_on_payment()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  -- Money on account settles nothing until it is against a bill.
  if new.charge_id is null then return null; end if;

  update public.park_payment_claims
     set resolved_at = now(),
         resolution = 'matched',
         resolution_note = 'A payment was recorded against this bill.'
   where charge_id = new.charge_id
     and resolved_at is null;
  return null;
end $function$;

drop trigger if exists trg_settle_claims_on_payment on public.park_payments;
create trigger trg_settle_claims_on_payment
  after insert or update of charge_id on public.park_payments
  for each row execute function public.settle_claims_on_payment();

-- 3. MONEY KEPT WITH NO REASON. Returning part of a deposit means the park
--    kept the rest, and that is the only money-out decision in the module with
--    nothing behind it. Reversal already demands a reason
--    (payment_reversal_has_a_reason); this is the same rule for the same kind
--    of act.
alter table public.park_payments drop constraint if exists park_payments_kept_deposit_has_a_reason;
alter table public.park_payments add constraint park_payments_kept_deposit_has_a_reason
  check (
    returned_on is null
    or returned_amount = amount
    or coalesce(btrim(return_note), '') <> ''
  );

do $$
declare lid uuid; pid uuid; lot uuid; ren uuid; res uuid; ch uuid; pay uuid; dep uuid;
        ok boolean; claim_state text;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0103 Proof','1 Rd','0103-proof', lid,'mh', false) returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'Lot 1', true,'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid,'0103 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange('2026-01-01','2027-01-01','[)'),'annual','active',500) returning id into res;
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, lines)
    values (pid, lot, res, ren,'2026-08', date '2026-08-01', 500,'[]'::jsonb) returning id into ch;

    -- (1) money is no longer destroyable by deleting the park
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on)
    values (pid, ren, ch, 500,'check', current_date) returning id into pay;
    ok := false;
    begin
      delete from public.parks where id = pid;
    exception when foreign_key_violation then ok := true;
    end;
    if not ok then raise exception '0103: DELETING A PARK STILL DESTROYS ITS PAYMENTS'; end if;

    -- (2) applying money to a disputed bill settles the claim
    delete from public.park_payments where id = pay;
    insert into public.park_payment_claims (charge_id, asserted_by, note)
    values (ch, 'renter', '0103 proof claim');
    insert into public.park_payments (park_id, renter_id, amount, method, received_on)
    values (pid, ren, 500,'check', current_date) returning id into pay;
    select resolution into claim_state from public.park_payment_claims where charge_id = ch;
    if claim_state is not null then raise exception '0103: unapplied money settled a claim it should not have'; end if;

    update public.park_payments set charge_id = ch where id = pay;
    select resolution into claim_state from public.park_payment_claims where charge_id = ch;
    if claim_state is distinct from 'matched' then
      raise exception '0103: applying money left the bill DISPUTED (claim=%)', coalesce(claim_state,'still open');
    end if;

    -- (3) keeping part of a deposit needs a reason
    insert into public.park_payments (park_id, renter_id, amount, method, received_on, kind)
    values (pid, ren, 300,'cash', current_date,'deposit') returning id into dep;
    ok := false;
    begin
      update public.park_payments set returned_on = current_date, returned_amount = 200 where id = dep;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0103: kept $100 of a deposit with no reason recorded'; end if;
    update public.park_payments
       set returned_on = current_date, returned_amount = 200, return_note = 'carpet'
     where id = dep;
    update public.park_payments set returned_on = null, returned_amount = null, return_note = null where id = dep;
    update public.park_payments set returned_on = current_date, returned_amount = 300 where id = dep;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
