-- 0120 — ONE LINK THAT BOOKS THE BOAT
--
-- A guest staying three nights will never make an account, and asking her to is
-- how she ends up ringing the office on a Saturday morning instead. So the same
-- discipline the extend-stay and confirm-a-payment links already use: one
-- unguessable token on her stay, one page, no password.
--
-- ITS OWN TOKEN, DELIBERATELY NOT `extend_token`. One link carrying two
-- authorities is one link somebody eventually forwards to a friend, and the
-- friend can then extend a stay they are not on. A token is a capability; two
-- capabilities want two tokens.
--
-- MINTED FOR EVERY LIVE STAY, not only the nightly ones. `who_may_book` is a
-- per-park dial now — a pavilion or a golf cart may legitimately be for
-- residents, or for both — so the page decides what to offer from the amenity's
-- own rule rather than from who was handed a link. A monthly resident at a park
-- whose only amenity is guests-only opens it and is told so plainly.

alter table public.lot_reservations
  add column if not exists use_token text unique;

comment on column public.lot_reservations.use_token is
  'Unguessable link to THIS stay''s amenity page — book the boat, the pavilion. '
  'Separate from extend_token on purpose: one link, one authority. A guest '
  'never makes an account, so the stay row is her identity.';

-- Every live stay gets one, so the office can text the link the day it books a
-- guest in rather than waiting for a nightly job to catch up.
update public.lot_reservations
   set use_token = encode(gen_random_bytes(24), 'hex')
 where use_token is null
   and status in ('approved', 'active');

create or replace function public.mint_use_token()
returns trigger language plpgsql as $$
begin
  if new.use_token is null and new.status in ('approved', 'active') then
    new.use_token := encode(gen_random_bytes(24), 'hex');
  end if;
  return new;
end $$;

drop trigger if exists trg_mint_use_token on public.lot_reservations;
create trigger trg_mint_use_token
  before insert or update on public.lot_reservations
  for each row execute function public.mint_use_token();

-- ------------------------------------------------- one party, N days total ---
--
-- `max_days` was enforced per BOOKING, which is the wrong unit once a guest can
-- tap day by day. A two-day cap that a guest can defeat with five separate taps
-- is not a cap; it is a speed bump with a comment attached. The rule the owner
-- means is "one party may hold this for at most N days", so it is counted
-- across every live booking that stay holds on that unit.
create or replace function public.amenity_booking_fits()
returns trigger language plpgsql as $$
declare
  stay record;
  am   record;
  held integer;
  want integer;
begin
  select a.* into am
    from public.park_amenities a
    join public.park_amenity_units u on u.amenity_id = a.id
   where u.id = new.unit_id;
  if am is null then
    raise exception 'That amenity is gone.';
  end if;
  if am.park_id <> new.park_id then
    raise exception 'That booking is against another park''s amenity.';
  end if;

  if new.status = 'blackout' then
    return new;
  end if;

  select r.*, l.park_id as lot_park_id, l.rental_mode
    into stay
    from public.lot_reservations r
    join public.park_lots l on l.id = r.park_lot_id
   where r.id = new.stay_id;
  if stay is null then
    raise exception 'That stay is gone.';
  end if;

  if stay.status not in ('approved', 'active') then
    raise exception 'That stay is not live, so nothing can be booked against it.';
  end if;
  if stay.lot_park_id <> new.park_id then
    raise exception 'That stay is at another park.';
  end if;
  if not (new.during <@ stay.during) then
    raise exception 'That is outside their stay.';
  end if;

  if am.who_may_book = 'guests' and stay.rental_mode <> 'short_term' then
    raise exception 'That one is for short-stay guests only.';
  end if;
  if am.who_may_book = 'residents' and stay.rental_mode = 'short_term' then
    raise exception 'That one is for residents only.';
  end if;

  if am.max_days is not null then
    want := upper(new.during) - lower(new.during);

    -- Everything this stay ALREADY holds on this unit, excluding the row being
    -- updated so an edit does not count itself twice.
    select coalesce(sum(upper(b.during) - lower(b.during)), 0)
      into held
      from public.amenity_bookings b
     where b.stay_id = new.stay_id
       and b.unit_id = new.unit_id
       and b.status = 'booked'
       and b.id <> new.id;

    if (held + want) > am.max_days then
      raise exception 'That is more days than this park allows one booking to hold.';
    end if;
  end if;

  return new;
end $$;

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  lid uuid; pid uuid; lot uuid; ren uuid; stay uuid;
  am uuid; unit uuid; ok boolean; tok text; tok2 text;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0120 Proof','1 Rd','0120-proof', lid,'mh', false) returning id into pid;
    insert into public.park_lots (park_id, lot_number, site_type, rental_mode, lifecycle)
    values (pid, 'N1', 'rv_site', 'short_term', 'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid, 'Guest One') returning id into ren;

    -- 1. A NEW LIVE STAY GETS A TOKEN WITHOUT ANYBODY ASKING.
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
    values (lot, ren, daterange('2026-07-14','2026-07-21'), 'nightly', 'approved')
    returning id, use_token into stay, tok;
    if tok is null or length(tok) < 32 then
      raise exception '0120: a live stay got no usable link token';
    end if;

    -- 2. IT IS NOT THE EXTEND TOKEN. Two authorities, two tokens.
    select extend_token into tok2 from public.lot_reservations where id = stay;
    if tok2 is not null and tok2 = tok then
      raise exception '0120: one token would both extend a stay and book a boat';
    end if;

    -- 3. THE CAP COUNTS THE STAY, NOT THE ROW. Two days allowed; three
    --    one-day taps must not slip past it.
    insert into public.park_amenities (park_id, name, charge_model, day_rate, who_may_book, max_days, active)
    values (pid, 'The pontoon', 'per_day', 150, 'guests', 2, true) returning id into am;
    insert into public.park_amenity_units (amenity_id, label)
    values (am, 'The pontoon') returning id into unit;

    insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
    values (pid, unit, stay, ren, daterange('2026-07-15','2026-07-16'));
    insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
    values (pid, unit, stay, ren, daterange('2026-07-16','2026-07-17'));

    ok := false;
    begin
      insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
      values (pid, unit, stay, ren, daterange('2026-07-17','2026-07-18'));
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0120: a guest held the boat for three days under a two-day cap';
    end if;

    -- 4. A CANCELLED DAY GIVES THE ALLOWANCE BACK. Otherwise changing your
    --    mind costs you the cap, which nobody would understand.
    update public.amenity_bookings
       set status = 'cancelled', cancelled_at = now(), cancel_reason = 'changed mind'
     where stay_id = stay and lower(during) = date '2026-07-15';
    insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
    values (pid, unit, stay, ren, daterange('2026-07-17','2026-07-18'));

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
