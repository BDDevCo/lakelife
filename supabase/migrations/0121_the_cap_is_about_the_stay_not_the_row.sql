-- 0121 — SAY WHAT THE CAP ACTUALLY MEASURES
--
-- 0120 moved `max_days` from counting one booking to counting everything a
-- stay holds on that unit, which is the rule the owner means. The message did
-- not move with it: a guest holding two of a two-day allowance and tapping a
-- third was told "that is more days than this park allows ONE BOOKING to
-- hold" — about a booking of one day. True of nothing she could see.
--
-- Found by tapping it. The screen now also stops OFFERING days once she is at
-- her allowance, so this message is the backstop rather than the first thing
-- she meets — but a backstop that lies is still a lie.

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
      -- Names the allowance and what is already gone, because "more days than
      -- allowed" about a one-day booking reads as a bug.
      raise exception 'This park allows % day(s) of the % per stay, and % already booked.',
        am.max_days, am.name, held;
    end if;
  end if;

  return new;
end $$;

