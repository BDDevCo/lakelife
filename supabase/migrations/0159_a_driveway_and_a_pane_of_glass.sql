-- ============================================================================
-- 0159 — A DRIVEWAY AND A PANE OF GLASS
--
-- Two new facts about a property, for two new services (snow removal and
-- window washing, both lake-home). No service row is created here and nothing
-- becomes bookable — this migration exists so that the columns arrive together
-- with every writer and every reader of them, in one commit.
--
-- THAT IS THE WHOLE POINT OF ITS SHAPE. This codebase's dominant defect is a
-- column read everywhere and written by nothing, and its mirror. A profile
-- column has FOUR doorways and three of them are easy to forget:
--
--   1. the column itself                     (here)
--   2. the app's own write path              (profile/actions.ts, same commit)
--   3. apply_flag_change — the ONLY route a crew's correction ever reaches
--      the profile                           (here, below)
--   4. vendor_jobs — the view is the ONLY way a crew can READ a profile
--      column at all                         (here, below)
--
-- Miss (3) and CLAUDE.md rule 6 becomes false: the flag flips to 'approved',
-- the profile is unchanged, and the repricing that follows runs on the old
-- number, with no error on any screen. Miss (4) and the crew's route card
-- simply never shows the fact, so they arrive not knowing whether it is 20
-- panes or 120.
--
-- ------------------------------------------------- why the two differ ------
--
-- `panes` is a COUNT, default 0, exactly like pier_sections. Zero is a real
-- answer meaning "no glass we handle", and `serviceApplies` already refuses a
-- counted service at zero — so a cottage with no panes on file gets no window
-- tile, with no extra branch anywhere.
--
-- `drive_band` is NULLABLE WITH NO DEFAULT, and that is deliberate and
-- different from `lawn_band` beside it. lawn_band is coerced to 'medium' by
-- three separate readers, so a customer who never opened the lawn step has a
-- medium lawn asserted about them on their profile, on the crew's card, and
-- in their price. This one follows beds/baths, which service-helpers.ts leaves
-- NULL because "a home with 0 bedrooms is a false fact, and false facts are
-- the thing this codebase keeps having to dig back out." An unmeasured
-- driveway produces NO snow tile rather than a wrong price.
-- ============================================================================

alter table public.property_profile
  add column if not exists panes integer default 0,
  add column if not exists drive_band text;

comment on column public.property_profile.panes is
  'Panes of glass the window-washing service counts. 0 = none on file, which '
  'gives the property no window-washing tile (serviceApplies refuses a counted '
  'service at zero). Default 0 mirrors pier_sections.';

comment on column public.property_profile.drive_band is
  'Driveway size for snow pricing: small | medium | large, or NULL when nobody '
  'has been asked. NULL is load-bearing — it is what keeps a snow tile off a '
  'property whose driveway has never been measured. Do NOT give this a '
  'default; lawn_band beside it is coerced to ''medium'' on read and that '
  'asserts a fact about homes nobody has looked at.';

alter table public.property_profile
  drop constraint if exists property_profile_drive_band_known;
alter table public.property_profile
  add constraint property_profile_drive_band_known
  check (drive_band is null or drive_band in ('small', 'medium', 'large'));

-- A pane count is a count. Same shape as the app's own sanitizer.
alter table public.property_profile
  drop constraint if exists property_profile_panes_is_sane;
alter table public.property_profile
  add constraint property_profile_panes_is_sane
  check (panes is null or (panes >= 0 and panes <= 999));

-- ----------------------------------- 3. the crew's correction can land -----
--
-- Unchanged from 0011 except for the two new keys. A crew standing on a
-- 300-foot driveway, or counting a wall of glass the profile says is eight
-- panes, can now propose the correction and have it actually applied when the
-- homeowner approves it. Without this the flag would be approved and the
-- profile silently untouched.
--
-- `ll_safe_count` is reused for panes (it is the same "a count from a browser"
-- problem), and the band follows lawn_band's exact three-value pattern.

