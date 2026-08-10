-- ============================================================================
-- 0061 — CHANGING THE RENT ON SOMEBODY WHO ALREADY LIVES THERE.
--
-- THE EVENT THIS EXISTS FOR. On Dec 15 2026 The Haven changes hands and all 19
-- sitting tenancies move from ~$272 to $400 at once — a ~45% increase, the
-- single most important operation of Year 1, and the app could not perform it.
-- `planBulkRates` changes the RATE CARD (what a vacant lot is advertised at).
-- It does not change what a person already living on a lot pays. Those are
-- different facts and conflating them would have quietly rewritten what 19
-- households owe with no record of when, why, or whether anyone told them.
--
-- SO: A RENT CHANGE IS ITS OWN RECORD, NOT AN EDIT.
--
-- `lot_reservations.quoted_amount` is what they pay TODAY. It is not touched
-- when a change is scheduled — only when the change actually takes effect. In
-- between, the roll keeps telling the truth: she still pays $275, and $400 is
-- coming on the 14th.
--
-- THE INVARIANT THAT MATTERS, and it is in the database rather than in a code
-- path somebody can forget:
--
--   A RENT CHANGE CANNOT BE APPLIED UNLESS NOTICE WAS GIVEN, AND THE EFFECTIVE
--   DATE CANNOT FALL INSIDE THE NOTICE PERIOD.
--
-- Not a UI nicety. A rent increase served short is unenforceable and, in a
-- mobile-home community, is the kind of mistake that ends up in front of a
-- judge with 19 households on the other side.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: it does not encode Indiana's
-- notice requirement, because I do not know it and guessing at a statutory
-- number is worse than having none. `parks.rent_notice_days` is a DIAL with a
-- deliberately conservative default. The owner's counsel sets the real number.
-- The database enforces whatever it is told, exactly.
-- ============================================================================

alter table public.parks
  add column if not exists rent_notice_days smallint not null default 30;

comment on column public.parks.rent_notice_days is
  'How many days notice a rent increase requires at this park. A DIAL, not a '
  'legal fact — LakeLife does not know the statute and must not pretend to. '
  'Counsel sets it; 0061 enforces it.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parks_rent_notice_days_check') then
    alter table public.parks add constraint parks_rent_notice_days_check
      check (rent_notice_days between 0 and 365);
  end if;
end $$;


create table if not exists public.lot_rent_changes (
  id             uuid primary key default gen_random_uuid(),
  -- Denormalised so RLS can scope without walking two joins on every read.
  park_id        uuid not null references public.parks(id) on delete cascade,
  reservation_id uuid not null references public.lot_reservations(id) on delete cascade,

  -- What they paid before. Kept even though the tenancy also knows, because
  -- the tenancy's number moves and this record must not.
  from_amount    numeric(10,2),
  to_amount      numeric(10,2) not null check (to_amount >= 0),

  effective_on   date not null,

  -- Captured AT THE TIME, not read from the park later. The park's dial may
  -- change; what this tenant was owed does not.
  notice_days_required smallint not null check (notice_days_required between 0 and 365),

  -- The day notice actually went out. Null means it has not.
  notice_given_on date,
  notice_method   text check (notice_method in ('letter', 'hand', 'posted', 'email', 'sms')),

  applied_at     timestamptz,
  cancelled_at   timestamptz,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),

  -- ---- THE TWO RULES ----

  -- 1. Nothing takes effect without notice having been given.
  constraint rent_change_needs_notice
    check (applied_at is null or notice_given_on is not null),

  -- 2. The effective date must sit at or beyond the far edge of the notice
  --    period, counted from the day notice was given. Enforced only once a
  --    notice date exists, so a change can be drafted before it is served.
  constraint rent_change_respects_notice
    check (
      notice_given_on is null
      or effective_on >= notice_given_on + notice_days_required
    ),

  -- A cancelled change can never also have been applied.
  constraint rent_change_not_both
    check (cancelled_at is null or applied_at is null)
);

comment on table public.lot_rent_changes is
  'A scheduled change to what a SITTING tenant pays. Separate from lot_rates, '
  'which is the advertised rate card for a vacant lot. quoted_amount moves only '
  'when the change is applied, so the roll tells the truth in the meantime.';

-- The nightly's working set: due, noticed, and not yet applied.
create index if not exists lot_rent_changes_due_idx
  on public.lot_rent_changes (effective_on)
  where applied_at is null and cancelled_at is null;

create index if not exists lot_rent_changes_res_idx
  on public.lot_rent_changes (reservation_id, created_at desc);


-- ---------------------------------------------------------------- rls -------
alter table public.lot_rent_changes enable row level security;

drop policy if exists lot_rent_changes_read on public.lot_rent_changes;
create policy lot_rent_changes_read on public.lot_rent_changes
  for select to authenticated
  using (public.ll_manages_park(park_id) or public.ll_is_ops());

-- Same posture as 0059: anon gets nothing, authenticated gets SELECT only, and
-- every write goes through the service role.
revoke all on public.lot_rent_changes from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.lot_rent_changes from authenticated;
grant select on public.lot_rent_changes to authenticated;


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int;
begin
  if to_regclass('public.lot_rent_changes') is null then
    raise exception '0061: lot_rent_changes missing';
  end if;

  select count(*) into n from pg_constraint
   where conname in ('rent_change_needs_notice', 'rent_change_respects_notice', 'rent_change_not_both');
  if n <> 3 then
    raise exception '0061: expected 3 notice constraints, found % — a rent increase could be applied unserved', n;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema='public' and table_name='lot_rent_changes' and grantee='anon'
  ) then
    raise exception '0061: anon holds a grant on lot_rent_changes';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='parks' and column_name='rent_notice_days'
  ) then
    raise exception '0061: parks.rent_notice_days missing';
  end if;

  raise notice '0061: rent changes are records, and none can take effect unserved.';
end $$;
