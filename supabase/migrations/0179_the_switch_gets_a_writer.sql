-- ============================================================================
-- 0179 — THE SWITCH GETS A WRITER.
--
-- 0174 added `services.crew_priced`, default false, and five migrations and
-- six commits were built on top of it. Nothing in the product could write it.
-- A column read everywhere and written by nothing is this codebase's oldest
-- and most expensive bug class, and here it was sitting under the whole
-- crew-priced marketplace: the only way to move a service onto the model he
-- chose was to hand-edit the database.
--
-- The writer is `setServiceCrewPriced` (src/app/ops/crew-priced-actions.ts) —
-- ops-gated, service-role, ONE SERVICE AT A TIME, never a bulk "turn
-- everything on". This file gives that writer the two things it needs and the
-- product did not have:
--
--   1. A PLACE TO RECORD THE CHANGE. There is no audit trail in this database
--      for a SERVICE-level pricing change. This was looked for rather than
--      assumed: `vendor_rate_history` (0041) keeps a CREW's old rate card,
--      captured by a trigger on `vendor_rates`; `lot_rent_changes` keeps a
--      park LOT's rent; `services` carries `last_auto_priced_at`, which is a
--      30-day cooldown stamp and not a record of what changed or who changed
--      it. None of them can hold "the crews now price the pier". So this adds
--      one table, shaped as closely on `vendor_rate_history` as the different
--      subject allows — ops-only at RLS, client writes revoked, the OLD value
--      kept beside the new — rather than inventing a second convention.
--
--   2. THE REFUSAL, IN THE DATABASE. The screen refuses a service whose shape
--      a crew's rate card cannot reproduce, and `setServiceCrewPriced` refuses
--      it again against the live row. A rule in one doorway of three is not a
--      rule, and the third doorway is `update services set crew_priced = true`
--      from anywhere at all — psql, a future migration, the SQL editor. The
--      CHECK below is that doorway, and it carries ALL THREE arms of
--      `crewCardCanPrice` (src/lib/crew-priced-eligibility.ts), including the
--      one that cannot fire yet. A CHECK with two of three arms, under a
--      comment claiming it mirrors the function, is code and comment agreeing
--      with each other and both wrong about what is enforced.
--
-- ======================== WHAT THE CHECK REFUSES, AND WHY ====================
--
-- A crew-priced job is priced by `priceService(rule, profile)` where `rule` is
-- built in `buildCandidates` out of the CREW's stored `vendor_rates` row, and
-- that row is whatever `computeRateRow` emitted. So the question is only ever
-- "can a crew's card carry every term this service's price is made of".
--
--   `pricing_model = 'band'`  — the price is chosen by a size WORD (small /
--     medium / large, read off `lawn_band` or `drive_band`) and nothing in the
--     product measures a yard: `CountableField` names sections, lifts, skis,
--     toys, beds, baths, panes and lots, and no area at all. A crew can only
--     fill in LakeLife's three buckets, so LakeLife would still be holding the
--     ladder — and "$25 an acre", his own example of a crew's rate, has no
--     acreage to multiply. Live row: `Lawn mowing & trim`. Waiting behind it,
--     inactive: `Snow removal — drive & walks`, which this refuses too without
--     anybody adding it to a list.
--
--   a non-empty `band_pricing->'add'` — `priceService` adds `rate x a counted
--     field` on top of the model price, and NO branch of `computeRateRow`
--     emits `add`. Live row: `Water toy prep & storage`, flat $120 with
--     {add:[{rate:60,field:toy_lifts},{rate:15,field:toys_count}]}. A
--     shoreline with two lifts and six toys costs $330 on the menu; a crew's
--     card would quote its flat number for that shoreline and for a bare one
--     alike. The term's RATE is irrelevant — a $0 term is a term somebody
--     edits next season and the card would still drop it.
--
--   a non-empty `band_pricing->'per_engine_hp_tiers'` — the same shape, the
--     same drop. No live service carries it today; it is refused anyway,
--     because the refusal is of the SHAPE and not of a list of names.
--
--   a `pricing_model` OUTSIDE the six `computeRateRow` has a branch for — the
--     crew rate-card builder would have no form to draw and a crew could not
--     type a number for it at all. The `pricing_model` enum holds exactly
--     those six today, so this arm refuses nothing that exists; it is here for
--     the seventh, which otherwise lands in a database that accepts it and a
--     TypeScript layer that does not.
--
-- DELIBERATELY NOT REFUSED, and this was checked rather than assumed: the
-- transport keys (`included_miles`, `per_mile_beyond`) are also absent from
-- every `computeRateRow` branch, but they are not LOST — `createBooking` adds
-- a tow only `if (!crewPriced && billsByDistance(priceRule))`, because on a
-- crew-priced service the crew is the one driving and the tow is inside their
-- own quote. A deliberate skip is not a dropped term, and refusing on it would
-- have blocked two services for a reason that is not true.
--
-- ============================ WHAT THIS DOES NOT DO =========================
--
-- IT SWITCHES NOTHING ON. Zero services are crew_priced before this file and
-- zero are after it; the post-conditions prove it. Which services move is a
-- pricing decision, and pricing decisions are his, made on his own screen with
-- the consequences printed above the button.
--
-- It does not touch `services_park_is_never_crew_priced` — 0176 dropped that
-- and was right to: a park is a customer like any other, and what protects The
-- Haven's mow is PRECEDENCE in `pricingPathFor`, which answers `park_rate`
-- before it ever looks at this flag. Re-adding a park fence here would undo
-- 0176 and break the one route by which a snow contractor's own card can ever
-- price the park's snow.
-- ============================================================================


