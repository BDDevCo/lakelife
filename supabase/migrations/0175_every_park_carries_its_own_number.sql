-- 0175 — EVERY PARK CARRIES ITS OWN NUMBER.
--
-- He decided this on 28 August 2026 and it was never built:
--
--   "we have our rate, they will have theirs when they upload their costs or
--    when a crew is onboarded with their pricing and the park chooses that new
--    pricing schema. we cannot determine other parks and vendor costs right
--    now, we can only control ours. they cant be combined."
--
-- ============ WHAT WAS IN THE WAY ============
--
-- 0115 fenced park pricing by ZEROING the global price row, which is only
-- available for `park_only` work — nobody else buys it. 0143 then opened the
-- other half (`services.park_bookable`) so a park could BOOK a lake-house
-- service, and said out loud what it was leaving undone:
--
--   "It does not let a park set its own PRICE on a general service...
--    Whether a park gets a negotiated rate on retail work is a business
--    decision, not a schema one, and it is not made here."
--
-- So The Haven's 28-section dock fell straight through to the retail card:
-- $220 + 28 x $48 = $1,564 a visit. On 23 September he named the real number —
-- "Its josh's and that is per season. so 1/2 of it is putting in and the other
-- 1/2 is taking it out" — $1,680 a season, $840 an operation, $30.00 A SECTION.
-- The menu was quoting the park's owner 1.86x his own quote, and the menu
-- figure is not a market observation: it was reverse-engineered from the
-- lakelife.html mockup and seeded by 0047 with no source note.
--
-- ============ WHAT CHANGED, AND WHERE ============
--
-- IN CODE, because it had to be. The 0115 trick cannot be repeated for
-- `park_bookable` work: zeroing the pier's global row would take the price away
-- from every lake homeowner who buys it. So the fence moved off the FLAG and
-- onto the DOORWAY — `withParkRate` (src/lib/park-rates.ts):
--
--   IF THE CUSTOMER IS A PARK, THE ONLY NUMBER THAT MAY PRICE THE WORK IS THAT
--   PARK'S OWN ROW. No row, no price.
--
-- Its second argument is now `ParkRates | null`. `null` = not a park, leave the
-- retail card alone. A Map — INCLUDING AN EMPTY ONE — = a park, and a park with
-- no row comes back base 0 / unit_rate 0, which is $0, which every surface
-- already refuses with an honest sentence. That is the same outcome 0115 got,
-- one customer at a time instead of one table row for everybody.
--
-- The flag is NOT what the overlay fences on, deliberately: five call sites
-- build a service rule and only one of them selected `park_only`. A fence
-- spelled in a column a caller can forget to select fails OPEN, to retail.
-- This one fails closed.
--
-- ============ WHAT THIS FILE DOES ============
--
-- No column, no CHECK on `services`, and nothing switched on. Only the rule
-- that the WRITER already enforces, made structural, plus the provenance.
--
-- `setParkServiceRate` is the one door that writes park_service_rates, and it
-- now accepts `park_only OR park_bookable`. A rule in one doorway is a rule
-- until somebody opens a second door — a backfill, an importer, a hand-run
-- UPDATE. The trigger below is the same sentence where it cannot be bypassed.
--
-- ============ WHAT THIS FILE DELIBERATELY DOES NOT DO ============
--
-- 1. IT DOES NOT SET THE HAVEN'S PIER RATE. Recording Josh's $840 is a pricing
--    decision and it is his. The door is built; it is left unused. And there is
--    a live question under it: whether the park buys this work THROUGH LakeLife
--    at all. Today it pays Josh $1,680 a season direct and LakeLife takes
--    nothing. Routed through, at the 12/12 platform fee 0174 shipped, the park
--    pays $940.80 an operation ($1,881.60 a season) and Josh keeps $1,478.40.
--    That lands on residents: the pier's park_costs row is allocation_method
--    'fee_covered', so it sits inside the $142.53 monthly fee 21 households
--    sign new leases against on 1 January.
--
-- 2. IT DOES NOT WIDEN `services_park_is_never_crew_priced`. 0174's CHECK
--    refuses `park_only AND crew_priced`. The dock is NOT park_only — it is
--    retail work a park may buy — so that CHECK does not fence it, and a
--    park_bookable service could legally be switched crew_priced tomorrow.
--    Today nothing reaches the crew-priced path from a park: `getPricedServices`
--    computes `crew_priced && !isGrounds`, `createBooking` computes
--    `crew_priced && !groundsForParkId`, and `enrollAutopilot` refuses only
--    when `!grounds`. All three fence it in CODE. Whether a park's dock is
--    governed by park pricing or by crew pricing is HIS decision — they are two
--    different models — so the CHECK is left exactly as 0174 wrote it and the
--    gap is named here rather than closed by a schema default.

-- --------------------------------------------- 1. the rule, where it lives --

create or replace function public.park_rate_needs_a_buyable_service()
returns trigger
language plpgsql
as $$
declare
  ok boolean;
  nm text;
begin
  select (s.park_only or s.park_bookable), s.name
    into ok, nm
    from public.services s
   where s.id = new.service_id;

  -- A SERVICE THAT IS GONE IS NOT A SERVICE THAT PASSES. `ok` is NULL when the
  -- select found nothing, and `if not ok` on a NULL is not true — the exact
  -- shape of guard this codebase has paid for before, where a failed lookup
  -- lets the row through. Tested explicitly.
  if ok is null then
    raise exception 'park_service_rates: service % does not exist — a park cannot price work that is not in the catalogue', new.service_id;
  end if;

  if not ok then
    raise exception 'park_service_rates: % is neither park_only nor park_bookable — a park cannot set a price on work it cannot buy', coalesce(nm, new.service_id::text);
  end if;

  return new;
