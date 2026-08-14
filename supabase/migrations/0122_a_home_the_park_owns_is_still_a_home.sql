-- 0122 — A HOME THE PARK OWNS IS STILL A HOME
--
-- The Haven's Lot 11 is a 2019 28x60 Shult that the park owns and rents out.
-- It needs cleaning between tenants, winterizing in October, de-winterizing in
-- April — ordinary house work, from the ordinary menu, at ordinary prices.
--
-- It could not be booked at all. `park_only` is a two-way fence: a park's
-- GROUNDS property sees only park services, and everything else sees only the
-- rest. That fence is right, and it was never the problem. The problem is that
-- a park-owned home is not a property at ALL — `park_owned_home` has been a
-- boolean on the lot since the module shipped, read by the cost split and the
-- revenue streams, and there is nothing anywhere a crew could be sent to.
--
-- So this changes no fence. It gives the home a property, and the existing
-- `.eq("park_only", false)` then hands it the whole house menu without a
-- single conditional being added anywhere.
--
-- THE LOT CARRIES THE LINK, not the tenancy and not the park.
--   * not the tenancy — 0107 dropped exactly that column, because a stay ends
--     and the house does not. The tenant changes; the pipes are the same pipes.
--   * not the park — `parks.service_property_id` is the GROUNDS, one per park.
--     A park may own five homes.
--   * the lot IS the place a crew drives to, which is 0107's own title.
--
-- ONLY A HOME THE PARK OWNS. A lot somebody else's home sits on is not the
-- park's to book work for, and the trigger below refuses it rather than leaving
-- that to a screen. Whose home it is decides whose service it is.

alter table public.park_lots
  add column if not exists service_property_id uuid unique
  references public.properties(id) on delete set null;

comment on column public.park_lots.service_property_id is
  'The PROPERTY for a home the park owns on this lot, so ordinary house work — '
  'cleaning, winterizing — can be booked for it. NULL for every lot whose home '
  'belongs to somebody else: their house is their business. Distinct from '
  'parks.service_property_id, which is the common ground and is one per park.';

create or replace function public.guard_lot_service_property()
returns trigger language plpgsql as $$
declare
  prop record;
begin
  if new.service_property_id is null then
    return new;
  end if;

  -- ONLY A HOME THE PARK OWNS.
  if new.park_owned_home is not true then
    raise exception 'Only a home the park owns can have work booked for it.';
  end if;

  select p.* into prop from public.properties p where p.id = new.service_property_id;
  if prop is null then
    raise exception 'That property is gone.';
  end if;

  -- IT MUST BELONG TO THIS PARK. Without this a browser could point a lot at
  -- somebody else's lake house, and every later read is lot-scoped — so the
  -- mistake would be invisible from here forever.
  if prop.park_id is distinct from new.park_id then
    raise exception 'That property is not this park''s.';
  end if;

  -- AND IT MUST NOT BE THE GROUNDS. The common ground is not a house; pointing
  -- a lot at it would put a 21-lot mow and a housekeeping visit on one menu.
  if exists (select 1 from public.parks k where k.service_property_id = new.service_property_id) then
    raise exception 'That is the park''s grounds, not a home.';
  end if;

  return new;
end $$;

drop trigger if exists trg_guard_lot_service_property on public.park_lots;
create trigger trg_guard_lot_service_property
  before insert or update on public.park_lots
  for each row execute function public.guard_lot_service_property();

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  lid uuid; pid uuid; own uuid; lot uuid; rented uuid;
  home uuid; grounds uuid; other uuid; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  select id into own from public.users limit 1;
  if lid is null or own is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0122 Proof','1 Rd','0122-proof', lid,'mh', false) returning id into pid;
    -- 0107 already refuses a service property owned by somebody outside the
    -- park. Proving THIS migration needs that one satisfied first.
    insert into public.park_members (park_id, user_id, role) values (pid, own, 'owner');

    insert into public.park_lots (park_id, lot_number, site_type, rental_mode, lifecycle, park_owned_home)
    values (pid, '11', 'mh_double', 'long_term', 'live', true) returning id into lot;
    insert into public.park_lots (park_id, lot_number, site_type, rental_mode, lifecycle, park_owned_home)
    values (pid, '14', 'mh_single', 'long_term', 'live', false) returning id into rented;

    insert into public.properties (owner_id, lake_id, address, park_id, sqft, beds, baths)
    values (own, lid, 'Lot 11, 0122 Proof', pid, 1680, 3, 2) returning id into home;

    -- 1. A PARK-OWNED HOME CAN CARRY ONE.
    update public.park_lots set service_property_id = home where id = lot;

    -- 2. A LOT SOMEBODY ELSE'S HOME SITS ON CANNOT. Their house is theirs.
    ok := false;
    begin
      update public.park_lots set service_property_id = home where id = rented;
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0122: a lot the park does not own a home on took a service property';
    end if;

    -- 3. NOR CAN IT POINT AT ANOTHER PARK'S PROPERTY.
    insert into public.properties (owner_id, lake_id, address, park_id)
    values (own, lid, 'Somebody else''s lake house', null) returning id into other;
    ok := false;
    begin
      update public.park_lots set service_property_id = other where id = lot;
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0122: a lot pointed at a property outside its park';
    end if;

    -- 4. NOR AT THE PARK'S OWN GROUNDS. A mow and a housekeeping visit must
    --    never share a menu.
    insert into public.properties (owner_id, lake_id, address, park_id)
    values (own, lid, '0122 Proof — grounds', pid) returning id into grounds;
    update public.parks set service_property_id = grounds where id = pid;
    ok := false;
    begin
      update public.park_lots set service_property_id = grounds where id = lot;
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0122: a lot pointed at the park grounds as though it were a home';
    end if;

    -- 5. ONE PROPERTY, ONE LOT. Two lots sharing a house is two crews sent to
    --    one door, and the unique index refuses it.
    ok := false;
    begin
      update public.park_lots set park_owned_home = true, service_property_id = home
       where id = rented;
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0122: two lots claimed the same home';
    end if;

    -- 6. UN-FLAGGING A PARK-OWNED HOME MUST NOT LEAVE A DANGLING LINK. It has
    --    to be given up in the same breath, or the guard refuses.
    ok := false;
    begin
      update public.park_lots set park_owned_home = false where id = lot;
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0122: a lot stopped being park-owned but kept its home';
    end if;
    update public.park_lots set park_owned_home = false, service_property_id = null where id = lot;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
