-- 0119 — THE PARK OWNS THINGS A GUEST CAN HAVE FOR A WHILE
--
-- The Haven comes with a boat, and it is for the short-stay guests to book
-- while they are here. That is the first case; it is not the shape of the
-- problem. A park also has a pavilion, a golf cart, four kayaks, a boat slip,
-- a storage bay — things the park owns that one party holds exclusively for a
-- window, at a price the park sets. This models that, not the boat.
--
-- THE FENCE, so nobody has to work it out later:
--   IF A CREW GETS PAID FOR IT, IT IS NOT AN AMENITY.
-- Mowing is a service: LakeLife dispatches it, a vendor is paid, photos gate
-- the completion, and there is a margin. Renting the pontoon is none of those.
-- Amenity money is the PARK'S money, the same side of the wall as rent, and it
-- never nets against anything LakeLife bills.
--
-- WHOLE DAYS, AND THAT IS A CHOICE
-- `during` is a daterange, half-open, whole days — the same type and the same
-- helpers (parseDaterange/toDaterange/overlaps/nightsIn) as every other window
-- in this schema. The alternative was tstzrange, and it was argued for: real
-- boat liveries overwhelmingly sell half-days, and a pavilion is booked by the
-- evening. Both are true and neither is here yet. Introducing a second range
-- type would fork the date library on day one for a boat that is handed over
-- with the keys in the morning.
--
-- SO THE REVISIT TRIGGER IS NAMED RATHER THAN DISCOVERED: the first amenity
-- that needs part of a day. `during` becomes tstzrange on a table holding a few
-- dozen rows, which is a cheap migration — but only if nobody has meanwhile
-- written code that assumes days. Hence `booking_grain`, which today has
-- exactly one legal value.
--
-- THREE TABLES, and the middle one is the one that earns its place:
--   park_amenities       what it is, what it costs, who may book it, when
--   park_amenity_units   the individual thing that gets held exclusively
--   amenity_bookings     one party, one unit, one window
-- Four kayaks are FOUR UNITS under ONE amenity, so the rate is edited once and
-- cannot disagree with itself — and the exclusion constraint still has a
-- per-object key, which is the only way the database can referee a clash.

-- ---------------------------------------------------------------- what ----
create table if not exists public.park_amenities (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,

  -- The owner's words. This prints on the guest's page, so it is his voice,
  -- not ours: "The pontoon", "Nana's kayaks", "The pavilion".
  name          text not null check (length(btrim(name)) between 2 and 60),

  -- Presentation only. NOTHING may branch on this except an icon map — the
  -- first `if (kind === 'boat')` in a screen is the moment the pavilion becomes
  -- wrong and this table's generality becomes a lie.
  kind          text not null default 'other'
                check (kind in ('boat','watercraft','vehicle','space','other')),

  booking_grain text not null default 'day' check (booking_grain in ('day')),

  -- HOW IT IS PAID FOR. 'included' and a rate of zero are DIFFERENT FACTS and
  -- are stored differently on purpose: without this the owner's day sheet reads
  -- "$0.00 — unpaid" for a boat that comes free with the cabin.
  charge_model  text not null default 'included'
                check (charge_model in ('included','per_day')),
  day_rate      numeric(10,2) check (day_rate is null or day_rate >= 0),
  constraint park_amenities_priced_if_charged
    check (charge_model <> 'per_day' or (day_rate is not null and day_rate > 0)),
  constraint park_amenities_included_is_free
    check (charge_model <> 'included' or day_rate is null),

  -- WHO. The Haven's boat is 'guests' — and that is what keeps 0118's argument
  -- true, because its upkeep is carried by the park precisely BECAUSE no
  -- monthly household can book it. A cart or a pavilion may legitimately be
  -- 'both'. This is a per-park dial, not a rule baked in for one park.
  who_may_book  text not null default 'guests'
                check (who_may_book in ('guests','residents','both')),

  -- Longest single booking, in days. Stops one guest holding the boat all week
  -- by accident. NULL = no limit, which is a real choice.
  max_days      smallint check (max_days is null or max_days between 1 and 60),

  -- ITS OWN SEASON, not the park's. A pontoon comes out of the water in October
  -- whether or not the park stays open, and a year-round park would otherwise
  -- sell a January day on the ice.
  season_open_month  smallint check (season_open_month between 1 and 12),
  season_open_day    smallint check (season_open_day between 1 and 31),
  season_close_month smallint check (season_close_month between 1 and 12),
  season_close_day   smallint check (season_close_day between 1 and 31),

  -- The park owner's own sentence above the button — life jackets are in the
  -- dock box, back by six, no wake past the point. No default and no seed:
  -- this is the one thing on the guest's page we must never write for him.
  rules         text,

  -- Ships dark. Nothing is bookable until he turns it on, having seen it.
  active        boolean not null default false,
  created_at    timestamptz not null default now(),

  unique (park_id, name)
);

