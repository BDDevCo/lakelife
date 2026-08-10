-- ============================================================================
-- 0067 — A FLAT FEE THAT COVERS THE LOT, AND THE ARITHMETIC THAT CHECKS IT.
--
-- THE OWNER'S CORRECTION, and it is the right one: per-bill RUBS allocation is
-- an apartment mechanism. A park charges ONE RECURRING FEE per lot — call it a
-- grounds fee — that covers water, sewer, trash, unmetered electricity and
-- maintenance together. The resident pays a number they can predict, and the
-- park stops re-deriving twenty shares every time a bill lands.
--
-- SO WHAT WERE THE BILLS FOR (0064)? They become the CHECK rather than the
-- billing. The fee is what he charges; park_costs is what he actually pays;
-- the difference is the only honest answer to "is my grounds fee set right?".
-- A park charging $50 against $71 of real cost is losing $21 a lot a month and
-- will not notice for a year. That comparison is the entire point of keeping
-- both tables.
--
-- WHAT A FEE COVERS IS DISCLOSED, not implied. `covers` is an allowlist drawn
-- from the same vocabulary as park_costs.category, which is what makes the
-- comparison above possible at all — a free-text "utilities and stuff" could
-- never be reconciled against anything.
--
-- FOR COUNSEL, same flag as 0064 and it does not go away by renaming the
-- mechanism: a flat fee bundling utilities may be treated differently from a
-- metered pass-through, and what must be disclosed in the agreement is a legal
-- question. The schema records what is charged and what it claims to cover.
-- It takes no position on whether that is permitted.
-- ============================================================================

create table if not exists public.park_fees (
  id         uuid primary key default gen_random_uuid(),
  park_id    uuid not null references public.parks(id) on delete cascade,

  -- In the owner's words, because it prints on a resident's bill.
  label      text not null check (length(trim(label)) between 2 and 60),
  amount     numeric(10,2) not null check (amount >= 0),

  cadence    text not null default 'monthly'
               check (cadence in ('monthly', 'per_stay', 'annual', 'one_time')),

  -- WHO PAYS IT. A grounds fee usually lands on everyone who lives there; a
  -- pet fee only on the people who opted in.
  applies_to text not null default 'long_term'
               check (applies_to in ('all_lots', 'long_term', 'short_term', 'opt_in')),

  -- WHAT IT COVERS, in the same vocabulary as park_costs.category so the two
  -- can be reconciled. This is what turns a fee from a number into a promise
  -- that can be checked.
  covers     text[] not null default '{}',

  active     boolean not null default true,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint park_fees_covers_known check (
    covers <@ array[
      'water', 'sewer', 'trash', 'common_electric', 'grounds',
      'maintenance', 'snow', 'pest', 'amenities', 'other'
    ]::text[]
  )
);

comment on table public.park_fees is
  'A recurring charge on top of rent. `covers` uses park_costs.category '
  'vocabulary so what the fee CLAIMS to cover can be reconciled against what '
  'the park actually paid.';

create index if not exists park_fees_park_idx
  on public.park_fees (park_id) where active;

-- Who is actually on an opt-in fee. A pet fee is not a park-wide fact.
create table if not exists public.lot_fee_assignments (
  id             uuid primary key default gen_random_uuid(),
  fee_id         uuid not null references public.park_fees(id) on delete cascade,
  park_lot_id    uuid not null references public.park_lots(id) on delete cascade,
  reservation_id uuid references public.lot_reservations(id) on delete set null,
  -- Overrides the fee's amount for this lot. Null = the standard amount.
  amount         numeric(10,2) check (amount is null or amount >= 0),
  quantity       smallint not null default 1 check (quantity > 0),
  created_at     timestamptz not null default now(),
  unique (fee_id, park_lot_id)
);


-- ------------------------------------------------- the agreement default ---
--
-- "Three months max, but typically month to month." The CAP and the DEFAULT
-- are different numbers and conflating them writes every new tenant a
-- three-month agreement when the house style is one month rolling.
alter table public.parks
  add column if not exists default_agreement_months smallint not null default 1;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_default_agreement_check') then
    alter table public.parks add constraint parks_default_agreement_check
      check (default_agreement_months between 1 and 120);
  end if;
end $$;

-- A default longer than the maximum is a contradiction the database can catch
-- once, rather than a surprise the guard trigger raises on every insert.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_default_within_max') then
    alter table public.parks add constraint parks_default_within_max
      check (
        max_agreement_months is null
        or default_agreement_months <= max_agreement_months
      );
  end if;
end $$;

comment on column public.parks.default_agreement_months is
  'What a new agreement is written for unless told otherwise. The Haven: 1 '
  '(month to month), capped at 3 by max_agreement_months.';


-- ---------------------------------------------------------------- rls -------
alter table public.park_fees            enable row level security;
alter table public.lot_fee_assignments  enable row level security;

drop policy if exists park_fees_read on public.park_fees;
create policy park_fees_read on public.park_fees
  for select to authenticated
  using (public.ll_manages_park(park_id) or public.ll_is_ops());

drop policy if exists lot_fee_assignments_read on public.lot_fee_assignments;
create policy lot_fee_assignments_read on public.lot_fee_assignments
  for select to authenticated
  using (
    public.ll_manages_lot(park_lot_id)
    or public.ll_is_ops()
    or exists (
      select 1 from public.lot_reservations lr
        join public.park_renters pr on pr.id = lr.renter_id
       where lr.id = lot_fee_assignments.reservation_id and pr.user_id = auth.uid()
    )
  );

revoke all on public.park_fees           from anon;
revoke all on public.lot_fee_assignments from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.park_fees from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.lot_fee_assignments from authenticated;
grant select on public.park_fees           to authenticated;
grant select on public.lot_fee_assignments to authenticated;


-- ------------------------------------------------------ post-conditions -----
do $$
begin
  if to_regclass('public.park_fees') is null then
    raise exception '0067: park_fees missing';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'park_fees_covers_known') then
    raise exception '0067: a fee could claim to cover something nothing can reconcile';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'parks_default_within_max') then
    raise exception '0067: a park could default to an agreement longer than its own cap';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public' and table_name in ('park_fees','lot_fee_assignments')
       and grantee='anon'
  ) then
    raise exception '0067: anon holds a grant on a fee table';
  end if;

  raise notice '0067: a fee says what it covers, and the cap and the default are different numbers.';
end $$;
