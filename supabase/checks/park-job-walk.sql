-- THE PARK JOB WALK — a crew's first day at The Haven, against the LIVE database.
--
-- Nobody had ever walked a PARK job end to end. Every guard in this chain was
-- written for a lake house and reused for a park, and reuse is exactly where a
-- rule quietly stops applying: `jobs_photo_gate` reads services.min_photos, so
-- it does not care whose property it is — but that is a claim, and a claim
-- about a trigger is worth nothing until the trigger refuses something.
--
-- So this MAKES a park job on The Haven's real grounds property and tries to
-- break each rule in turn, reporting what the database actually said.
--
-- ============ IT LEAVES NOTHING BEHIND ============
--
-- One PL/pgSQL block that ends by RAISING, so the whole thing rolls back: the
-- crew, the job, the photos, every row. The transcript comes back as the
-- exception message. Safer than create-then-delete-by-id — there is no window
-- in which a stray row exists, and no cleanup step that can fail halfway.
--
-- It uses The Haven's REAL grounds property and REAL services on purpose. A
-- fixture park would prove the trigger works on a fixture park.
--
-- ============ RUN IT ============
--
--   Supabase MCP `execute_sql`, or the SQL editor. It is EXPECTED TO FAIL —
--   the exception IS the output. Anything other than "PARK JOB WALK" is a real
--   error.
--
-- ============ WHAT IT SHOULD SAY ============
--
-- RUN AGAINST PRODUCTION 5 Sep 2026. Verbatim:
--
--   mow min_photos   : 2
--   job created      : $100 price / $80 cost
--   0 of 2 photos -> REFUSED: rule 2: job ... cannot
--   1 of 2 photos -> REFUSED: rule 2: job ... cannot
--   2 of 2 photos -> complete
--   cost above price -> REFUSED: a job cannot be assigned at a loss: vendor_cost 150 exc
--   lot at this park -> allowed (correct)
--   lot, OTHER park  -> only one park exists, not testable
--   owner sees visits today: 1
--   and its columns are   : park_id, visit_date, est_minutes, crew, service, status, lot_number
--
-- EVERY RULE HELD. That last line is the other half of the answer: the owner's
-- visit view carries crew, service, time and lot number and NOTHING about a
-- household — no name, no contact, no rent. "The park owner sees visits, not
-- tenants" is real, not just intended.
--
-- Every REFUSED line is a rule doing its job. A line that says ALLOWED where
-- this comment says REFUSED is a hole, and the rule it names is the one to fix.

do $$
declare
  v_park    uuid := 'facade00-0000-4000-8000-000000000001';  -- The Haven
  v_prop    uuid;                                            -- its grounds property
  v_owner   uuid;
  v_lake    uuid;
  v_mow     uuid;  v_mow_min int;
  v_crewusr uuid := gen_random_uuid();
  v_vendor  uuid;
  v_job     uuid;
  v_lot     uuid;
  v_other   uuid;
  t text := '';
