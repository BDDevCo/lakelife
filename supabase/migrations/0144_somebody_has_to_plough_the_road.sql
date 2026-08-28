-- 0144 — SOMEBODY HAS TO PLOUGH THE ROAD.
--
-- The Haven goes live 1 JANUARY, in LaGrange County, Indiana. Twenty-five
-- services existed and not one of them cleared anything.
--
-- ============ SNOW WAS A WORD, IN ONE LIST OUT OF FOUR ============
--
-- `park_fees.covers` has allowed 'snow' since 0067, so a park owner could tick
-- "Snow removal" on the fee his residents pay. Nothing else in the system knew
-- the word: no cost category to file the bill under, no schedule to remind him
-- it is due, and no service to buy it with. A fee that promises snow and a
-- product that cannot deliver, record or even name it.
--
-- Worse than absent — the coverage panel puts every ticked cover into
-- `claimed`, so ticking Snow produced "Your fee covers Snow removal but you
-- haven't recorded a bill for it" FOREVER, because no bill could carry that
-- category. This migration makes the word mean the same thing in all four
-- places.
--
-- ============ WHY FLAT, AND NOT PER LOT ============
--
-- The three existing park services price `per_section` on `lots`, because a
-- mow, a spring cleanup and a leaf haul all get bigger as the park fills.
-- SNOW DOES NOT. The road is the same length whether twelve pads are occupied
-- or twenty-one, and the plough drives it either way. So: flat, with the whole
-- per-push amount in `base`.
--
-- It also cannot be priced by depth, however much one would like to. The
-- engine quotes at BOOKING — before anyone has seen the snow — so there is no
-- input to read. A band on inches would be a number invented at the wrong
-- moment.
--
-- ============ PROTECTIVE, AND THE REASON IS 0053 ============
--
-- `expireUnfilledJobs` flips an unfilled job to `cancelled` on its date and
-- tells the customer "we couldn't line up a crew in time — so we've cancelled
-- it and you were never charged." 0053 carved out work whose absence destroys
-- something, because for a winterization that sentence is a burst pipe.
--
-- An uncleared park road on the morning of a storm is that shape. Twenty-one
-- homes, some of them people who cannot walk out, and no way in for an
-- ambulance. "You were never charged" is not the point. `criticality =
-- 'protective'` means the nightly may never quietly cancel it; it stays on the
-- ops board instead, which is the only honest failure.
--
-- ============ AND IT IS NOT WATER WORK ============
--
-- `is_water_work = false`, deliberately and load-bearingly. Water work is
-- refused outside a lake's ice-out-to-pull-deadline window, which is exactly
-- and only the months when it snows. Flagging snow as water work would make it
-- unbookable for the whole of its own season.
--
-- ============ IT ARRIVES WITH NO PRICE, ON PURPOSE ============
--
-- base 0 / unit_rate 0, like every park service since 0115. The Haven's plough
-- rate is a LaGrange County number nobody else should inherit, and a park with
-- no rate of its own prices to $0 — which every surface already treats as "not
-- applicable" and refuses to book, while the park's service desk asks him for
-- the number. A default here would be this migration inventing what a plough
-- costs in a county it has never seen.

-- ------------------------------------------------------- 1. the service ----

insert into public.services
  (name, kind, pricing_model, base, unit_rate, band_pricing, frequency_options,
   min_photos, daily_capacity, criticality, needs_interior_access,
   is_water_work, park_only, park_bookable, active)
select
  'Snow clearing — roads & common drives',
  'standalone',
  'flat',
  0,            -- see header: the park sets its own number
  0,
  null,         -- flat counts nothing; the park_only fence keeps it off houses
  array['Per push'],
  2,            -- before and after, on the road. The proof it was cleared.
  5,            -- same as the other park services
  'protective', -- 0053: the nightly may never cancel this one
  false,
  false,        -- LOAD-BEARING. See header.
  true,         -- park_only: this is the park's road, not a house's drive
  false,        -- park_only and park_bookable are different axes (0143)
  true
where not exists (
  select 1 from public.services where name = 'Snow clearing — roads & common drives'
);

comment on column public.services.criticality is
  'routine | protective. Protective work is never auto-cancelled by the '
  'nightly when no crew is found (0053) — its absence destroys something or '
  'strands someone. Winterization, and since 0144 snow clearing.';

