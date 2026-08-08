-- ============================================================================
-- 0055 — park_renters: a renter the park knows about who has never logged in.
--
-- THE PROBLEM, verified on production before writing this:
--   lot_reservations.renter_user_id is NOT NULL and CASCADEs from users.
--
-- Two consequences, both fatal to the product:
--
--   1. On closing morning the rent roll shows an EMPTY PARK. Every sitting
--      tenant at the park being bought predates the platform. Some are elderly,
--      some pay by money order, some will never install an app. Not one of them
--      can be represented. A rent roll that holds 60 of 79 tenants is a rent
--      roll nobody uses, and the owner goes back to the notebook — at which
--      point nothing else we build matters.
--
--   2. Say the second one out loud, because it is the sentence that justifies
--      this migration: TODAY YOUR TENANT'S PHONE CAN DELETE YOUR LEASE.
--      deleteAccount() removes the auth user; the cascade takes the tenancy,
--      and would take the ledger, the lease and the deposit with it.
--
-- THE MODEL, and the sentence to keep:
--   `park_renters` is A PARK'S FILE ON A PERSON. `users` is A PERSON.
--   Many files, one person. Do not "simplify" this into a global identity
--   graph later — that is both a privacy hazard and a merge problem nobody
--   gets right. A file exists whether or not anyone ever logs in; user_id is
--   NULL until someone CLAIMS it, and goes back to NULL if they delete their
--   account. The file, and everything hanging off it, survives.
--
-- THE INVARIANT, asserted mechanically at the end of this file:
--   no park_* table may make users.id its only pointer to a person.
--   That single assertion is what stops this regressing in six months when
--   somebody adds park_inspections.
--
-- SAFE TO RESTRUCTURE: parks, park_lots, lot_rates, renter_units and
-- lot_reservations are ALL EMPTY in production (verified). parks.active has
-- never been true. So the columns are swapped outright rather than
-- backfilled — there is nothing to migrate.
-- ============================================================================

create table if not exists public.park_renters (
  id         uuid primary key default gen_random_uuid(),
  park_id    uuid not null references public.parks(id) on delete cascade,

  -- NULL = UNCLAIMED. This is the entire point of the table. A tenant who
  -- never signs up is a first-class citizen here, not a degraded one.
  -- ON DELETE SET NULL, never cascade: deleting the account un-claims the
  -- file, it does not destroy the park's records.
  user_id    uuid references public.users(id) on delete set null,

  display_name text not null,
  email        text,

  -- A PARK-SCOPED VERIFIED MOBILE THAT REQUIRES NO ACCOUNT. Ten seconds at
  -- the office window — "what's the best number? I'll text you the receipt" —
  -- and she gets rent receipts, due reminders and freeze warnings forever
  -- without installing anything or choosing a password. All the operational
  -- value of the app, zero app. Without this the whole conversion ladder is
  -- unreachable for exactly the people it exists for.
  mobile_e164        text,
  mobile_verified_at timestamptz,
  -- Operational and marketing consent are DIFFERENT LEGAL BASES and get
  -- different columns. A rent receipt is not a promotion.
  sms_consent_operational_at timestamptz,
  sms_consent_marketing_at   timestamptz,

  -- 'paper' is a real, permanent, respectable answer. 25-35% of a park never
  -- converts and that is fine — a paper tenant who pays on time must render
  -- exactly as green as everyone else, or the colours stop meaning anything.
  contact_pref text not null default 'paper'
    check (contact_pref in ('sms', 'email', 'paper', 'none')),

  -- WHERE THE FACT CAME FROM. Seller rent rolls in this industry commonly run
  -- 10-20% inflated, and every platform in both markets renders them as fact.
  -- Carrying provenance lets the rent roll show its work — "$27,200 expected,
  -- $24,100 confirmed by tenants, $3,100 from the seller's roll only" — which
  -- is the most persuasive thing we can put in front of park owner #2.
  source text not null default 'owner_knowledge'
    check (source in ('seller_roll', 'owner_knowledge', 'tenant_confirmed', 'document', 'self_signup')),

  -- How an unclaimed file becomes a claimed one. Short, single-use, handed
  -- over deliberately by the park owner — never guessable, never emailed to
  -- an address we have not verified.
  claim_code text unique,
  claimed_at timestamptz,

  notes      text,
  created_at timestamptz not null default now()
);

