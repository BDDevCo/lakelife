-- ============================================================
--  LakeLife — add jet skis + PWC lifts to the property profile.
--  Jet skis are winterized & stored per unit; each usually sits on
--  its own PWC lift that gets set each spring and pulled each fall.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

alter table public.property_profile
  add column if not exists jet_skis integer default 0,
  add column if not exists pwc_lifts integer default 0;
