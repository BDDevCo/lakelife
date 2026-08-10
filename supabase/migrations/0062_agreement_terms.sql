-- ============================================================================
-- 0062 — AGREEMENTS HAVE A MAXIMUM LENGTH, AND RENEWING IS A NEW AGREEMENT.
--
-- THE OWNER'S RULE, for The Haven: no stay runs longer than three months.
-- Somebody may stay as long as they like, but each further period is a NEW
-- three-month agreement, executed on its own. If the periods are CONSECUTIVE,
-- no second deposit is collected.
--
-- WHY THIS IS NOT AN "EXTENSION". 0058 gave a renter a one-tap extend that
-- widens the existing range. That is the right model for a campsite and the
-- WRONG model here: if each period requires its own executed agreement, then
-- silently widening a date range destroys the very thing the structure exists
-- to produce — a discrete, signed, dated record per period. So a renewal
-- writes a SUCCESSOR ROW, and the two are tied together by a chain.
--
-- THE CHAIN IS THE UNIT THAT MATTERS. Not the agreement — the chain. It is
-- what a deposit attaches to, what "how long have they actually been here"
-- means, and what tells you that somebody on their eighth consecutive
-- three-month agreement has in practice lived here two years.
--
-- ---------------------------------------------------------------------------
-- A FLAG FOR COUNSEL, RECORDED HERE BECAUSE THE SCHEMA IS WHERE IT BITES:
-- serial short agreements are a recognised structure, and they are also
-- something courts in some jurisdictions look through. A resident who has held
-- a lot for two years via eight consecutive three-month agreements may be
-- treated as a long-term tenant whatever the paperwork says. This migration
-- therefore makes the chain length VISIBLE (agreement_seq) rather than hiding
-- it, so nobody has to reconstruct it later. LakeLife takes no position on
-- whether the structure achieves what it intends — that is a legal question.
-- ---------------------------------------------------------------------------
-- ============================================================================

-- ------------------------------------------------------------- park dials ---

-- NULL means "no cap" — a park that runs month-to-month or annual tenancies is
-- a normal park and must not be forced into this. The Haven sets 3.
alter table public.parks
  add column if not exists max_agreement_months smallint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_max_agreement_months_check') then
    alter table public.parks add constraint parks_max_agreement_months_check
      check (max_agreement_months is null or max_agreement_months between 1 and 120);
  end if;
end $$;

comment on column public.parks.max_agreement_months is
  'Longest single agreement this park writes. NULL = no cap. Staying longer '
  'means a NEW agreement, chained to the last one.';

