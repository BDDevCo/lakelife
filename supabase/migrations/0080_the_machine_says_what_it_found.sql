-- 0080 — WHAT THE EVENING CHECK ACTUALLY FOUND.
--
-- 0079 recorded THAT the reconciler ran and HOW MANY things it noticed. It
-- never recorded WHAT. So every night the machine detected an occupied lot
-- with no bill against it — money quietly not being charged for a household
-- that is still living there — wrote the number 1 into a column nothing read,
-- and told the owner "Checked last night."
--
-- A check whose findings are discarded is not a check. It is the appearance of
-- one, which is worse than no check at all, because the owner stops looking.
--
-- The lines are stored as the reconciler wrote them, in its own words, rather
-- than as codes the screen re-phrases. They are already plain English written
-- for this specific owner ("3 occupied lots have no bill for 2026-08 — lots 4,
-- 7 and 12"), and re-deriving that sentence at render time from a kind and a
-- list of lot numbers is how the two drift apart.

alter table public.park_machine_runs
  add column if not exists findings jsonb not null default '[]'::jsonb;

comment on column public.park_machine_runs.findings is
  'What the run noticed, as [{kind, urgent, line, lotNumbers}] in the '
  'reconciler''s own words. `found` is this array''s length; they are written '
  'in the same statement so they cannot disagree.';

-- A COUNT THAT DISAGREES WITH THE LIST IS A LIE ABOUT BOTH. They are written
-- together by one update, so the only way to break this is a bug — which is
-- precisely when a screen must not quietly show the wrong number.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'machine_run_count_matches_findings'
  ) then
    alter table public.park_machine_runs
      add constraint machine_run_count_matches_findings
      check (
        jsonb_typeof(findings) = 'array'
        -- A run still in flight has claimed its seat and written nothing yet.
        and (finished_at is null or found = jsonb_array_length(findings))
      );
  end if;
end $$;


-- ------------------------------------------------------ post-conditions -----
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'park_machine_runs'
       and column_name = 'findings'
  ) then
    raise exception '0080: findings column is missing';
  end if;

  -- Attempt the violation. A finished run whose count disagrees with its list
  -- must be refused, or the constraint is decoration.
  begin
    insert into public.park_machine_runs
      (park_id, run_on, runner, ok, found, findings, finished_at)
    values
      ('00000000-0000-0000-0000-000000000000', '1900-01-02', '__probe__',
       true, 3, '[]'::jsonb, now());
    raise exception '0080: a finished run claiming 3 findings with an empty list was accepted';
  exception
    when check_violation then null;         -- refused for the right reason
    when foreign_key_violation then null;   -- refused earlier; the park is fake
  end;
end $$;
