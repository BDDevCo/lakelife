-- ============================================================================
-- 0059 — THE RENT-ROLL IMPORT: the paste, the rows, and what each row made.
--
-- (Written as "0057" in docs/park-importer.md §6; 0057 and 0058 were taken by
-- the lot taxonomy and extend-stay while this was being designed.)
--
-- WHAT THIS IS FOR. On closing day a man has a seller's rent roll and 79 lots.
-- Every hour those names are not in the system, he is running his new park out
-- of a notebook. This is the table that holds the paste and, crucially, holds
-- WHAT EACH LINE OF IT BECAME — so the whole thing can be undone by id rather
-- than by cleverness.
--
-- THE ONE PROPERTY THAT SHAPES EVERY COLUMN HERE: the commit is NOT one
-- transaction. 78 good rows and one collision must never roll back to 79 zero
-- rows. So each row carries its own outcome — the three ids it created, or the
-- error that stopped it — and the loop keeps going.
-- ============================================================================

-- ---------------------------------------------------------------- batches ---
create table if not exists public.park_import_batches (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),

  -- THE PASTE, VERBATIM. This is the attach-the-page rail: the only honest
  -- record of what he was actually looking at when he approved these rows.
  -- When a tenant says "I never paid $465", this is the document that settles
  -- it, and a summary of it would not.
  raw_text      text not null,
  content_hash  text not null,
  source_kind   text not null default 'paste'
                  check (source_kind in ('paste', 'typed', 'photo_note')),

  -- The day the park changed hands. Every grandfathered tenancy's range starts
  -- here, because the database needs a finite range and this is the only date
  -- we actually know. NOT the move-in date — see tenancy_began_on below.
  cutover_date  date not null,

  -- The honest yield, rendered on screen as "read 24 of 31 lines". A number
  -- that is allowed to be less than 100% is the whole trust posture.
  lines_total   int,
  lines_read    int,

  committed_at  timestamptz,
  undone_at     timestamptz,
  undone_by     uuid references public.users(id) on delete set null,
  counts        jsonb not null default '{}'::jsonb
);

comment on table public.park_import_batches is
  'One paste of a seller rent roll. raw_text is kept VERBATIM because it is the '
  'evidence for every number it produced — a park''s entire tenant list in '
  'plaintext, and at least as sensitive as park_renters itself.';

comment on column public.park_import_batches.content_hash is
  'Over the normalised blob. Blocks a second paste of the same list, which is '
  'what turns 79 tenants into 158 files — park_renters_one_claim_per_park is '
  'partial (where user_id is not null) so the database will happily hold them.';

create index if not exists park_import_batches_park_idx
  on public.park_import_batches (park_id, created_at desc);

-- Re-paste detection is a lookup on every paste, so give it an index. NOT
-- unique: "read it again anyway" is a legitimate answer, and a second honest
-- import of a genuinely re-sent list must remain possible.
create index if not exists park_import_batches_hash_idx
  on public.park_import_batches (park_id, content_hash);


-- ------------------------------------------------------------------- rows ---
create table if not exists public.park_import_rows (
  id        uuid primary key default gen_random_uuid(),
  batch_id  uuid not null references public.park_import_batches(id) on delete cascade,

  -- line_no is 1-based and indexes the ORIGINAL paste, including the lines we
  -- could not read. That is what makes "we read 24 of 31" checkable rather
  -- than merely stated: the missing seven have numbers he can go look at.
  line_no   int  not null,
  raw_line  text not null,

  parsed    jsonb not null default '{}'::jsonb,   -- what we proposed
  resolved  jsonb not null default '{}'::jsonb,   -- what he confirmed

  verdict   text not null default 'ask'
              check (verdict in ('import', 'ask', 'skip', 'vacant', 'not_a_lot', 'unparsed')),
  flags     text[] not null default '{}',

  -- EXACTLY what this row created, so undo is precise rather than clever.
  -- Deleting the lot/renter/reservation later must not delete the audit trail
  -- of the import, hence set null rather than cascade.
  created_lot_id         uuid references public.park_lots(id)        on delete set null,
  created_renter_id      uuid references public.park_renters(id)     on delete set null,
  created_reservation_id uuid references public.lot_reservations(id) on delete set null,
  matched_lot_id         uuid references public.park_lots(id)        on delete set null,
  matched_renter_id      uuid references public.park_renters(id)     on delete set null,

  -- Why this row did NOT land. The prototype dropped rows silently; a number
  -- he read on screen and approved must never fail to reach the database
  -- without a sentence explaining it.
  commit_error  text,

  unique (batch_id, line_no)
);

