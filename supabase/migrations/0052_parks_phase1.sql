-- ============================================================================
-- 0052 — PARKS, PHASE 1: inventory, tenancy, and services for a mobile-home /
--        RV park run on LakeLife.
--
-- Design: docs/park-module-design.md. A park owner adopts LakeLife.ai as their
-- park management system; their renters become platform customers scoped to
-- that park. The software is the channel, the SERVICES are the business.
--
-- WHAT THIS PHASE DELIBERATELY DOES NOT DO — all the risk lives here:
--   * NO rent, NO invoices, NO payouts, NO money movement of any kind. Rent is
--     a pass-through with zero margin and must NEVER enter the job/invoice
--     pipeline (six concrete breakages documented in the design doc, starting
--     with expireUnfilledJobs CANCELLING a rent row and texting the renter
--     "we couldn't line up a crew in time").
--   * NO documents, NO leases, NO driver's licences. The per-record signer and
--     the storage-erase path must exist before the first upload; neither does.
--   * NO screening. Building it could make LakeLife a Consumer Reporting
--     Agency under the FCRA.
--
-- FOUR CONSTRAINTS FROM THE BACKEND MAPPING, each of which would have broken
-- something if ignored:
--   1. A LOT IS NOT A `properties` ROW. properties.place_id carries a GLOBAL
--      unique index and every lot in a park shares the park's one Google Place
--      ID, so lot #2 would fail with "this property already has a profile".
--      Lots are their own table; a lot gains a properties row only when a
--      tenancy goes active, owned by the RENTER (the person we charge and
--      text), with place_id NULL.
--   2. NO NEW user_role VALUE. `services_read` grants SELECT on services only
--      to ops or role='owner', so a role='renter' would render an EMPTY
--      services menu with no error — killing the service capture that
--      justifies the whole module. Park identity lives in side tables.
--   3. NEVER WIDEN ll_is_ops(). A park owner with the ops role would see every
--      homeowner's price, LakeLife's margin, and every crew's W-9. Park
--      visibility gets its own definer helper, scoped to their park.
--   4. SHIP DARK. parks.active is the launch switch, following the
--      service_packages.active precedent.
-- ============================================================================

-- btree_gist lets an exclusion constraint mix equality (the lot) with overlap
-- (the date range) — this is what makes double-booking impossible in the
-- DATABASE rather than by convention.
create extension if not exists btree_gist;


-- =============================================================== PARKS ======
create table if not exists public.parks (
  id                 uuid primary key default gen_random_uuid(),
  lake_id            uuid references public.lakes(id) on delete set null,
  name               text not null,
  slug               text unique,
  address            text,
  lat                double precision,
  lng                double precision,

  -- ---- the setup interview: every park runs differently, so these are DIALS,
  -- ---- not assumptions. Rule 8 — configuration lives in the database.
  park_type          text not null default 'mixed'
                       check (park_type in ('mh', 'rv', 'mixed')),
  -- 55+ is declared by the park owner. It is NOT just a filter: it gates
  -- whether the application may ask for age AT ALL. In an all-ages park there
  -- is no legitimate purpose for a date of birth and collecting one leaves a
  -- familial-status exposure sitting in the record forever.
  age_restricted     boolean not null default false,
  -- Null = year-round. A seasonal park closes for the winter.
  season_open_month  smallint check (season_open_month between 1 and 12),
  season_open_day    smallint check (season_open_day between 1 and 31),
  season_close_month smallint check (season_close_month between 1 and 12),
  season_close_day   smallint check (season_close_day between 1 and 31),
  -- Most park owners want to approve a renter before they move in. Default to
  -- the safer answer.
  approval_required  boolean not null default true,
  included_utilities text[] not null default '{}',
  house_rules        text,          -- displayed to renters, never enforced by software

  active             boolean not null default false,   -- THE LAUNCH SWITCH
  created_at         timestamptz not null default now()
);

create index if not exists parks_lake_idx on public.parks(lake_id);
create index if not exists parks_active_idx on public.parks(active) where active;


-- ====================================================== PARK MEMBERS ========
-- Who may administer a park. This is how a park owner gets authority WITHOUT
-- the ops role — see constraint 3 above.
create table if not exists public.park_members (
  park_id    uuid not null references public.parks(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'manager')),
  created_at timestamptz not null default now(),
  primary key (park_id, user_id)
);

create index if not exists park_members_user_idx on public.park_members(user_id);


