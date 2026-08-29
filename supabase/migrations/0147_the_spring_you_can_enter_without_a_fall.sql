-- 0147 — THE SPRING YOU CAN ENTER WITHOUT A FALL.
--
-- Owner decision (29 Aug 2026): the 2026 fall season is already gone. Boats on
-- these lakes come out of the water 12–16 Nov, and The Haven does not close
-- until 15 Dec — so by the time there is a park, every boat worth winterizing
-- has been winterized by somebody else. The first season LakeLife can actually
-- sell into is SPRING 2027: de-winterize, test run, and put the boat back in.
--
-- ============ THE SPRING HAS NO FRONT DOOR ============
--
-- Both storage packages are fall-entry, full-season envelopes:
--
--   we_haul  "We pick it up"          fall: haul-out (required) + shop
--                                            winterization (required) + storage
--                                     spring: de-winterize, return & splash
--   you_tow  "You tow it to the shop"  fall: shop winterization (required)
--                                     spring: de-winterize, return & splash
--
-- The spring legs are the BACK HALF. They are born from the fall group by
-- `birthSpringJobs`, with custody sticky to whoever holds the boat. A customer
-- whose boat wintered in a third party's yard has no group, no stay, and
-- therefore no way in — the required legs are fall legs that already happened,
-- somewhere else, without us.
--
-- The fall solved this long ago and the spring never got the same treatment:
-- `Fall winterization` ($485) is a standalone service sitting outside the
-- package machinery entirely. Spring has no equivalent.
--
-- ============ WHY NOT JUST FLIP `kind` ============
--
-- Because `kind` is single-valued and read in BOTH directions, exclusively:
--
--   the customer menu   .eq("kind", "standalone")        4 call sites
--   the package wizard  .in("kind", ["component","addon"])
--   the crew rate card  component/addon ⇒ always priceable, no menu step
--
-- Moving these two services to `standalone` takes them OUT of the packages.
-- `you_tow`'s spring phase is EXACTLY these two legs and nothing else, so it
-- would be left with an empty spring: a package that books a fall visit and
-- promises a spring with no legs. That is precisely the failure
-- `src/app/book/storage/data.ts` already warns about in prose — "priced,
-- bookable, and wrong" — and it would land on the fall-2027 product that this
-- whole plan depends on working as designed.
--
-- So the opening is a SECOND DOOR, named, exactly as 0143 did for parks:
-- `park_bookable` let a park buy a general service without disturbing the
-- `park_only` fence. `solo_bookable` lets a package leg be booked on its own
-- without disturbing `kind`. One row, one price, one vendor rate, two doors.
--
-- ============ WHAT THIS DOES NOT DO ============
--
--   · It turns NOTHING on. Both services stay `active = false`. The launch
--     switch is `active`, by design, and it is the owner's to flip when there
--     is a crew and a price he is happy with. Until then this is inert.
--   · It changes NO price. $9/ft de-winterize and $285 splash are the numbers
--     the package design already carries. Whether they are the right numbers
--     for a job sold on its own is a pricing decision, not a migration.
--   · It does not touch the packages, the stays, or `birthSpringJobs`. Fall
--     2027 still works exactly as designed.
--
-- WHAT IT DOES NOT SOLVE, AND MUST NOT BE READ AS SOLVING: a boat wintered in
-- somebody else's yard still has to be COLLECTED. A job knows the customer's
-- property and nothing else — there is no pickup address anywhere in the
-- schema. This migration opens the door for "customer brings it to the water";
-- "we collect it from the storer" needs a pickup location and a release
-- handoff, and is deliberately not attempted here.

-- ------------------------------------------------------- 1. the column ---

alter table public.services
  add column if not exists solo_bookable boolean not null default false;

comment on column public.services.solo_bookable is
  'Whether this package component may ALSO be booked on its own, outside a '
  'package. `kind` stays what it is, so the package wizard and the crew rate '
  'card keep seeing it as a leg. The customer menu accepts kind=standalone OR '
  'solo_bookable. Added 0147 for spring-entry boat work, where the fall half '
  'of the package happened somewhere else. Does not imply active.';

-- ------------------------------------------------- 2. the spring legs ---

-- The two legs that ARE the spring product. Left inactive on purpose.
update public.services
   set solo_bookable = true
 where name in ('Spring de-winterize & test run', 'Boat return & splash')
   and kind = 'component';

-- ---------------------------------------------------- 3. the tripwires ---

do $$
declare
  n integer;
  spring_legs integer;
begin
  -- 1. BOTH LEGS GOT THE FLAG. Named rather than counted, so a rename shows up
  --    here rather than as a spring that quietly never opens.
  select count(*) into n
    from public.services
   where solo_bookable
     and name in ('Spring de-winterize & test run', 'Boat return & splash');
  if n <> 2 then
    raise exception '0147: % of the 2 spring legs are solo_bookable — check the names', n;
  end if;

  -- 2. NOTHING ELSE GOT IT. This is a deliberate, small opening.
  select count(*) into n from public.services where solo_bookable;
  if n <> 2 then
    raise exception '0147: % solo_bookable services, expected exactly the 2 spring legs', n;
  end if;

  -- 3. `kind` IS UNTOUCHED — the whole point. A standalone service is already
  --    on the menu; flagging one solo_bookable would put it in the menu query
  --    twice. (Same shape as 0143's park_only/park_bookable check.)
  if exists (select 1 from public.services where solo_bookable and kind = 'standalone') then
    raise exception '0147: a standalone service is flagged solo_bookable — it is already bookable';
  end if;

  -- 4. THE PACKAGES KEEP THEIR SPRING. If this ever reads 0, the back half of
  --    both packages has been emptied and fall 2027 sells a spring it cannot
  --    deliver — the exact failure this migration exists to avoid causing.
  select count(*) into spring_legs
    from public.package_components pc
    join public.services s on s.id = pc.service_id
   where pc.phase = 'spring' and s.kind in ('component', 'addon');
  if spring_legs = 0 then
    raise exception '0147: no spring package legs left — the packages have been emptied';
  end if;

  -- 5. NOTHING WAS TURNED ON. `active` is the launch switch and it is his.
  if exists (
    select 1 from public.services
     where solo_bookable and active
  ) then
    raise notice '0147: a solo_bookable service is ACTIVE — spring is live, confirm that was intended';
  end if;
end $$;