comment on table public.park_amenities is
  'A thing the park owns that one party can hold exclusively for a window — a '
  'boat, a pavilion, a cart, a slip. IF A CREW GETS PAID FOR IT, IT IS NOT AN '
  'AMENITY: that is a LakeLife service, with a vendor, a photo gate and a '
  'margin. Amenity money is the park''s money, the same side as rent.';

-- ------------------------------------------------------------ which one ----
create table if not exists public.park_amenity_units (
  id          uuid primary key default gen_random_uuid(),
  amenity_id  uuid not null references public.park_amenities(id) on delete cascade,

  -- What the owner hands over, in words a guest can repeat back. "The pontoon",
  -- "Kayak 3 (green)". A guest who cannot say which one she has is a phone call.
  label       text not null check (length(btrim(label)) between 1 and 60),
  sort_order  smallint not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),

  unique (amenity_id, label)
);

-- -------------------------------------------------------------- who has ----
create table if not exists public.amenity_bookings (
  id          uuid primary key default gen_random_uuid(),

  -- Denormalised ON PURPOSE: every read on this table is park-scoped and every
  -- authority check is `assertMyPark`. Reaching the park through two joins on
  -- a public endpoint is how one gets forgotten.
  park_id     uuid not null references public.parks(id) on delete cascade,
  unit_id     uuid not null references public.park_amenity_units(id) on delete cascade,

  -- WHOSE. A guest booking hangs off their STAY; that row is their identity and
  -- they will never have an account. NULL only for a blackout, which is the
  -- park taking a day off the calendar for itself.
  stay_id     uuid references public.lot_reservations(id) on delete cascade,
  renter_id   uuid references public.park_renters(id) on delete set null,

  during      daterange not null,
  status      text not null default 'booked'
              check (status in ('booked','cancelled','blackout')),

  -- What it cost AT THE TIME. Snapshotted like lot_reservations.quoted_amount,
  -- so editing the rate in August cannot rewrite what July's guest agreed to.
  quoted_amount numeric(10,2) check (quoted_amount is null or quoted_amount >= 0),

  -- The guest ticked the park's own rules. Read on the owner's day sheet: he is
  -- handing somebody the keys to a boat and wants to know they saw the line
  -- about life jackets.
  acknowledged_at timestamptz,

  -- NULL means the guest did it themselves, off their token.
  booked_by   uuid references public.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at  timestamptz not null default now(),

  constraint amenity_booking_is_a_real_window check (not isempty(during)),
  -- An unbounded range overlaps everything and would take the unit off the
  -- calendar permanently, with no error and nothing on screen to explain it.
  constraint amenity_booking_is_bounded
    check (not lower_inf(during) and not upper_inf(during)),
  -- A blackout is the park's own; a guest day always names a stay.
  constraint amenity_booking_blackout_has_no_stay
    check ((status = 'blackout') = (stay_id is null)),
  constraint amenity_booking_cancel_has_a_reason
    check (cancelled_at is null or coalesce(btrim(cancel_reason), '') <> '')
);

-- THE REFEREE. Two guests, one boat, overlapping days — refused by the
-- database, not by a screen that raced. Cancelled rows drop out of the
-- predicate, so cancelling frees the day with no further work.
alter table public.amenity_bookings
  drop constraint if exists amenity_no_double_booking;
alter table public.amenity_bookings
  add constraint amenity_no_double_booking
  exclude using gist (unit_id with =, during with &&)
  where (status in ('booked','blackout'));

