-- 0150 — SOMEBODY HAS TO HAND IT OVER.
--
-- THE DRIVEWAY RULE, in the owner's own words (src/lib/arrival.ts):
--
--   "If the crew doesnt need to get into the house then do the work or it
--    becomes a no show, reschedule if both parties agree or they get charged."
--
-- `noAnswerOutcome` implements it from one column, `needs_interior_access`.
-- Both spring collection services carry FALSE, so the rule resolves to
-- "proceed_as_booked" and the crew is told, in `noAnswerExplainer`:
--
--   "No answer is fine for Boat return & splash — do the work as booked and
--    we'll bill the original amount."
--
-- On a collection there IS no work to do as booked. The boat is behind
-- somebody else's gate; if nobody hands it over, the crew leaves with an empty
-- trailer. Telling them to proceed and bill the original amount is a sentence
-- that cannot be acted on and a bill nobody earned.
--
-- ============ WHY NOT JUST SET needs_interior_access ============
--
-- Because the explainer would then say "Boat return & splash needs to get
-- inside", which is equally untrue and sends the crew looking for a door.
-- The column means what it says, and it is right about housekeeping, both
-- winterizations and spring opening. It should keep meaning that.
--
-- What interior access and boat release have in common is one rung up: THE
-- VISIT CANNOT PROCEED UNTIL SOMEBODY LETS THE CREW AT THE THING. That is the
-- rule the owner actually stated. So this adds the second instance of it
-- rather than overloading the first.
--
-- ============ THE GUARD IS WIDENED, NOT DUPLICATED ============
--
-- `noAnswerOutcome` now returns no_show when EITHER flag is set, and the
-- explainer carries a sentence per case — a crew that cannot get a boat
-- released is not told to knock harder.
--
-- The failure mode this migration exists to avoid CREATING is the one this
-- codebase keeps meeting: a guard whose input nobody passes. `needs_release`
-- is therefore REQUIRED (not optional) in the TypeScript type the rule takes,
-- so every call site must name it and the compiler refuses the ones that
-- forget. Four readers were widened in the same commit.
--
-- ============ WHAT THIS DOES NOT DO ============
--
--   · It does not make LakeLife a party to the release. Courier, not witness:
--     we do not contact the yard, do not hold an authorisation, and do not
--     claim anybody agreed to anything. Arranging it is the customer's, and
--     0151 records that they say they have.
--   · It does not add a no-show REASON code. `jobs.no_show_reason` is free
--     text and already carries "the marina wouldn't release it" perfectly well.

-- ------------------------------------------------------- 1. the column ---

alter table public.services
  add column if not exists needs_release boolean not null default false;

comment on column public.services.needs_release is
  'Whether this visit needs a THIRD PARTY to hand the customer''s property '
  'over before it can start — a marina, storage yard or barn releasing a boat. '
  'Sibling of needs_interior_access: both mean "the crew cannot get at the '
  'thing on their own", and either one turns no-answer into a no-show rather '
  'than into proceed-as-booked. Set for the spring collection services (0150).';

-- --------------------------------------------- 2. the two collections ---

-- Exactly the services that fetch a boat from somewhere we do not control.
update public.services
   set needs_release = true
 where needs_pickup_spot;

-- ------------------------------------------- 3. the crew's day sees it ---

-- `vendor_jobs` is what the crew's Today list reads, with `select("*")`, and
-- it is where VendorStopCard gets `needs_interior_access`. Without the sibling
-- column the sheet cannot be told about a release and the driveway rule is
-- decided from half its inputs.
--
-- REPLACED, NOT REBUILT, and the definition below is `pg_get_viewdef` output
-- with ONE line appended. A view rewrite empties a screen with no error, so
-- the safe move is to change exactly one thing. The new column is LAST
-- because `create or replace view` will not accept it anywhere else.
create or replace view public.vendor_jobs as
 SELECT j.id,
    j.property_id,
    j.service_id,
    s.name AS service_name,
    s.min_photos,
    j.date,
    j.slot,
    j.frequency,
    j.status,
    j.route_id,
    j.sequence,
    j.created_at,
    p.address,
    p.lat,
    p.lng,
    lk.name AS lake_name,
    u.name AS owner_name,
    pp.pier_sections,
    pp.boat_lifts,
    pp.pwc_lifts,
    pp.jet_skis,
    pp.lawn_band,
    s.needs_interior_access,
    j.est_minutes,
    j.held_at,
    j.no_show_at,
    j.no_show_reason,
    j.stood_down_at,
    j.stood_down_reason,
    s.needs_release
   FROM jobs j
     LEFT JOIN services s ON s.id = j.service_id
     JOIN properties p ON p.id = j.property_id
     LEFT JOIN lakes lk ON lk.id = p.lake_id
     LEFT JOIN users u ON u.id = p.owner_id
     LEFT JOIN property_profile pp ON pp.property_id = j.property_id
  WHERE j.vendor_id = ll_my_vendor_id();

-- ---------------------------------------------------- 4. the tripwires ---

do $$
declare n integer;
begin
  -- 1. BOTH COLLECTION SERVICES ARE COVERED. Until this ran, both told the
  --    crew to proceed and bill for a boat they could not reach.
  select count(*) into n from public.services where needs_release;
  if n <> 2 then
    raise exception '0150: % services need a release, expected the 2 collections', n;
  end if;

  -- 2. A RELEASE ONLY MAKES SENSE WHERE THE THING IS SOMEWHERE ELSE. If a
  --    service needs a handover but never asks where the property is, nobody
  --    knows whose gate the crew is standing at.
  if exists (select 1 from public.services where needs_release and not needs_pickup_spot) then
    raise exception '0150: a service needs a release but never asks where the boat is';
  end if;

  -- 3. THE ORIGINAL RULE IS UNTOUCHED. Housekeeping, both winterizations and
  --    spring opening still need to get inside, and this migration must not
  --    have quietly moved any of them onto the new flag instead.
  select count(*) into n from public.services where needs_interior_access;
  if n <> 5 then
    raise exception '0150: % services need interior access, expected the original 5', n;
  end if;

  -- 4. THE CREW'S DAY STILL WORKS. A rewritten view that lost a column, or
  --    lost its ll_my_vendor_id() filter, is the failure this whole section is
  --    written carefully to avoid — the first would break the sheet, the
  --    second would show every crew everybody's jobs.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'vendor_jobs';
  if n <> 30 then
    raise exception '0150: vendor_jobs has % columns, expected 30 (29 + needs_release)', n;
  end if;
  if position('ll_my_vendor_id' in pg_get_viewdef('public.vendor_jobs'::regclass, true)) = 0 then
    raise exception '0150: vendor_jobs lost its vendor filter — every crew would see every job';
  end if;

  -- 5. AND NOTHING IS BOTH. Not an error in itself, but it would mean a
  --    service claiming two different reasons a crew cannot start, and the
  --    explainer can only say one of them.
  if exists (select 1 from public.services where needs_release and needs_interior_access) then
    raise exception '0150: a service claims both interior access and a release — the crew can only be told one';
  end if;
end $$;
