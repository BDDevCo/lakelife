-- 0137 — THE LOT THE VIEW COULD NEVER FIND
--
-- `/park/visits` says "Grounds" for every visit ever made inside a park,
-- including work done on one specific lot. Not sometimes — always, for every
-- park, since 0107 shipped.
--
-- 0107 added `jobs.park_lot_id`, joined the visit view to it, and guarded it
-- with a trigger. Then nothing ever wrote it. Not the booking flow, not the
-- park service desk, not the request-to-job path — I grepped every insert and
-- update against `public.jobs` in the application. The column has been NULL on
-- every row of that table since the day it was created, so the LEFT JOIN never
-- matches and `lot_number` is always NULL.
--
-- It is not that the link is missing. 0122 built it, three weeks later and for
-- a different reason: a home the park owns gets its own `properties` row, and
-- `park_lots.service_property_id` points at it. That migration's own heading is
-- "THE LOT CARRIES THE LINK", and it is unique, so one property belongs to at
-- most one lot. 0107's column was superseded by 0122's and the view was never
-- moved across.
--
-- So join the link that exists and is written, rather than the one that is
-- guarded and empty. This fixes every visit already in the table — there is no
-- backfill to run, because the answer was always derivable.
--
-- WHAT STILL DOES NOT LEAVE THIS VIEW: no renter, no address, no price, no
-- margin, no job id to join back with. 0085 kept the lot out; 0107 put it in
-- for liability, and that judgement is unchanged. A park owner learns that a
-- crew came to lot 7 on Tuesday, which is what he could see out of the window.
--
-- NULL still means the common ground — `parks.service_property_id` is the
-- park's own grounds property and belongs to no lot, so it matches nothing
-- here and the screen goes on saying "Grounds" for exactly the work that is.

create or replace view public.park_site_visits
with (security_invoker = true) as
select
  p.park_id                                   as park_id,
  j.date                                      as visit_date,
  j.est_minutes                               as est_minutes,
  coalesce(v.company, 'Crew to be assigned')  as crew,
  s.name                                      as service,
  j.status                                    as status,
  -- NULL = the common ground. The screen says "the grounds", not a bare dash.
  l.lot_number                                as lot_number
from public.jobs j
join public.properties p on p.id = j.property_id
left join public.vendors   v on v.id = j.vendor_id
left join public.services  s on s.id = j.service_id
-- 0107 joined `l.id = j.park_lot_id`, a column nothing writes. The lot's own
-- pointer at its home's property is the link that is actually maintained.
left join public.park_lots l on l.service_property_id = j.property_id
where p.park_id is not null
  and j.status in ('scheduled', 'in_progress', 'complete', 'paid');

comment on view public.park_site_visits is
  'Crew, service, when and WHICH LOT — for work inside a park. 0085 kept the '
  'lot out; 0107 put it in for liability but joined a column nothing writes, '
  'so every visit read "Grounds"; 0137 joins park_lots.service_property_id, '
  'the link 0122 established and maintains. Still carries no renter, address, '
  'price, margin or job id. A park manager may read only their own park''s rows.';

-- Service-role only, exactly as 0085 and 0107 left it: the app reads this
-- through createServiceClient() AFTER assertMyPark. No grant to authenticated.
revoke all on public.park_site_visits from anon, authenticated;

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  cols text[];
begin
  select array_agg(column_name::text order by column_name)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'park_site_visits';

  -- The lot is selectable.
  if not ('lot_number' = any(cols)) then
    raise exception '0137: park_site_visits lost lot_number';
  end if;

  -- And nothing that was kept out has crept back in.
  if cols && array['renter_id','renter','display_name','address','lat','lng',
                   'customer_price','margin','vendor_cost','job_id','id',
                   'park_lot_id','property_id'] then
    raise exception '0137: park_site_visits leaks a column it must not carry: %',
      array_to_string(cols, ', ');
  end if;
end $$;
