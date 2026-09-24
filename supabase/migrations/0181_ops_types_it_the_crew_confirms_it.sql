-- 0181 — OPS TYPES IT FROM THE CALL. THE CREW IS STILL THE ONE WHO SAYS YES.
--
-- Brendon, 24 September 2026:
--
--   "me add them directly and answer most of the questions in some ops portal,
--    then they get sent a confirmation email or text where all they have to do
--    is upload or input a few small items"
--
-- He is right about the workflow. He is going to be ON THE PHONE with Josh and
-- with the landscaper. Him typing what they tell him beats a contractor filling
-- a six-card wizard on a phone at a job site, and it is more accurate: a wrong
-- lake tick silently drops a crew from every job on that water, and he knows
-- which lakes they work because he just asked.
--
-- ============ BUT A PRE-FILLED VALUE IS A PROPOSAL, NOT A FACT ============
--
-- This is the whole reason the proposal gets its own table instead of being
-- typed straight into `vendors` and `vendor_rates`.
--
-- He abolished LakeLife-set pricing this week — "I do not want lakelife setting
-- the pricing for crews, that doesnt make us 3rd part enough" — and a rate ops
-- typed that goes LIVE without the crew confirming it is LakeLife setting a
-- crew's price with extra steps. The same trap has already cost this product a
-- real bug: a seeded `daily_capacity` of 1 satisfied `activationGaps`, rendered
-- the wizard's capacity step ticked with a "Saved" pill for a number nobody
-- chose, and then capped that crew at one job a day forever.
--
-- So nothing ops types lands on a column the product reads. It lands HERE, and
-- the crew's own confirmation is the act that copies it across — edited or not.
-- If they change nothing, their tap is still what made it real.
--
-- ============ AND NOTHING DOWNSTREAM MEASURES AGAINST IT ============
--
-- His correction the same day, when I asked whether ops should hear about a
-- crew changing a pre-filled rate:
--
--   "Im wouldnt be building a quote around $50, its whatever his pricing is or
--    another contractor pricing is. we are not setting anypricing."
--
-- So a proposed rate is NOT a quote, NOT a floor, NOT a default any engine
-- falls back to, and NOT a figure any screen reports against. It is a typing
-- convenience with an expiry: the moment the crew settles it, it is history.
-- There is deliberately no variance view, no "ops proposed X, crew set Y"
-- anywhere, and this table is ops-and-owner readable only so nobody is tempted
-- to build one. A screen that reports a crew's pricing back to the operator is
-- supervision, not a marketplace.
--
-- ============ FOUR THINGS OPS MAY NEVER PROPOSE, AND THEY ARE NOT COLUMNS ===
--
-- There is no bank column here, no terms column, no COI column and no verified
-- mobile column. Not "ops-invisible" versions of them — they are absent, so no
-- future form can quietly grow one:
--
--   BANK / PAYOUT. One person typing another person's payout destination is the
--   cleanest fraud available in this product.
--   THE TERMS. "Courier, not witness" — no signature LakeLife is not party to.
--   The acceptance ledger (0139) records the crew's own act, with the exact
--   words and a pinned digest.
--   THE COI AND W-9. Their documents, and the insurance gate checks the
--   certificate NAMES THEIR BUSINESS (0152) — ops uploading one proves nothing.
--   MOBILE VERIFICATION. Has to be their handset.
--
-- `phone_e164` below is the ONE apparent exception and is not one: it is what
-- the crew read out on the call, stored so the verify box opens pre-filled. It
-- is never copied to `users.mobile_e164`, which by standing rule means a number
-- they gave us AND verified. A number somebody else typed is neither.

-- ---------------------------------------------------------------------------
-- THE PROPOSAL
-- ---------------------------------------------------------------------------

