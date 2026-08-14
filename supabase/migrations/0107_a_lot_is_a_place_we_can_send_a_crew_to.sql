-- 0107 — A LOT IS A PLACE WE CAN SEND A CREW TO.
--
-- ParkNav has rendered "Book services for the park" since it shipped, pointing
-- at /book — where a park owner with no property is told "Set up your property
-- first." and handed the lake-house wizard. A shipped promise with no
-- mechanism. This migration is the mechanism.
--
-- ============ WHY 0052'S COLUMN CANNOT WORK, AND IS DROPPED HERE ============
--
-- 0052 put `service_property_id` on lot_reservations so "the renter can book
-- ordinary lake services against their lot". Three years of schema later that
-- is impossible as written:
--
--   * 0055 DROPPED lot_reservations.renter_user_id and replaced it with
--     renter_id -> park_renters(id), whose user_id is NULLABLE BY DESIGN
--     ("NULL = UNCLAIMED. This is the entire point of the table."). A
--     reservation therefore carries NO USER AT ALL, and properties.owner_id is
--     NOT NULL. There is nobody for the minted property to belong to.
--   * 0062 made a tenancy a CHAIN of agreements. At The Haven's three-month
--     cap that is 19 households x 4 agreements = 76 properties a year, each
--     one a duplicate address.
--
-- The column has never been written. It is dropped rather than left as a
-- comment describing a thing that cannot happen — this repo's commonest defect
-- is exactly that.
--
-- WHAT REPLACES IT: the PARK is the customer. One property for the park, owned
-- by the park's own member, and a job may name the LOT it is at. The renter
-- needs no account for a crew to be sent to their lot, which matters because
-- nineteen of The Haven's twenty-one households will never have one.
--
-- ================== THE LOT IS VISIBLE, AND THAT IS NEW ==================
--
-- 0085 said: "THE LINK IS TO THE PARK, NEVER TO THE LOT. That is the whole
-- design." This migration deliberately reverses that, on the owner's decision,
-- for a reason 0085 did not weigh: LIABILITY. A contractor on Lot 7 is on land
-- the park owns, using utilities the park maintains, under the park's
-- insurance. "A landlord always needs to know who is on property."
--
-- IT ALSO PASSES 0085'S OWN TEST. That test is "what he could already learn by
-- looking out the window" — and a van parked at Lot 7 is visible from the
-- window. 0085 was stricter than its own stated rule required, and it bought
-- privacy that the rent roll already gave away: he knows which household is on
-- which lot, because he collects their rent.
--
-- WHAT STAYS OUT, PERMANENTLY: price, margin, the renter's name on a job, and
-- the household's profile. Those are NOT visible from the window and are not
-- liability facts. A visit log answers "who is on my land, where, when". It
-- must never become a record of what a household buys or what they paid.
--
-- A LAKELIFE SERVICE DEBT NEVER TOUCHES park_charges OR park_payments, IN
-- EITHER DIRECTION. This migration creates no FK path between the rent ledger
-- and jobs/invoices. 0052's central prohibition is unchanged.

-- ------------------------------------------- 1. drop the impossible column --
do $$
declare n int;
begin
  select count(*) into n
    from public.lot_reservations where service_property_id is not null;
  if n > 0 then
    raise exception '0107: % reservations carry a service_property_id — something started writing it; do NOT drop', n;
  end if;
end $$;

alter table public.lot_reservations drop column if exists service_property_id;

-- ------------------------------------- 2. the park's own grounds property --
alter table public.parks
  add column if not exists service_property_id uuid
    references public.properties(id) on delete set null;

create unique index if not exists parks_service_property_uidx
  on public.parks (service_property_id) where service_property_id is not null;

comment on column public.parks.service_property_id is
  'The PARK''S OWN properties row — the common ground it buys work on. '
  'owner_id is one of the park''s own members: the person we charge and text. '
  'NOT a tenancy pointer. 0052 put one of those on lot_reservations for a '
  'renter; 0055 then made a reservation carry no user at all, and that column '
  'is dropped in this file.';