end;
$$;

drop trigger if exists park_rate_needs_a_buyable_service on public.park_service_rates;
create trigger park_rate_needs_a_buyable_service
  before insert or update of service_id on public.park_service_rates
  for each row execute function public.park_rate_needs_a_buyable_service();

comment on table public.park_service_rates is
  'WHAT ONE PARK PAYS FOR ONE SERVICE. The only number allowed to price that '
  'park''s work. Rates NEVER combine: not across parks, not from LakeLife''s '
  'retail card, not from a crew''s card. A park with no row here has no price '
  'and the service is refused rather than quoted from somebody else''s number '
  '(src/lib/park-rates.ts withParkRate — see 0115 and 0175). Widened 0175 from '
  'park_only to anything the park may buy, so The Haven can hold Josh''s $840 '
  'an operation instead of the $1,564 the lake-house card charges for the same '
  '28-section dock.';

-- ----------------------------------------------------- 2. prove it, loudly --

do $$
declare
  lake_only uuid;
  buyable   uuid;
  a_park    uuid;
  bad       int;
  bit       boolean := false;
begin
  -- (a) NOTHING ALREADY ON FILE BREAKS IT. A trigger added over rows that
  --     already violate it enforces the rule only for the future and reads,
  --     forever after, as though it always held.
  select count(*) into bad
    from public.park_service_rates r
    join public.services s on s.id = r.service_id
   where not (s.park_only or s.park_bookable);
  if bad > 0 then
    raise exception '0175: % park rate row(s) already point at a service the park cannot buy — fix the data before the rule', bad;
  end if;

  -- (b) IT BITES. A rate against lake-house-only work must be refused.
  select id into lake_only from public.services
   where not park_only and not park_bookable and active limit 1;
  select id into a_park from public.parks limit 1;

  if lake_only is null or a_park is null then
    raise notice '0175: NO PROBE RAN for the buyable-service rule — this database holds no lake-house-only service or no park. The trigger exists; that it BITES is unverified here.';
  else
    begin
      insert into public.park_service_rates (park_id, service_id, base, unit_rate)
      values (a_park, lake_only, 1, 0);
    exception when others then
      -- A PROBE THAT PASSES FOR THE WRONG REASON IS WORSE THAN NO PROBE.
      -- `when others then bit := true` counts ANY failure as proof the trigger
      -- bit — a NOT NULL violation, a renamed column, a permission error. The
      -- sentinel is the trigger's own sentence; anything else is re-raised.
      if sqlerrm not like '%neither park_only nor park_bookable%' then
        raise exception '0175: the lake-house-only probe failed for a reason that is NOT the rule — the rule is unverified: %', sqlerrm;
      end if;
      bit := true;
    end;
    if not bit then
      -- Roll the probe back before failing, so a bad run leaves no rate row
      -- behind quoting $1 for a service nobody meant to price.
      delete from public.park_service_rates where park_id = a_park and service_id = lake_only;
      raise exception '0175: a park was able to price a service it cannot buy';
    end if;
  end if;

  -- (c) AND IT DOES NOT BITE THE THING IT IS FOR. A guard that refuses
  --     everything is not a guard, and an absence-only probe would pass with
  --     the whole condition deleted.
  select id into buyable from public.services
   where park_bookable and not park_only and active limit 1;
  if buyable is null or a_park is null then
    raise notice '0175: no park_bookable service to probe the ALLOW half against — the refusal above is unpaired here.';
  else
    begin
      insert into public.park_service_rates (park_id, service_id, base, unit_rate)
      values (a_park, buyable, 1, 0)
      on conflict (park_id, service_id) do nothing;
      -- Only remove what this probe put there. A park that already holds a
      -- real rate for this service keeps it.
      delete from public.park_service_rates
       where park_id = a_park and service_id = buyable and base = 1 and unit_rate = 0 and note is null;
    exception when others then
      raise exception '0175: a park was REFUSED a rate on work it may buy — the widening did not happen: %', sqlerrm;
    end;
  end if;

  -- (d) A SERVICE THAT ISN'T THERE IS REFUSED. `if not ok` on a NULL is not
  --     true, which is how a failed lookup becomes a pass — so the function
  --     tests for NULL first. The FK on service_id may well refuse this row
  --     before the trigger ever runs; the assertion is that the ROW does not
  --     land, whichever of the two catches it.
  bit := false;
  if a_park is not null then
    begin
      insert into public.park_service_rates (park_id, service_id, base, unit_rate)
      values (a_park, '00000000-0000-0000-0000-000000000000', 1, 0);
    exception when others then
      -- TWO SENTINELS HERE, and that is deliberate: the FK on service_id may
      -- refuse this row before the trigger ever runs. Either is a pass — the
      -- assertion is that the ROW DOES NOT LAND — but a THIRD kind of error is
      -- not, and would otherwise have read as one.
      if sqlerrm not like '%does not exist%' and sqlerrm not like '%foreign key%'
         and sqlerrm not like '%violates foreign key constraint%' then
        raise exception '0175: the missing-service probe failed for a reason that is NOT the rule: %', sqlerrm;
      end if;
      bit := true;
    end;
    if not bit then
      delete from public.park_service_rates
       where park_id = a_park and service_id = '00000000-0000-0000-0000-000000000000';
      raise exception '0175: a park priced a service that does not exist';
    end if;
  end if;

  raise notice '0175: a park may price anything it can buy, and nothing it cannot.';
end $$;