-- ------------------------------------------------ 1. the pricing change log --

create table if not exists public.service_pricing_changes (
  id         uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  -- WHO. Nullable because a change applied by a migration or a nightly has no
  -- person behind it, and a fabricated user id is worse than an honest null.
  changed_by uuid references public.users(id) on delete set null,
  -- WHICH DIAL MOVED. Text rather than an enum so the next pricing column to
  -- get a writer lands here instead of growing a second table.
  field      text not null,
  old_value  jsonb not null,
  new_value  jsonb not null,
  note       text,
  changed_at timestamptz not null default now()
);

comment on table public.service_pricing_changes is
  'Every change to a SERVICE-level pricing decision, with the value it held '
  'before. Written by ops server actions (setServiceCrewPriced, 0179); never '
  'by a client — the grants below are the second lock behind RLS. Distinct '
  'from vendor_rate_history (0041), which keeps a CREW''s old rate card, and '
  'from lot_rent_changes, which keeps a park lot''s rent.';

-- A ROW THAT RECORDS NO CHANGE IS NOISE IN THE ONE PLACE THAT MUST BE READ.
-- It is also the shape a double-tap produces, and a log that says the pier
-- moved twice when it moved once is a log nobody can reconcile against the
-- flag's current value.
alter table public.service_pricing_changes
  drop constraint if exists service_pricing_changes_is_a_change;
alter table public.service_pricing_changes
  add constraint service_pricing_changes_is_a_change check (old_value is distinct from new_value);

alter table public.service_pricing_changes
  drop constraint if exists service_pricing_changes_names_a_field;
alter table public.service_pricing_changes
  add constraint service_pricing_changes_names_a_field check (length(btrim(field)) > 0);

create index if not exists service_pricing_changes_idx
  on public.service_pricing_changes (service_id, changed_at desc);

alter table public.service_pricing_changes enable row level security;
drop policy if exists service_pricing_changes_ops on public.service_pricing_changes;
create policy service_pricing_changes_ops on public.service_pricing_changes
  for select using (public.ll_is_ops());

-- RLS IS THE FIRST LOCK AND THE REVOKE IS THE SECOND, said per table rather
-- than left to a default (the house rule that cost real money before).
revoke insert, update, delete, truncate, references, trigger
  on public.service_pricing_changes from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.service_pricing_changes from authenticated;
grant select on public.service_pricing_changes to authenticated;


-- ------------------------------------ 2. the third doorway on the flag itself --

alter table public.services
  drop constraint if exists services_crew_priced_needs_a_card_that_can_price;
