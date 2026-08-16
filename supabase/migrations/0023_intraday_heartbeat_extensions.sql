-- RECOVERED, NOT REWRITTEN (20260722170358 — "intraday heartbeat extensions").
--
-- This migration has been live in production since it was applied and had NO
-- FILE in this repository. It was applied inline, which records the SQL in
-- supabase_migrations.schema_migrations and writes nothing to disk — so a
-- rebuild from `supabase/migrations/` would have produced a database missing
-- it, silently and with no error.
--
-- The SQL below is the EXACT text Postgres recorded as applied, decoded from
-- the ledger. Not retyped and not tidied: a recovered migration that has been
-- "improved" on the way out is a different migration wearing the same name.
--
-- Already applied. Present so the repo and the database agree.

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
-- ==============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;
