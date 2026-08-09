-- ============================================================================
-- 0058 — EXTEND A STAY: one text, one tap, no account.
--
-- TWO PROBLEMS, ONE MECHANISM.
--
-- The revenue one: a guest booked through Friday gets a text on Wednesday and
-- can keep the site with one tap. Turning a short stay into a long one is the
-- highest-value behaviour change in a transient park, and the moment to ask is
-- before they start packing.
--
-- The correctness one, and it is a latent bug shipped in dd56c59: month-to-
-- month tenancies are stored as a ROLLING FINITE RANGE (phase 2 design §1h —
-- unbounded ranges make the rent roll report a lot VACANT while someone lives
-- on it). Nothing rolled them forward. A year after move-in, Donna's tenancy
-- would quietly lapse and her lot would read empty with her still on it. The
-- same extension mechanism fixes that.
--
-- WHY A TOKEN AND NOT A LOGIN. The renter has no account and may never have
-- one — that is the entire point of park_renters. A signed link in a text is
-- the only thing that can reach her. This mirrors the existing /a, /c and /d
-- token surfaces rather than inventing a new pattern.
-- ============================================================================

-- The one-tap link. Random, unguessable, and UNIQUE so a token identifies
-- exactly one stay. Null until a reminder is actually sent — a token that was
-- never texted to anybody is a credential lying around for no reason.
alter table public.lot_reservations
  add column if not exists extend_token text unique;

-- Exactly-once, same discipline as the waitlist warning: a guest texted three
-- nights running about the same checkout stops reading our texts, and the one
-- they stop reading is the freeze warning.
alter table public.lot_reservations
  add column if not exists extend_reminded_at timestamptz;

-- How many times this stay has rolled. Past a threshold the app stops rolling
-- silently and surfaces it, so a tenancy nobody has looked at in five years
-- becomes visible instead of compounding.
alter table public.lot_reservations
  add column if not exists extended_count int not null default 0;

alter table public.lot_reservations
  add column if not exists extended_at timestamptz;

comment on column public.lot_reservations.extend_token is
  'Unguessable one-tap extend link, texted to a renter who has NO ACCOUNT and '
  'may never have one. Null until a reminder is sent — an untexted token is a '
  'credential lying around for nothing.';

comment on column public.lot_reservations.extended_count is
  'Silent rolls so far. Past lib/extend-stay MAX_SILENT_ROLLS the app stops '
  'rolling and tells the park owner, so a forgotten tenancy surfaces.';

-- The nightly's working set: live stays with an end date and no reminder yet.
-- Partial, so it stays small however big the table gets.
create index if not exists lot_res_extend_due_idx
  on public.lot_reservations (status)
  where extend_reminded_at is null and status in ('approved', 'active');


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='lot_reservations'
     and column_name in ('extend_token','extend_reminded_at','extended_count','extended_at');
  if n <> 4 then
    raise exception '0058: expected 4 extension columns, found %', n;
  end if;

  -- A shared token would let one renter extend another's stay.
  if not exists (
    select 1 from pg_indexes
     where schemaname='public' and tablename='lot_reservations'
       and indexdef ilike '%extend_token%' and indexdef ilike '%unique%'
  ) then
    raise exception '0058: extend_token is not unique — one token could reach two stays';
  end if;

  -- The exclusion constraint is what makes an extension safe: widening a range
  -- is an UPDATE it re-validates for free, so an extension into somebody
  -- else's booked window simply fails rather than double-selling the lot.
  if not exists (select 1 from pg_constraint where conname = 'lot_no_double_booking') then
    raise exception '0058: the no-double-booking constraint is missing — an extension could double-sell a lot';
  end if;

  raise notice '0058: extend-stay ready. One text, one tap, no account.';
end $$;