create table if not exists public.crew_setup_proposals (
  id            uuid primary key default gen_random_uuid(),
  -- ONE OPEN PROPOSAL PER CREW. A second would give the crew two cards saying
  -- two different things with no way to tell which call it came from.
  vendor_id     uuid not null unique references public.vendors(id) on delete cascade,

  proposed_by   uuid not null references public.users(id) on delete restrict,
  proposed_at   timestamptz not null default now(),
  -- SNAPSHOT, NOT A JOIN. The crew's card says "Brendon set this up from your
  -- call on 24 September 2026", and that sentence is a record of what we told
  -- them — it must not change later because a users row did. It also keeps this
  -- table from ever needing to embed `users`, which carries two foreign keys
  -- here and would be ambiguous to PostgREST (see 0178, which took /ops down).
  proposed_by_name text,
  -- Free text from the call: "spoke to Josh 24 Sep, he does the Haven pier".
  note          text,

  -- ---- what ops was told on the phone. EVERY ONE OPTIONAL. ----
  -- An empty box asks a question; a filled one answers it, and a default here
  -- would answer it wrongly on the crew's behalf. Nothing is seeded.
  phone_e164     text,
  service_lakes  uuid[],
  work_days      text[],
  daily_capacity integer,

  -- ---- how it ended ----
  settled_at    timestamptz,
  settled_as    text,
  settled_by    uuid references public.users(id) on delete set null,

  constraint crew_setup_proposals_capacity_in_range
    check (daily_capacity is null or (daily_capacity >= 1 and daily_capacity <= 20)),
  constraint crew_setup_proposals_phone_is_e164
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint crew_setup_proposals_settled_is_one_of_two
    check (settled_as is null or settled_as in ('confirmed', 'declined')),
  -- THE THREE SETTLEMENT COLUMNS MOVE TOGETHER OR NOT AT ALL. A settled_at with
  -- no settled_by is a confirmation nobody made; a settled_by with no
  -- settled_at is a name attached to nothing.
  constraint crew_setup_proposals_settlement_is_whole
    check (
      (settled_at is null and settled_as is null and settled_by is null)
      or (settled_at is not null and settled_as is not null and settled_by is not null)
    )
);

comment on table public.crew_setup_proposals is
  'What ops typed from a phone call with a crew. Nothing here is true until the crew settles it; the settlement is what writes vendors/vendor_rates. Never read as a price, a floor or a default.';

-- ---------------------------------------------------------------------------
-- THE PROPOSED RATE CARD
-- ---------------------------------------------------------------------------
-- Its own rows rather than jsonb on the proposal, because a rate is per service
-- and the service id has to be a real foreign key: a retired service must take
-- its proposed rate with it, not leave a dangling id that renders as a blank
-- line on a crew's confirmation card.

create table if not exists public.crew_setup_proposed_rates (
  proposal_id  uuid not null references public.crew_setup_proposals(id) on delete cascade,
  service_id   uuid not null references public.services(id) on delete cascade,
  -- Same three columns as `vendor_rates`, and written through the same
  -- `computeRateRow` — so what the crew confirms is byte-for-byte the shape
  -- their own rates screen would have produced.
  base         numeric,
  unit_rate    numeric,
  band_pricing jsonb,
  primary key (proposal_id, service_id)
);

comment on table public.crew_setup_proposed_rates is
  'A number ops read back off a phone call. Not a quote, not a floor, not a default — a pre-fill the crew edits or accepts, after which it is simply their own rate card.';

-- A BLANK PROPOSED RATE IS NOT A PROPOSAL.
--
-- "A blank card counts as unpriced" is already the rule on the crew's own
-- screen, and a row of zeros here would be worse than absent: the crew's card
-- would show a priced-looking line that pays nothing, and confirming it would
-- write exactly the empty rate dispatch refuses. A CHECK cannot do this — the
-- band shapes need `jsonb_each` and `jsonb_array_elements`, and CHECK forbids
-- subqueries — so it is a trigger, which is the honest tool rather than an
-- IMMUTABLE wrapper around functions that are not.
create or replace function public.ll_proposed_rate_must_be_real()
returns trigger language plpgsql as $$
declare
  real_money boolean := false;
begin
  if coalesce(new.base, 0) > 0 or coalesce(new.unit_rate, 0) > 0 then
    real_money := true;
  elsif new.band_pricing is not null then
    -- A band price keyed directly on the object (small/medium/large)...
    --
    -- CASE, NOT `jsonb_typeof(...) = 'number' and (...)::numeric > 0`.
    -- Postgres does not promise to evaluate WHERE conjuncts left to right, so
    -- the type guard does NOT protect the cast beside it: a band_pricing
    -- object carrying `tiers` (an ARRAY) made the planner attempt
    -- `array::numeric` and the whole insert died with a raw 22023. The
    -- migration's own post-conditions caught it on the tiered probe. A CASE
    -- does order its arms, so the cast is only ever reached for a number.
    select exists (
      select 1 from jsonb_each(new.band_pricing) e
       where case when jsonb_typeof(e.value) = 'number' then (e.value)::numeric else 0 end > 0
    ) into real_money;
    -- ...or one inside the tiers array (per_foot, storage).
    if not real_money and jsonb_typeof(new.band_pricing -> 'tiers') = 'array' then
      select exists (
        select 1 from jsonb_array_elements(new.band_pricing -> 'tiers') t
         where case when jsonb_typeof(t -> 'price') = 'number' then (t ->> 'price')::numeric else 0 end > 0
      ) into real_money;
    end if;
  end if;

  if not real_money then
    raise exception 'a proposed rate with no money in it is not a proposal — leave the service off the card instead';
  end if;
  return new;
