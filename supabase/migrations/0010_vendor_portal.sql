-- ============================================================
--  LakeLife — Phase 4: vendor portal.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ---------- which days a vendor works (scheduler routes only these) --------
alter table public.vendors
  add column if not exists work_days text[] not null default array['Mon','Tue','Wed','Thu','Fri','Sat'];

-- A vendor may self-serve ONLY their work days — never their own COI/expiry,
-- status, capacity or payout token (that would defeat "no valid COI, no jobs").
revoke update on public.vendors from authenticated, anon;
grant update (work_days) on public.vendors to authenticated;

-- ---------- SECURITY DEFINER visibility helpers ----------------------------
-- RLS applied to a policy's OWN subquery means "exists (select from jobs ...)"
-- returns nothing for owners/vendors (jobs is ops-only). These definer helpers
-- answer the ownership question without tripping over that.
create or replace function public.ll_owns_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.jobs j join public.properties p on p.id = j.property_id
  where j.id = p_job_id and p.owner_id = auth.uid()) $$;

create or replace function public.ll_my_vendor_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.jobs j
  where j.id = p_job_id and j.vendor_id = public.ll_my_vendor_id()) $$;

-- Repair the flag + job-photo policies to use the helpers (owner branch was
-- silently always-false before).
drop policy if exists flags_access on public.flags;
create policy flags_access on public.flags for all
  using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id() or public.ll_owns_job(job_id))
  with check (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

drop policy if exists jobphotos_access on public.job_photos;
create policy jobphotos_access on public.job_photos for all
  using (public.ll_is_ops() or public.ll_my_vendor_job(job_id) or public.ll_owns_job(job_id))
  with check (public.ll_is_ops() or public.ll_my_vendor_job(job_id));

-- ---------- vendor_jobs view v2: everything a crew needs, NO prices --------
-- Adds service name, the photo minimum, the address/pin, and the property
-- facts a crew works from. Still zero price columns (rule 1) and NO gate
-- code (rule 3 — that's served day-of by the app server only).
drop view if exists public.vendor_jobs;
create view public.vendor_jobs
with (security_invoker = off) as
  select j.id, j.property_id, j.service_id,
         s.name  as service_name,
         s.min_photos,
         j.date, j.slot, j.frequency, j.status, j.route_id, j.sequence, j.created_at,
         p.address, p.lat, p.lng,
         lk.name as lake_name,
         u.name  as owner_name,
         pp.pier_sections, pp.boat_lifts, pp.pwc_lifts, pp.jet_skis, pp.lawn_band
  from public.jobs j
  left join public.services s on s.id = j.service_id
  join public.properties p on p.id = j.property_id
  left join public.lakes lk on lk.id = p.lake_id
  left join public.users u on u.id = p.owner_id
  left join public.property_profile pp on pp.property_id = j.property_id
  where j.vendor_id = public.ll_my_vendor_id();

grant select on public.vendor_jobs to authenticated;

-- ---------- atomic flag approval (rule 6) ----------------------------------
-- One transaction: mark the flag approved AND apply its proposed profile
-- change together. Repricing runs in the app right after (pricing engine
-- lives there); if it ever failed, profile+flag are still consistent and
-- repricing is safely retryable.
create or replace function public.apply_flag_change(p_flag_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  f record;
begin
  select * into f from public.flags where id = p_flag_id and status = 'pending' for update;
  if not found then
    raise exception 'flag is not pending';
  end if;

  if f.proposed_change is not null then
    update public.property_profile pp
       set pier_sections = coalesce((f.proposed_change->>'pier_sections')::int, pp.pier_sections),
           boat_lifts    = coalesce((f.proposed_change->>'boat_lifts')::int,    pp.boat_lifts),
           pwc_lifts     = coalesce((f.proposed_change->>'pwc_lifts')::int,     pp.pwc_lifts),
           jet_skis      = coalesce((f.proposed_change->>'jet_skis')::int,      pp.jet_skis),
           toy_lifts     = coalesce((f.proposed_change->>'toy_lifts')::int,     pp.toy_lifts),
           lawn_band     = coalesce(f.proposed_change->>'lawn_band',            pp.lawn_band)
     where pp.property_id = (select property_id from public.jobs where id = f.job_id);
  end if;

  update public.flags set status = 'approved' where id = p_flag_id;
end $$;

-- Only the server (service role) calls this; no client grants.
revoke execute on function public.apply_flag_change(uuid) from public, anon, authenticated;
