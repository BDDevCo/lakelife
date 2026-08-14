-- 0115 — A PARK SETS ITS OWN PRICES.
--
-- Brendon: "we have to build the platform out not just for our park but for
-- others so there needs to be proper toggles or ability to edit as a new park
-- owner that doesnt have our data from the haven already built in."
--
-- The three `park_only` services are GLOBAL rows, and 0113 priced the grounds
-- mow at base 16 + $4/lot straight off The Haven's own $100/week contract. A
-- park owner in another market signing up tomorrow would be quoted Angola,
-- Indiana pricing, with no screen anywhere to change it — and would have no way
-- to know the number came from somebody else's park.
--
-- ================== WHY A MISSING RATE MUST PRICE NOTHING ==================
--
-- The tempting design is to fall back to the global row when a park has not
-- set its own. That is exactly the bug: it is silent, it looks like a working
-- price, and the new owner never finds out he is quoting a stranger's rate.
--
-- So the global base and unit_rate on a park_only service are ZEROED here, and
-- a park with no rate of its own sees the service listed with NO PRICE and a
-- line asking for one. An empty state a person can act on beats a confident
-- wrong number every time.
--
-- The lot-rent side already works this way: `lot_rates` holds what THIS park
-- charges, and nothing invents a rent for a lot that has none.

create table if not exists public.park_service_rates (
  id          uuid primary key default gen_random_uuid(),
  park_id     uuid not null references public.parks(id) on delete cascade,
  service_id  uuid not null references public.services(id) on delete cascade,

  -- Same shape as the service's own rule, so the pricing engine needs no new
  -- model: whatever `pricing_model` the service declares, these two numbers
  -- feed it. For the grounds services that is per_section on the lot count.
  base        numeric(10,2) not null default 0 check (base >= 0),
  unit_rate   numeric(10,2) not null default 0 check (unit_rate >= 0),

  note        text,
  updated_at  timestamptz not null default now(),
  unique (park_id, service_id)
);

comment on table public.park_service_rates is
  'What THIS park pays for a park-only service. There is no fallback to a '
  'global price: a park with no row here sees the service with no price and a '
  'prompt to set one. A silent fallback would quote a new owner another '
  'park''s rate and he would never find out.';

alter table public.park_service_rates enable row level security;
revoke all on public.park_service_rates from anon, authenticated;

-- THE HAVEN'S OWN NUMBERS, moved out of the global row and into its own.
-- $100 a week for the whole park at 21 lots, which is his actual contract.
insert into public.park_service_rates (park_id, service_id, base, unit_rate, note)
select p.id, s.id, 16, 4, 'From the seller: $100/week for the park (21 lots).'
from public.parks p
cross join public.services s
where s.name = 'Park grounds mowing & trim'
  and p.slug = 'scratch-haven'
on conflict (park_id, service_id) do nothing;

-- Now the global numbers go to zero. A park_only service has no price of its
-- own any more — it has a SHAPE, and each park supplies the numbers.
update public.services
   set base = 0, unit_rate = 0
 where park_only = true;

comment on column public.services.park_only is
  'Sold ONLY against a park''s own grounds property. Its base and unit_rate are '
  'ZERO by design: the price lives in park_service_rates, per park. A park with '
  'no rate set sees no price rather than somebody else''s.';

do $$
declare lid uuid; pid uuid; sid uuid; n int; priced numeric;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  -- 1. NO park_only SERVICE CARRIES A GLOBAL PRICE ANY MORE.
  select count(*) into n from public.services
   where park_only = true and (base <> 0 or unit_rate <> 0);
  if n > 0 then
    raise exception '0115: % park service(s) still carry a global price a new park would inherit', n;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0115 Proof','1 Rd','0115-proof', lid,'mh', false) returning id into pid;
    select id into sid from public.services where name = 'Park grounds mowing & trim';

    -- 2. A BRAND-NEW PARK INHERITS NOTHING.
    select count(*) into n from public.park_service_rates where park_id = pid;
    if n <> 0 then
      raise exception '0115: a new park was given service rates it never set';
    end if;

    -- 3. It sets its own, and they are ITS OWN — a different market, a
    --    different number, and The Haven is unaffected.
    insert into public.park_service_rates (park_id, service_id, base, unit_rate)
    values (pid, sid, 200, 11);

    select base + unit_rate * 21 into priced
      from public.park_service_rates where park_id = pid and service_id = sid;
    if priced is distinct from 431 then
      raise exception '0115: the new park''s own rate did not take (got %)', priced;
    end if;

    -- 4. One rate per service per park. Two prices for one mow is a bug that
    --    shows up as a different quote every page load.
    declare ok boolean := false;
    begin
      insert into public.park_service_rates (park_id, service_id, base, unit_rate)
      values (pid, sid, 999, 0);
    exception when unique_violation then ok := true;
    end;
    if not ok then raise exception '0115: a park held two prices for one service'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
