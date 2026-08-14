-- 0112 — THE PARK CARRIES THE EMPTY LOTS.
--
-- Brendon: "it needs to be allocated across all rentable lots and even shared
-- with the STR lots, rented or not. the lots that are empty have to be paid
-- for by the park owner."
--
-- He is right, and the code has been claiming to do this while doing the
-- opposite. `allocateCost` divides by OCCUPIED lots, so the empties were
-- already excluded from the denominator and what the park "absorbed" was the
-- rounding remainder. On a $400 bill the costs screen tells him:
--
--     "You carry $0.05 — 2 empty lots."
--
-- Five cents, labelled as the cost of two vacancies.
--
-- ================== WHAT THE RESIDENT NOTICES ==================
--
-- Dividing by occupied lots means a household's utility share MOVES WHEN
-- THEIR NEIGHBOURS MOVE. Same $1,140 water bill, same month, same water:
--
--     19 occupied -> $60.00 each
--     15 occupied -> $76.00 each     (+26.7%, for a reason that is not theirs)
--      1 occupied -> $1,140.00       (the last tenant pays for the whole park)
--
-- That last line is not a hypothetical; it is what the formula does. Dividing
-- by RENTABLE lots holds every one of those at $54.28 and puts the difference
-- where the risk actually sits — vacancy is the landlord's, not the
-- neighbours'.
--
-- ================== WHY THIS NEEDS COLUMNS ==================
--
-- `park_lots` has no history. Without a snapshot, the same July bill split on
-- 1 August (21 lots) and re-examined in September after four homes go live
-- (25 lots) gives two different answers for a closed month, and nothing
-- records which denominator was actually used. "The park absorbs the empty
-- lots" has to be a fact in a row, not a sentence on a screen.
--
-- ================== WHY NO SHARE ROW FOR AN EMPTY LOT ==================
--
-- `lot_cost_shares.reservation_id` is nullable, so a share for a vacant or
-- park-owned lot is physically storable. It must not be stored:
--
--   * it could never be billed — the charge run reads
--     `.in("reservation_id", ids)` and NULL matches no IN list;
--   * `sync_cost_allocated` would still count it into `allocated_total`, so
--     the screen would say the money was passed on when it never was;
--   * and `park_absorbed` would read $0.00 while the park carried it — the
--     exact inversion of the thing being built.
--
-- So the empties and the park-owned homes are in the DENOMINATOR and never in
-- a share. A trigger enforces it, so no later writer can reintroduce the row.

alter table public.park_costs
  add column if not exists park_absorbed    numeric(10,2) not null default 0
    check (park_absorbed >= 0),
  add column if not exists denominator_lots integer,
  add column if not exists payer_lots       integer;

comment on column public.park_costs.park_absorbed is
  'What the PARK carried on this bill: the vacant lots'' share, the '
  'park-owned homes'' share, and the rounding remainder. A snapshot taken when '
  'the split was recorded, because park_lots has no history.';

comment on column public.park_costs.denominator_lots is
  'The R in "1 of R rentable lots" at the moment of the split — every lot that '
  'could be rented, occupied or not, including the park''s own homes.';

comment on column public.park_costs.payer_lots is
  'How many of those R lots actually had somebody to bill. R minus this is '
  'what the park carried, and why.';

-- A share must have somebody to bill. See the header.
create or replace function public.guard_cost_share_has_payer()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  if new.reservation_id is null then
    raise exception 'lot_cost_shares: a share with no tenancy can never be billed, but WOULD be counted as allocated — a vacant or park-owned lot belongs in the denominator and in park_absorbed, never in a share row';
  end if;
  return new;
end $function$;

-- BEFORE INSERT only, deliberately. 0064 made the reservation FK
-- `on delete set null` so removing a tenancy does not destroy the money
-- record; an UPDATE guard would break that.
drop trigger if exists trg_cost_share_has_payer on public.lot_cost_shares;
create trigger trg_cost_share_has_payer
  before insert on public.lot_cost_shares
  for each row execute function public.guard_cost_share_has_payer();

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; lot uuid; ren uuid; res uuid; cost uuid; sh uuid;
        ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0112 Proof','1 Rd','0112-proof', lid,'mh', false) returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'1', true,'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid,'0112 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange('2026-01-01','2027-01-01','[)'),'monthly','active', 500)
    returning id into res;

    insert into public.park_costs
      (park_id, category, period_start, period_end, amount_paid, allocated_total,
       park_absorbed, denominator_lots, payer_lots)
    values (pid,'water', date '2026-07-01', date '2026-07-31', 1140, 1031.32,
            108.68, 21, 19)
    returning id into cost;

    -- 1. THE SNAPSHOT SURVIVES. It is what makes a closed month re-checkable
    --    after the roll changes.
    if (select denominator_lots from public.park_costs where id = cost) <> 21
       or (select park_absorbed from public.park_costs where id = cost) <> 108.68 then
      raise exception '0112: the split did not record its own denominator';
    end if;

    -- 2. A SHARE WITH A PAYER IS FINE.
    insert into public.lot_cost_shares (cost_id, park_lot_id, reservation_id, amount, basis)
    values (cost, lot, res, 54.28, '1 of 21 rentable lots') returning id into sh;

    -- 3. A SHARE WITH NOBODY TO BILL IS REFUSED. This is the row that would
    --    read as "passed on" forever while nobody was ever asked for it.
    ok := false;
    begin
      insert into public.lot_cost_shares (cost_id, park_lot_id, reservation_id, amount, basis)
      values (cost, lot, null, 54.28, 'the empty one');
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0112: a share was stored for a lot with no tenancy — it can never be billed and would still count as allocated';
    end if;

    -- 4. ENDING A TENANCY STILL LEAVES THE MONEY RECORD STANDING. 0064 made
    --    the FK `on delete set null` for exactly this; a BEFORE INSERT guard
    --    must not have broken it.
    delete from public.lot_reservations where id = res;
    if (select count(*) from public.lot_cost_shares where id = sh) <> 1 then
      raise exception '0112: deleting a tenancy destroyed the share it was billed';
    end if;
    if (select reservation_id from public.lot_cost_shares where id = sh) is not null then
      raise exception '0112: the share still points at a tenancy that is gone';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
