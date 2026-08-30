-- 0148 — THE BOAT IS NOT WHERE THE CUSTOMER LIVES.
--
-- 0147 opened a spring door: `Spring de-winterize & test run` and
-- `Boat return & splash` can now be booked on their own, without the fall half
-- of a package that happened somewhere else. Its own header says plainly what
-- it did NOT solve, and this is that:
--
--   "a boat wintered in somebody else's yard still has to be COLLECTED. A job
--    knows the customer's property and nothing else — there is no pickup
--    address anywhere in the schema."
--
-- ============ WHY THE PROPERTY IS THE WRONG ANSWER ============
--
-- Every job on the platform happens AT the customer's property. Mow, clean,
-- open, close, pull the pier — the address on the job IS `properties.address`,
-- and `jobs` carries no location of its own because it never needed one.
--
-- Spring boat work is the first thing LakeLife sells where that is false. In
-- spring 2027 the boat spent the winter in a third party's yard: a marina, a
-- storage lot, a neighbour's barn. Sending a crew to the customer's lake house
-- to collect a boat that is twenty miles away is not a near miss — there is
-- nothing there to collect.
--
-- ============ WHAT THIS ADDS ============
--
--   jobs.pickup_address / pickup_lat / pickup_lng
--     Where the boat actually is for THIS visit. Nullable, because every other
--     service on the platform is correctly silent about it. Captured by the
--     same Places autocomplete the property address uses, so it arrives with
--     coordinates when Google answers and as typed text when it does not —
--     that field already degrades gracefully and a typed address is still an
--     address a crew can drive to.
--
--   services.needs_pickup_spot
--     Which services have to ask. Named, not inferred: the alternative is
--     hardcoding two service names in the booking flow, and rule 8 keeps this
--     kind of rule in the database.
--
-- ============ THE RULE IS THE FLAG *AND* THE ABSENCE OF A GROUP ============
--
-- A package visit must NOT ask. Inside `we_haul` / `you_tow` the boat is in
-- OUR yard and we know exactly where — `storage_stays.vendor_id` says so, and
-- `birthSpringJobs` pins the spring legs to whoever holds it. Asking the
-- customer where their boat is, when we are the ones holding it, is a question
-- that makes the platform look like it has lost the boat.
--
-- So the requirement is `needs_pickup_spot AND group_id IS NULL`. Both halves
-- carry meaning and both are checked server-side, where the booking is made.
--
-- ============ WHAT THIS DOES NOT DO ============
--
--   · It does not price by distance. The market does — the research file has
--     Timber at $150 within 10 miles and $225 to 20, Pointe Marine at $3.60 a
--     mile past 20 — and `Boat return & splash` is a flat $285 to anywhere.
--     That is a pricing decision, and inventing a distance band here would be
--     inventing a price. It stays flat until the owner says otherwise.
--   · It does not model a RELEASE. Whoever holds the boat has to hand it over,
--     and nothing here asks them to. Today that is a conversation the customer
--     has; if it needs to become a record, it needs its own design.
--   · It does not let one visit collect two boats from two places. A job
--     prices the whole fleet, so it gets one spot.

-- ------------------------------------------------------ 1. the columns ---

alter table public.jobs
  add column if not exists pickup_address text,
  add column if not exists pickup_lat double precision,
  add column if not exists pickup_lng double precision;

comment on column public.jobs.pickup_address is
  'Where the boat actually is for this visit, when that is NOT the customer''s '
  'property — spring collection from wherever it wintered. Null for every '
  'service that happens at the property, which is all of them but these. '
  'Required at booking when services.needs_pickup_spot and the job has no group.';

comment on column public.jobs.pickup_lat is
  'Coordinates of pickup_address when Places returned them. Null when the '
  'address was typed rather than picked — the address still stands. Routing '
  'and the claim board prefer these over the property''s when present, because '
  'the distance that matters is to the BOAT.';

alter table public.services
  add column if not exists needs_pickup_spot boolean not null default false;

comment on column public.services.needs_pickup_spot is
  'Whether booking this service on its own must ask where the boat is. Set for '
  'the spring legs (0148), which are the first work LakeLife sells that does '
  'not happen at the customer''s property. Never asked inside a package: there '
  'the boat is in our own yard and storage_stays says which.';

-- -------------------------------------------------- 2. the two services ---

update public.services
   set needs_pickup_spot = true
 where name in ('Spring de-winterize & test run', 'Boat return & splash');

-- ---------------------------------------------------- 3. the tripwires ---

do $$
declare n integer;
begin
  -- 1. BOTH SPRING LEGS ASK. Named, so a rename surfaces here rather than as a
  --    crew dispatched to an empty driveway.
  select count(*) into n
    from public.services
   where needs_pickup_spot
     and name in ('Spring de-winterize & test run', 'Boat return & splash');
  if n <> 2 then
    raise exception '0148: % of the 2 spring legs ask for a pickup spot', n;
  end if;

  -- 2. NOTHING ELSE ASKS. Every other service happens at the property, and
  --    asking there is a question with no right answer.
  select count(*) into n from public.services where needs_pickup_spot;
  if n <> 2 then
    raise exception '0148: % services ask for a pickup spot, expected 2', n;
  end if;

  -- 3. THE FLAG ONLY MEANS ANYTHING ON A SOLO-BOOKABLE SERVICE. A service that
  --    can only be reached inside a package would ask a question the booking
  --    flow never gets to, which is a column with no writer wearing a rule.
  if exists (
    select 1 from public.services
     where needs_pickup_spot and not solo_bookable and kind <> 'standalone'
  ) then
    raise exception '0148: a service asks for a pickup spot but cannot be booked on its own';
  end if;

  -- 4. THE COLUMNS LANDED. A missing one reads downstream as "no pickup given"
  --    — indistinguishable from a customer who was never asked.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs' and column_name = 'pickup_address'
  ) then
    raise exception '0148: jobs.pickup_address is missing';
  end if;
end $$;