create index if not exists amenity_bookings_by_park on public.amenity_bookings (park_id, during);
create index if not exists amenity_bookings_by_stay on public.amenity_bookings (stay_id);

-- ------------------------------------------------- it has to fit the stay ---
--
-- Three things SQL alone cannot say, and one that comes from a column rather
-- than from The Haven's arrangement.
create or replace function public.amenity_booking_fits()
returns trigger language plpgsql as $$
declare
  stay record;
  am   record;
  lot  record;
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

  -- A blackout is the park's own day. Nothing below applies to it.
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
  -- CONTAINED BY THE STAY. Somebody who leaves on Sunday cannot have the boat
  -- on Monday, and the database is where that belongs.
  if not (new.during <@ stay.during) then
    raise exception 'That is outside their stay.';
  end if;

  -- WHO MAY BOOK, read off the amenity rather than assumed. The Haven's boat
  -- is 'guests' — which is exactly what makes 0118 true, because its upkeep is
  -- the park's precisely because no monthly household can book it.
  if am.who_may_book = 'guests' and stay.rental_mode <> 'short_term' then
    raise exception 'That one is for short-stay guests only.';
  end if;
  if am.who_may_book = 'residents' and stay.rental_mode = 'short_term' then
    raise exception 'That one is for residents only.';
  end if;

  if am.max_days is not null
     and (upper(new.during) - lower(new.during)) > am.max_days then
    raise exception 'That is longer than this park allows for one booking.';
  end if;

  return new;
end $$;

drop trigger if exists trg_amenity_booking_fits on public.amenity_bookings;
create trigger trg_amenity_booking_fits
  before insert or update on public.amenity_bookings
  for each row execute function public.amenity_booking_fits();

-- ------------------------------------------------------------- the money ----
-- The same shape 0097 gave a tip: money that must never enter the rent path
-- gets its own kind and its own foreign key. `park_payments_is_anchored`
-- (0102) is satisfied unchanged because an amenity row carries renter_id.
alter table public.park_payments
  add column if not exists amenity_booking_id uuid
  references public.amenity_bookings(id) on delete set null;

alter table public.park_payments drop constraint if exists park_payments_kind_check;
alter table public.park_payments add constraint park_payments_kind_check
  check (kind in ('rent', 'deposit', 'amenity'));

alter table public.park_payments drop constraint if exists park_payments_amenity_is_linked;
alter table public.park_payments add constraint park_payments_amenity_is_linked
  check ((kind = 'amenity') = (amenity_booking_id is not null));

-- Amenity money is never against a rent bill. park_charges is month-shaped —
-- `unique (reservation_id, period_month)` — and putting a boat day in it would
-- refuse that household's actual rent bill for the month.
alter table public.park_payments drop constraint if exists park_payments_amenity_has_no_charge;
alter table public.park_payments add constraint park_payments_amenity_has_no_charge
  check (kind <> 'amenity' or charge_id is null);

comment on column public.park_payments.amenity_booking_id is
  'The boat day / pavilion evening this money is for. Set exactly when '
  'kind = ''amenity''. Never carries a charge_id: an amenity is not rent and '
  'park_charges is one-row-per-household-per-month.';

-- ------------------------------------------------------------- the fence ----
alter table public.park_amenities      enable row level security;
alter table public.park_amenity_units  enable row level security;
alter table public.amenity_bookings    enable row level security;

