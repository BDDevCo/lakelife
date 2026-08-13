-- 0093 — THE CREW CAN SEE THE STAND-DOWN.
--
-- 0088 added `jobs.stood_down_at` as a THIRD completion-blocking fact and
-- added it to none of the four crew-side readers. So the moment an owner
-- declines a correction the crew said they could not work around:
--
--   the amber "waiting on the owner" banner DISAPPEARS (held_at was cleared),
--   "I'm here" comes back, and "Mark complete" re-enables.
--
-- The crew's card silently reverts to an ordinary pending stop. They may go
-- and do the damaging partial scope that 0088 exists to prevent — and if they
-- tap Complete they get "0 of 2 photos uploaded", an instruction to photograph
-- work that must not happen.
--
-- The database still held the line: nothing bills, nothing pays, no false
-- completion. What was lost is the crew's morning and any chance of telling
-- them to go home.
--
-- THE REWRITE IS THE DANGEROUS PART, AND IT IS WHY THIS IS ITS OWN MIGRATION.
-- 0086 did this exact thing six hours earlier, wrote `security_invoker = true`,
-- and blanked every crew's route until 0087 put it back. `off` is deliberate:
-- the view is postgres-owned and self-scopes with `ll_my_vendor_id()`, and
-- `jobs` RLS has only an ops policy. The post-conditions below assert it.

create or replace view public.vendor_jobs
with (security_invoker = off) as
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
    -- ---- appended, 0093 ----
    j.stood_down_at,
    j.stood_down_reason
   FROM jobs j
     LEFT JOIN services s ON s.id = j.service_id
     JOIN properties p ON p.id = j.property_id
     LEFT JOIN lakes lk ON lk.id = p.lake_id
     LEFT JOIN users u ON u.id = p.owner_id
     LEFT JOIN property_profile pp ON pp.property_id = j.property_id
  WHERE j.vendor_id = ll_my_vendor_id();

do $$
declare opts text; n int; leaked text;
begin
  -- THE ONE THAT 0086 NEEDED AND DID NOT HAVE.
  select coalesce(array_to_string(c.reloptions, ','), '') into opts
    from pg_class c where c.relname = 'vendor_jobs' and c.relnamespace = 'public'::regnamespace;
  if opts ilike '%security_invoker=true%' or opts ilike '%security_invoker=on%' then
    raise exception
      '0093: vendor_jobs is security_invoker again — that empties every crew''s route';
  end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='vendor_jobs'
     and column_name in ('held_at','no_show_at','stood_down_at');
  if n <> 3 then
    raise exception '0093: vendor_jobs is missing a completion-blocking column (got % of 3)', n;
  end if;

  select string_agg(column_name, ', ') into leaked
    from information_schema.columns
   where table_schema='public' and table_name='vendor_jobs'
     and column_name in ('customer_price','vendor_cost','margin','tip_amount','fee_proposed_amount');
  if leaked is not null then
    raise exception '0093: vendor_jobs exposes %, which rule 1 forbids', leaked;
  end if;

  if pg_get_viewdef('public.vendor_jobs'::regclass, true) not ilike '%ll_my_vendor_id()%' then
    raise exception '0093: vendor_jobs lost its vendor predicate';
  end if;

  if (select column_name from information_schema.columns
       where table_schema='public' and table_name='vendor_jobs' and ordinal_position = 6) <> 'date' then
    raise exception '0093: the existing columns moved';
  end if;
end $$;
