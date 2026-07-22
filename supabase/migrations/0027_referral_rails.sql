-- ============================================================
--  LakeLife — referral rails (roadmap §8 "NOW" scope): every user
--  gets a shareable code, and signups that arrive through one are
--  attributed permanently — so the history EXISTS the day the rep /
--  give-get economics turn on (§8b, owner-confirmed numbers, later).
--  Golden rule honored from day one: attribution at signup, rewards
--  (when they come) only ever on COLLECTED money. Self-referral
--  blocked in the claim action. Run once. Safe to re-run.
-- ============================================================

alter table public.users
  add column if not exists referral_code text unique default encode(gen_random_bytes(4), 'hex'),
  add column if not exists referred_by uuid references public.users(id) on delete set null;

-- Backfill codes for existing users (default only applies to new rows).
update public.users set referral_code = encode(gen_random_bytes(4), 'hex')
 where referral_code is null;

create index if not exists users_referred_by on public.users (referred_by);