-- ============================================================== LOTS ========
create table if not exists public.park_lots (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,
  lot_number    text not null,
  site_type     text not null default 'rv_full'
                  check (site_type in ('mh_pad', 'rv_full', 'rv_we', 'tent', 'slip_only')),

  -- FIT CONSTRAINTS. Matching data, not decoration: a 40-foot RV cannot go on
  -- a 30-foot pad, and offering it is a cancelled booking and an angry phone
  -- call on arrival day.
  max_length_ft smallint check (max_length_ft is null or max_length_ft > 0),
  amperage      smallint check (amperage is null or amperage in (20, 30, 50, 100)),
  has_water     boolean not null default true,
  has_sewer     boolean not null default false,
  slip_included boolean not null default false,

  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (park_id, lot_number)
);

create index if not exists park_lots_park_idx on public.park_lots(park_id) where active;


-- ======================================================== LOT RATES =========
-- The park owner dictates the money. LakeLife never prices a lot — this table
-- is the park's own rate card, one row per term it sells (rule 8).
create table if not exists public.lot_rates (
  id           uuid primary key default gen_random_uuid(),
  park_lot_id  uuid not null references public.park_lots(id) on delete cascade,
  term         text not null check (term in ('nightly', 'weekly', 'monthly', 'seasonal', 'annual')),
  amount       numeric(10,2) not null check (amount >= 0),
  created_at   timestamptz not null default now(),
  unique (park_lot_id, term)
);


-- ==================================================== RENTER UNITS ==========
-- The renter OWNS the mobile home or RV and RENTS the lot. The unit's size
-- decides which lots fit, and its type decides which services apply —
-- winterizing a park model is not winterizing a travel trailer.
create table if not exists public.renter_units (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  unit_type   text not null default 'rv'
                check (unit_type in ('mobile_home', 'park_model', 'travel_trailer', 'fifth_wheel', 'motorhome', 'rv')),
  make        text,
  model       text,
  year        smallint,
  length_ft   smallint check (length_ft is null or length_ft > 0),
  created_at  timestamptz not null default now()
);

create index if not exists renter_units_user_idx on public.renter_units(user_id);


-- ================================================= LOT RESERVATIONS =========
-- Exclusive occupancy of a lot over a DATE RANGE, priced by term. The closest
-- existing cousin in this codebase is storage_stays (intake -> occupancy ->
-- release); this is that shape plus a rate and an approval.
create table if not exists public.lot_reservations (
  id             uuid primary key default gen_random_uuid(),
  park_lot_id    uuid not null references public.park_lots(id) on delete cascade,
  renter_user_id uuid not null references public.users(id) on delete cascade,
  renter_unit_id uuid references public.renter_units(id) on delete set null,

  during         daterange not null,
  term           text not null check (term in ('nightly', 'weekly', 'monthly', 'seasonal', 'annual')),
  -- What the park owner's rate card said AT THE TIME. Snapshotted so a later
  -- rate change never rewrites what a renter agreed to.
  quoted_amount  numeric(10,2) check (quoted_amount is null or quoted_amount >= 0),

  status         text not null default 'applied'
                   check (status in ('applied', 'approved', 'declined', 'active', 'ended', 'cancelled')),
  -- Set when a park member decides. NOT a screening result — the platform
  -- records a human's decision and never produces or suggests one.
  decided_by     uuid references public.users(id) on delete set null,
  decided_at     timestamptz,

  -- The properties row minted when this tenancy goes active, so the renter can
  -- book ordinary lake services against their lot through the existing engine.
  -- Owned by the RENTER: properties.owner_id must keep meaning exactly one
  -- thing — "the person we charge and text" — which 30+ call sites assume.
  service_property_id uuid references public.properties(id) on delete set null,

  created_at     timestamptz not null default now(),

  check (not isempty(during))
);

-- NO DOUBLE BOOKING, enforced by Postgres rather than by hope. Two people may
-- both APPLY for the same lot (the park owner picks); only a decision holds
-- the dates.
alter table public.lot_reservations
  drop constraint if exists lot_no_double_booking;
alter table public.lot_reservations
  add constraint lot_no_double_booking
  exclude using gist (park_lot_id with =, during with &&)
  where (status in ('approved', 'active'));

