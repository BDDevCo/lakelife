-- 0076 — GIVE THE RENTER SOMETHING BACK.
--
-- The two-party problem has one real cure: shrink the gap between "money
-- changed hands" and "somebody recorded it" to zero, and make sure the renter
-- walks away holding proof. Everything else — claims, disputed states — is
-- mitigation after the fact.
--
-- There are TWO moments, and they need different machinery:
--
--   ATTENDED. Cash or a check handed over in person. The office records it and
--   the renter leaves with a numbered receipt. Gap closed at the counter.
--
--   UNATTENDED. A secured drop box, which is what this park will realistically
--   have. Nobody is there. Nothing can be issued at the moment of payment, and
--   this is precisely where a household is most exposed — cash into a slot,
--   no trace, and the only record starts existing when somebody empties the box
--   days later.
--
--   The answer to that is not a phone. It is a NUMBERED TWO-PART SLIP at the
--   box: they fill both halves, drop one in with the money and keep the other.
--   A serial number nobody can backdate, a carbon of what they wrote, and it
--   works for the quarter to a third of this park who will never touch a
--   screen. If their half exists and no payment was ever recorded against that
--   serial, that is a dispute with a number on it.

-- ---------------------------------------------------------------- receipts --

alter table public.park_payments
  add column if not exists receipt_no integer,
  -- The serial off the slip they dropped in the box, when that is how it came.
  add column if not exists drop_slip_no text;

/**
 * Per-park receipt numbers, assigned in the database so nothing can bypass it.
 *
 * Sequential per park is what makes a receipt book auditable: a gap is visible.
 * park_payments deliberately carries no park_id (0072's note), so the number is
 * derived through the charge.
 *
 * The advisory lock is what makes concurrent recording safe — two people at two
 * screens cannot take the same number. It is transaction-scoped, so it releases
 * on commit or rollback without any cleanup.
 */
create or replace function public.assign_receipt_no()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; n integer;
begin
  if new.receipt_no is not null then return new; end if;

  select c.park_id into pid from public.park_charges c where c.id = new.charge_id;
  if pid is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended(pid::text, 0));

  select coalesce(max(p.receipt_no), 0) + 1 into n
    from public.park_payments p
    join public.park_charges c on c.id = p.charge_id
   where c.park_id = pid;

  new.receipt_no := n;
  return new;
end $$;

drop trigger if exists trg_assign_receipt_no on public.park_payments;
create trigger trg_assign_receipt_no
before insert on public.park_payments
for each row execute function public.assign_receipt_no();

-- -------------------------------------------------------------- drop slips --

-- Where the next printed slip starts. Printing a sheet advances it, so a serial
-- is never handed out twice — which is the only property that makes the slip
-- worth anything as evidence.
alter table public.parks
  add column if not exists next_drop_slip_no integer not null default 1
    check (next_drop_slip_no > 0);

-- Post-conditions: prove the numbering rather than trust it.
do $$
declare p uuid; l uuid; c1 uuid; c2 uuid; p2 uuid; l2 uuid; c3 uuid;
        a integer; b integer; other integer;
begin
  insert into public.parks (id, name) values (gen_random_uuid(), 'mig0076 probe A')
    returning id into p;
  insert into public.park_lots (park_id, lot_number) values (p, 'X') returning id into l;
  insert into public.park_charges (park_id, park_lot_id, period_month, due_on, amount)
    values (p, l, '2026-01', '2026-01-01', 100) returning id into c1;
  insert into public.park_charges (park_id, park_lot_id, period_month, due_on, amount)
    values (p, l, '2026-02', '2026-02-01', 100) returning id into c2;

  insert into public.park_payments (charge_id, amount, method, received_on)
    values (c1, 100, 'cash', '2026-01-02') returning receipt_no into a;
  insert into public.park_payments (charge_id, amount, method, received_on)
    values (c2, 100, 'check', '2026-02-02') returning receipt_no into b;

  if a <> 1 or b <> 2 then
    raise exception '0076: receipts did not run 1, 2 — got %, %', a, b;
  end if;

  -- A SECOND PARK STARTS AT 1. Receipt books are per park, not per database.
  insert into public.parks (id, name) values (gen_random_uuid(), 'mig0076 probe B')
    returning id into p2;
  insert into public.park_lots (park_id, lot_number) values (p2, 'Y') returning id into l2;
  insert into public.park_charges (park_id, park_lot_id, period_month, due_on, amount)
    values (p2, l2, '2026-01', '2026-01-01', 100) returning id into c3;
  insert into public.park_payments (charge_id, amount, method, received_on)
    values (c3, 100, 'cash', '2026-01-02') returning receipt_no into other;

  if other <> 1 then
    raise exception '0076: a second park did not start its own book — got %', other;
  end if;

  delete from public.park_payments where charge_id in (c1, c2, c3);
  delete from public.parks where id in (p, p2);
end $$;