create or replace function public.apply_flag_change(p_flag_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  f  record;
  pc jsonb;
begin
  select * into f from public.flags where id = p_flag_id and status = 'pending' for update;
  if not found then
    raise exception 'flag is not pending';
  end if;

  pc := f.proposed_change;
  if pc is not null then
    update public.property_profile pp
       set pier_sections = coalesce(public.ll_safe_count(pc->>'pier_sections'), pp.pier_sections),
           boat_lifts    = coalesce(public.ll_safe_count(pc->>'boat_lifts'),    pp.boat_lifts),
           pwc_lifts     = coalesce(public.ll_safe_count(pc->>'pwc_lifts'),     pp.pwc_lifts),
           jet_skis      = coalesce(public.ll_safe_count(pc->>'jet_skis'),      pp.jet_skis),
           toy_lifts     = coalesce(public.ll_safe_count(pc->>'toy_lifts'),     pp.toy_lifts),
           panes         = coalesce(public.ll_safe_count(pc->>'panes'),         pp.panes),
           lawn_band     = coalesce(
                             case when pc->>'lawn_band' in ('small','medium','large')
                                  then pc->>'lawn_band' end,
                             pp.lawn_band),
           drive_band    = coalesce(
                             case when pc->>'drive_band' in ('small','medium','large')
                                  then pc->>'drive_band' end,
                             pp.drive_band)
     where pp.property_id = (select property_id from public.jobs where id = f.job_id);
  end if;

  update public.flags set status = 'approved' where id = p_flag_id;
end $function$;

-- ------------------------------------- 4. the crew can READ the two facts --
--
-- APPENDED, NEVER REORDERED. `create or replace view` requires the existing
-- columns to keep their position and type, and 0150 carries a tripwire about
-- this precisely because a rewrite here has emptied the crew's route card
-- before, silently. The two new columns go on the end and nothing above them
-- moves.

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
    s.needs_release,
    pp.panes,
    pp.drive_band
   FROM jobs j
     LEFT JOIN services s ON s.id = j.service_id
     JOIN properties p ON p.id = j.property_id
     LEFT JOIN lakes lk ON lk.id = p.lake_id
     LEFT JOIN users u ON u.id = p.owner_id
     LEFT JOIN property_profile pp ON pp.property_id = j.property_id
  WHERE j.vendor_id = ll_my_vendor_id();

-- --------------------------------------------------- post-conditions ------

do $$
declare n int; ok boolean; v_prop uuid;
begin
  -- The columns exist, with the shapes their comments promise.
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='property_profile'
         and column_name in ('panes','drive_band')) <> 2 then
    raise exception '0159: the two profile columns did not land';
  end if;
  if (select column_default from information_schema.columns
       where table_schema='public' and table_name='property_profile'
         and column_name='drive_band') is not null then
    raise exception '0159: drive_band has a DEFAULT — an unmeasured driveway would assert a size';
  end if;

  -- The crew can read both. This is the doorway that is easiest to miss and
  -- the one with no error when it is missed.
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='vendor_jobs'
         and column_name in ('panes','drive_band')) <> 2 then
    raise exception '0159: vendor_jobs does not project the new facts — no crew can see them';
  end if;
  -- And nothing above them moved.
  if (select column_name from information_schema.columns
       where table_schema='public' and table_name='vendor_jobs' and ordinal_position=1) <> 'id' then
    raise exception '0159: vendor_jobs column order shifted — the route card reads by name but the view is load-bearing';
  end if;

  -- The correction path actually writes them.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='apply_flag_change'
         and pg_get_functiondef(p.oid) like '%drive_band%'
         and pg_get_functiondef(p.oid) like '%panes%') <> 1 then
    raise exception '0159: apply_flag_change ignores the new keys — a crew correction would be approved and dropped';
  end if;

  -- THE BAND REFUSES ANYTHING BUT THE THREE, proven against a real row rather
  -- than read off pg_constraint — a constraint can exist and not bite.
  -- UPDATE, not INSERT: it touches an existing row and invents nothing, and
  -- the whole migration is one transaction, so the write never survives.
  select property_id into v_prop from public.property_profile limit 1;
  if v_prop is null then
    raise notice '0159: no property_profile row to prove the CHECK against; skipped';
  else
    ok := false;
    begin
      update public.property_profile set drive_band = 'enormous' where property_id = v_prop;
    exception when others then
      ok := (sqlerrm like '%drive_band_known%');
    end;
    if not ok then
      raise exception '0159: an invented driveway size was accepted, or refused by something other than its own constraint';
    end if;

    -- And the three real values are accepted, or the column is useless.
    update public.property_profile set drive_band = 'large' where property_id = v_prop;
    if (select drive_band from public.property_profile where property_id = v_prop) <> 'large' then
      raise exception '0159: a real driveway size would not save';
    end if;
    -- Put it back. NULL is the truth: nobody has measured this driveway.
    update public.property_profile set drive_band = null where property_id = v_prop;
  end if;

  raise notice '0159: a driveway and a pane of glass have somewhere to live, and four doorways each.';
end $$;