-- THE TWO RULES ABOVE THAT SQL ALONE CANNOT STATE. 0050's lesson, applied on
-- day one instead of after an audit: if the comments claim a rule, the database
-- has to hold it. Both are reachable only by the service role today, which is
-- exactly the argument that was wrong last time — a server action is one bad
-- refactor away from writing either of these.
create or replace function public.guard_lot_reservation()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- 1. The unit on a reservation must belong to the renter on it. Otherwise a
  --    park owner reviewing an application reads someone else's rig — wrong
  --    length, wrong type, and a fit check that passes on the wrong data.
  if new.renter_unit_id is not null
     and not exists (
       select 1 from public.renter_units u
        where u.id = new.renter_unit_id and u.user_id = new.renter_user_id
     ) then
    raise exception
      'lot_reservations: unit % does not belong to renter %',
      new.renter_unit_id, new.renter_user_id;
  end if;

  -- 2. A renter may not be recorded as deciding their own tenancy — UNLESS they
  --    administer the park. An owner who keeps a lot for themselves or family is
  --    a real arrangement, and blocking it would be a bug of its own.
  if new.decided_by is not null
     and new.decided_by = new.renter_user_id
     and not exists (
       select 1
         from public.park_lots pl
         join public.park_members pm on pm.park_id = pl.park_id
        where pl.id = new.park_lot_id and pm.user_id = new.renter_user_id
     ) then
    raise exception 'lot_reservations: a renter cannot approve their own tenancy';
  end if;

  return new;
end $$;

drop trigger if exists lot_res_guard on public.lot_reservations;
create trigger lot_res_guard
  before insert or update on public.lot_reservations
  for each row execute function public.guard_lot_reservation();

create index if not exists lot_res_lot_idx    on public.lot_reservations(park_lot_id);
create index if not exists lot_res_renter_idx on public.lot_reservations(renter_user_id);
create index if not exists lot_res_status_idx on public.lot_reservations(status);


-- ================================================= AUTHORIZATION ============
-- Park authority WITHOUT the ops role. Definer functions, matching the
-- ll_is_ops / ll_my_vendor_id convention in 0002 — a policy's own subquery
-- over another RLS-protected table silently returns nothing, which 0010
-- documents the hard way.
create or replace function public.ll_my_park_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$ select park_id from public.park_members where user_id = auth.uid() $$;

create or replace function public.ll_manages_park(p uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
        select 1 from public.park_members
         where park_id = p and user_id = auth.uid()
      ) $$;

-- Is this lot inside a park the caller administers?
create or replace function public.ll_manages_lot(l uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
        select 1
          from public.park_lots pl
          join public.park_members pm on pm.park_id = pl.park_id
         where pl.id = l and pm.user_id = auth.uid()
      ) $$;

-- May the caller see this UNIT? Deliberately the narrowest possible answer:
-- only a unit ATTACHED TO A RESERVATION on a lot in a park they administer.
-- A park owner deciding an application has to see the make, type and length —
-- length is the whole point of the fit constraints — but that is the only door.
-- There is no browsing people's property, and the moment the reservation is
-- gone so is the access.
create or replace function public.ll_can_see_unit(u uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
        select 1
          from public.lot_reservations r
          join public.park_lots pl   on pl.id = r.park_lot_id
          join public.park_members pm on pm.park_id = pl.park_id
         where r.renter_unit_id = u and pm.user_id = auth.uid()
      ) $$;


-- ================================================= ROW-LEVEL SECURITY =======
alter table public.parks             enable row level security;
alter table public.park_members      enable row level security;
alter table public.park_lots         enable row level security;
alter table public.lot_rates         enable row level security;
alter table public.renter_units      enable row level security;
alter table public.lot_reservations  enable row level security;

-- PARKS: an ACTIVE park is public (the /parks/[slug] page fills vacancies);
-- an inactive one is visible only to its managers and ops.
drop policy if exists parks_read on public.parks;
create policy parks_read on public.parks
  for select using (active or public.ll_manages_park(id) or public.ll_is_ops());

drop policy if exists park_members_read on public.park_members;
create policy park_members_read on public.park_members
  for select using (user_id = auth.uid() or public.ll_manages_park(park_id) or public.ll_is_ops());

-- LOTS and RATES: readable with the park. A renter needs to see what is
-- available and what it costs before they apply.
drop policy if exists park_lots_read on public.park_lots;
create policy park_lots_read on public.park_lots
  for select using (
    exists (select 1 from public.parks p where p.id = park_id and p.active)
    or public.ll_manages_park(park_id) or public.ll_is_ops()
  );

drop policy if exists lot_rates_read on public.lot_rates;
create policy lot_rates_read on public.lot_rates
  for select using (
    public.ll_manages_lot(park_lot_id) or public.ll_is_ops()
    or exists (
      select 1 from public.park_lots pl join public.parks p on p.id = pl.park_id
       where pl.id = park_lot_id and p.active
    )
  );

-- RENTER UNITS are personal property. Only the renter and ops — plus the
-- single narrow door in ll_can_see_unit(). A park member does NOT get a
-- blanket read: they reach a unit ONLY through a reservation on their own
-- lot, never by browsing people.
drop policy if exists renter_units_read on public.renter_units;
create policy renter_units_read on public.renter_units
  for select using (
    user_id = auth.uid() or public.ll_can_see_unit(id) or public.ll_is_ops()
  );

