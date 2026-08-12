-- 0087 — PUT `vendor_jobs` BACK. I BROKE IT IN 0086.
--
-- 0086 added the arrival columns to `vendor_jobs` and, in rewriting the view,
-- wrote `with (security_invoker = true)`. The view has been `security_invoker
-- = off` since 0010, deliberately.
--
-- 0060 wrote down exactly why, and predicted this mistake almost word for
-- word: "`owner_jobs` and `vendor_jobs` are owned by postgres with
-- security_invoker off, which normally means an RLS bypass. They are safe...
-- each carries its OWN caller-scoped predicate (`j.vendor_id =
-- ll_my_vendor_id()`) which reads per-request JWT claims regardless of the
-- invoker setting... Flipping them to security_invoker would additionally
-- require the underlying tables' RLS to admit the caller, which is a
-- behaviour change to the owner and vendor portals and belongs in its own
-- change with its own verification."
--
-- `jobs` carries one policy, `jobs_ops`. A crew is not ops. So from 0086 until
-- now, every crew's Today route rendered "No stops on your route today" —
-- with no error anywhere, because an RLS-filtered read is not a failure, it
-- is an empty list. Found by signing in as a crew and looking at the screen.
--
-- The columns 0086 added are correct and stay. Only the invoker setting was
-- wrong. This file carries the definition that ships.

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
    -- ---- appended, 0086 ----
    s.needs_interior_access,
    j.est_minutes,
    j.held_at,
    j.no_show_at,
    j.no_show_reason
   FROM jobs j
     LEFT JOIN services s ON s.id = j.service_id
     JOIN properties p ON p.id = j.property_id
     LEFT JOIN lakes lk ON lk.id = p.lake_id
     LEFT JOIN users u ON u.id = p.owner_id
     LEFT JOIN property_profile pp ON pp.property_id = j.property_id
  WHERE j.vendor_id = ll_my_vendor_id();

-- ------------------------------------------------------ post-conditions ----
do $$
declare opts text; n int; leaked text;
begin
  -- THE ONE THAT WOULD HAVE CAUGHT 0086.
  select coalesce(array_to_string(c.reloptions, ','), '') into opts
    from pg_class c where c.relname = 'vendor_jobs' and c.relnamespace = 'public'::regnamespace;
  if opts ilike '%security_invoker=true%' or opts ilike '%security_invoker=on%' then
    raise exception
      '0087: vendor_jobs is security_invoker again — that empties every crew''s route, because jobs RLS has no vendor policy';
  end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='vendor_jobs'
     and column_name in ('held_at','no_show_at','no_show_reason','needs_interior_access','est_minutes');
  if n <> 5 then raise exception '0087: the arrival columns went missing in the revert (got %)', n; end if;

  select string_agg(column_name, ', ') into leaked
    from information_schema.columns
   where table_schema='public' and table_name='vendor_jobs'
     and column_name in ('customer_price','vendor_cost','margin');
  if leaked is not null then
    raise exception '0087: vendor_jobs exposes %, which rule 1 forbids', leaked;
  end if;

  -- The caller-scoped predicate is what makes invoker=off safe. If it ever
  -- disappears, the view hands every crew every job on the lake.
  if pg_get_viewdef('public.vendor_jobs'::regclass, true) not ilike '%ll_my_vendor_id()%' then
    raise exception '0087: vendor_jobs lost its vendor predicate — it would expose every crew''s work';
  end if;
end $$;
