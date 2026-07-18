-- ============================================================
--  LakeLife — booking: capacity, job frequency, owner booking.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ---------- per-service daily crew capacity (drives "full" days) ----------
-- Real capacity comes from vendors in Phase 5; these are sensible defaults,
-- matching the prototype, and editable from Ops later.
alter table public.services
  add column if not exists daily_capacity integer not null default 5;

update public.services set daily_capacity = case name
  when 'Pier install / removal'      then 3
  when 'Boat lift set / pull'        then 4
  when 'PWC lift set / pull'         then 4
  when 'Boat storage & winterize'    then 4
  when 'Jet ski winterize & store'   then 4
  when 'Water toy prep & storage'    then 6
  when 'Lawn mowing & trim'          then 8
  when 'Housekeeping'                then 5
  when 'Spring opening'              then 3
  when 'Fall winterization'          then 3
  else daily_capacity end;

-- ---------- remember the chosen frequency on a job ----------
alter table public.jobs
  add column if not exists frequency text;

-- ---------- let an owner book (insert) a job for their own property ----------
-- They can create a 'requested' job with a customer price, but can NEVER set
-- vendor_cost or margin (rule 1). Reads still go through the price-safe
-- owner_jobs view below, so owners never see cost/margin.
drop policy if exists jobs_owner_insert on public.jobs;
create policy jobs_owner_insert on public.jobs for insert
  with check (
    vendor_cost is null
    and margin is null
    and exists (
      select 1 from public.properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );

-- ---------- owner_jobs view: add service name + frequency ----------
-- Drop first: "create or replace view" can't remove/reorder columns, and we're
-- changing the column set (adding service_name + frequency).
drop view if exists public.owner_jobs;
create view public.owner_jobs
with (security_invoker = off) as
  select j.id, j.property_id, j.service_id, s.name as service_name,
         j.date, j.slot, j.frequency, j.status, j.customer_price, j.created_at
  from public.jobs j
  join public.properties p on p.id = j.property_id
  left join public.services s on s.id = j.service_id
  where p.owner_id = auth.uid();

grant select on public.owner_jobs to authenticated;
