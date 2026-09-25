-- 0182 — WHAT A PARK PAYS LAKELIFE. $ PER LOT, PER MONTH, AND NOBODY IS CHARGED.
--
-- Brendon, 24 September 2026, having weighed a percentage of gross rent against
-- a flat per-lot charge: "I like the per lot amount. $8 per lot per month? make
-- it a ops toggle".
--
-- ============ THE DIRECTION OF THIS MONEY IS THE WHOLE RISK ============
--
-- It runs LAKELIFE -> THE PARK OWNER. Every other park money table runs the
-- other way (park -> resident: park_charges, park_fees, park_payments,
-- park_refunds) or records the park's own costs (park_costs, which SPLITS
-- across lots and lands on nineteen rent bills). The failure this migration is
-- shaped to prevent is LakeLife's own revenue appearing on a resident's bill.
--
-- That is enforced by SHAPE, not by comment:
--
--   THE PREFIX IS `lakelife_`, NOT `park_`. Every park->resident reader in the
--   tree names its table as a literal string. None of those strings can reach
--   these tables, and neither can a future `park_*` sweep.
--
--   THERE IS NO HOUSEHOLD-SHAPED COLUMN. No renter_id, no park_lot_id, no
--   reservation_id, no charge_id. A resident bill line needs one; these tables
--   cannot produce one. It is the mirror of the guard that already makes a
--   park->LakeLife row impossible in park_payments.
--
--   `direction` IS SINGLE-VALUED. The column exists only so the database will
--   refuse a row claiming any other direction — a column with a writer and a
--   constraint, rather than a sentence in a header.
--
--   THERE IS NO PAID STATE. draft | issued | void. No `paid`, no `sent`, no
--   payment_id. Nothing can pay one of these and nothing can claim one was
--   sent, so no column is able to lie about either. "Issued" means ops froze
--   the figure for that month — courier, not witness.
--
--   THE TOTAL IS ARITHMETIC THE DATABASE CHECKS. amount = count x rate, and
--   the lot list's length must equal the count. A row cannot claim a total its
--   own count does not produce, nor a count its own lot list does not produce.
--
-- ============ AND THE COMMERCIAL TERMS DO NOT GO ON `parks` ============
--
-- The obvious home for "this park's rate" and "the month it starts" is two
-- columns on `parks`. They would be PUBLIC. 0052 grants `select on public.parks
-- ... to anon` and its read policy is `active or manages or ops` — so on any
-- ACTIVE park, every column is readable by anyone holding the publishable key
-- that ships in the browser bundle. LakeLife's negotiated per-park rate and the
-- date it began charging are not public facts. They live here instead, on a
-- table with no policy at all.

-- ---------------------------------------------------------------------------
-- WHAT WE AGREED WITH ONE PARK
-- ---------------------------------------------------------------------------