-- ------------------------------------- 2. the word, in the other three ----
--
-- A bill can now be filed as snow, and a recurring snow bill can be reminded
-- about. Without these the first plough invoice would land under `grounds` and
-- mix with the mowing, or under `other` and mix with the pier — and the fee's
-- Snow tick would stay permanently unverified.

alter table public.park_costs drop constraint if exists park_costs_category_check;
alter table public.park_costs add constraint park_costs_category_check
  check (category in ('water', 'sewer', 'trash', 'common_electric', 'grounds',
                      'snow', 'unit_electric', 'other', 'tax', 'insurance'));

alter table public.park_cost_schedules drop constraint if exists park_cost_schedules_category_check;
alter table public.park_cost_schedules add constraint park_cost_schedules_category_check
  check (category in ('water', 'sewer', 'trash', 'common_electric', 'grounds',
                      'snow', 'tax', 'insurance'));

-- ------------------------------------------------------ post-conditions ----
--
-- SHIP-TIME ASSERTIONS. They run once and cannot police the next migration.

do $$
declare svc record; lid uuid; pid uuid; ok boolean;
begin
  select id, pricing_model, base, unit_rate, criticality, is_water_work,
         park_only, park_bookable, active, min_photos
    into svc
    from public.services where name = 'Snow clearing — roads & common drives';
  if not found then
    raise exception '0144: the snow service was not created';
  end if;

  -- 1. IT ARRIVES UNPRICED, so the desk asks him rather than inventing a rate.
  if svc.base <> 0 or svc.unit_rate <> 0 then
    raise exception '0144: snow shipped with a global price of % / % — 0115 says every park sets its own', svc.base, svc.unit_rate;
  end if;

  -- 2. FLAT. Per-section would scale the road with the lot count.
  if svc.pricing_model <> 'flat' then
    raise exception '0144: snow is priced %, expected flat', svc.pricing_model;
  end if;

  -- 3. PROTECTIVE. The nightly may never cancel it out from under a storm.
  if svc.criticality <> 'protective' then
    raise exception '0144: snow is %, expected protective', svc.criticality;
  end if;

  -- 4. NOT WATER WORK — or the season guard refuses it every month it snows.
  if svc.is_water_work then
    raise exception '0144: snow is flagged as water work, which makes it unbookable all winter';
  end if;

  -- 5. ON THE PARK MENU, and not on a lake house's.
  if not svc.park_only or svc.park_bookable then
    raise exception '0144: snow must be park_only and not park_bookable';
  end if;
  if not svc.active then
    raise exception '0144: snow was created inactive';
  end if;

  -- 6. A SNOW BILL CAN NOW BE FILED, and a snow reminder can exist. Proved on
  --    a throwaway park that is rolled back with the rest of this block.
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0144: no lake to hang a fixture on — row proofs skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0144 Proof', '1 Rd', '0144-proof', lid, 'mh', false) returning id into pid;

    insert into public.park_costs
      (park_id, category, period_start, period_end, amount_paid,
       allocation_method, park_absorbed, allocated_at)
    values (pid, 'snow', current_date, current_date + 1, 250,
            'fee_covered', 250, now());

    insert into public.park_cost_schedules (park_id, category, cadence, due_day, label)
    values (pid, 'snow', 'monthly', 5, '0144 proof');

    -- and the categories that were already there still are
    insert into public.park_costs
      (park_id, category, period_start, period_end, amount_paid,
       allocation_method, park_absorbed, allocated_at)
    values (pid, 'grounds', current_date, current_date + 1, 100,
            'fee_covered', 100, now());

    -- 7. AND NOTHING ELSE SLIPPED IN. A category that was never legal is
    --    still refused, so the constraint was widened rather than dropped.
    ok := false;
    begin
      insert into public.park_costs
        (park_id, category, period_start, period_end, amount_paid,
         allocation_method, park_absorbed, allocated_at)
      values (pid, 'maintenance', current_date, current_date + 1, 1,
              'fee_covered', 1, now());
    exception when others then ok := true;
    end;
    if not ok then
      raise exception '0144: the category check was dropped, not widened — anything is filed now';
    end if;

    raise exception 'ROLLBACK_0144_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_0144_PROOF' then raise; end if;
  end;
end $$;
