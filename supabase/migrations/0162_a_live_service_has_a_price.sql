-- 0162 — A LIVE SERVICE HAS A PRICE
--
-- The companion to 0161. That one stopped a bookable service having no photo
-- gate; this stops one having no PRICE.
--
-- 0115 is the expensive lesson behind it: zeroing a global price made every
-- unpatched pricing call site silently return $0, and it produced three money
-- bugs. A service that is `active` with nothing to charge is a real, tickable,
-- free job — the customer books, a crew is dispatched, and the invoice is
-- nothing. Nothing in the product prevented it.
--
-- It is live right now in a benign form: 'Snow removal — drive & walks' and
-- 'Window washing' (0160) exist unpriced, held safe ONLY by `active = false`
-- and by whoever remembers why. One UPDATE undoes that. Since nothing in the
-- app writes `services.active` at all — the only writers of this table are the
-- margin-health nudger and the nightly est_minutes learner — switching a
-- service on is always a hand-written statement, which is exactly the kind of
-- act that should meet a constraint.
--
-- ---------------------------------------------- what counts as a price -----
--
-- Four shapes, because the models charge differently:
--   flat / per_section / per_foot / seasonal_plus_perdiem -> base or unit_rate
--   band                                                  -> band_pricing.small
--   per_sqft_band                                         -> band_pricing.tiers
--
-- PARK-ONLY SERVICES ARE EXEMPT, and that is not laziness. 0115 deliberately
-- zeroed the global price on every park_only row so a missing park rate could
-- never quietly become somebody else's number; their real price lives in
-- park_service_rates, per park. A global CHECK cannot see that, and demanding
-- a global price would force exactly the invented figure 0115 removed.
--
-- COALESCE IS LOAD-BEARING. With band_pricing NULL, `band_pricing->'small'`
-- is NULL, so the whole OR chain evaluates to NULL — and a CHECK constraint
-- PASSES on NULL. Without the coalesce this reads as a guard and enforces
-- nothing, which is worse than not having it. Verified against production
-- before writing: all 28 rows pass, so this is a ratchet, not a backfill.

alter table public.services
  drop constraint if exists services_live_work_has_a_price;
alter table public.services
  add constraint services_live_work_has_a_price
  check (
    active = false
    or park_only = true
    or coalesce(
         base > 0
         or unit_rate > 0
         or jsonb_typeof(band_pricing->'small') = 'number'
         or (jsonb_typeof(band_pricing->'tiers') = 'array'
             and jsonb_array_length(band_pricing->'tiers') > 0),
       false)
  );

comment on constraint services_live_work_has_a_price on public.services is
  'A bookable service must be able to charge something. park_only rows are '
  'exempt: 0115 zeroed their global price on purpose and the real number lives '
  'in park_service_rates per park. The coalesce matters — a NULL band_pricing '
  'would otherwise make the whole test NULL, and a CHECK passes on NULL.';

do $$
declare n int; ok boolean; v_id uuid;
begin
  select count(*) into n from public.services
   where active and not park_only
     and not coalesce(base > 0 or unit_rate > 0
                      or jsonb_typeof(band_pricing->'small') = 'number'
                      or (jsonb_typeof(band_pricing->'tiers') = 'array'
                          and jsonb_array_length(band_pricing->'tiers') > 0), false);
  if n <> 0 then
    raise exception '0162: % live service(s) still cannot charge anything', n;
  end if;

  -- IT BITES on the exact row it was written for: switching on window washing
  -- while it is still unpriced. Rolled back with the migration.
  select id into v_id from public.services where name = 'Window washing';
  if v_id is null then
    raise exception '0162: the service this was written against is gone';
  end if;
  ok := false;
  begin
    update public.services set active = true where id = v_id;
  exception when others then
    ok := (sqlerrm like '%has_a_price%');
  end;
  if not ok then
    raise exception '0162: an unpriced service was switched on';
  end if;

  -- AND IT LETS THE REAL THING THROUGH — price and activate together, which is
  -- how go-live is meant to happen. If this failed, the constraint would block
  -- the owner from ever launching anything.
  begin
    update public.services
       set base = 60, unit_rate = 7, active = true
     where id = v_id;
  exception when others then
    raise exception '0162: pricing and activating in one statement was refused: %', sqlerrm;
  end;
  if not (select active from public.services where id = v_id) then
    raise exception '0162: the priced service did not go live';
  end if;

  -- NOT TOO BLUNT: a park service at 0/0 is correct and must stay allowed.
  update public.services set active = true
   where name = 'Snow clearing — roads & common drives';

  raise exception 'ROLLBACK_0162_PROOF';
exception when others then
  if sqlerrm <> 'ROLLBACK_0162_PROOF' then raise; end if;
end $$;
