-- ============================================================================
-- 0064 — GETTING THE PARK'S COSTS BACK, WITHOUT EVER GETTING BACK MORE.
--
-- WHAT THE OWNER ASKED FOR: recover water, sewer, trash, park lighting and
-- grounds — "basically the expenses that are in Michael's numbers year over
-- year". The seller's opex ran $37,968 → $41,200 across 2021-2025, and the
-- proforma expects ~$16,000/yr of it to come back from residents.
--
-- HOW IT WORKS, in one line: you enter what a bill actually cost, and the app
-- divides it across the lots that were OCCUPIED. Nothing is estimated, nothing
-- is marked up, and the bill you typed is kept as the evidence.
--
-- ---------------------------------------------------------------------------
-- THE CARDINAL RULE, AND IT IS A DATABASE CONSTRAINT:
--
--     YOU CANNOT BILL BACK MORE THAN YOU PAID.
--
--     check (allocated_total <= amount_paid)
--
-- Over-recovery is the single thing that turns cost recovery from a normal
-- landlord practice into a problem with a regulator and 19 households. It is
-- also the easiest thing in the world to do by accident: a rounding rule that
-- rounds UP, a lot added after the split, a bill edited downward after the
-- shares went out. So it is not a rule in a function somewhere — the row
-- physically cannot exist.
--
-- Rounding therefore goes DOWN, always, and THE PARK ABSORBS THE REMAINDER.
-- $100 across three lots is 33.33 each and the park eats a penny. The opposite
-- convention recovers $100.02 and breaks the rule above for one cent, which is
-- exactly the kind of detail that reads badly in a complaint.
--
-- VACANT LOTS DO NOT PAY, and the park absorbs their share. That is both
-- correct — nobody lives there to consume anything — and the right incentive.
-- ---------------------------------------------------------------------------
--
-- FOR COUNSEL, and this one is not optional:
--
--   * Indiana regulates how a mobile-home community may bill residents for
--     utilities. Whether these categories may be passed through at all, which
--     of them require disclosure in the agreement, and whether a non-utility
--     cost like GROUNDS or COMMON LIGHTING may sit in the same mechanism as
--     water and sewer are legal questions this schema does not answer. It
--     records categories separately precisely so they can be treated
--     differently once somebody qualified says how.
--   * LakeLife takes no position on which categories are recoverable. It
--     enforces only the arithmetic: never more than was paid.
-- ============================================================================

-- ------------------------------------------------------------- the bills ---
create table if not exists public.park_costs (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,

  -- SEPARATE CATEGORIES ON PURPOSE. Water and sewer are utilities; grounds and
  -- common lighting are services. They may well be treated differently in law
  -- and in the agreement, and a single "utilities" bucket would make that
  -- distinction impossible to draw later without unpicking history.
  category      text not null check (category in
                  ('water', 'sewer', 'trash', 'common_electric', 'grounds', 'other')),

  -- Half-open, like every other range in this schema.
  period_start  date not null,
  period_end    date not null,

  -- WHAT THE PARK ACTUALLY PAID. Off the bill, not an estimate.
  amount_paid   numeric(10,2) not null check (amount_paid >= 0),

  -- What has been handed to residents. Maintained by trigger; the constraint
  -- below is the one that matters.
  allocated_total numeric(10,2) not null default 0 check (allocated_total >= 0),

  allocation_method text not null default 'per_lot'
                      check (allocation_method in ('per_lot', 'metered')),

  -- The bill, in his words: "March water, Wolcottville Utilities, acct 4471".
  source_note   text,
  allocated_at  timestamptz,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint park_costs_period_real check (period_end > period_start),

  -- ---- THE CARDINAL RULE ----
  constraint park_costs_never_over_recover check (allocated_total <= amount_paid)
);

comment on table public.park_costs is
  'One bill the park paid. allocated_total can never exceed amount_paid — that '
  'constraint is the whole point of the table.';

create index if not exists park_costs_park_idx
  on public.park_costs (park_id, period_start desc);


