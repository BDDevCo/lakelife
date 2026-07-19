-- ============================================================
--  LakeLife — security hardening from the full diagnosis.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- 1) A user must NOT be able to mark their own email/phone as verified by
--    talking to the database directly (defeats rule 5). Column-level grants:
--    authenticated users may update only their harmless profile fields; the
--    verified flags and role are written solely by our server (service role)
--    and triggers.
--    Note: phone/email are deliberately NOT self-updatable either — otherwise
--    a user could verify once, then swap in any number while phone_verified
--    stays true. All phone/email writes go through our server (service role).
revoke update on public.users from authenticated, anon;
grant update (name) on public.users to authenticated;

-- 2) Bookings are created only by the app server, which re-prices, checks the
--    season window, capacity, and (now) email+SMS verification. The direct
--    owner-insert path allowed arbitrary status/price/date rows — close it.
drop policy if exists jobs_owner_insert on public.jobs;