-- RESERVATIONS: the renter sees their own; a park member sees their park's.
-- Note what a park member CANNOT reach through this: the renter's personal
-- service history, their payment methods, or any other park's rows.
drop policy if exists lot_res_read on public.lot_reservations;
create policy lot_res_read on public.lot_reservations
  for select using (
    renter_user_id = auth.uid() or public.ll_manages_lot(park_lot_id) or public.ll_is_ops()
  );

-- WRITES GO THROUGH SERVER ACTIONS ONLY. The standing pattern in this codebase
-- (0009, 0011, 0012): RLS alone is not enough, every table revokes client
-- writes explicitly and the service role does the writing behind an
-- authorization check. A renter must not be able to approve their own tenancy.
-- TRUNCATE is included deliberately: `revoke insert, update, delete` does not
-- cover it, and TRUNCATE ignores row-level security entirely.
revoke insert, update, delete, truncate on public.parks            from authenticated, anon;
revoke insert, update, delete, truncate on public.park_members     from authenticated, anon;
revoke insert, update, delete, truncate on public.park_lots        from authenticated, anon;
revoke insert, update, delete, truncate on public.lot_rates        from authenticated, anon;
revoke insert, update, delete, truncate on public.renter_units     from authenticated, anon;
revoke insert, update, delete, truncate on public.lot_reservations from authenticated, anon;

grant select on public.parks, public.park_members, public.park_lots,
                public.lot_rates, public.renter_units, public.lot_reservations
  to authenticated;
-- The public park page reads active parks and their lots while signed out.
grant select on public.parks, public.park_lots, public.lot_rates to anon;

-- ...and NOTHING else while signed out. Supabase's default privileges hand
-- `anon` a SELECT grant on every new table, so silence here would leave the
-- public key holding a grant on renters' personal property and their tenancy
-- history. RLS blocks it today — but then the grant layer and the policy layer
-- disagree, and one future policy widening turns a signed-in-user bug into a
-- public data leak. Say what we mean at both layers.
revoke select on public.park_members     from anon;
revoke select on public.renter_units     from anon;
revoke select on public.lot_reservations from anon;


-- ================================================= AGE GATE (55+) ===========
-- The 55+ flag gates whether age may be collected at all. There is no age
-- column in this phase precisely because no park needs one yet — this guard
-- exists so that when one is added, an all-ages park can never carry it.
comment on column public.parks.age_restricted is
  'Park owner declares 55+ housing. GATES whether the application may ask for '
  'age AT ALL — an all-ages park must never collect a date of birth (no '
  'legitimate purpose, and a familial-status exposure in the record). Claiming '
  'the exemption also carries occupancy-verification duties: the platform '
  'maintains the record and chases the survey, it never asserts the park '
  'qualifies. That claim is the park owner''s, and their counsel''s.';


-- ================================================= POST-CONDITIONS ==========
-- 0050's other lesson: "no error" is not proof. A PL/pgSQL syntax slip rolled
-- that whole file back silently and the objects simply were not there. Assert
-- EXISTENCE of everything load-bearing, and fail loudly if it is missing.
do $$
declare n int;
begin
  if not exists (select 1 from pg_extension where extname = 'btree_gist') then
    raise exception '0052: btree_gist is required for the no-double-booking constraint';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'lot_no_double_booking') then
    raise exception '0052: the no-double-booking exclusion constraint did not land — two renters could be sold the same lot';
  end if;

  select count(*) into n from pg_tables
   where schemaname = 'public'
     and tablename in ('parks','park_members','park_lots','lot_rates','renter_units','lot_reservations');
  if n <> 6 then
    raise exception '0052: expected 6 park tables, found %', n;
  end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('ll_my_park_ids','ll_manages_park','ll_manages_lot','ll_can_see_unit','guard_lot_reservation');
  if n <> 5 then
    raise exception '0052: expected 5 park functions, found %', n;
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'lot_res_guard' and not tgisinternal
  ) then
    raise exception '0052: the lot_res_guard trigger did not land — a reservation could carry someone else''s unit, or a renter could approve their own tenancy';
  end if;

  -- The privacy line. If anon ever holds a SELECT grant on renters' personal
  -- property or their tenancy history, only RLS stands between the public key
  -- and that data — and that is one policy edit from a breach.
  select count(*) into n from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'
     and table_name in ('park_members','renter_units','lot_reservations')
     and privilege_type = 'SELECT';
  if n <> 0 then
    raise exception '0052: anon still holds SELECT on % park privacy table(s)', n;
  end if;

  raise notice '0052: parks phase 1 ready. parks.active is OFF for every park — that is the launch switch.';
end $$;
