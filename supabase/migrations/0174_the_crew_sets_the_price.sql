-- ============================================================================
-- 0174 — THE CREW SETS THE PRICE.
--
-- Brendon, 23 September 2026, in his own words:
--
--   "Lake life doesnt set the pricing, crew does still... crew prices 2 acre
--    yard at $50, we add on 12% to the home owner and take 12% from the
--    Crew... I do not want lakelife setting the pricing for crews, that doesnt
--    make us 3rd part enough. we do not have a menu price, the crews and our
--    machine dictate that in their onboarding... now if there is more than one
--    crew that has been onboarded at a lower rate the homeowner should be given
--    the options available, and what days and the crew rating....then they make
--    the decision."
--
-- HE IS BUYING A POSTURE, NOT MARGIN. The counsel draft's independent-
-- contractor paragraph opens "Crews independently set rate cards"
-- (docs/user-agreement-counsel-draft-v2.txt). Who sets the price is one of the
-- facts a worker-classification test weighs hardest, and a LakeLife menu price
-- falsifies that sentence on the page. A published percentage on top of a
-- number the crew chose does not. That is the WHY behind every line below.
--
-- ============================== THE ARITHMETIC ==============================
--
--   q             the crew's own quote, priced off the crew's own card
--   customerPrice round2(q × (1 + fee_customer_pct))   what the customer is billed
--   crewPayout    round2(q × (1 − fee_crew_pct))       what we actually pay them
--   LakeLife      customerPrice − crewPayout           never rounded separately
--
-- At 12/12 on a $50 yard: the customer pays $56.00, the crew is paid $44.00,
-- LakeLife keeps $12.00. Our share of the bill is the CONSTANT (c + k)/(1 + c)
-- — 21.43% at 12/12 — on every job, forever, whatever the crew charges. Cents
-- are carried: $416 at 12/12 is $465.92, and rounding to dollars would make the
-- stated 12% visibly wrong to anyone with a calculator, which is now BOTH sides
-- of the transaction.
--
-- =================== THE COLUMNS KEEP THEIR EXISTING MEANING =================
--
-- This is the whole trick, and it is why this migration adds exactly ONE new
-- money column instead of restructuring the ledger:
--
--   jobs.customer_price = customerPrice   what the customer is billed   UNCHANGED
--   jobs.vendor_cost    = crewPayout      what we PAY the crew          UNCHANGED
--                                         (so payouts.amount = vendor_cost still ties)
--   jobs.margin         = customer_price − vendor_cost                  UNCHANGED
--   jobs.crew_quote     = q               NEW: what the crew typed, before either fee
--
-- Every existing invoice, payout, ledger and report reader stays correct
-- without being touched, and `guard_job_money_shape` (0050) keeps reconciling
-- margin against the other two exactly as it does today.
--
-- WHAT DOES FLIP IS THE MEANING OF A CREW'S RATE CARD, and that is the one
-- thing here that can quietly cheat a real person. Today a crew types $100 and
-- is paid $100. On a crew-priced service they type $100 and are paid $88 —
-- same column, same screen, opposite meaning. Every crew-facing surface that
-- shows a rate has to say both numbers in plain words ("You quote $50. You are
-- paid $44 after the 12% platform fee."). A silent 12% deduction on a
-- contractor's invoice is the worst outcome available from this change, and no
-- database constraint can prevent it — it is a copy obligation, recorded here
-- because this is the file that creates the possibility.
--
-- ============================ THE SWITCH IS PER SERVICE =====================
--
-- `services.crew_priced` defaults FALSE, and this migration switches NOTHING
-- on. False is today's behaviour byte for byte: the menu price, the margin
-- floor, the ranker's margin key, the gap offers, all exactly as they are. The
-- post-conditions below prove no existing service changed, because flipping one
-- is a pricing decision and pricing decisions are his.
--
-- Per service because only 11 of the 13 live services can do this arithmetic
-- today. LAWN is a BAND (small/medium/large) with no acreage anywhere in the
-- product, so his own "$25/acre" example cannot yet be expressed; WATER TOYS
-- drops its add-on terms in the flat branch of the rate-card builder. Those two
-- stay false until their own build lands.
--
-- PARK WORK IS NEVER CREW-PRICED, and the CHECK below makes that structural
-- rather than a habit. A park's rate is a number its owner negotiated — The
-- Haven's mow is the $125 Mike agreed — and 21 households sign leases against
-- $400 + $142.53 on 1 January. Crew pricing is for the lakes, not the park,
-- until the park has had its own season.
--
-- ================================ THE DIALS =================================
--
-- Two of them, not one. He said 12 each way and "whatever we want to call it",
-- which means they may diverge; two columns now save a migration later. They
-- are FROZEN onto each job at booking (jobs.fee_customer_pct, fee_crew_pct,
-- crew_quote) so that tuning a dial can never reprice work already sold. A job
-- always recomputes from its OWN frozen three, never from the live dial — and
-- the all-or-nothing CHECK below is what makes "its own three" a thing that
-- either exists or does not, never half of it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: it does not retire the margin
-- floor. `platform_settings.margin_floor` still rules every menu-priced job,
-- which is all of them. The floor is skipped in code on the crew-priced path
-- only (src/lib/dispatch.ts), because there LakeLife's share is a constant and
-- the comparison stops being a per-crew filter: at 11%/11% it computes 19.82%,
-- falls under the live 0.20 dial, and would refuse EVERY job on the platform
-- with `below_floor`, a reason no screen prints.
-- ============================================================================


-- ------------------------------------------------- 1. the per-service switch --

alter table public.services
  add column if not exists crew_priced boolean not null default false;

comment on column public.services.crew_priced is
  'FALSE (the default, and every service today) = the menu price and the '
  'margin floor, unchanged. TRUE = the crew''s own rate card IS the price: '
  'the customer is billed quote x (1 + platform_fee_customer_pct) and the crew '
  'is paid quote x (1 - platform_fee_crew_pct), and there is no menu price for '
  'this service at all. Added 0174. Never true for a park_only service — the '
  'park''s own negotiated rate wins there, and a CHECK enforces it.';

-- A PARK'S RATE IS NOT A CREW'S RATE. 0115 gave every park its own table
-- because The Haven pays $125 for a mow on the strength of a contract signed in
-- LaGrange County, and a park inheriting a lake crew's card silently is worse
-- than showing no number at all. Without this the two models could be true of
-- the same row and the answer would depend on which pricing doorway you came
-- through — the exact shape of bug 0115's overlay caused when it was not
-- everywhere.
alter table public.services drop constraint if exists services_park_is_never_crew_priced;
alter table public.services add constraint services_park_is_never_crew_priced
  check (not (park_only and crew_priced));


-- ------------------------------------------- 2. the three frozen job columns --

alter table public.jobs
  add column if not exists crew_quote       numeric,
  add column if not exists fee_customer_pct numeric,
  add column if not exists fee_crew_pct     numeric;

comment on column public.jobs.crew_quote is
  'What the crew TYPED, before either fee — their own card priced against this '
  'property. NOT what they are paid: that is vendor_cost, which is this number '
  'less fee_crew_pct. NULL on every menu-priced job, which is all of them '
  'today. Added 0174.';
comment on column public.jobs.fee_customer_pct is
  'The customer-side platform fee FROZEN onto this job at booking, so tuning '
  'the live dial can never reprice work already sold. customer_price = '
  'crew_quote x (1 + this). Added 0174.';
comment on column public.jobs.fee_crew_pct is
  'The crew-side platform fee FROZEN onto this job at booking. vendor_cost = '
  'crew_quote x (1 - this) — the crew is paid LESS than the number they typed, '
  'and every crew-facing screen must say so in words. Added 0174.';

-- ALL THREE OR NONE. A half-frozen quote is a price nobody can reproduce: with
-- a quote and no percentages there is no way to re-derive what the customer was
-- billed or what the crew was paid, and with percentages and no quote there is
-- nothing to apply them to. Either this job was sold under the crew-priced
-- model and carries the whole recipe, or it was not and carries none of it.
alter table public.jobs drop constraint if exists jobs_crew_price_all_or_nothing;
alter table public.jobs add constraint jobs_crew_price_all_or_nothing check (
  (crew_quote is null and fee_customer_pct is null and fee_crew_pct is null)
  or
  (crew_quote is not null and fee_customer_pct is not null and fee_crew_pct is not null)
);

-- THE LAST DOORWAY BEFORE A CONTRACTOR IS PAID NOTHING. `getPlatformSettings`
-- clamps both dials to [0, 0.5] and `platform-fee.ts` refuses anything outside
-- [0, 1) again, so nothing legitimate can land here. The value of saying it a
-- third time, in the database, is that a fee_crew_pct of 1.0 pays a real person
-- $0 for a day's work through a row that looks entirely deliberate, and the
-- payout would tie perfectly against it.
alter table public.jobs drop constraint if exists jobs_frozen_fees_are_fractions;
alter table public.jobs add constraint jobs_frozen_fees_are_fractions check (
  (fee_customer_pct is null or (fee_customer_pct >= 0 and fee_customer_pct < 1))
  and
  (fee_crew_pct is null or (fee_crew_pct >= 0 and fee_crew_pct < 1))
  and
  (crew_quote is null or crew_quote >= 0)
);


-- --------------------------------------------------------------- 3. the dials --
--
-- Written the way 0018 and 0090 write a dial: `platform_settings` is (key,
-- value jsonb, updated_at) with no label or description column, and the insert
-- is ON CONFLICT DO NOTHING so re-running this file can never stamp over a
-- number he has since tuned.
insert into public.platform_settings (key, value) values
  ('platform_fee_customer_pct', '0.12'::jsonb),
  ('platform_fee_crew_pct',     '0.12'::jsonb)
on conflict (key) do nothing;


-- -------------------------------------------------------------- 4. the grants --
--
-- Restated rather than assumed, per the house rule: RLS is the first lock and a
-- REVOKE is the second, and the second has to be said per table rather than
-- left to a default. 0100 already revoked client writes on `jobs`, `services`
-- and `platform_settings`, and the grants are table-wide, so the four new
-- columns are covered the moment they exist — but a migration that adds money
-- columns and says nothing about who may write them is how the gap reopens.
-- Nothing below widens anything; the post-conditions prove it.
revoke insert, update, delete, truncate, references, trigger
  on public.jobs, public.services, public.platform_settings from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.jobs, public.services, public.platform_settings from authenticated;
grant select on public.services to authenticated;


-- ------------------------------------------------------- 5. post-conditions --
--
-- SHIP-TIME ASSERTIONS. Everything that writes a row does it inside a block
-- that raises on the way out, so the probes roll back and leave nothing behind.
do $$
declare
  n          integer;
  switched   integer;
  d_customer numeric;
  d_crew     numeric;
  jid        uuid;
  sid        uuid;
  ok         boolean;
  leaked     text;
begin
  -- (a) THE FOUR NEW COLUMNS EXIST, WITH THE STATED TYPES AND DEFAULTS. -----
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'jobs'
     and column_name in ('crew_quote', 'fee_customer_pct', 'fee_crew_pct')
     and data_type = 'numeric';
  if n <> 3 then
    raise exception '0174: % of the 3 frozen job columns exist as numeric', n;
  end if;

  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'services'
     and column_name = 'crew_priced'
     and data_type = 'boolean'
     and is_nullable = 'NO'
     and column_default = 'false';
  if n <> 1 then
    raise exception
      '0174: services.crew_priced is not a NOT NULL boolean defaulting to false — a service with no answer to "who sets the price" is unpriceable';
  end if;

  -- (b) BOTH DIALS READ BACK AS 0.12. A dial the code reads and the table does
  --     not hold is this codebase's oldest bug wearing a hat: parseSetting
  --     hands back the code default and the row is decorative.
  select (value #>> '{}')::numeric into d_customer
    from public.platform_settings where key = 'platform_fee_customer_pct';
  select (value #>> '{}')::numeric into d_crew
    from public.platform_settings where key = 'platform_fee_crew_pct';
  if d_customer is null or d_crew is null then
    raise exception '0174: a platform fee dial is missing (customer %, crew %)', d_customer, d_crew;
  end if;
  if d_customer <> 0.12 or d_crew <> 0.12 then
    -- Not an error if HE tuned them — but this file only ever runs on a fresh
    -- apply, and the insert above is ON CONFLICT DO NOTHING, so a value other
    -- than 0.12 here means somebody hand-edited the seed. Say so loudly rather
    -- than shipping a number nobody chose.
    raise exception '0174: the dials read % / %, expected 0.12 / 0.12', d_customer, d_crew;
  end if;

  -- (c) NOTHING WAS SWITCHED ON. Production behaviour is byte-for-byte
  --     unchanged by this migration: crew_priced is a door, not a decision, and
  --     which services walk through it is his call on his own screen. A
  --     migration that quietly flipped one would change what a customer is
  --     billed for the next booking of it.
  select count(*) into switched from public.services where crew_priced;
  if switched <> 0 then
    raise exception '0174: % service(s) are already crew_priced — this migration switches nothing on', switched;
  end if;

  -- (d) THE ALL-OR-NOTHING CHECK ACTUALLY REFUSES A HALF-FROZEN ROW.
  --     Asserting the constraint EXISTS is not the same as asserting it BITES,
  --     and a constraint that exists and permits the thing it names is worse
  --     than none: everything downstream would be written against a guarantee
  --     that is not there.
  if not exists (select 1 from pg_constraint where conname = 'jobs_crew_price_all_or_nothing') then
    raise exception '0174: the all-or-nothing constraint is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jobs_frozen_fees_are_fractions') then
    raise exception '0174: nothing stops a frozen crew fee of 1.0 — a contractor paid $0';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'services_park_is_never_crew_priced') then
    raise exception '0174: a park_only service could be crew_priced';
  end if;

  -- A job that will not set off the OTHER before-update triggers on this table
  -- (the photo gate, the water-season window, the no-show and tip guards): not
  -- water work, and not finished.
  select j.id into jid
    from public.jobs j
    left join public.services s on s.id = j.service_id
   where coalesce(s.is_water_work, false) = false
     and j.status::text in ('requested', 'scheduled')
   limit 1;

  begin
    if jid is null then
      raise notice '0174: NO PROBE RAN for the frozen-quote rules — this database holds no unfinished non-water job to attempt one against. The constraints exist (asserted above); that they BITE is unverified here.';
    else
      -- A quote with no percentages: unreproducible, and refused.
      ok := false;
      begin
        update public.jobs set crew_quote = 50 where id = jid;
      exception when check_violation then ok := true;
      end;
      if not ok then
        raise exception '0174: a job took a crew_quote with no frozen fees — that price can never be re-derived';
      end if;

      -- Percentages with nothing to apply them to: refused from the other side.
      ok := false;
      begin
        update public.jobs set fee_customer_pct = 0.12, fee_crew_pct = 0.12 where id = jid;
      exception when check_violation then ok := true;
      end;
      if not ok then
        raise exception '0174: a job took frozen fees with no crew quote';
      end if;

      -- A crew fee of 1.0 pays a real person nothing.
      ok := false;
      begin
        update public.jobs
           set crew_quote = 50, fee_customer_pct = 0.12, fee_crew_pct = 1
         where id = jid;
      exception when check_violation then ok := true;
      end;
      if not ok then
        raise exception '0174: a job accepted a 100%% crew fee — the crew would be paid $0';
      end if;

      -- AND THE OTHER HALF OF THE BRANCH: the complete recipe is ACCEPTED. A
      -- constraint that refuses everything would pass all three probes above
      -- and make crew pricing unbookable.
      update public.jobs
         set crew_quote = 50, fee_customer_pct = 0.12, fee_crew_pct = 0.12
       where id = jid;
      if not exists (
        select 1 from public.jobs
         where id = jid and crew_quote = 50 and fee_customer_pct = 0.12 and fee_crew_pct = 0.12
      ) then
        raise exception '0174: the three frozen columns could not be written together';
      end if;
    end if;

    -- (e) A PARK SERVICE CANNOT BE CREW-PRICED, proved the same way.
    select id into sid from public.services where park_only limit 1;
    if sid is null then
      raise notice '0174: no park_only service to probe — the CHECK exists (asserted above) but is unexercised here.';
    else
      ok := false;
      begin
        update public.services set crew_priced = true where id = sid;
      exception when check_violation then ok := true;
      end;
      if not ok then
        raise exception '0174: a park_only service was switched to crew pricing — the park''s negotiated rate is not a crew''s card';
      end if;
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  -- (f) RULE 1 SURVIVES WHERE IT STILL CAN. A published 12% makes "vendors
  --     never see customer prices or margin" unenforceable by arithmetic — a
  --     crew who knows their card is $50 knows the customer paid $56, and no
  --     grant stops division. What the database must still refuse is
  --     PROJECTING the money onto a crew-readable surface, and `vendor_jobs`
  --     is that surface. It holds no money column today; this keeps it that
  --     way, because the obvious next convenience is to add crew_quote to it.
  select string_agg(column_name, ', ') into leaked
    from information_schema.columns
   where table_schema = 'public' and table_name = 'vendor_jobs'
     and column_name in ('customer_price', 'margin', 'crew_quote', 'fee_customer_pct', 'fee_crew_pct');
  if leaked is not null then
    raise exception '0174: vendor_jobs projects % to crews', leaked;
  end if;

  -- (g) AND NEITHER `anon` NOR `authenticated` GAINED A WRITE. The columns are
  --     new; the grants are table-wide and were already revoked by 0100. This
  --     catches a future migration re-granting the table out from under them.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ') into leaked
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and table_name in ('jobs', 'services', 'platform_settings')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if leaked is not null then
    raise exception '0174: a client can write the pricing tables — %', leaked;
  end if;

  raise notice '0174: the crew sets the price. Nothing is switched on, both dials read 0.12, a half-frozen quote is refused, and a park keeps its own rate.';
end $$;