-- A park may only point at a property owned by one of ITS OWN members, and
-- that property must carry no Google place_id (0006's global partial unique
-- index would otherwise collide a park's grounds with a real address). Both
-- are database rules rather than code conventions: one bad refactor pointing a
-- park at a RENTER'S property would invert every privacy argument here.
create or replace function public.guard_park_service_property()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare p record;
begin
  if new.service_property_id is null then return new; end if;

  select pr.owner_id, pr.place_id into p
    from public.properties pr where pr.id = new.service_property_id;
  if not found then
    raise exception 'parks: that property does not exist';
  end if;

  if not exists (
    select 1 from public.park_members pm
     where pm.park_id = new.id and pm.user_id = p.owner_id
  ) then
    raise exception 'parks: a park''s service property must be owned by one of its own members';
  end if;

  if p.place_id is not null then
    raise exception 'parks: a park''s service property must not carry a Google place_id';
  end if;

  return new;
end $function$;

drop trigger if exists parks_service_property_guard on public.parks;
create trigger parks_service_property_guard
  before insert or update on public.parks
  for each row execute function public.guard_park_service_property();

-- ------------------------------------------------ 3. the lot a job is at --
alter table public.jobs
  add column if not exists park_lot_id uuid
    references public.park_lots(id) on delete set null;

create index if not exists jobs_park_lot_idx
  on public.jobs (park_lot_id) where park_lot_id is not null;

comment on column public.jobs.park_lot_id is
  'The lot this work is at, for park-authored work inside a park. NULL means '
  'the common ground, or an ordinary lake-home job. Set by the PARK when it '
  'sends a crew to a named lot — the renter needs no account for this. Read by '
  'the crew''s sheet (so the truck goes to the right pad) and by the park''s '
  'visit log (so the owner knows who is on his land and where). Never carries '
  'a price and never names the household.';

-- The lot must be IN the park that owns the job's property. Without this a
-- browser-supplied id could pin a job to another park's lot, and the visit log
-- — which is scoped by park — would show a stranger's work to the wrong owner.
create or replace function public.guard_job_park_lot()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare prop_park uuid; lot_park uuid;
begin
  if new.park_lot_id is null then return new; end if;

  select park_id into prop_park from public.properties where id = new.property_id;
  select park_id into lot_park  from public.park_lots  where id = new.park_lot_id;

  if prop_park is null then
    raise exception 'jobs: a job can only name a lot when its property belongs to a park';
  end if;
  if prop_park is distinct from lot_park then
    raise exception 'jobs: that lot is not in this job''s park';
  end if;
  return new;
end $function$;

drop trigger if exists jobs_park_lot_guard on public.jobs;
create trigger jobs_park_lot_guard
  before insert or update of park_lot_id, property_id on public.jobs
  for each row execute function public.guard_job_park_lot();

-- --------------------------------------- 4. the visit log carries the lot --
-- Crew, service, time — AND WHERE. Still no renter, no address, no price, no
-- margin, no job id to join back with. What a park owner cannot select, he
-- cannot leak; the lot is now selectable and the money still is not.
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
left join public.park_lots l on l.id = j.park_lot_id
where p.park_id is not null
  and j.status in ('scheduled', 'in_progress', 'complete', 'paid');

comment on view public.park_site_visits is
  'Crew, service, when and WHICH LOT — for work inside a park. 0085 kept the '
  'lot out; 0107 puts it in, for liability: a landlord always needs to know '
  'who is on his property and where. Still carries no renter, address, price, '
  'margin or job id. A park manager may read only their own park''s rows.';

revoke all on public.park_site_visits from anon, authenticated;

-- ----------------------------------------- 5. services sold only to parks --
alter table public.services
  add column if not exists park_only boolean not null default false;

comment on column public.services.park_only is
  'Sold ONLY against a park''s own grounds property. A grounds property sees '
  'ONLY these; every other property sees only the rest. Default false is the '
  'launch switch — an existing service is unaffected.';

-- The three the common ground actually needs. Priced off the LIVE LOT COUNT,
-- a new countable field, because a 21-lot park is a different day's work from
-- a 60-lot park and a flat rate would be wrong at both ends.
--
-- THESE PRICES ARE PLACEHOLDERS and are marked as such on the screen. Nothing
-- is sellable until the owner sets his real numbers; the screen prints the
-- arithmetic before any booking button.
insert into public.services
  (name, pricing_model, base, unit_rate, frequency_options, min_photos,
   is_water_work, band_pricing, park_only, active, needs_interior_access)
values
  ('Park grounds mowing & trim', 'per_section', 140, 22,
   array['Weekly','Every 2 weeks'], 2, false,
   '{"count_field":"lots"}'::jsonb, true, true, false),
  ('Common-area spring cleanup', 'per_section', 380, 12,
   array['One-time'], 3, false,
   '{"count_field":"lots"}'::jsonb, true, true, false),
  ('Common-area fall cleanup & leaf haul', 'per_section', 340, 12,
   array['One-time'], 3, false,
   '{"count_field":"lots"}'::jsonb, true, true, false)
on conflict (name) do update
  set pricing_model = excluded.pricing_model,
      base          = excluded.base,
      unit_rate     = excluded.unit_rate,
      band_pricing  = excluded.band_pricing,
      park_only     = excluded.park_only,
      min_photos    = excluded.min_photos;

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; pid2 uuid; lot uuid; lot2 uuid; prop uuid; prop2 uuid;
        uid uuid; ok boolean; n int; leaked text;
begin
  select id into lid from public.lakes limit 1;
  select id into uid from public.users limit 1;
  if lid is null or uid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0107 Proof','1 Rd','0107-proof', lid,'mh', false) returning id into pid;
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0107 Other','2 Rd','0107-other', lid,'mh', false) returning id into pid2;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'7', true,'live') returning id into lot;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid2,'99', true,'live') returning id into lot2;

    insert into public.properties (owner_id, lake_id, address, park_id)
    values (uid, lid, 'The Haven — grounds', pid) returning id into prop;

    -- 1. A PARK CANNOT POINT AT A PROPERTY OWNED BY A NON-MEMBER.
    ok := false;
    begin
      update public.parks set service_property_id = prop where id = pid;
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0107: a park adopted a property owned by somebody who is not its member';
    end if;

    -- Make the owner a member; now it holds.
    insert into public.park_members (park_id, user_id, role) values (pid, uid, 'owner');
    update public.parks set service_property_id = prop where id = pid;

    -- 2. A place_id ON THE GROUNDS PROPERTY IS REFUSED (0006 collision).
    update public.properties set place_id = '0107-fake-place' where id = prop;
    ok := false;
    begin
      update public.parks set service_property_id = prop where id = pid;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0107: a grounds property kept a Google place_id'; end if;
    update public.properties set place_id = null where id = prop;

    -- 3. A JOB MAY NAME A LOT IN ITS OWN PARK...
    insert into public.jobs (property_id, park_lot_id, date, status)
    values (prop, lot, current_date, 'scheduled');

    -- ...AND MAY NOT NAME ANOTHER PARK'S LOT.
    ok := false;
    begin
      insert into public.jobs (property_id, park_lot_id, date, status)
      values (prop, lot2, current_date, 'scheduled');
    exception when others then ok := true;
    end;
    if not ok then raise exception '0107: a job pinned itself to another park''s lot'; end if;

    -- ...AND A NON-PARK PROPERTY MAY NOT NAME A LOT AT ALL.
    insert into public.properties (owner_id, lake_id, address)
    values (uid, lid, '0107 lake house') returning id into prop2;
    ok := false;
    begin
      insert into public.jobs (property_id, park_lot_id, date, status)
      values (prop2, lot, current_date, 'scheduled');
    exception when others then ok := true;
    end;
    if not ok then raise exception '0107: a lake house claimed a park lot'; end if;

    -- 4. THE VISIT LOG SHOWS THE LOT, AND STILL LEAKS NO MONEY.
    select count(*) into n from public.park_site_visits
     where park_id = pid and lot_number = '7';
    if n <> 1 then raise exception '0107: the visit log does not carry the lot (got %)', n; end if;

    select string_agg(column_name, ', ') into leaked
      from information_schema.columns
     where table_schema='public' and table_name='park_site_visits'
       and column_name in ('customer_price','vendor_cost','margin','renter_id',
                           'address','job_id','owner_id','renter_name');
    if leaked is not null then
      raise exception '0107: the visit log leaks % — price and identity must never be selectable', leaked;
    end if;

    -- 5. THE PARK SERVICES PRICE OFF THE LOT COUNT, AND CARRY A PHOTO GATE.
    select count(*) into n from public.services
     where park_only = true and (min_photos < 2 or active = false);
    if n > 0 then
      raise exception '0107: % park service(s) ship without a real photo gate', n;
    end if;
    select count(*) into n from public.services
     where park_only = true and band_pricing->>'count_field' <> 'lots';
    if n > 0 then raise exception '0107: a park service is not priced off the lot count'; end if;

    -- 6. THE OLD COLUMN IS GONE.
    select count(*) into n from information_schema.columns
     where table_schema='public' and table_name='lot_reservations'
       and column_name='service_property_id';
    if n <> 0 then raise exception '0107: lot_reservations still carries service_property_id'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
