-- ============================================================
--  LakeLife — waitlist terminal state (ladder rungs 6–8).
--  One dial: how many days before an UNFILLED job's date the customer
--  gets the "still hunting — here are your options" text. The terminal
--  itself (honest auto-cancel when the date passes, never charged) needs
--  no schema — 'cancelled' status and the jobs table already exist.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

insert into public.platform_settings (key, value) values
  ('waitlist_warning_days', '2'::jsonb)
on conflict (key) do nothing;
