-- 0104 — A COST SHARE REACHES A BILL.
--
-- `recordCost` splits a bill across the lots and writes a row per household
-- into `lot_cost_shares`. That table has exactly TWO references in the whole
-- codebase: that insert, and a row count. Nothing bills from it.
--
-- So the owner enters the water bill, taps "save it and split it", the costs
-- screen reads "passed on $1,140" — and not one household is ever asked for a
-- cent of it. Worse, "recovered" on that screen is computed from
-- `park_costs.allocated_total`, which is the amount he INTENDED to split. It
-- is a synonym for "allocated" wearing the name of money that came back. The
-- proforma expects roughly $16,000 a year through this path.
--
-- HOW IT REACHES A HOUSEHOLD: as a LINE on their next rent bill, not as a
-- separate charge. `park_charges.lines` is already a jsonb statement and
-- `buildStatement` already composes it, so a share becomes "Water — your
-- share" beside the rent. That also sidesteps the one-live-charge-per-month
-- unique index entirely: no new charge, no collision, no new charge `kind`.
--
-- BILLED ONCE, EVER. `billed_on_charge_id` is what makes the run idempotent
-- and gives this table the reader it never had. A share with a charge is spent;
-- a share without one is waiting. Voiding a charge releases its shares, or
-- cancelling a wrong bill would silently swallow the water money with it —
-- the same lesson 0101 learned about a voided month.

alter table public.lot_cost_shares
  add column if not exists billed_on_charge_id uuid
    references public.park_charges(id) on delete set null;

comment on column public.lot_cost_shares.billed_on_charge_id is
  'The charge this share was billed on, or NULL when it is still waiting. '
  'Set by the charge run, cleared when that charge is voided. The difference '
  'between allocated and BILLED is the difference between what the owner '
  'intended to pass on and what a household was actually asked for.';

-- The run reads exactly this: unbilled shares for these tenancies.
create index if not exists lot_cost_shares_unbilled_idx
  on public.lot_cost_shares (reservation_id)
  where billed_on_charge_id is null;

create index if not exists lot_cost_shares_charge_idx
  on public.lot_cost_shares (billed_on_charge_id)
  where billed_on_charge_id is not null;

do $$
declare lid uuid; pid uuid; lot uuid; ren uuid; res uuid; ch uuid; cost uuid; sh uuid;
        still_there uuid;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0104 Proof','1 Rd','0104-proof', lid,'mh', false) returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'Lot 1', true,'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid,'0104 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange('2026-01-01','2027-01-01','[)'),'annual','active',500) returning id into res;
    insert into public.park_costs (park_id, category, period_start, period_end, amount_paid, allocated_total, allocation_method)
    values (pid,'water', date '2026-07-01', date '2026-07-31', 1140, 1140, 'per_lot') returning id into cost;
    insert into public.lot_cost_shares (cost_id, park_lot_id, reservation_id, amount, basis)
    values (cost, lot, res, 60, 'per lot') returning id into sh;
    insert into public.park_charges (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, lines)
    values (pid, lot, res,ren,'2026-08', date '2026-08-01', 560,'[]'::jsonb) returning id into ch;

    -- 1. A share starts unbilled — which is what the run looks for.
    if (select billed_on_charge_id from public.lot_cost_shares where id = sh) is not null then
      raise exception '0104: a new share was already marked billed';
    end if;

    -- 2. Billing it stamps the charge.
    update public.lot_cost_shares set billed_on_charge_id = ch where id = sh;
    if (select billed_on_charge_id from public.lot_cost_shares where id = sh) <> ch then
      raise exception '0104: the share did not record which bill carried it';
    end if;

    -- 3. THE ONE THAT MATTERS: voiding the bill must RELEASE the share, not
    --    destroy it. Cancelling a wrong bill silently swallowing the water
    --    money is the same defect 0101 fixed for a voided month.
    update public.park_charges set status = 'void', voided_at = now(), void_reason = '0104 proof' where id = ch;
    delete from public.park_charges where id = ch;
    select id into still_there from public.lot_cost_shares where id = sh;
    if still_there is null then
      raise exception '0104: deleting the charge DESTROYED the cost share';
    end if;
    if (select billed_on_charge_id from public.lot_cost_shares where id = sh) is not null then
      raise exception '0104: the share still points at a charge that is gone';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
