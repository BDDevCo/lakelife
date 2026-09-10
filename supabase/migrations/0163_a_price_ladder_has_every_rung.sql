-- 0163 — A PRICE LADDER HAS EVERY RUNG
--
-- Tightening 0162, written yesterday, which was a third of a guard.
--
-- It asked only whether `band_pricing->'small'` was a number. For a `band`
-- service that lets a THREE-rung ladder go live with ONE rung filled. The
-- other two then fall through `cfg[key] ?? rule.base` (pricing.ts) to base,
-- which is 0 on every band row — so a customer with a medium or large
-- driveway is quoted $0.
--
-- That is the exact failure 0162 exists to prevent, surviving inside 0162, for
-- roughly two thirds of customers. And it is worse than an obvious $0: the
-- owner would believe snow was live, because the one driveway size he happened
-- to test would price correctly.
--
-- The same hole in the other banded model: `per_sqft_band` finds the first
-- tier whose `max` is null or exceeds the property's sqft, and if none matches
-- it also falls to `rule.base`. A tiers array with no terminating
-- `{"max": null}` entry therefore prices the LARGEST houses at $0 — the ones
-- that pay the most. `services_duration_ladder_terminates` already makes
-- exactly this demand of duration_bands; pricing had no equivalent.
--
-- Verified against production before writing: all 28 rows pass, so this is a
-- ratchet with no backfill. Housekeeping's tiers already terminate and the mow
-- already carries all three rungs.
--
-- COALESCE, AGAIN, for the same reason as 0162: with band_pricing NULL every
-- jsonb_typeof is NULL, the CASE yields NULL, and a CHECK PASSES on NULL.

alter table public.services
  drop constraint if exists services_live_work_has_a_price;
alter table public.services
  add constraint services_live_work_has_a_price
  check (
    active = false
    or park_only = true
    or coalesce(
         case pricing_model
           when 'band' then
             jsonb_typeof(band_pricing->'small')  = 'number'
             and jsonb_typeof(band_pricing->'medium') = 'number'
             and jsonb_typeof(band_pricing->'large')  = 'number'
           when 'per_sqft_band' then
             jsonb_typeof(band_pricing->'tiers') = 'array'
             and jsonb_array_length(band_pricing->'tiers') > 0
             and band_pricing->'tiers' @> '[{"max": null}]'::jsonb
           else base > 0 or unit_rate > 0
         end,
       false)
  );

comment on constraint services_live_work_has_a_price on public.services is
  'A bookable service must be able to charge EVERY customer, not the first one '
  'tested. A band service needs all three rungs — a missing rung falls through '
  'to base, which is 0 on every band row. A per_sqft_band needs a terminating '
  '{"max": null} tier or the largest houses price at 0. park_only rows are '
  'exempt (0115 zeroes their global price on purpose; the real number is '
  'per-park). The coalesce matters: a CHECK passes on NULL.';

do $$
declare v_id uuid; ok boolean;
begin
  select id into v_id from public.services where name = 'Snow removal — drive & walks';
  if v_id is null then
    raise exception '0163: the service this was written against is gone';
  end if;

  -- ONE RUNG IS REFUSED. This is the case 0162 allowed through.
  ok := false;
  begin
    update public.services
       set band_pricing = '{"band_field":"drive_band","small":45}'::jsonb, active = true
     where id = v_id;
  exception when others then
    ok := (sqlerrm like '%has_a_price%');
  end;
  if not ok then
    raise exception '0163: a band service went live with one rung of three';
  end if;

  -- TWO IS STILL REFUSED, so the check counts rungs rather than looking for
  -- any key at all.
  ok := false;
  begin
    update public.services
       set band_pricing = '{"band_field":"drive_band","small":45,"medium":65}'::jsonb, active = true
     where id = v_id;
  exception when others then
    ok := (sqlerrm like '%has_a_price%');
  end;
  if not ok then
    raise exception '0163: a band service went live with two rungs of three';
  end if;

  -- ALL THREE GOES LIVE, or the owner could never launch a banded service.
  begin
    update public.services
       set band_pricing = '{"band_field":"drive_band","small":45,"medium":65,"large":95}'::jsonb,
           active = true
     where id = v_id;
  exception when others then
    raise exception '0163: a fully priced ladder was refused: %', sqlerrm;
  end;
  if not (select active from public.services where id = v_id) then
    raise exception '0163: the fully priced service did not go live';
  end if;

  -- AND THE BAND FIELD SURVIVES, or snow prices off the customer's LAWN.
  if (select band_pricing->>'band_field' from public.services where id = v_id) <> 'drive_band' then
    raise exception '0163: writing the ladder dropped band_field';
  end if;

  raise exception 'ROLLBACK_0163_PROOF';
exception when others then
  if sqlerrm <> 'ROLLBACK_0163_PROOF' then raise; end if;
end $$;
