-- ============================================================
--  LakeLife — Seed the three lakes  (run AFTER 0001 and 0002)
--  Dates come straight from the prototype's Lake Conditions panel.
--  pull_deadline = hard_freeze_est − 8 days  (CLAUDE.md rule 7)
--  Update ice_out_actual each March and the booking calendar reflows.
-- ============================================================

insert into public.lakes (name, ice_out_actual, hard_freeze_est, pull_deadline) values
  ('Big Long Lake',   date '2026-03-21', date '2026-11-22', date '2026-11-14'),
  ('Pretty Lake',     date '2026-03-24', date '2026-11-20', date '2026-11-12'),
  ('Big Turkey Lake', date '2026-03-19', date '2026-11-24', date '2026-11-16')
on conflict (name) do update
  set ice_out_actual  = excluded.ice_out_actual,
      hard_freeze_est = excluded.hard_freeze_est,
      pull_deadline   = excluded.pull_deadline;

-- Sanity check: pull deadline must equal freeze minus 8 days.
do $$
declare bad int;
begin
  select count(*) into bad from public.lakes
   where pull_deadline <> hard_freeze_est - 8;
  if bad > 0 then
    raise exception 'Pull deadline rule broken on % lake(s)', bad;
  end if;
end $$;