create index if not exists park_renters_park_idx on public.park_renters(park_id);
create index if not exists park_renters_user_idx on public.park_renters(user_id) where user_id is not null;

-- One CLAIMED file per person per park. Postgres allows many NULLs in a
-- unique index, which is exactly right: a park may hold any number of
-- unclaimed files, but a signed-in person resolves to at most one file per
-- park.
create unique index if not exists park_renters_one_claim_per_park
  on public.park_renters(park_id, user_id) where user_id is not null;

comment on table public.park_renters is
  'A PARK''S FILE ON A PERSON. users is a PERSON; this is a FILE. Many files, '
  'one person. user_id is NULL until claimed and returns to NULL if the '
  'account is deleted — the file, the tenancy, the ledger and the lease all '
  'survive. Never collapse this into a global identity graph.';


-- ================================================ REPOINT THE TENANCY =======
-- Empty tables, so this is a swap, not a backfill.
--
-- ORDER IS LOAD-BEARING. The 0052 policies name the very columns being
-- swapped, and Postgres records a policy -> column dependency, so the drops
-- below fail with 2BP01 ("cannot drop column ... because other objects depend
-- on it") unless the policies come down FIRST. Both are recreated against
-- renter_id further down.
--
-- Deliberately NOT `drop column ... cascade`: cascade would silently delete
-- the policies and leave these tables governed by whatever policies happened
-- to remain, which on a privacy table is the exact opposite of what we want.
-- Dropping them by name means the recreate below is the only way they come
-- back, and if it were ever removed the tables would read as deny-all rather
-- than as something subtly wrong.
drop policy if exists lot_res_read      on public.lot_reservations;
drop policy if exists renter_units_read on public.renter_units;

alter table public.lot_reservations
  add column if not exists renter_id uuid references public.park_renters(id) on delete cascade;

alter table public.lot_reservations drop column if exists renter_user_id;
alter table public.lot_reservations alter column renter_id set not null;

create index if not exists lot_res_renter_idx2 on public.lot_reservations(renter_id);
drop index if exists lot_res_renter_idx;

-- The rig belongs to the park's FILE on a person, not to an account that can
-- vanish. A mobile home outlives the tenancy; it must outlive the login too.
alter table public.renter_units
  add column if not exists renter_id uuid references public.park_renters(id) on delete cascade;
alter table public.renter_units drop column if exists user_id;
alter table public.renter_units alter column renter_id set not null;

drop index if exists renter_units_user_idx;
create index if not exists renter_units_renter_idx on public.renter_units(renter_id);


-- ================================================= AUTHORIZATION ============
-- Which park FILES belong to the signed-in person. Definer, matching the
-- ll_* convention — a policy's own subquery over another RLS-protected table
-- silently returns nothing (0010 documents this the hard way).
create or replace function public.ll_my_renter_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$ select id from public.park_renters where user_id = auth.uid() $$;

-- Rewritten: a unit is reachable by its OWN claimed renter, by a park member
-- through a reservation on their lot (the narrow door from 0052), or by ops.
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
alter table public.park_renters enable row level security;

-- A person sees their OWN file. A park member sees the files in THEIR park.
-- Nobody else sees anything — an unclaimed file is a park's private record of
-- a neighbour, and it is not public in any sense.
drop policy if exists park_renters_read on public.park_renters;
create policy park_renters_read on public.park_renters
  for select using (
    user_id = auth.uid() or public.ll_manages_park(park_id) or public.ll_is_ops()
  );

drop policy if exists renter_units_read on public.renter_units;
create policy renter_units_read on public.renter_units
  for select using (
    renter_id in (select public.ll_my_renter_ids())
    or public.ll_can_see_unit(id)
    or public.ll_is_ops()
  );

drop policy if exists lot_res_read on public.lot_reservations;
create policy lot_res_read on public.lot_reservations
  for select using (
    renter_id in (select public.ll_my_renter_ids())
    or public.ll_manages_lot(park_lot_id)
    or public.ll_is_ops()
  );

-- Writes go through server actions only, and anon reads NOTHING here: a
-- park's file on a person is the most sensitive row in the module.
revoke insert, update, delete, truncate on public.park_renters from authenticated, anon;
grant select on public.park_renters to authenticated;
revoke select on public.park_renters from anon;


-- ================================================= THE GUARD, REWRITTEN =====
-- Same two rules as 0052, re-expressed against the file rather than the
-- account: a reservation's unit must belong to the same renter file, and a
-- renter may not be recorded as deciding their own tenancy unless they
-- administer the park.
create or replace function public.guard_lot_reservation()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare renter_account uuid;
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

  -- A tenancy must be inside ONE park. Nothing stopped a reservation pairing
  -- park A's LOT with a renter file belonging to park B — and because
  -- ll_manages_lot and ll_can_see_unit both key off the LOT, such a row would
  -- hand park A's member a read on park B's renter file and their rig. Writes
  -- are service-role only, so this was never reachable from a browser; but
  -- 0055 is the migration that gives a renter file a park_id, which is what
  -- makes the mismatch expressible AND cheap to refuse. The comments claim
  -- park scoping, so the database holds it.
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

  return new;
end $$;

drop trigger if exists lot_res_guard on public.lot_reservations;
create trigger lot_res_guard
  before insert or update on public.lot_reservations
  for each row execute function public.guard_lot_reservation();


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int; bad text;
begin
  if not exists (select 1 from pg_tables where schemaname='public' and tablename='park_renters') then
    raise exception '0055: park_renters did not land';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='lot_reservations' and column_name='renter_user_id'
  ) then
    raise exception '0055: lot_reservations.renter_user_id still exists — the account pointer was not removed';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='renter_units' and column_name='user_id'
  ) then
    raise exception '0055: renter_units.user_id still exists — a deleted account would still take the rig';
  end if;

  -- THE INVARIANT. No table in this module may point at users.id as its ONLY
  -- route to a person — otherwise deleting an account takes the park's records
  -- with it, which is the whole bug this migration exists to kill.
  --
  -- The prefix list covers park_*, lot_* AND renter_*, not just park_*. An
  -- earlier draft matched only 'park\_%' and would therefore have exempted
  -- lot_reservations and renter_units — the exact two tables being fixed here
  -- — as well as any future lot_ledger or renter_document. A guard that does
  -- not cover the thing it was written for is worse than no guard, because it
  -- reads as protection.
  --
  -- Two deliberate exceptions:
  --   park_members  — a table about ADMINISTRATORS, who are always real
  --                   accounts by definition.
  --   park_renters  — the file itself, whose whole job is to hold the
  --                   NULLABLE pointer at an account.
  -- lot_reservations.decided_by also points at users, and correctly: a
  -- decision is made by an administrator, not by a tenant file. It is
  -- ON DELETE SET NULL, so an account deletion erases the decider, never the
  -- decision — hence the nullability test below rather than a blanket ban.
  select string_agg(distinct tc.table_name || '.' || kcu.column_name, ', ') into bad
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
    join information_schema.columns c
      on c.table_schema = tc.table_schema and c.table_name = tc.table_name
     and c.column_name = kcu.column_name
   where tc.constraint_type = 'FOREIGN KEY'
     and tc.table_schema = 'public'
     -- 'park%' not 'park\_%': the escaped form requires a literal underscore
     -- and therefore skips the `parks` table itself, which is precisely the
     -- kind of hole that makes a guard read as protection while providing
     -- none. A future parks.owner_user_id NOT NULL would have sailed through.
     and (tc.table_name like 'park%'
          or tc.table_name like 'lot\_%' escape '\'
          or tc.table_name like 'renter\_%' escape '\')
     and ccu.table_name = 'users'
     and tc.table_name not in ('park_members', 'park_renters')
     -- A NOT NULL pointer at users is the fatal shape: the row cannot survive
     -- the account. A nullable one degrades gracefully and is allowed.
     and c.is_nullable = 'NO';
  if bad is not null then
    raise exception
      '0055: these columns are a NOT NULL foreign key straight to users, so '
      'deleting an account would delete the park''s records with it: %. '
      'Point them at park_renters instead.', bad;
  end if;

  select count(*) into n from pg_policy where polname = 'park_renters_read';
  if n <> 1 then raise exception '0055: park_renters_read policy missing'; end if;

  select count(*) into n from information_schema.role_table_grants
   where grantee='anon' and table_schema='public' and table_name='park_renters'
     and privilege_type='SELECT';
  if n <> 0 then raise exception '0055: anon can read park_renters'; end if;

  raise notice '0055: park_renters ready. A tenant no longer needs an account to exist, and deleting one no longer deletes the lease.';
end $$;
