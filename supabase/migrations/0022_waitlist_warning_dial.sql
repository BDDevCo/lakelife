-- RECOVERED, NOT REWRITTEN (20260722165138 — "waitlist warning dial").
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
--  LakeLife — waitlist terminal state (ladder rungs 6–8).
--  One dial: how many days before an UNFILLED job's date the customer
--  gets the "still hunting — here are your options" text. The terminal
--  itself (honest auto-cancel when the date passes, never charged) needs
--  no schema — 'cancelled' status and the jobs table already exist.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ==============================================================

insert into public.platform_settings (key, value) values
  ('waitlist_warning_days', '2'::jsonb)
on conflict (key) do nothing;
