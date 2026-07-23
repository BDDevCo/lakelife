-- ============================================================
--  LakeLife — terms-of-service acceptance rails (owner posture,
--  2026-07-22): ONE bulletproof user agreement carries all the legal
--  weight. LakeLife is a third-party administrator; the service
--  relationship is customer ↔ crew; our duty is verification
--  (insurance + EIN). This records WHO accepted WHICH version WHEN —
--  the attorney's text drops into the /terms page later and a version
--  bump re-prompts everyone at their next sign-in.
--  Run once. Safe to re-run.
-- ============================================================

alter table public.users
  add column if not exists tos_version text,
  add column if not exists tos_accepted_at timestamptz;