comment on column public.park_import_rows.commit_error is
  'Set when a row was approved but did not land — a lot collision, a check '
  'violation, a trigger. The loop continues and the receipt says so in words. '
  'Never a 500, never a rollback of the rows that worked.';

create index if not exists park_import_rows_batch_idx
  on public.park_import_rows (batch_id, line_no);


-- ------------------------------------------------------- renter additions ---

-- A PHONE NUMBER THAT IS NEVER A SEND TARGET. A number off a seller's roll is
-- a number nobody consented to be texted at — it may be a wrong number, an old
-- number, or the seller's own. Writing it to mobile_e164 would enrol 79
-- strangers into automated texting on closing day, which is both a TCPA
-- exposure and the single fastest way to burn the park's goodwill.
--
-- It lives here so the office can CALL, and it can only become mobile_e164 by
-- somebody verifying it. Enforced by a repo test, not just by intention.
alter table public.park_renters
  add column if not exists phone_on_file_with_park text;

comment on column public.park_renters.phone_on_file_with_park is
  'From a seller roll or an office card. NEVER a send target — no consent '
  'exists for it. Promotion to mobile_e164 requires verification.';

-- Two files for one person, discovered later. Point the loser at the winner
-- rather than deleting: a deleted file takes its reservation history with it.
alter table public.park_renters
  add column if not exists merged_into uuid references public.park_renters(id) on delete set null;

-- The moment a human being confirmed this file is right. What turns
-- source='seller_roll' into something the rent roll may render as fact.
alter table public.park_renters
  add column if not exists confirmed_at timestamptz;


-- -------------------------------------------------- reservation additions ---

-- HOW THIS TENANCY CAME TO EXIST. A grandfathered tenancy is not an approved
-- application and must never render as one.
alter table public.lot_reservations
  add column if not exists origin text not null default 'application';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lot_res_origin_check') then
    alter table public.lot_reservations
      add constraint lot_res_origin_check
      check (origin in ('application', 'office', 'grandfathered', 'transfer'));
  end if;
end $$;

-- NOT lower(during). during starts at the cutover date because the database
-- needs a finite range; reading the move-in date off it would make every
-- sitting tenant look like they moved in on closing day. That is not a guess,
-- it is a fabrication. When this is null the display string is "On file" and
-- nothing more.
alter table public.lot_reservations
  add column if not exists tenancy_began_on date;

comment on column public.lot_reservations.tenancy_began_on is
  'The real move-in date, when known. NEVER derived from lower(during) — that '
  'would date every grandfathered tenancy to closing day.';

alter table public.lot_reservations
  add column if not exists due_day smallint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lot_res_due_day_check') then
    alter table public.lot_reservations
      add constraint lot_res_due_day_check
      check (due_day is null or due_day between 1 and 31);
  end if;
end $$;

-- WHERE THE RENT NUMBER CAME FROM. Seller rolls in this industry commonly run
-- 10-20% inflated and every platform in both markets renders them as fact.
-- Carrying provenance is what lets the rent roll show its work.
alter table public.lot_reservations
  add column if not exists amount_source text not null default 'owner_knowledge';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lot_res_amount_source_check') then
    alter table public.lot_reservations
      add constraint lot_res_amount_source_check
      check (amount_source in ('seller_roll', 'owner_knowledge', 'tenant_confirmed', 'document', 'self_signup'));
  end if;
end $$;

alter table public.lot_reservations
  add column if not exists amount_source_at timestamptz;

alter table public.lot_reservations
  add column if not exists import_batch_id uuid
    references public.park_import_batches(id) on delete set null;

-- A GRANDFATHERED TENANCY CANNOT CARRY A DECISION, because no decision
-- happened. Somebody will eventually ship "bulk approve all sitting tenants"
-- because it looks tidy on a dashboard. The database refuses. Written NOT
-- VALID-free: the column defaults to 'application', so no existing row can
-- violate it.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lot_res_grandfathered_undecided') then
    alter table public.lot_reservations
      add constraint lot_res_grandfathered_undecided
      check (origin <> 'grandfathered' or (decided_by is null and decided_at is null));
  end if;
end $$;

create index if not exists lot_res_import_batch_idx
  on public.lot_reservations (import_batch_id)
  where import_batch_id is not null;