-- ------------------------------------------------------------ the shares ---
create table if not exists public.lot_cost_shares (
  id           uuid primary key default gen_random_uuid(),
  cost_id      uuid not null references public.park_costs(id) on delete cascade,
  park_lot_id  uuid not null references public.park_lots(id) on delete cascade,

  -- WHO was on the lot when this was split. Kept so a share can still be
  -- explained after somebody moves out.
  reservation_id uuid references public.lot_reservations(id) on delete set null,

  amount       numeric(10,2) not null check (amount >= 0),

  -- The sentence the resident reads: "1 of 19 occupied lots".
  basis        text,
  created_at   timestamptz not null default now(),

  -- One share per lot per bill. A second would be a double charge.
  unique (cost_id, park_lot_id)
);

create index if not exists lot_cost_shares_lot_idx
  on public.lot_cost_shares (park_lot_id, created_at desc);


-- --------------------------------------------- keeping the total honest ----
--
-- The trigger recomputes from the shares themselves rather than adding a
-- delta, so a bad update cannot drift the total away from reality. With ~20
-- lots per bill the sum is trivial, and correctness is worth more than the
-- microseconds.
create or replace function public.sync_cost_allocated()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare target uuid;
begin
  target := coalesce(new.cost_id, old.cost_id);
  update public.park_costs c
     set allocated_total = coalesce(
           (select sum(s.amount) from public.lot_cost_shares s where s.cost_id = target), 0)
   where c.id = target;
  return null;
end $$;

drop trigger if exists trg_sync_cost_allocated on public.lot_cost_shares;
create trigger trg_sync_cost_allocated
after insert or update or delete on public.lot_cost_shares
for each row execute function public.sync_cost_allocated();


-- --------------------------------------------------- the park-owned home ---
--
-- Lot 7 at The Haven carries a double-wide the PARK owns and rents out. It is
-- not a pad someone parks their own home on, and the rent is a HOME rent, so
-- the roll should not quietly present the two as the same thing.
alter table public.park_lots
  add column if not exists park_owned_home boolean not null default false;

comment on column public.park_lots.park_owned_home is
  'The park owns the home standing on this lot and rents it out. The rent is '
  'for the HOME, not the pad — and the park, not the resident, maintains it.';


-- ---------------------------------------------------------------- rls -------
alter table public.park_costs      enable row level security;
alter table public.lot_cost_shares enable row level security;

drop policy if exists park_costs_read on public.park_costs;
create policy park_costs_read on public.park_costs
  for select to authenticated
  using (public.ll_manages_park(park_id) or public.ll_is_ops());

-- A resident may see their OWN share — it is their bill — and the park team
-- sees all of them. Deliberately NOT the park's total: what the park paid for
-- the whole roll is the park's business.
drop policy if exists lot_cost_shares_read on public.lot_cost_shares;
create policy lot_cost_shares_read on public.lot_cost_shares
  for select to authenticated
  using (
    public.ll_manages_lot(park_lot_id)
    or public.ll_is_ops()
    or exists (
      select 1
        from public.lot_reservations lr
        join public.park_renters pr on pr.id = lr.renter_id
       where lr.id = lot_cost_shares.reservation_id
         and pr.user_id = auth.uid()
    )
  );

revoke all on public.park_costs      from anon;
revoke all on public.lot_cost_shares from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.park_costs from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.lot_cost_shares from authenticated;
grant select on public.park_costs      to authenticated;
grant select on public.lot_cost_shares to authenticated;


-- ------------------------------------------------------ post-conditions -----
do $$
begin
  if to_regclass('public.park_costs') is null then
    raise exception '0064: park_costs missing';
  end if;
  if to_regclass('public.lot_cost_shares') is null then
    raise exception '0064: lot_cost_shares missing';
  end if;

  -- The one that matters more than the rest put together.
  if not exists (select 1 from pg_constraint where conname = 'park_costs_never_over_recover') then
    raise exception '0064: the park could bill back more than it paid';
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_sync_cost_allocated') then
    raise exception '0064: allocated_total would drift from the shares';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public' and table_name in ('park_costs','lot_cost_shares')
       and grantee='anon'
  ) then
    raise exception '0064: anon holds a grant on a cost table';
  end if;

  raise notice '0064: costs recover, and never more than was paid.';
end $$;
