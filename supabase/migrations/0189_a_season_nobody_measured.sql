alter table public.lakes alter column season_confirmed set default false;

-- The three founding lakes were inserted in one statement on 2026-07-18
-- 19:48:29 by 0047_seeds_and_backfills.sql, whose dates are verbatim
-- lakelife.html:658,669,680. updateLakeConditions (ops/actions.ts:405-429) is
-- the only writer and has never run on them, yet they read confirmed —
-- because the column defaulted TRUE. A default is not an act, and a public,
-- indexed, hourly-cached page has been printing "Ice-out: March 21." with the
-- hedge suppressed. The DATES ARE NOT TOUCHED: only the claim that somebody
-- measured them.
update public.lakes l
   set season_confirmed = false
 where l.is_fixture = false
   and (l.ice_out_actual, l.hard_freeze_est, l.pull_deadline) in (
     (date '2026-03-21', date '2026-11-22', date '2026-11-14'),
     (date '2026-03-24', date '2026-11-20', date '2026-11-12'),
     (date '2026-03-19', date '2026-11-24', date '2026-11-16')
   );