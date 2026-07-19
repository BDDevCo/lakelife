-- ============================================================
--  LakeLife — Phase 4 security hardening (0011).
--  Closes two live vulnerabilities found by adversarial review:
--
--  (1) Forgeable photo gate (breaks CLAUDE.md rule 2). A vendor could
--      POST rows straight to public.job_photos via PostgREST (their own
--      JWT + the public anon key), because the default table INSERT grant
--      to `authenticated` was never revoked and jobphotos_access.with_check
--      allows a vendor to write rows for their own jobs. Forged rows (no
--      real image) satisfied completeJob's count-based gate -> payout for
--      un-photographed work.
--
--  (2) Flag injection (breaks rule 6 + pricing integrity). A vendor could
--      POST arbitrary rows to public.flags the same way, bypassing the
--      submitFlag/sanitizeProposed whitelist, then an owner approval fed
--      the unvalidated proposed_change into property_profile (over-billing
--      via per_section repricing, band mispricing, or a ::int cast crash
--      that DoS'd the approval).
--
--  The app writes BOTH tables only through the service-role client
--  (uploadJobPhoto, submitFlag, declineFlag, apply_flag_change), which
--  bypasses these grants — so revoking client writes changes nothing for
--  the product and removes the entire attack surface. Same pattern already
--  used for public.users (0009) and public.vendors (0010).
--
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ---------- (1)+(2) lock direct client writes; keep SELECT (RLS-governed) --
-- Every legitimate write goes through the service role; authenticated/anon
-- have no business INSERT/UPDATE/DELETE-ing these tables directly. SELECT
-- stays so vendors can read their own photos and owners can read their flags.
revoke insert, update, delete on public.job_photos from authenticated, anon;
revoke insert, update, delete on public.flags      from authenticated, anon;

-- After this, the only way a job_photos row exists is uploadJobPhoto, which
-- uploads a real file to the private bucket BEFORE inserting the row — so
-- completeJob's photo count once again reflects real, uploaded photos.

-- ---------- (2) defense-in-depth: make apply_flag_change value-safe --------
-- Even though flags can no longer be client-forged, the approval RPC must
-- never corrupt the pricing source of truth or crash on a bad value. This
-- mirrors sanitizeProposed() at the database layer: counts are accepted only
-- as 0-99 integers, lawn_band only as a known band; anything else is ignored
-- (coalesced to the existing value) rather than written or cast-crashed.
create or replace function public.ll_safe_count(p text)
returns int language sql immutable
as $$ select case when p ~ '^[0-9]{1,2}$' then p::int else null end $$;

create or replace function public.apply_flag_change(p_flag_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  f  record;
  pc jsonb;
begin
  select * into f from public.flags where id = p_flag_id and status = 'pending' for update;
  if not found then
    raise exception 'flag is not pending';
  end if;

  pc := f.proposed_change;
  if pc is not null then
    update public.property_profile pp
       set pier_sections = coalesce(public.ll_safe_count(pc->>'pier_sections'), pp.pier_sections),
           boat_lifts    = coalesce(public.ll_safe_count(pc->>'boat_lifts'),    pp.boat_lifts),
           pwc_lifts     = coalesce(public.ll_safe_count(pc->>'pwc_lifts'),     pp.pwc_lifts),
           jet_skis      = coalesce(public.ll_safe_count(pc->>'jet_skis'),      pp.jet_skis),
           toy_lifts     = coalesce(public.ll_safe_count(pc->>'toy_lifts'),     pp.toy_lifts),
           lawn_band     = coalesce(
                             case when pc->>'lawn_band' in ('small','medium','large')
                                  then pc->>'lawn_band' end,
                             pp.lawn_band)
     where pp.property_id = (select property_id from public.jobs where id = f.job_id);
  end if;

  update public.flags set status = 'approved' where id = p_flag_id;
end $$;

-- Only the server (service role) calls this; no client grants.
revoke execute on function public.apply_flag_change(uuid) from public, anon, authenticated;