create table if not exists public.lakelife_park_terms (
  park_id            uuid primary key references public.parks(id) on delete cascade,

  -- NULL = this park pays the list price (the platform_settings dial).
  -- A park's own rate REPLACES the list price outright and never blends with
  -- it: park rates never combine. ZERO IS A REAL VALUE — a pilot park, or one
  -- held free while a conversation is open — which is why the code that reads
  -- it uses `??` and not `||`.
  fee_per_lot_cents  integer,

  -- NULL = THIS PARK IS NOT BEING BILLED, and that is the value every park
  -- ships with. The list price is LakeLife's own and is true on day one; "this
  -- park owes it" is a different fact, it is false for every park today, and
  -- the two must not be able to be set by the same act.
  fee_start_month    text,

  set_by             uuid references public.users(id) on delete set null,
  set_at             timestamptz not null default now(),

  constraint lakelife_park_terms_rate_is_not_negative
    check (fee_per_lot_cents is null or fee_per_lot_cents >= 0),
  constraint lakelife_park_terms_start_is_a_month
    check (fee_start_month is null or fee_start_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

comment on table public.lakelife_park_terms is
  'What LakeLife charges ONE park, and the month it starts. Not on `parks`, which anon may read. NULL start month = not being billed, which is every park today.';

-- ---------------------------------------------------------------------------
-- ONE MONTH'S FIGURE, FROZEN
-- ---------------------------------------------------------------------------

create table if not exists public.lakelife_park_invoices (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete restrict,
  period_month  text not null check (period_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  direction     text not null default 'lakelife_to_park'
                  check (direction = 'lakelife_to_park'),
  -- The rule that produced the count, written down so a later change of rule is
  -- visible on the rows raised under the old one rather than silently retrospective.
  basis         text not null default 'live_in_service_not_park_home_not_slip_or_storage'
                  check (basis = 'live_in_service_not_park_home_not_slip_or_storage'),

  lot_count     integer not null check (lot_count >= 0),
  -- The actual lots. So "why is this month $8 less than last?" is answerable
  -- from the rows themselves rather than from a lot table that has since moved.
  lot_numbers   text[]  not null,
  -- WHEN THE COUNT WAS TAKEN. Without it a void-and-re-raise of a closed month
  -- silently resamples today's lots: the same month, no dial moved, a different
  -- number, and nothing on the row able to explain it.
  counted_at    timestamptz not null default now(),

  -- FROZEN AT RAISE TIME, never re-derived from the live dial — the same reason
  -- 0174 freezes the fee percentages onto a job. Moving the dial must not be
  -- able to reprice a month already raised.
  rate_cents    integer not null check (rate_cents >= 0),
  amount_cents  integer not null,

  status        text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  raised_by     uuid not null references public.users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  void_reason   text,

  constraint lakelife_park_invoices_total_is_its_own_arithmetic
    check (amount_cents = lot_count * rate_cents),
  constraint lakelife_park_invoices_count_matches_its_lot_list
    check (cardinality(lot_numbers) = lot_count),
  constraint lakelife_park_invoices_void_says_when
    check ((status = 'void') = (voided_at is not null))
);

comment on table public.lakelife_park_invoices is
  'One month of LakeLife''s per-lot fee for one park, frozen. NOT a demand: nothing sends it and no park can pay it. draft | issued | void — there is deliberately no paid state.';

-- ONE LIVE ROW PER PARK PER MONTH — and `where status <> 'void'` is
-- load-bearing. Without it, voiding a month burns that month forever.
create unique index if not exists lakelife_park_invoices_one_live_per_month
  on public.lakelife_park_invoices (park_id, period_month)
  where status <> 'void';

-- ---------------------------------------------------------------------------
-- WHEN A MONTH MAY BE INVOICED
-- ---------------------------------------------------------------------------
-- THREE REFUSALS, IN THE DATABASE, because the action is not the only thing
-- that will ever write here and a rule in one doorway is not a rule.
--
-- The third is a promise already made. The park section of the terms in force
-- says, unqualified as to whose bill: "Once you tell us the day you took the
-- park over, it will not bill for any month that began before it." An invoice
-- for a month before the park's cutover contradicts a sentence the owner has
-- already accepted.

-- The cutover boundary, mirroring src/lib/billing-start.ts firstBillablePeriod
-- exactly: a go-live on the 1st makes that month ours; any later day means the
-- month began before us and belongs to whoever was collecting then. A test
-- runs both over a range of dates and requires identical answers.
--
-- `date_trunc` TO THE MONTH FIRST, and that is not a tidy-up. The obvious
-- formulation — cutover + 1 month, back off to the 1st — is WRONG at month
-- ends, because Postgres CLAMPS: 2026-01-31 + 1 month is 2026-02-28, and
-- subtracting thirty days lands back in January. A cutover on the 31st would
-- then declare its own month billable, which is the exact thing the rule
-- exists to refuse. Truncating first removes the day of the month from the
-- arithmetic entirely. The probe below fires on 2026-01-31 for this reason.
create or replace function public.ll_first_billable_period(cutover date)
returns text language sql immutable as $fn$
  select case
    when cutover is null then null
    when extract(day from cutover) = 1 then to_char(cutover, 'YYYY-MM')
    else to_char(date_trunc('month', cutover) + interval '1 month', 'YYYY-MM')
  end
$fn$;

create or replace function public.ll_park_invoice_is_allowed()
returns trigger language plpgsql as $fn$
declare
  start_month text;
  cut         date;
  first_ok    text;
begin
  select t.fee_start_month into start_month
    from public.lakelife_park_terms t where t.park_id = new.park_id;

  if start_month is null then
    raise exception 'that park is not being billed yet — set the month its fee starts first';
  end if;
  if new.period_month < start_month then
    raise exception 'that month is before the park''s fee starts';
  end if;

  select p.cutover_date into cut from public.parks p where p.id = new.park_id;
  first_ok := public.ll_first_billable_period(cut);
  if first_ok is not null and new.period_month < first_ok then
    raise exception 'that month began before the park was taken over';
  end if;

  return new;
end $fn$;

drop trigger if exists lakelife_park_invoices_allowed on public.lakelife_park_invoices;
create trigger lakelife_park_invoices_allowed
  before insert on public.lakelife_park_invoices
  for each row execute function public.ll_park_invoice_is_allowed();

-- ---------------------------------------------------------------------------
-- WHO MAY READ — NOBODY BUT THE SERVICE ROLE
-- ---------------------------------------------------------------------------
-- No policy at all, on purpose. In this phase the fee is an ops figure: there
-- is no park-facing surface, no document in force naming it, and no way for a
-- park to pay it. A table nothing outside ops can select is a table no
-- resident-facing query can accidentally embed.
--
-- The standing `alter default privileges` does NOT revoke writes from
-- `authenticated`; that revoke has to be written per table or PostgREST leaves
-- it writable by anyone who can log in.

alter table public.lakelife_park_terms    enable row level security;
alter table public.lakelife_park_invoices enable row level security;

revoke all on public.lakelife_park_terms    from anon, authenticated;
revoke all on public.lakelife_park_invoices from anon, authenticated;

-- ---------------------------------------------------------------------------
-- THE LIST PRICE
-- ---------------------------------------------------------------------------
-- $8. Unlike a crew's rate — which LakeLife may never set — this one is
-- LakeLife's own price, so a seeded value is a fact that is true on day one.
--
-- The CODE fallback in settings.ts is 0, not 8, and deliberately disagrees with
-- this seed: getPlatformSettings returns DEFAULT_SETTINGS wholesale on a failed
-- read, so a code default of 8 would point the degraded path at the ON value —
-- the same shape that once turned unattended AI sending on. The live value is
-- this row; the fallback is silence.
insert into public.platform_settings (key, value)
values ('park_platform_fee_per_lot_monthly', '8'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- POST-CONDITIONS — every probe rolls back
-- ---------------------------------------------------------------------------
do $$
declare
  ok         boolean;
  n          integer;
  leaked     text;
  ops_id     uuid;
  park_id_v  uuid;
  transcript text := '';
  dial       jsonb;
begin
  -- (a) THE LIST PRICE IS ON FILE AND IS THE NUMBER HE NAMED.
  select value into dial from public.platform_settings where key = 'park_platform_fee_per_lot_monthly';
  if dial is null then
    raise exception '0182: the per-lot dial was not seeded';
  end if;
  if (dial #>> '{}')::numeric <> 8 then
    raise notice '0182: the per-lot dial reads % (not the seeded 8) — somebody has already moved it, which is fine', dial;
  end if;

  -- (b) NOBODY IS BEING BILLED. The fact that must be false on day one.
  select count(*) into n from public.lakelife_park_terms where fee_start_month is not null;
  if n <> 0 then
    raise exception '0182: % park(s) already carry a fee start month — nothing should be billing', n;
  end if;
  select count(*) into n from public.lakelife_park_invoices;
  if n <> 0 then
    raise exception '0182: % invoice row(s) exist before anything has been raised', n;
  end if;

  -- (c) NO HOUSEHOLD-SHAPED COLUMN EXISTS on either table. Absence is the
  --     enforcement: this makes a future "just add a lot id" fail the
  --     migration that adds it rather than ship.
  select string_agg(table_name || '.' || column_name, ', ') into leaked
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('lakelife_park_terms', 'lakelife_park_invoices')
     and (
       column_name ~* '(renter|resident|household|tenan)'
       or column_name ~* '(lot_id|reservation|charge_id|payment)'
       or column_name ~* '^(paid|sent)'
     );
  if leaked is not null then
    raise exception '0182: a LakeLife invoice grew a column a resident could hang on — %', leaked;
  end if;

  -- (d) NO CLIENT MAY READ OR WRITE EITHER TABLE.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ') into leaked
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and table_name in ('lakelife_park_terms', 'lakelife_park_invoices');
  if leaked is not null then
    raise exception '0182: a client can reach LakeLife''s own park revenue — %', leaked;
  end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('lakelife_park_terms', 'lakelife_park_invoices')
     and c.relrowsecurity;
  if n <> 2 then
    raise exception '0182: row-level security is off on % of the two tables', 2 - n;
  end if;

  -- (e) THE CUTOVER BOUNDARY AGREES WITH billing-start.ts.
  if public.ll_first_billable_period(date '2026-12-01') <> '2026-12' then
    raise exception '0182: a go-live on the 1st should make that month billable';
  end if;
  if public.ll_first_billable_period(date '2026-12-15') <> '2027-01' then
    raise exception '0182: a mid-month go-live should push to the next month';
  end if;
  if public.ll_first_billable_period(date '2026-12-31') <> '2027-01' then
    raise exception '0182: a month-end go-live should push to the next month';
  end if;
  if public.ll_first_billable_period(null) is not null then
    raise exception '0182: no cutover date should mean no restriction';
  end if;
  -- THE MONTH-END CASE, which the obvious `+ 1 month` arithmetic gets wrong:
  -- Postgres clamps 2026-01-31 + 1 month to 2026-02-28, and backing off the
  -- day of the month from there lands in JANUARY — declaring billable the very
  -- month the rule exists to refuse.
  if public.ll_first_billable_period(date '2026-01-31') <> '2026-02' then
    raise exception '0182: a month-end go-live clamped back into its own month — got %', public.ll_first_billable_period(date '2026-01-31');
  end if;
  if public.ll_first_billable_period(date '2026-02-28') <> '2026-03' then
    raise exception '0182: February month-end did not roll to March';
  end if;
  transcript := transcript || '[cutover boundary agrees] ';

  -- (f) THE RULES BITE — probed against real rows, then rolled back.
  begin
    select id into ops_id from public.users where role = 'ops' order by created_at limit 1;
    select id into park_id_v from public.parks order by created_at limit 1;
    if ops_id is null or park_id_v is null then
      raise notice '0182: not enough seeded rows to probe (ops=%, park=%)', ops_id, park_id_v;
      raise exception 'ROLLBACK_POSTCONDITION';
    end if;

    -- A park with no start month cannot be invoiced at all.
    insert into public.lakelife_park_terms (park_id, set_by) values (park_id_v, ops_id)
      on conflict (park_id) do update set fee_start_month = null;
    ok := false;
    begin
      insert into public.lakelife_park_invoices (park_id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
      values (park_id_v, '2027-01', 20, array['1','2'], 800, 16000, ops_id);
    exception when others then ok := (sqlerrm like '%not being billed yet%');
      if not ok then raise; end if;
    end;
    transcript := transcript || format('[no start month refused=%s] ', ok);
    if not ok then raise exception '0182: a park with no start month was invoiced'; end if;

    update public.lakelife_park_terms set fee_start_month = '2027-01' where park_id = park_id_v;

    -- A count that does not match its own lot list is refused.
    ok := false;
    begin
      insert into public.lakelife_park_invoices (park_id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
      values (park_id_v, '2027-01', 20, array['1','2'], 800, 16000, ops_id);
    exception when check_violation then ok := true;
    end;
    transcript := transcript || format('[count vs lot list refused=%s] ', ok);
    if not ok then raise exception '0182: a count that disagreed with its lot list was accepted'; end if;

    -- A total that is not count x rate is refused.
    ok := false;
    begin
      insert into public.lakelife_park_invoices (park_id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
      values (park_id_v, '2027-01', 2, array['1','2'], 800, 99999, ops_id);
    exception when check_violation then ok := true;
    end;
    transcript := transcript || format('[bad total refused=%s] ', ok);
    if not ok then raise exception '0182: a total that was not count x rate was accepted'; end if;

    -- Another direction is refused.
    ok := false;
    begin
      insert into public.lakelife_park_invoices (park_id, period_month, direction, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
      values (park_id_v, '2027-01', 'park_to_resident', 2, array['1','2'], 800, 1600, ops_id);
    exception when check_violation then ok := true;
    end;
    transcript := transcript || format('[other direction refused=%s] ', ok);
    if not ok then raise exception '0182: a row claimed a direction this table does not have'; end if;

    -- A month before the start month is refused.
    ok := false;
    begin
      insert into public.lakelife_park_invoices (park_id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
      values (park_id_v, '2026-12', 2, array['1','2'], 800, 1600, ops_id);
    exception when others then ok := (sqlerrm like '%before the park%fee starts%');
      if not ok then raise; end if;
    end;
    transcript := transcript || format('[month before the start refused=%s] ', ok);
    if not ok then raise exception '0182: a month before the fee start was invoiced'; end if;

    -- The correct recipe is accepted.
    insert into public.lakelife_park_invoices (park_id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
    values (park_id_v, '2027-01', 2, array['1','2'], 800, 1600, ops_id);
    select count(*) into n from public.lakelife_park_invoices where park_id = park_id_v;
    transcript := transcript || format('[correct recipe accepted=%s] ', n = 1);
    if n <> 1 then raise exception '0182: a correct invoice was refused'; end if;

    -- A SECOND live row for the same month is refused...
    ok := false;
    begin
      insert into public.lakelife_park_invoices (park_id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
      values (park_id_v, '2027-01', 2, array['1','2'], 800, 1600, ops_id);
    exception when unique_violation then ok := true;
    end;
    transcript := transcript || format('[second live month refused=%s] ', ok);
    if not ok then raise exception '0182: a park was invoiced twice for one month'; end if;

    -- ...but voiding the first frees the month, rather than burning it forever.
    update public.lakelife_park_invoices set status = 'void', voided_at = now()
     where park_id = park_id_v and period_month = '2027-01';
    insert into public.lakelife_park_invoices (park_id, period_month, lot_count, lot_numbers, rate_cents, amount_cents, raised_by)
    values (park_id_v, '2027-01', 3, array['1','2','6'], 800, 2400, ops_id);
    transcript := transcript || '[re-raise after void accepted=true] ';

    raise notice '0182 PROBE_ROLLBACK: %', transcript;
    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  -- (g) NOTHING LEAKED.
  select count(*) into n from public.lakelife_park_invoices;
  if n <> 0 then raise exception '0182: % probe invoice(s) survived', n; end if;
  select count(*) into n from public.lakelife_park_terms where fee_start_month is not null;
  if n <> 0 then raise exception '0182: a probe left a park being billed'; end if;

  raise notice '0182: LakeLife can record what a park owes it, nobody is being billed, and no client can read a cent of it.';
end $$;