end $$;

drop trigger if exists crew_setup_proposed_rates_must_be_real on public.crew_setup_proposed_rates;
create trigger crew_setup_proposed_rates_must_be_real
  before insert or update on public.crew_setup_proposed_rates
  for each row execute function public.ll_proposed_rate_must_be_real();

-- ---------------------------------------------------------------------------
-- WHO MAY PROPOSE, AND WHO MAY SETTLE
-- ---------------------------------------------------------------------------
-- The server action asserts ops before it writes, and client writes are revoked
-- below — but the rule that matters here is not "only ops can type this", it is
-- "ONLY THE CREW CAN AGREE TO IT", and that one deserves to be structural.
--
-- Without it, the whole posture is one server-action bug away from ops
-- confirming a crew's own rate card on their behalf, which is precisely the
-- thing this table exists to make impossible.
create or replace function public.ll_only_the_crew_settles_their_setup()
returns trigger language plpgsql as $$
declare
  owner uuid;
begin
  if new.settled_at is null then
    return new;
  end if;
  -- LET THE CONSTRAINT SPEAK FOR ITS OWN CASE. A settlement with no actor is
  -- already refused by crew_setup_proposals_settlement_is_whole, and a BEFORE
  -- trigger runs first — so without this line the honest "a settlement with
  -- nobody attached" error is replaced by a confusing one about whose act it is.
  if new.settled_by is null then
    return new;
  end if;
  -- Already settled and not being changed — let ordinary updates through.
  if tg_op = 'UPDATE' and old.settled_at is not null and old.settled_by = new.settled_by then
    return new;
  end if;

  select v.user_id into owner from public.vendors v where v.id = new.vendor_id;
  if owner is null then
    raise exception 'that crew has not claimed their account yet, so nobody can confirm their setup';
  end if;
  if new.settled_by is distinct from owner then
    raise exception 'only the crew themselves may confirm or decline what ops set up for them';
  end if;
  return new;
end $$;

drop trigger if exists crew_setup_proposals_only_the_crew_settles on public.crew_setup_proposals;
create trigger crew_setup_proposals_only_the_crew_settles
  before insert or update on public.crew_setup_proposals
  for each row execute function public.ll_only_the_crew_settles_their_setup();

-- ---------------------------------------------------------------------------
-- WHO MAY READ
-- ---------------------------------------------------------------------------

alter table public.crew_setup_proposals enable row level security;
alter table public.crew_setup_proposed_rates enable row level security;

drop policy if exists crew_setup_proposals_access on public.crew_setup_proposals;
create policy crew_setup_proposals_access on public.crew_setup_proposals for select
  using (public.ll_is_ops() or vendor_id = public.ll_my_vendor_id());

-- SAME FENCE AS THE PARENT, ASKED THROUGH IT. A proposed rate is a crew's
-- pricing; a second crew reading it would be reading a competitor's card.
drop policy if exists crew_setup_proposed_rates_access on public.crew_setup_proposed_rates;
create policy crew_setup_proposed_rates_access on public.crew_setup_proposed_rates for select
  using (
    exists (
      select 1 from public.crew_setup_proposals p
       where p.id = crew_setup_proposed_rates.proposal_id
         and (public.ll_is_ops() or p.vendor_id = public.ll_my_vendor_id())
    )
  );

-- Postgres' default grants would let a signed-in client write both of these.
-- Every write goes through a server action holding the service role.
revoke insert, update, delete on public.crew_setup_proposals from anon, authenticated;
revoke insert, update, delete on public.crew_setup_proposed_rates from anon, authenticated;
grant select on public.crew_setup_proposals to authenticated;
grant select on public.crew_setup_proposed_rates to authenticated;

create index if not exists idx_crew_setup_proposals_open
  on public.crew_setup_proposals(vendor_id) where settled_at is null;

-- ---------------------------------------------------------------------------
-- POST-CONDITIONS — every probe rolls back
-- ---------------------------------------------------------------------------
do $$
declare
  ok       boolean;
  n        integer;
  leaked   text;
  ops_id   uuid;
  other_id uuid;
  vend_id  uuid;
  prop_id  uuid;
  svc_id   uuid;
  before_n integer;
  transcript text := '';