-- ALL THREE ARMS, IN THE ORDER `crewCardCanPrice` ASKS THEM.
--
--   1. `no_card_for_this_model` — the model must be one `computeRateRow` has
--      a branch for. This arm was MISSING from the first cut while the
--      comments above and the constraint comment below both claimed the CHECK
--      mirrored the function; code, comment and test all agreeing and all
--      wrong about what is enforced is this codebase's most expensive shape.
--      It cannot fire today — every value of `PricingModel` has a branch — and
--      that is exactly why it has to be written now: the arm exists FOR the
--      seventh model, and the day one lands the TypeScript would refuse it
--      while this doorway, the psql one, waved it through.
--
--   2. the size word, and 3. the terms a card drops.
--
-- `case when jsonb_typeof(...) = 'array'`, NOT `coalesce(jsonb_array_length
-- (...), 0)`, AND NOT A BARE `and`. Three separate traps, all of them live:
--
--   1. `jsonb_array_length` RAISES 22023 on a non-array rather than returning
--      null — verified against this database — so wrapping it in `coalesce`
--      does not make it total. A `band_pricing` whose `add` was ever written
--      as an OBJECT would make the whole row unupdatable: not just
--      `crew_priced = true`, but `crew_priced = false` and every unrelated
--      write, the auto-pricer's `last_auto_priced_at` stamp included. And it
--      would surface as a raw Postgres string, because the action's handler
--      re-runs the TypeScript check — total via `Array.isArray` — and is told
--      the row is fine.
--
--   2. POSTGRES DOES NOT PROMISE TO SHORT-CIRCUIT `and`. `jsonb_typeof(x) =
--      'array' and jsonb_array_length(x) > 0` may evaluate the right side
--      anyway, which is trap 1 with an extra step. `case` is the construct
--      that is guaranteed not to evaluate the branch it did not take.
--
--   3. AND THE PREDICATE HAS TO BE TWO-VALUED. `jsonb_typeof(null)` is null,
--      so `jsonb_typeof(band_pricing -> 'add') = 'array'` is NULL on every
--      row with no `add` key — which is 25 of the 28 services. A CHECK passes
--      on NULL, so the constraint would still have behaved; but the same
--      expression in the post-conditions' `where` matches NOTHING, and probe
--      (e) below would have failed to find a single flippable service and
--      aborted this migration with "the CHECK would refuse the entire menu".
--      `case` returns its `else` on a null `when`, so this form answers true
--      or false and never null. Post-condition (b2) pins exactly that.
alter table public.services
  add constraint services_crew_priced_needs_a_card_that_can_price check (
    not coalesce(crew_priced, false)
    or (
      pricing_model in ('flat', 'per_section', 'per_foot', 'seasonal_plus_perdiem', 'band', 'per_sqft_band')
      and pricing_model <> 'band'
      and case when jsonb_typeof(band_pricing -> 'add') = 'array'
               then jsonb_array_length(band_pricing -> 'add') = 0 else true end
      and case when jsonb_typeof(band_pricing -> 'per_engine_hp_tiers') = 'array'
               then jsonb_array_length(band_pricing -> 'per_engine_hp_tiers') = 0 else true end
    )
  );

comment on constraint services_crew_priced_needs_a_card_that_can_price on public.services is
  'A service may only be crew_priced if a crew''s rate card can reproduce its '
  'price. Mirrors all three arms of crewCardCanPrice '
  '(src/lib/crew-priced-eligibility.ts): the model must be one computeRateRow '
  'can build a card for, a band service is chosen by a size word with no '
  'measurement behind it, and add[] / per_engine_hp_tiers[] are terms '
  'computeRateRow emits on no branch. Added 0179.';


-- ------------------------------------------------------- 3. post-conditions --
--
-- SHIP-TIME ASSERTIONS. Everything that writes a row does it inside a block
-- that raises on the way out, so the probes roll back and leave nothing
-- behind. A migration without the half that proves a VALID write is ACCEPTED
-- is a draft: a constraint that refuses everything passes every refusal probe
-- and makes the feature unusable.
do $$
declare
  n        integer;
  switched integer;
  sid      uuid;
  band_sid uuid;
  add_sid  uuid;
  bad_sid  uuid;
  ok       boolean;
  leaked   text;
  rid      uuid;
  logs_before integer;
