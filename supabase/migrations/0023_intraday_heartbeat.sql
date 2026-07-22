-- ============================================================
--  LakeLife — intraday heartbeat (stress-test design, Phase D step 10).
--  Vercel Hobby allows only two daily crons (nightly + seasonal use them),
--  so the 30-minute heartbeat runs from Postgres itself: pg_cron fires
--  pg_net to call /api/cron/intraday (CRON_SECRET-gated, fail-closed),
--  which quietly re-tries waitlist fills and re-homes today's jobs.
--
--  This file enables the extensions ONLY. The cron.schedule(...) statement
--  carries the Authorization secret, and this repository is PUBLIC — so the
--  schedule is applied out-of-band (Supabase management API / SQL editor):
--
--    select cron.schedule(
--      'lakelife-intraday',
--      '*/30 * * * *',
--      $$ select net.http_post(
--           url := 'https://www.lakelife.ai/api/cron/intraday',
--           headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
--         ) $$
--    );
--
--  Run once. Safe to re-run.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;