begin
  select count(*) into before_n from public.crew_setup_proposals;

  -- (a) THE TABLES AND THEIR FENCES EXIST.
  if to_regclass('public.crew_setup_proposals') is null then
    raise exception '0181: crew_setup_proposals was not created';
  end if;
  if to_regclass('public.crew_setup_proposed_rates') is null then
    raise exception '0181: crew_setup_proposed_rates was not created';
  end if;

  -- (b) THE FOUR THINGS OPS MAY NEVER PROPOSE ARE NOT COLUMNS. Absence is the
  --     enforcement; this is what makes a future "just add a masked field"
  --     fail the migration that adds it rather than ship.
  select string_agg(column_name, ', ') into leaked
    from information_schema.columns
   where table_schema = 'public' and table_name = 'crew_setup_proposals'
     and (
       column_name ~* '(bank|account|routing|payout|iban)'
       or column_name ~* '(coi|w9|w_9|insur|certificate)'
       or column_name ~* '(terms|accept|consent|signature|signed)'
       or column_name ~* 'verified'
     );
  if leaked is not null then
    raise exception '0181: the proposal table grew a column ops must never fill — %', leaked;
  end if;

  -- (c) NO CLIENT MAY WRITE EITHER TABLE.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ') into leaked
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and table_name in ('crew_setup_proposals', 'crew_setup_proposed_rates')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if leaked is not null then
    raise exception '0181: a client can write a setup proposal — %', leaked;
  end if;

  -- (d) BOTH TABLES HAVE A READ POLICY AND RLS IS ON.
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('crew_setup_proposals', 'crew_setup_proposed_rates')
     and c.relrowsecurity;
  if n <> 2 then
    raise exception '0181: row-level security is off on % of the two setup tables', 2 - n;
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and policyname in ('crew_setup_proposals_access', 'crew_setup_proposed_rates_access');
  if n <> 2 then
    raise exception '0181: % of the two read policies is missing', 2 - n;
  end if;

  -- (e) THE RULES BITE — probed against real rows, then rolled back.
  begin
    select id into ops_id from public.users where role = 'ops' order by created_at limit 1;
    -- A user with NO crew row of their own: attaching them below must not
    -- detach somebody else's account from their vendor.
    select u.id into other_id from public.users u
     where u.id <> ops_id
       and not exists (select 1 from public.vendors v where v.user_id = u.id)
     order by u.created_at limit 1;
    select id into svc_id from public.services where active order by name limit 1;
    if ops_id is null or other_id is null or svc_id is null then
      raise notice '0181: not enough seeded rows to probe the rules (ops=%, other=%, service=%) — the structural checks above still ran', ops_id, other_id, svc_id;
      raise exception 'ROLLBACK_POSTCONDITION';
    end if;

    insert into public.vendors (company, invite_email, service_types, daily_capacity, status)
    values ('zz-0181-probe', 'zz-0181-probe@lakelife.invalid', array[]::text[], null, 'invited')
    returning id into vend_id;

    insert into public.crew_setup_proposals (vendor_id, proposed_by, proposed_by_name, daily_capacity)
    values (vend_id, ops_id, 'probe', 4)
    returning id into prop_id;

    -- A capacity outside 1..20 is not a capacity.
    ok := false;
    begin
      update public.crew_setup_proposals set daily_capacity = 0 where id = prop_id;
    exception when check_violation then ok := true;
    end;
    transcript := transcript || format('[capacity 0 refused=%s] ', ok);
    if not ok then raise exception '0181: a daily capacity of 0 was accepted'; end if;

    -- A phone that is not E.164 is not a phone.
    ok := false;
    begin
      update public.crew_setup_proposals set phone_e164 = '260-555-0134' where id = prop_id;
    exception when check_violation then ok := true;
    end;
    transcript := transcript || format('[loose phone refused=%s] ', ok);
    if not ok then raise exception '0181: a non-E.164 phone number was accepted'; end if;

    -- A settlement missing its actor is not a settlement.
    ok := false;
    begin
      update public.crew_setup_proposals set settled_at = now(), settled_as = 'confirmed' where id = prop_id;
    exception when check_violation then ok := true;
    end;
    transcript := transcript || format('[settlement with no actor refused=%s] ', ok);
    if not ok then raise exception '0181: a settlement with nobody attached was accepted'; end if;

    -- THE ONE THAT MATTERS: ops cannot agree on the crew's behalf. The vendor
    -- row above is unclaimed, so there is nobody who legitimately could.
    ok := false;
    begin
      update public.crew_setup_proposals
         set settled_at = now(), settled_as = 'confirmed', settled_by = ops_id
       where id = prop_id;
    exception when others then ok := (sqlerrm like '%has not claimed their account%');
      if not ok then raise; end if;
    end;
    transcript := transcript || format('[ops confirming for an unclaimed crew refused=%s] ', ok);
    if not ok then raise exception '0181: ops confirmed a crew setup on the crew''s behalf'; end if;

    -- Claim the crew, and a STRANGER still cannot settle it.
    update public.vendors set user_id = other_id where id = vend_id;
    ok := false;
    begin
      update public.crew_setup_proposals
         set settled_at = now(), settled_as = 'confirmed', settled_by = ops_id
       where id = prop_id;
    exception when others then ok := (sqlerrm like '%only the crew themselves%');
      if not ok then raise; end if;
    end;
    transcript := transcript || format('[stranger settling refused=%s] ', ok);
    if not ok then raise exception '0181: somebody who is not the crew settled their setup'; end if;

    -- ...and the crew themselves CAN.
    update public.crew_setup_proposals
       set settled_at = now(), settled_as = 'confirmed', settled_by = other_id
     where id = prop_id;
    select count(*) into n from public.crew_setup_proposals
     where id = prop_id and settled_as = 'confirmed';
    transcript := transcript || format('[the crew settling accepted=%s] ', n = 1);
    if n <> 1 then raise exception '0181: the crew could not confirm their own setup'; end if;

    -- A proposed rate with no money in it is refused...
    ok := false;
    begin
      insert into public.crew_setup_proposed_rates (proposal_id, service_id, base, unit_rate, band_pricing)
      values (prop_id, svc_id, 0, 0, null);
    exception when others then ok := (sqlerrm like '%no money in it%');
      if not ok then raise; end if;
    end;
    transcript := transcript || format('[blank rate refused=%s] ', ok);
    if not ok then raise exception '0181: a proposed rate of zero was accepted'; end if;

    -- ...a band with a real number in it is not...
    insert into public.crew_setup_proposed_rates (proposal_id, service_id, base, unit_rate, band_pricing)
    values (prop_id, svc_id, 0, 0, '{"small": 0, "medium": 95, "large": 0}'::jsonb);
    select count(*) into n from public.crew_setup_proposed_rates where proposal_id = prop_id;
    transcript := transcript || format('[band rate accepted=%s] ', n = 1);
    if n <> 1 then raise exception '0181: a real band rate was refused'; end if;

    -- ...and neither is a tiered one.
    update public.crew_setup_proposed_rates
       set band_pricing = '{"tiers": [{"max": 20, "price": 0}, {"max": null, "price": 18.5}]}'::jsonb
     where proposal_id = prop_id;
    transcript := transcript || '[tiered rate accepted=true] ';

    -- AND THE SHAPE THAT BROKE THE TRIGGER THE FIRST TIME: a band object whose
    -- values are NOT all numbers. This probe is why the guard is a CASE.
    ok := false;
    begin
      update public.crew_setup_proposed_rates
         set band_pricing = '{"count_field": "sections", "tiers": [{"max": null, "price": 0}]}'::jsonb
       where proposal_id = prop_id;
    exception when others then ok := (sqlerrm like '%no money in it%');
      if not ok then raise; end if;
    end;
    transcript := transcript || format('[mixed-type band with no money refused=%s] ', ok);
    if not ok then raise exception '0181: a band carrying no money was accepted'; end if;

    raise notice '0181 PROBE_ROLLBACK: %', transcript;
    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  -- (f) NOTHING LEAKED. The probes above insert a vendors row and attach a
  --     user to it; a leak would put a crew named zz-0181-probe on the ops
  --     board and a stranger's id on their account.
  select count(*) into n from public.crew_setup_proposals;
  if n <> before_n then
    raise exception '0181: % probe proposal(s) survived', n - before_n;
  end if;
  select count(*) into n from public.vendors where company = 'zz-0181-probe';
  if n <> 0 then
    raise exception '0181: % probe vendor row(s) survived', n;
  end if;

  raise notice '0181: ops can type a crew''s setup from the call and nobody but that crew can agree to it. Bank, terms, insurance and a verified mobile are not columns here.';
end $$;
