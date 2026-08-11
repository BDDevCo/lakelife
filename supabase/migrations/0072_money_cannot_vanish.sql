-- 0072 — RECORDED MONEY CANNOT BE DELETED BY SOMETHING ELSE'S CLEANUP.
--
-- park_payments.charge_id was ON DELETE CASCADE, and park_charges.park_lot_id
-- is ON DELETE CASCADE. So deleting a LOT deleted its bills, and deleting its
-- bills deleted the cash recorded against them — silently, with no error and no
-- trace, three tables away from whatever the operator thought they were doing.
--
-- That is not hypothetical. `undoImport` deletes a lot when no tenancy is left
-- on it, having itself just deleted the import's tenancies a few lines earlier.
-- So the guard passes in the ordinary case: import the roll, bill a month,
-- collect it, then undo the import — and every payment is gone while the screen
-- says "your roll is back how it was".
--
-- RESTRICT makes the whole chain refuse. A lot with money recorded against it
-- cannot be deleted by anybody, by any path, including one nobody has written
-- yet. Deleting money has to become a thing somebody does ON PURPOSE.

alter table public.park_payments
  drop constraint if exists park_payments_charge_id_fkey;

alter table public.park_payments
  add constraint park_payments_charge_id_fkey
  foreign key (charge_id) references public.park_charges(id)
  on delete restrict;

-- A BILL YOU HAVE TAKEN MONEY FOR CANNOT BE CANCELLED.
--
-- `voidCharge` sets status='void' with no look at paid_total, and on the rent
-- screen "Cancel this bill" sits directly beside "Record it". Cancelling a paid
-- bill makes the cash vanish from every accrual total while it sits in the bank
-- — the ledger's summarise() skips void charges entirely.
--
-- There is no refund path in this system yet. When there is, this constraint is
-- what forces the refund to be recorded rather than papered over by a void.
alter table public.park_charges
  drop constraint if exists park_charges_paid_cannot_void;

alter table public.park_charges
  add constraint park_charges_paid_cannot_void
  check (status <> 'void' or paid_total = 0);

-- Post-condition: prove both, by attempting the violation.
do $$
declare
  p uuid; l uuid; c uuid; ok boolean;
begin
  insert into public.parks (id, name) values (gen_random_uuid(), 'mig0072 probe')
    returning id into p;
  insert into public.park_lots (park_id, lot_number) values (p, 'X') returning id into l;
  insert into public.park_charges (park_id, park_lot_id, period_month, due_on, amount)
    values (p, l, '2026-01', '2026-01-01', 100) returning id into c;
  insert into public.park_payments (charge_id, amount, method, received_on)
    values (c, 100, 'check', '2026-01-02');

  begin
    delete from public.park_lots where id = l;
    ok := false;
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then
    raise exception '0072: deleting a lot still destroys recorded payments';
  end if;

  begin
    update public.park_charges set status = 'void',
      voided_at = now(), void_reason = 'probe' where id = c;
    ok := false;
  exception when check_violation then ok := true;
  end;
  if not ok then
    raise exception '0072: a paid charge can still be voided';
  end if;

  delete from public.park_payments where charge_id = c;
  delete from public.parks where id = p;
end $$;
