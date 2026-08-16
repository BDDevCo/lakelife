-- 0131 — A MONTH THAT BEGAN BEFORE US IS NOT OURS TO BILL.
--
-- A park changes hands on the 15th. The seller collected the whole month on
-- the 1st and settles the back half with the buyer at the closing table, in one
-- number, between the two of them. The RESIDENT is not in that transaction:
-- they paid their month and owe nobody anything for it.
--
-- Our roll did not know that. It prorates from the day each tenancy is filed,
-- so filing nineteen households on takeover afternoon read "about $2,834 owed
-- this month" — and the button beside it would have raised nineteen real bills
-- for rent already sitting in the seller's account.
--
-- THE RULE: a charge's period must BEGIN on or after the park's go-live date.
--
--   go live Dec 15 → December began on the 1st, before us → refused.
--                    January begins after → allowed.
--   go live Dec 1  → December begins the day we start → allowed.
--
-- A park that genuinely must collect that first part-month says so by setting
-- go-live to the 1st of it, which is exactly the claim "this whole month is
-- mine to bill". There is deliberately no second dial.
--
-- NULL cutover_date means NO RESTRICTION. Most parks join with no handover at
-- all and no meaningful start date; refusing to bill them would be a worse
-- failure than the one this prevents.
--
-- WHY IN THE DATABASE, when both server actions already refuse. Because
-- `previewChargeRun` and `runCharges` are two exported entry points today and
-- there is nothing stopping a third being written next month by someone who
-- does not know this rule exists. The nightly reconciler already went quiet in
-- the go-live month while the roll shouted a number at the owner — that split
-- is precisely what happens when a rule lives in the callers instead of under
-- them.

create or replace function public.park_charge_not_before_go_live()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutover date;
  v_starts  date;
begin
  select p.cutover_date into v_cutover
  from public.parks p where p.id = new.park_id;

  if v_cutover is null then
    return new;                       -- no handover, no restriction
  end if;

  -- period_month is text 'YYYY-MM'; the period begins on its first day.
  v_starts := (new.period_month || '-01')::date;

  if v_starts < v_cutover then
    raise exception
      'charge period % begins before the park went live on % — that month belongs to whoever was collecting rent then',
      new.period_month, v_cutover
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

drop trigger if exists park_charges_not_before_go_live on public.park_charges;
create trigger park_charges_not_before_go_live
  before insert on public.park_charges
  for each row execute function public.park_charge_not_before_go_live();

-- ------------------------------------------------------- post-conditions ----
--
-- PROVEN ON A COPY, because the obvious probe is vacuous.
--
-- The first draft inserted into park_charges itself, against whatever park and
-- tenancy it could find. The only park in the database has 21 lots and zero
-- tenancies, so there was no reservation_id to use, the insert failed on a
-- not-null constraint rather than on the rule, the handler swallowed it, and
-- the migration reported success having tested nothing. A gate that guards
-- nineteen real bills deserves better than a test that cannot fail.
--
-- A temp table takes the same trigger with no foreign keys in the way, so the
-- rule can be exercised with dummy ids and all three cases actually run.

do $$
declare
  v_park     uuid;
  v_prior    date;
  v_refused  boolean := false;
  v_allowed  boolean := false;
  v_firstDay boolean := false;
  dummy      uuid := '00000000-0000-4000-8000-0000000000aa';
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'park_charges_not_before_go_live' and not tgisinternal
  ) then
    raise exception 'ROLLBACK_POSTCONDITION: go-live trigger missing';
  end if;

  select p.id, p.cutover_date into v_park, v_prior from public.parks p limit 1;
  if v_park is null then return; end if;   -- no parks yet: nothing to prove against

  create temp table probe_go_live_charges
    (like public.park_charges including defaults) on commit drop;
  create trigger probe_go_live before insert on probe_go_live_charges
    for each row execute function public.park_charge_not_before_go_live();

  update public.parks set cutover_date = date '2099-06-15' where id = v_park;

  -- 1. A month that began before go-live is refused.
  begin
    insert into probe_go_live_charges
      (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount)
    values (v_park, dummy, dummy, dummy, '2099-06', date '2099-06-01', 100);
  exception when check_violation then v_refused := true;
  end;

  -- 2. The next whole month is allowed.
  insert into probe_go_live_charges
    (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount)
  values (v_park, dummy, dummy, dummy, '2099-07', date '2099-07-01', 100);
  v_allowed := true;

  -- 3. Go-live ON the first does not block its own month — otherwise a park
  --    that starts cleanly on the 1st could never bill at all.
  update public.parks set cutover_date = date '2099-06-01' where id = v_park;
  begin
    insert into probe_go_live_charges
      (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount)
    values (v_park, dummy, dummy, dummy, '2099-06', date '2099-06-01', 100);
    v_firstDay := true;
  exception when check_violation then v_firstDay := false;
  end;

  -- Put the park back exactly as it was, before any assertion can abort.
  update public.parks set cutover_date = v_prior where id = v_park;

  if not v_refused then
    raise exception 'ROLLBACK_POSTCONDITION: a month predating go-live was accepted';
  end if;
  if not v_allowed then
    raise exception 'ROLLBACK_POSTCONDITION: a month after go-live was blocked';
  end if;
  if not v_firstDay then
    raise exception 'ROLLBACK_POSTCONDITION: go-live on the 1st blocked its own month';
  end if;
end
$$;