begin
  select service_property_id, lake_id into v_prop, v_lake from public.parks where id = v_park;
  if v_prop is null then
    raise exception 'The Haven has no grounds property — run enableParkServices first.';
  end if;
  select owner_id into v_owner from public.properties where id = v_prop;
  select id, coalesce(min_photos,0) into v_mow, v_mow_min
    from public.services where name = 'Park grounds mowing & trim';

  t := t || E'\n  grounds property : ' || v_prop
         || E'\n  mow min_photos   : ' || v_mow_min;

  -- A crew, good on paper: unexpired COI, matching named insured, active.
  insert into auth.users (id) values (v_crewusr);
  insert into public.vendors
    (user_id, company, status, coi_url, coi_expiry, coi_named_insured, w9_url,
     service_types, service_lakes, daily_capacity)
  values
    (v_crewusr, 'zz-walk crew', 'active', 'x/coi.pdf', current_date + 200,
     'zz-walk crew', 'x/w9.pdf',
     array['Park grounds mowing & trim'], array[v_lake], 2)
  returning id into v_vendor;

  -- The job the park books: its own grounds, priced at what the park pays.
  insert into public.jobs
    (property_id, service_id, status, date, slot, customer_price, vendor_id, vendor_cost, margin)
  values
    (v_prop, v_mow, 'scheduled', current_date, '8a', 100, v_vendor, 80, 20)
  returning id into v_job;
  t := t || E'\n  job created      : yes, $100 price / $80 cost';

  -- ---- RULE 2, the one everything rests on -------------------------------
  -- Nothing uploaded yet.
  begin
    update public.jobs set status = 'complete', completed_at = now() where id = v_job;
    t := t || E'\n  mow, 0 of ' || v_mow_min || ' photos -> ALLOWED  <-- HOLE';
  exception when others then
    t := t || E'\n  mow, 0 of ' || v_mow_min || ' photos -> REFUSED: ' || left(sqlerrm, 60);
  end;

  -- One short.
  insert into public.job_photos (job_id, url) values (v_job, 'x/1.jpg');
  begin
    update public.jobs set status = 'complete', completed_at = now() where id = v_job;
    t := t || E'\n  mow, 1 of ' || v_mow_min || ' photos -> ALLOWED  <-- HOLE';
  exception when others then
    t := t || E'\n  mow, 1 of ' || v_mow_min || ' photos -> REFUSED: ' || left(sqlerrm, 60);
  end;

  -- Enough.
  insert into public.job_photos (job_id, url) values (v_job, 'x/2.jpg');
  begin
    update public.jobs set status = 'complete', completed_at = now() where id = v_job;
    t := t || E'\n  mow, ' || v_mow_min || ' of ' || v_mow_min || ' photos -> complete';
  exception when others then
    t := t || E'\n  mow, ' || v_mow_min || ' of ' || v_mow_min || ' photos -> REFUSED: ' || left(sqlerrm, 60)
           || '  <-- the gate is too tight';
  end;

  -- ---- THE MONEY SHAPE ---------------------------------------------------
  -- A crew cannot be paid more than the park is charged.
  begin
    insert into public.jobs
      (property_id, service_id, status, date, slot, customer_price, vendor_id, vendor_cost, margin)
    values (v_prop, v_mow, 'scheduled', current_date, '10a', 100, v_vendor, 150, -50);
    t := t || E'\n  cost above price -> ALLOWED  <-- HOLE';
  exception when others then
    t := t || E'\n  cost above price -> REFUSED: ' || left(sqlerrm, 60);
  end;

  -- ---- THE LOT GUARD -----------------------------------------------------
  -- A job may name the lot it is at. It must be a lot of THIS park.
  select id into v_lot from public.park_lots where park_id = v_park limit 1;
  select id into v_other from public.park_lots where park_id <> v_park limit 1;
  if v_lot is not null then
    begin
      update public.jobs set park_lot_id = v_lot where id = v_job;
      t := t || E'\n  lot at this park -> allowed (correct)';
    exception when others then
      t := t || E'\n  lot at this park -> REFUSED: ' || left(sqlerrm, 60) || '  <-- too tight';
    end;
  end if;
  if v_other is not null then
    begin
      update public.jobs set park_lot_id = v_other where id = v_job;
      t := t || E'\n  lot, OTHER park  -> ALLOWED  <-- HOLE';
    exception when others then
      t := t || E'\n  lot, OTHER park  -> REFUSED: ' || left(sqlerrm, 60);
    end;
  else
    t := t || E'\n  lot, OTHER park  -> not testable, only one park exists';
  end if;

  -- ---- WHAT THE OWNER ENDS UP ABLE TO SEE --------------------------------
  -- park_site_visits is a VIEW, derived from the job — it has no id and no
  -- job_id, which is the design: the owner is shown a visit, never a record he
  -- could join back to a household.
  t := t || E'\n  owner sees visits today: '
         || (select count(*) from public.park_site_visits
              where park_id = v_park and visit_date = current_date);
  t := t || E'\n  and its columns are   : '
         || (select coalesce(string_agg(column_name, ', ' order by ordinal_position), 'none')
               from information_schema.columns where table_name='park_site_visits');

  raise exception E'PARK JOB WALK%', t;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART TWO — RULE 1, AT THE DATABASE RATHER THAN IN THE TYPES.