-- What this park collects to hold a lot, once per unbroken chain of stays.
-- NULL means the park takes no deposit.
alter table public.parks
  add column if not exists deposit_amount numeric(10,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_deposit_amount_check') then
    alter table public.parks add constraint parks_deposit_amount_check
      check (deposit_amount is null or deposit_amount >= 0);
  end if;
end $$;


-- -------------------------------------------------------------- the chain ---

-- Consecutive agreements with the same person on the same lot share this.
-- Defaulted per row so every existing tenancy is trivially its own chain of
-- one, which is exactly what an inherited month-to-month tenancy is.
alter table public.lot_reservations
  add column if not exists agreement_chain_id uuid;

update public.lot_reservations
   set agreement_chain_id = id
 where agreement_chain_id is null;

alter table public.lot_reservations
  alter column agreement_chain_id set default gen_random_uuid();
alter table public.lot_reservations
  alter column agreement_chain_id set not null;

-- 1 for the first agreement, 2 for the first renewal, and so on. THE NUMBER
-- THAT MAKES A TWO-YEAR RESIDENCY VISIBLE instead of implied.
alter table public.lot_reservations
  add column if not exists agreement_seq smallint not null default 1;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lot_res_agreement_seq_check') then
    alter table public.lot_reservations add constraint lot_res_agreement_seq_check
      check (agreement_seq >= 1);
  end if;
end $$;

comment on column public.lot_reservations.agreement_seq is
  'Position in the chain. Eight consecutive three-month agreements is someone '
  'who has lived here two years — surfaced deliberately, not buried.';

-- What was actually collected to open THIS chain.
alter table public.lot_reservations
  add column if not exists deposit_amount numeric(10,2);
alter table public.lot_reservations
  add column if not exists deposit_collected_on date;

-- ---- THE RULE, ENFORCED BY THE DATABASE ----
--
-- A RENEWAL CANNOT CARRY A DEPOSIT. "If the stays are consecutive we will not
-- collect another deposit" is the owner's policy; this is the reason it cannot
-- be got wrong by an accident in a code path. The deposit belongs to the chain
-- and is recorded once, on the agreement that opened it.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lot_res_deposit_once_per_chain') then
    alter table public.lot_reservations add constraint lot_res_deposit_once_per_chain
      check (agreement_seq = 1 or (deposit_amount is null and deposit_collected_on is null));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lot_res_deposit_nonneg') then
    alter table public.lot_reservations add constraint lot_res_deposit_nonneg
      check (deposit_amount is null or deposit_amount >= 0);
  end if;
end $$;

create index if not exists lot_res_chain_idx
  on public.lot_reservations (agreement_chain_id, agreement_seq);


-- --------------------------------------------------- the term cap, guarded --
--
-- A CHECK constraint cannot read another table, so the park's cap is enforced
-- in the existing guard trigger. Written as an EXTENSION of the current
-- function body rather than a replacement, because that body already carries
-- three invariants worth keeping (0052, repointed by 0055).
--
-- Measured in DAYS against the month cap times 31, plus a day. Months are not
-- a fixed length and the point here is to catch a year written where a quarter
-- was meant — not to quibble over whether February makes it 89 days or 92.
create or replace function public.guard_lot_reservation()
returns trigger
language plpgsql security definer set search_path = public
as $function$
declare
  renter_account uuid;
  cap_months smallint;
  span_days int;
begin
  if new.renter_unit_id is not null
     and not exists (
       select 1 from public.renter_units u
        where u.id = new.renter_unit_id and u.renter_id = new.renter_id
     ) then
    raise exception
      'lot_reservations: unit % does not belong to renter file %',
      new.renter_unit_id, new.renter_id;
  end if;

  -- A tenancy must be inside ONE park: ll_manages_lot and ll_can_see_unit both
  -- key off the LOT, so a reservation pairing park A's lot with park B's renter
  -- file would hand park A's member a read on park B's renter and their rig.
  if not exists (
    select 1
      from public.park_lots pl
      join public.park_renters pr on pr.park_id = pl.park_id
     where pl.id = new.park_lot_id and pr.id = new.renter_id
  ) then
    raise exception
      'lot_reservations: renter file % is not in the park that owns lot %',
      new.renter_id, new.park_lot_id;
  end if;

  if new.decided_by is not null then
    select user_id into renter_account
      from public.park_renters where id = new.renter_id;

    if renter_account is not null and new.decided_by = renter_account
       and not exists (
         select 1
           from public.park_lots pl
           join public.park_members pm on pm.park_id = pl.park_id
          where pl.id = new.park_lot_id and pm.user_id = renter_account
       ) then
      raise exception 'lot_reservations: a renter cannot approve their own tenancy';
    end if;
  end if;

  -- 0062: no agreement may run longer than the park says one may.
  --
  -- GRANDFATHERED TENANCIES ARE EXEMPT. The 19 sitting tenants at The Haven
  -- were inherited as month-to-month and are written on a rolling one-year
  -- horizon; holding them to a cap they never agreed to would refuse the
  -- import outright on closing day. Converting them is a decision with its own
  -- notice, not a side effect of a schema change.
  if new.during is not null and new.origin is distinct from 'grandfathered' then
    select p.max_agreement_months into cap_months
      from public.park_lots pl
      join public.parks p on p.id = pl.park_id
     where pl.id = new.park_lot_id;

    if cap_months is not null then
      span_days := upper(new.during) - lower(new.during);
      if span_days > (cap_months::int * 31) + 1 then
        raise exception
          'lot_reservations: this park writes agreements of at most % months; that one runs % days. Renew instead — it chains to the last one.',
          cap_months, span_days;
      end if;
    end if;
  end if;

  return new;
end $function$;


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='lot_reservations'
     and column_name in ('agreement_chain_id','agreement_seq','deposit_amount','deposit_collected_on');
  if n <> 4 then
    raise exception '0062: expected 4 agreement columns, found %', n;
  end if;

  -- The one that makes the owner's deposit policy structural.
  if not exists (select 1 from pg_constraint where conname = 'lot_res_deposit_once_per_chain') then
    raise exception '0062: a renewal could record a second deposit';
  end if;

  if exists (select 1 from public.lot_reservations where agreement_chain_id is null) then
    raise exception '0062: a tenancy has no chain';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='parks' and column_name='max_agreement_months'
  ) then
    raise exception '0062: parks.max_agreement_months missing';
  end if;

  raise notice '0062: agreements are capped and chained; a deposit is collected once per chain.';
end $$;