begin
  -- (a) THE LOG EXISTS, WITH THE COLUMNS THE WRITER INSERTS. ----------------
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'service_pricing_changes'
     and column_name in ('service_id', 'changed_by', 'field', 'old_value', 'new_value', 'note', 'changed_at');
  if n <> 7 then
    raise exception '0179: % of the 7 change-log columns exist — setServiceCrewPriced inserts all of them', n;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'services_crew_priced_needs_a_card_that_can_price') then
    raise exception '0179: the shape CHECK is missing — a band service could be flipped crew_priced from psql';
  end if;

  -- (b) NOTHING WAS SWITCHED ON. Same assertion 0174 and 0176 make, for the
  --     same reason: this file opens a door, it does not walk through it.
  select count(*) into switched from public.services where crew_priced;
  if switched <> 0 then
    raise exception '0179: % service(s) are already crew_priced — this migration switches nothing on', switched;
  end if;

  -- (b2) THE SHAPE PREDICATE ANSWERS TRUE OR FALSE ON EVERY ROW, NEVER NULL.
  --
  --      The first cut of this CHECK read `jsonb_typeof(band_pricing ->
  --      'add') = 'array' and ...`, which is NULL on every service with no
  --      `add` key — 25 of the 28. A CHECK passes on NULL, so the constraint
  --      LOOKED right; the same expression in probe (e)'s `where` matched no
  --      rows at all and would have aborted this migration claiming the CHECK
  --      refused the entire menu. A predicate that is only correct because
  --      three-valued logic lets it through is a predicate nobody can reuse.
  select count(*) into n
    from public.services
   where (
     pricing_model in ('flat', 'per_section', 'per_foot', 'seasonal_plus_perdiem', 'band', 'per_sqft_band')
     and pricing_model <> 'band'
     and case when jsonb_typeof(band_pricing -> 'add') = 'array'
              then jsonb_array_length(band_pricing -> 'add') = 0 else true end
     and case when jsonb_typeof(band_pricing -> 'per_engine_hp_tiers') = 'array'
              then jsonb_array_length(band_pricing -> 'per_engine_hp_tiers') = 0 else true end
   ) is null;
  if n <> 0 then
    raise exception '0179: the shape predicate answers NULL on % service(s) — it passes as a CHECK by accident and matches nothing as a filter', n;
  end if;

  select count(*) into logs_before from public.service_pricing_changes;

  begin
    -- (c) THE SHAPE CHECK BITES ON A BAND SERVICE. Asserting a constraint
    --     EXISTS is not asserting it REFUSES, and a constraint that permits
    --     the thing it names is worse than none — every screen downstream
    --     would be written against a guarantee that is not there.
    select id into band_sid from public.services where pricing_model = 'band' limit 1;
    if band_sid is null then
      raise notice '0179: NO PROBE RAN for the band refusal — this database holds no band service to attempt one against.';
    else
      ok := false;
      begin
        update public.services set crew_priced = true where id = band_sid;
      exception when check_violation then ok := true;
      end;
      if not ok then
        raise exception '0179: a band service was flipped crew_priced — a crew can only fill in our three size buckets, and nothing measures the yard';
      end if;
    end if;

    -- (d) AND ON A SERVICE WHOSE add[] TERMS THE CARD WOULD DROP.
    --
    --     `jsonb_typeof` FIRST here too, for the same reason as the CHECK: a
    --     bare `jsonb_array_length` over the whole table raises 22023 the
    --     moment one row's `add` is not an array, and this probe would abort
    --     the migration with a Postgres string instead of testing anything.
    select id into add_sid
      from public.services
     where case when jsonb_typeof(band_pricing -> 'add') = 'array'
                then jsonb_array_length(band_pricing -> 'add') > 0 else false end
     limit 1;
    if add_sid is null then
      raise notice '0179: NO PROBE RAN for the dropped-terms refusal — no service declares add[] terms.';
    else
      ok := false;
      begin
        update public.services set crew_priced = true where id = add_sid;
      exception when check_violation then ok := true;
      end;
      if not ok then
        raise exception '0179: a service with add[] terms was flipped crew_priced — every crew would quote one flat number whatever is on the property';
      end if;
    end if;

    -- (e) THE OTHER HALF OF THE BRANCH: A SERVICE THAT CAN DO THIS IS
    --     ACCEPTED. Without this, a CHECK of `false` would pass (c) and (d)
    --     and make crew pricing impossible on every service on the menu.
    select id into sid
      from public.services
     where active
       and pricing_model in ('flat', 'per_section', 'per_foot', 'seasonal_plus_perdiem', 'band', 'per_sqft_band')
       and pricing_model <> 'band'
       and case when jsonb_typeof(band_pricing -> 'add') = 'array'
                then jsonb_array_length(band_pricing -> 'add') = 0 else true end
       and case when jsonb_typeof(band_pricing -> 'per_engine_hp_tiers') = 'array'
                then jsonb_array_length(band_pricing -> 'per_engine_hp_tiers') = 0 else true end
     limit 1;
    if sid is null then
      raise exception '0179: no active service has a shape a crew card can price — the CHECK would refuse the entire menu';
    end if;
    update public.services set crew_priced = true where id = sid;
    if not exists (select 1 from public.services where id = sid and crew_priced) then
      raise exception '0179: a service a crew card CAN price was still refused';
    end if;

    -- (e2) THE per_engine_hp_tiers ARM BITES, with no live row carrying it.
    --      An arm nothing on the menu can exercise is an arm nobody has ever
    --      seen refuse anything; the term is written onto the service that
    --      just went crew-priced and the CHECK has to take it back.
    ok := false;
    begin
      update public.services
         set band_pricing = coalesce(band_pricing, '{}'::jsonb)
                            || '{"per_engine_hp_tiers":[{"max":null,"price":40}]}'::jsonb
       where id = sid;
    exception when check_violation then ok := true;
    end;
    if not ok then
      raise exception '0179: a crew_priced service accepted per_engine_hp_tiers — no computeRateRow branch emits it, so every crew would quote the same number for a 300hp boat and a rowboat';
    end if;

    -- (e3) A MALFORMED TERM IS A DECISION, NOT A WALL.
    --
    --      `jsonb_array_length` RAISES on a non-array (22023, verified), so
    --      the first cut of this CHECK — `coalesce(jsonb_array_length(...),
    --      0)` — made a row whose `add` was written as an OBJECT completely
    --      unupdatable: not just `crew_priced = true`, but `crew_priced =
    --      false` and every unrelated write, the auto-pricer's
    --      `last_auto_priced_at` included. Both statements below would have
    --      aborted this migration with a raw Postgres string.
    --
    --      And the verdict has to MATCH THE TYPESCRIPT, which is total via
    --      `Array.isArray`: a non-array `add` declares no term, `priceService`
    --      skips it for the same reason, so the flip is ALLOWED. Two doorways
    --      that disagree about one row are worse than either answer.
    select id into bad_sid from public.services where id <> sid and not crew_priced limit 1;
    if bad_sid is null then
      raise exception '0179: no second service to probe the malformed-term path against';
    end if;
    update public.services
       set band_pricing = coalesce(band_pricing, '{}'::jsonb) || '{"add":{"rate":60,"field":"toy_lifts"}}'::jsonb
     where id = bad_sid;
    update public.services set crew_priced = true where id = bad_sid;
    if not exists (select 1 from public.services where id = bad_sid and crew_priced) then
      raise exception '0179: a malformed add term refused a flip the TypeScript allows — the two doorways disagree';
    end if;
    update public.services set crew_priced = false where id = bad_sid;

    -- (f) A CHANGE-LOG ROW FOR A REAL CHANGE IS ACCEPTED...
    insert into public.service_pricing_changes (service_id, field, old_value, new_value, note)
    values (sid, 'crew_priced', 'false'::jsonb, 'true'::jsonb, '0179 post-condition probe')
    returning id into rid;
    if rid is null then
      raise exception '0179: the change log refused a well-formed row';
    end if;

    -- ...AND ONE THAT RECORDS NO CHANGE IS NOT.
    ok := false;
    begin
      insert into public.service_pricing_changes (service_id, field, old_value, new_value)
      values (sid, 'crew_priced', 'true'::jsonb, 'true'::jsonb);
    exception when check_violation then ok := true;
    end;
    if not ok then
      raise exception '0179: the change log accepted a row where nothing changed';
    end if;

    -- ...and neither is one that names no field.
    ok := false;
    begin
      insert into public.service_pricing_changes (service_id, field, old_value, new_value)
      values (sid, '   ', 'false'::jsonb, 'true'::jsonb);
    exception when check_violation then ok := true;
    end;
    if not ok then
      raise exception '0179: the change log accepted a row naming no field';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  -- (g) EVERY PROBE ABOVE ROLLED BACK. Said out loud because (e) deliberately
  --     flips a live service on, and a probe that leaked would change what a
  --     customer is billed for the next booking of it.
  select count(*) into switched from public.services where crew_priced;
  if switched <> 0 then
    raise exception '0179: % service(s) are crew_priced AFTER the probes — a post-condition leaked a pricing change into production', switched;
  end if;
  -- Compared against the count taken BEFORE the probes, not against zero: the
  -- log is append-only and legitimately fills up once he starts moving
  -- services, so "must be empty" would turn a re-apply into an abort for a
  -- reason that is not a fault.
  select count(*) into n from public.service_pricing_changes;
  if n <> logs_before then
    raise exception '0179: % probe row(s) survived in the change log', n - logs_before;
  end if;

  -- (h) NO CLIENT MAY WRITE THE LOG OR THE FLAG. The log is new; `services`
  --     was revoked by 0100 and restated by 0174, and this catches a future
  --     migration re-granting either out from under them.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ') into leaked
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and table_name in ('services', 'service_pricing_changes')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if leaked is not null then
    raise exception '0179: a client can write a pricing table — %', leaked;
  end if;

  -- (i) AND THE LOG IS OPS-ONLY TO READ. It names which services LakeLife is
  --     moving off its own menu, which is not a crew's business and not a
  --     customer's.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'service_pricing_changes'
       and policyname = 'service_pricing_changes_ops'
  ) then
    raise exception '0179: the change log has no ops-only read policy';
  end if;

  raise notice '0179: the switch has a writer. Nothing is switched on, a band service and an add[] service are both refused, a service a card can price is accepted, and the change log refuses a row that records no change.';
end $$;