--
-- CLAUDE.md rule 1: "Vendors NEVER see customer prices or margin. Enforce at
-- the API/RLS level, not just the UI."
--
-- The TypeScript half is genuinely good — `OpenJob` has no customer_price and
-- no margin field at all, so the claim board cannot leak one by accident, and
-- open-data.ts marks the price "server-side only — never returned". But a type
-- is not RLS, and rule 1 names RLS specifically.
--
-- RUN AGAINST PRODUCTION 5 Sep 2026:
--
--   the crew holding the job can read the job row : 0
--   ... and can read its customer_price           : 0
--   a DIFFERENT signed-in user can read that job  : 0
--   jobs column grants for authenticated          : SELECT
--
-- Zero for the crew who HOLDS the job. The reason is stronger than hiding a
-- column: `jobs` carries exactly ONE policy —
--
--   jobs_ops : ll_is_ops()
--
-- — so the table is shut to every client that is not ops. A crew's screens are
-- server-rendered through the service role, which selects only safe columns
-- (vendor/data.ts even notes that job_items carries customer_price/vendor_cost
-- "which we never select"). There is no API path by which a price reaches a
-- crew's browser, because there is no API path to the table.
--
-- Worth re-running if a policy is ever ADDED to jobs. A well-meaning
-- "vendors can see their own jobs" policy would open the row — and with it
-- every column on it, since Postgres RLS is row-level and the column grant
-- above is a blanket SELECT.

do $$
declare
  v_park uuid := 'facade00-0000-4000-8000-000000000001';
  v_prop uuid; v_lake uuid; v_mow uuid;
  v_crewusr uuid := gen_random_uuid();
  v_other   uuid := gen_random_uuid();
  v_vendor uuid; v_job uuid;
  n_price int; n_rows int; n_other int;
  t text := '';
begin
  select service_property_id, lake_id into v_prop, v_lake from public.parks where id = v_park;
  select id into v_mow from public.services where name = 'Park grounds mowing & trim';

  insert into auth.users (id) values (v_crewusr), (v_other);
  insert into public.vendors
    (user_id, company, status, coi_url, coi_expiry, coi_named_insured, w9_url,
     service_types, service_lakes, daily_capacity)
  values (v_crewusr, 'zz-rls crew', 'active', 'x/coi.pdf', current_date + 200,
     'zz-rls crew', 'x/w9.pdf', array['Park grounds mowing & trim'], array[v_lake], 2)
  returning id into v_vendor;

  insert into public.jobs
    (property_id, service_id, status, date, slot, customer_price, vendor_id, vendor_cost, margin)
  values (v_prop, v_mow, 'scheduled', current_date, '8a', 100, v_vendor, 80, 20)
  returning id into v_job;

  -- Sign in as the crew who HOLDS the job, as the client role. Not the service
  -- role — that is the whole point; the service role is meant to see this.
  perform set_config('request.jwt.claims', json_build_object('sub', v_crewusr::text, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n_rows from public.jobs where id = v_job;
  begin
    select count(*) into n_price from public.jobs where id = v_job and customer_price is not null;
  exception when others then n_price := -1; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other::text, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n_other from public.jobs where id = v_job;
  reset role;

  t := t || E'\n  the crew holding it can read the job row      : ' || n_rows
         || E'\n  ... and can read its customer_price           : ' || n_price
         || E'\n  a DIFFERENT signed-in user can read that job  : ' || n_other
         || E'\n  jobs column grants for authenticated          : '
         || (select coalesce(string_agg(distinct privilege_type, ', '), 'none')
               from information_schema.role_table_grants
              where table_schema='public' and table_name='jobs' and grantee='authenticated')
         || E'\n  policies on jobs                             : '
         || (select coalesce(string_agg(polname, ', '), 'NONE')
               from pg_policy where polrelid = 'public.jobs'::regclass);

  raise exception E'RULE 1 RLS WALK%', t;
end $$;