-- RLS IS NOT A GRANT. Every read and write goes through the service client
-- behind an assertMyPark, or behind a guest's token — never the anon client.
revoke insert, update, delete on public.park_amenities     from anon, authenticated;
revoke insert, update, delete on public.park_amenity_units from anon, authenticated;
revoke insert, update, delete on public.amenity_bookings   from anon, authenticated;

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  lid uuid; pid uuid; lot uuid; ren uuid; stay uuid;
  lot2 uuid; ren2 uuid; stay2 uuid;
  am uuid; unit uuid; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0119 Proof','1 Rd','0119-proof', lid,'mh', false) returning id into pid;

    insert into public.park_lots (park_id, lot_number, site_type, rental_mode, lifecycle)
    values (pid, 'N1', 'rv_site', 'short_term', 'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid, 'Guest One') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
    values (lot, ren, daterange('2026-07-14','2026-07-18'), 'nightly', 'approved')
    returning id into stay;

    insert into public.park_amenities (park_id, name, kind, charge_model, day_rate, who_may_book, active)
    values (pid, 'The pontoon', 'boat', 'per_day', 150, 'guests', true) returning id into am;
    insert into public.park_amenity_units (amenity_id, label)
    values (am, 'The pontoon') returning id into unit;

    -- 1. A DAY INSIDE THE STAY IS ACCEPTED.
    insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during, quoted_amount)
    values (pid, unit, stay, ren, daterange('2026-07-15','2026-07-16'), 150);

    -- 2. THE SAME DAY, AGAIN, IS REFUSED BY THE DATABASE (23P01) — not by a
    --    screen that checked a moment earlier.
    ok := false;
    begin
      insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
      values (pid, unit, stay, ren, daterange('2026-07-15','2026-07-16'));
    exception when exclusion_violation then ok := true;
    end;
    if not ok then raise exception '0119: one boat was booked twice for one day'; end if;

    -- 3. BACK TO BACK IS FINE. Half-open means [15,16) and [16,17) do not touch.
    insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during, quoted_amount)
    values (pid, unit, stay, ren, daterange('2026-07-16','2026-07-17'), 150);

    -- 4. OUTSIDE THE STAY IS REFUSED. They leave on the 18th.
    ok := false;
    begin
      insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
      values (pid, unit, stay, ren, daterange('2026-07-19','2026-07-20'));
    exception when others then ok := true;
    end;
    if not ok then raise exception '0119: a guest booked a day after they had left'; end if;

    -- 5. A MONTHLY RESIDENT CANNOT TAKE A GUESTS-ONLY AMENITY. This is 0118's
    --    argument enforced where a screen cannot forget it.
    insert into public.park_lots (park_id, lot_number, site_type, rental_mode, lifecycle)
    values (pid, 'M1', 'mh_single', 'long_term', 'live') returning id into lot2;
    insert into public.park_renters (park_id, display_name)
    values (pid, 'Resident One') returning id into ren2;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
    values (lot2, ren2, daterange('2026-01-01','2027-01-01'), 'monthly', 'active')
    returning id into stay2;

    ok := false;
    begin
      insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
      values (pid, unit, stay2, ren2, daterange('2026-07-20','2026-07-21'));
    exception when others then ok := true;
    end;
    if not ok then raise exception '0119: a monthly resident booked a guests-only amenity'; end if;

    -- 6. A BLACKOUT NEEDS NO STAY, AND BLOCKS THE DAY ANYWAY.
    insert into public.amenity_bookings (park_id, unit_id, during, status)
    values (pid, unit, daterange('2026-08-01','2026-08-03'), 'blackout');
    ok := false;
    begin
      insert into public.amenity_bookings (park_id, unit_id, stay_id, renter_id, during)
      values (pid, unit, stay, ren, daterange('2026-08-02','2026-08-03'));
    exception when others then ok := true;
    end;
    if not ok then raise exception '0119: a guest booked a day the park had blacked out'; end if;

    -- 7. AN UNBOUNDED WINDOW IS REFUSED — it would overlap everything forever.
    ok := false;
    begin
      insert into public.amenity_bookings (park_id, unit_id, during, status)
      values (pid, unit, daterange(null, '2026-09-01'), 'blackout');
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0119: an unbounded booking was accepted'; end if;

    -- 8. A PRICED AMENITY MUST CARRY A PRICE, AND A FREE ONE MUST NOT.
    ok := false;
    begin
      insert into public.park_amenities (park_id, name, charge_model) values (pid, 'Unpriced', 'per_day');
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0119: a per-day amenity shipped with no rate'; end if;
    ok := false;
    begin
      insert into public.park_amenities (park_id, name, charge_model, day_rate)
      values (pid, 'Free but priced', 'included', 25);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0119: an included amenity carried a rate'; end if;

    -- 9. AMENITY MONEY IS NOT RENT AND CANNOT BE FILED AS IT.
    ok := false;
    begin
      insert into public.park_payments (park_id, renter_id, amount, method, received_on, kind)
      values (pid, ren, 150, 'cash', current_date, 'amenity');
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0119: amenity money was filed with no booking behind it'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
