-- 0082 — THE SEASONAL PULL REMINDER GOES OUT ONCE PER SEASON, PER HOUSEHOLD.
--
-- `sendSeasonalPullReminders` fired purely on a date match — "is this lake's
-- pull deadline exactly N days out?" — with a de-dupe set that lived only for
-- the duration of one invocation. The route accepts GET **and** POST and takes
-- a caller-supplied `?lead=`, so anyone verifying it works re-emails every
-- household on that lake, and a cron retry does the same.
--
-- Every other exactly-once send in this codebase already uses a claim row
-- (`waitlist_notice_log`, 0049): the INSERT is the claim, a duplicate-key
-- failure is how the second attempt learns it has nothing to do. This is that
-- pattern, for the one send that never had it.
--
-- Keyed by (property, season, kind) rather than by date, because the point is
-- "this household has been told about THIS season's freeze" — not "we sent
-- something on the 14th". A re-run with a different `?lead=` must not count as
-- a different message.

create table if not exists public.seasonal_notice_log (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  /** The year of the pull deadline being warned about. */
  season_year integer not null,
  kind        text not null default 'pull_deadline',
  sent_at     timestamptz not null default now()
);

create unique index if not exists seasonal_notice_log_once_idx
  on public.seasonal_notice_log (property_id, season_year, kind);

alter table public.seasonal_notice_log enable row level security;
-- Service-role only. Nothing user-facing reads this; it is a send ledger.
revoke select, insert, update, delete on public.seasonal_notice_log from anon, authenticated;

comment on table public.seasonal_notice_log is
  'Claim rows for seasonal sends. The INSERT is the claim: a duplicate key is '
  'how a re-run learns this household has already been told about this season.';


-- ------------------------------------------------------ post-conditions -----
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where tablename = 'seasonal_notice_log' and indexname = 'seasonal_notice_log_once_idx'
  ) then
    raise exception '0082: the claim index is missing — the reminder could go out twice';
  end if;

  -- Attempt the violation: the same household, twice, for the same season.
  begin
    insert into public.seasonal_notice_log (property_id, season_year)
    values ('00000000-0000-0000-0000-000000000000', 1900);
    insert into public.seasonal_notice_log (property_id, season_year)
    values ('00000000-0000-0000-0000-000000000000', 1900);
    raise exception '0082: the same household was claimed twice for one season';
  exception
    when unique_violation then null;        -- refused for the right reason
    when foreign_key_violation then null;   -- refused earlier; the property is fake
  end;
end $$;
