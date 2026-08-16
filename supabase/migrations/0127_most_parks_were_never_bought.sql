-- 0127 — MOST PARKS WERE NEVER BOUGHT
--
-- The park module was built while buying one, and it shows. A tenancy's
-- provenance can be `seller_roll`, screens say "off the seller's roll" and
-- "N days to closing", and the day-one flow is documented as "the first
-- afternoon after closing".
--
-- Every one of those is true of The Haven and false of the product. A park
-- owner who has held their park for eleven years and simply wants their
-- existing residents on LakeLife has no seller, no closing and no purchase —
-- and the first thing the software says to them is a word from somebody else's
-- transaction.
--
-- This is the same mistake as 0113's mow rate: a fact about The Haven baked in
-- as a default for every park. That one cost money. This one costs credibility
-- with park owner #2, which is the one we do not have yet.
--
-- ------------------------------------------------------------------ what --
--
-- `seller_roll` becomes `prior_roll`: the rent roll that existed before
-- LakeLife did. True whether it arrived from a seller at a closing table, from
-- the owner's own spreadsheet, or from a shoebox — which is the point.
--
-- The other four values were already agnostic and are untouched:
--   owner_knowledge   the owner told us
--   tenant_confirmed  the resident confirmed it
--   document          it is written down somewhere
--   self_signup       they signed themselves up
--
-- NO DATA MIGRATION IS NEEDED and that was checked, not assumed: zero rows in
-- either table currently hold the old value. The UPDATEs below are still here
-- because this file has to be correct on a database that DOES have some — a
-- rebuild, a branch, or a park imported between this being written and run.

alter table public.park_renters drop constraint if exists park_renters_source_check;
alter table public.lot_reservations drop constraint if exists lot_res_amount_source_check;

update public.park_renters     set source        = 'prior_roll' where source        = 'seller_roll';
update public.lot_reservations set amount_source = 'prior_roll' where amount_source = 'seller_roll';

alter table public.park_renters add constraint park_renters_source_check
  check (source in ('prior_roll', 'owner_knowledge', 'tenant_confirmed', 'document', 'self_signup'));

alter table public.lot_reservations add constraint lot_res_amount_source_check
  check (amount_source in ('prior_roll', 'owner_knowledge', 'tenant_confirmed', 'document', 'self_signup'));

comment on column public.park_renters.source is
  'Where this file came from. `prior_roll` = the rent roll that existed before '
  'LakeLife — a seller''s sheet, the owner''s spreadsheet, a shoebox. Renamed '
  'from `seller_roll` in 0127: most parks joining were never bought, and the '
  'product must not assume a transaction that only happened to us.';

comment on column public.lot_reservations.amount_source is
  'Where this RENT FIGURE came from, which is not the same question as where '
  'the tenancy came from. Rolls in this industry commonly run 10-20% inflated, '
  'so the rent roll shows its work rather than rendering a number as fact.';

-- ------------------------------------------------------- post-conditions --
do $$
declare
  ok boolean;
  n integer;
begin
  begin
    -- 1. THE OLD VALUE IS GONE FROM BOTH TABLES.
    select count(*) into n from public.park_renters where source = 'seller_roll';
    if n > 0 then raise exception '0127: % park_renters still on seller_roll', n; end if;
    select count(*) into n from public.lot_reservations where amount_source = 'seller_roll';
    if n > 0 then raise exception '0127: % tenancies still on seller_roll', n; end if;

    -- 2. AND IT CANNOT COME BACK. A constraint that still accepts the old
    --    value would let the importer keep writing it and nobody would notice
    --    until a park owner read the word "seller" on their own screen.
    ok := false;
    begin
      insert into public.park_renters (park_id, display_name, source)
      select id, 'zz-0127 proof', 'seller_roll' from public.parks limit 1;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0127: park_renters still accepts seller_roll'; end if;

    -- 3. THE NEW VALUE IS ACCEPTED.
    insert into public.park_renters (park_id, display_name, source)
    select id, 'zz-0127 proof', 'prior_roll' from public.parks limit 1;

    -- 4. AND THE FOUR THAT WERE ALREADY AGNOSTIC STILL WORK — including
    --    self_signup, which is what a resident claiming their own file will
    --    write and which 0055 has allowed since the day it was created.
    insert into public.park_renters (park_id, display_name, source)
    select id, 'zz-0127 proof', s
    from public.parks, unnest(array['owner_knowledge','tenant_confirmed','document','self_signup']) s
    limit 4;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
