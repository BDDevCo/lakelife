-- 0085 — WHO IS ON MY PROPERTY, AND WHEN.
--
-- Brendon: "park owner should see for crew validation knowing who is on site
-- at what times but thats about it. Crew, Service, Time/date."
--
-- THE LINE THAT MAKES THIS SAFE is not sensitivity, it is WHAT HE COULD
-- ALREADY LEARN BY LOOKING OUT THE WINDOW. He can see a truck in his own park
-- today. A visit log tells him it is expected — it adds no information he
-- could not get by standing there. A per-tenant purchase history is
-- information he could NEVER get that way, so it stays out.
--
-- THE LINK IS TO THE PARK, NEVER TO THE LOT. That is the whole design. With
-- only a park id he can see that a crew is coming; he cannot attribute a visit
-- to a household. Carrying park_lot_id would hand him exactly the correlation
-- this is built to withhold, and no screen-level discipline would hold it back
-- for long.

alter table public.properties
  add column if not exists park_id uuid references public.parks(id) on delete set null;

comment on column public.properties.park_id is
  'The park this property sits in, when the OWNER OF THE PROPERTY chose to say '
  'so. Deliberately the park and NOT the lot: it lets a park owner see that a '
  'crew is on his land without letting him attribute a visit to a tenant. '
  'Self-declared, never inferred — nobody is enrolled in being visible.';

create index if not exists properties_park_idx
  on public.properties (park_id) where park_id is not null;

-- ------------------------------------------------------------- the view ---
-- CREW, SERVICE, TIME/DATE. Nothing else leaves this view: no renter, no
-- address, no lot, no price, no margin, no job id to join back with. What a
-- park owner cannot select, he cannot leak.
create or replace view public.park_site_visits
with (security_invoker = true) as
select
  p.park_id                                   as park_id,
  j.date                                      as visit_date,
  j.est_minutes                               as est_minutes,
  coalesce(v.company, 'Crew to be assigned')  as crew,
  s.name                                      as service,
  j.status                                    as status
from public.jobs j
join public.properties p on p.id = j.property_id
left join public.vendors  v on v.id = j.vendor_id
left join public.services s on s.id = j.service_id
where p.park_id is not null
  and j.status in ('scheduled', 'in_progress', 'complete', 'paid');

comment on view public.park_site_visits is
  'Crew, service and when — for work inside a park. Deliberately carries no '
  'renter, address, lot, price or job id. A park manager may read only their '
  'own park''s rows (see the grant below + park_members).';

revoke all on public.park_site_visits from anon, authenticated;

-- ------------------------------------------------------ post-conditions ----
do $$
declare n int; leaked text;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='properties' and column_name='park_id';
  if n <> 1 then raise exception '0085: properties.park_id missing'; end if;

  -- THE ONE THAT MATTERS: the view must not expose anything that identifies a
  -- household, a place, or a price.
  select string_agg(column_name, ', ') into leaked
    from information_schema.columns
   where table_schema='public' and table_name='park_site_visits'
     and column_name in (
       'park_lot_id','lot_number','renter_id','renter','display_name','address',
       'nickname','customer_price','vendor_cost','margin','property_id','job_id',
       'owner_id','user_id','lat','lng'
     );
  if leaked is not null then
    raise exception '0085: park_site_visits exposes %, which a landlord must not see', leaked;
  end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='park_site_visits'
     and column_name in ('crew','service','visit_date');
  if n <> 3 then raise exception '0085: the view is missing crew/service/visit_date'; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='park_site_visits'
     and grantee in ('anon','authenticated');
  if n <> 0 then raise exception '0085: park_site_visits is directly selectable by a browser'; end if;
end $$;