-- -------------------------------------------------------- park additions ----
alter table public.parks
  add column if not exists rent_due_day smallint not null default 1;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_rent_due_day_check') then
    alter table public.parks
      add constraint parks_rent_due_day_check check (rent_due_day between 1 and 31);
  end if;
end $$;

-- How many days behind the office typically is. Used to soften "overdue" so
-- the first thing the app ever tells a new owner is not a false alarm about
-- eleven tenants who actually paid on Tuesday.
alter table public.parks
  add column if not exists office_recording_lag_days smallint not null default 3;

alter table public.parks
  add column if not exists cutover_date date;


-- ---------------------------------------------------------------- rls -------
alter table public.park_import_batches enable row level security;
alter table public.park_import_rows    enable row level security;

-- A batch holds a park's ENTIRE TENANT LIST IN PLAINTEXT. Reads are for the
-- people who manage that park and for ops. Nobody else, ever.
drop policy if exists park_import_batches_read on public.park_import_batches;
create policy park_import_batches_read on public.park_import_batches
  for select to authenticated
  using (public.ll_manages_park(park_id) or public.ll_is_ops());

drop policy if exists park_import_rows_read on public.park_import_rows;
create policy park_import_rows_read on public.park_import_rows
  for select to authenticated
  using (exists (
    select 1 from public.park_import_batches b
     where b.id = park_import_rows.batch_id
       and (public.ll_manages_park(b.park_id) or public.ll_is_ops())
  ));

-- RLS IS NOT ENOUGH. Supabase hands `authenticated` and `anon` a blanket grant
-- on new tables in public. Every write goes through the service role.
--
-- REVOKE ALL, not the usual insert/update/delete/truncate list. That list is
-- what every earlier migration used, and it leaves REFERENCES and TRIGGER
-- behind — verified on a branch, where this migration's own post-condition
-- refused to let it land. Neither is a data leak on its own (both need rights
-- in the schema that `anon` does not hold), but a table carrying a park's
-- entire tenant list should hand the anonymous role NOTHING, and "nothing" is
-- a far easier invariant to check than a list of six named privileges.
revoke all on public.park_import_batches from anon;
revoke all on public.park_import_rows    from anon;

-- `authenticated` keeps SELECT and only SELECT — the RLS policies above decide
-- which rows that means.
revoke insert, update, delete, truncate, references, trigger
  on public.park_import_batches from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.park_import_rows    from authenticated;
grant select on public.park_import_batches to authenticated;
grant select on public.park_import_rows    to authenticated;


-- ------------------------------------------------------ post-conditions -----
-- Verify by EXISTENCE. A migration that half-applied and rolled back leaves no
-- error behind to find later.
do $$
declare n int;
begin
  if to_regclass('public.park_import_batches') is null then
    raise exception '0059: park_import_batches missing';
  end if;
  if to_regclass('public.park_import_rows') is null then
    raise exception '0059: park_import_rows missing';
  end if;

  -- The constraint that stops "bulk approve all sitting tenants".
  if not exists (select 1 from pg_constraint where conname = 'lot_res_grandfathered_undecided') then
    raise exception '0059: grandfathered-undecided constraint missing — a sitting tenant could be recorded as approved';
  end if;

  -- Before any code path can write a pasted number, the column that is NOT a
  -- send target has to exist. Otherwise the obvious place to put it is
  -- mobile_e164, and 79 strangers get texted on closing day.
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='park_renters'
       and column_name='phone_on_file_with_park'
  ) then
    raise exception '0059: phone_on_file_with_park missing — a pasted phone has nowhere safe to land';
  end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='lot_reservations'
     and column_name in ('origin','tenancy_began_on','due_day','amount_source','amount_source_at','import_batch_id');
  if n <> 6 then
    raise exception '0059: expected 6 new reservation columns, found %', n;
  end if;

  -- anon must not read a park's tenant list. Belt and braces with the RLS
  -- policies above, because a future GRANT could quietly undo them.
  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public'
       and table_name in ('park_import_batches','park_import_rows')
       and grantee = 'anon'
  ) then
    raise exception '0059: anon still holds a grant on an import table';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public'
       and table_name in ('park_import_batches','park_import_rows')
       and grantee = 'authenticated'
       and privilege_type <> 'SELECT'
  ) then
    raise exception '0059: authenticated holds more than SELECT on an import table';
  end if;

  raise notice '0059: import batches ready. The paste is kept, and every row knows what it made.';
end $$;
