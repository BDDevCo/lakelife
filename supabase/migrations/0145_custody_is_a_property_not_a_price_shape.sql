-- 0145 — CUSTODY IS A PROPERTY OF THE SERVICE, NOT A SHAPE OF ITS PRICE.
--
-- The owner decided (design §F.5) that storage work is a HARD GATE: a crew may
-- only take custody of a boat with an unexpired garagekeepers/bailee policy on
-- file. A standard COI is worthless here — general liability excludes damage to
-- property in the vendor's own care, custody and control. That gate is built,
-- and `isEligible` enforces it properly.
--
-- It just asks the wrong question about when to run.
--
-- ============ THE HOLE ============
--
-- `src/lib/dispatch.ts` applies the three custody gates — garagekeepers, barn
-- type, free feet — only `if (input.storage)`. And `src/app/book/dispatch.ts`
-- sets `input.storage` only inside `if (job.group_id)`, when one of the
-- package's legs has `pricing_model = 'seasonal_plus_perdiem'`.
--
-- So custody was inferred from TWO accidents: that the job came through the
-- package wizard, and that one of its legs happened to be priced by the season.
-- Neither is what makes a job custody. Holding somebody's property is.
--
-- Three services were ACTIVE and took custody through the ordinary
-- single-service path, where no group and no seasonal leg exist — so none of
-- the three gates ran at all:
--
--   Boat storage & winterize      per_foot $50/ft
--   Jet ski winterize & store     per_section $350
--   Water toy prep & storage      flat $120
--
-- Nothing has been booked through them because every vendor on the platform is
-- still a fixture that dispatch skips. THE HOLE OPENS THE DAY A REAL CREW IS
-- ONBOARDED — which is step one of running any season at all.
--
-- ============ THE FIX ============
--
-- A named column. `takes_custody` says the thing directly instead of leaving it
-- to be deduced from a pricing model, and dispatch reads it. The package path
-- is untouched: a seasonal leg still derives its indoor/outdoor tier from
-- `band_pricing.storage_type`, exactly as before, because that path also has to
-- pick the right BUILDING. This only adds a second way in for the standalone
-- services, where there is no declared tier and the honest answer is to check
-- the insurance and the space without demanding a barn type.
--
-- TRANSPORT IS NOT CUSTODY HERE. Boat haul-out and Boat return & splash move a
-- hull rather than keep it, and the design wants on-hook cover for those — a
-- different policy, and not this flag's job. Left false deliberately.
--
-- A JUDGEMENT HE CAN REVERSE IN ONE UPDATE: "Water toy prep & storage" is $120
-- of tubes in a corner, and flagging it means a crew needs a garagekeepers
-- policy to take it. That is the same rule applied to a much smaller asset. It
-- is flagged because holding property is holding property, but if it turns out
-- to block real small jobs, one UPDATE turns it off.

-- ------------------------------------------------------- 1. the property ---

alter table public.services
  add column if not exists takes_custody boolean not null default false;

comment on column public.services.takes_custody is
  'Whether performing this service means holding the customer''s property. '
  'Drives the garagekeepers / barn-type / free-feet gates in dispatch. Named '
  'rather than inferred: before 0145 custody was deduced from a package leg '
  'priced seasonal_plus_perdiem, so three standalone storage services reached '
  'crews with no insurance check at all. Transport (haul-out, return & splash) '
  'is deliberately FALSE — moving a hull wants on-hook cover, a different '
  'policy from keeping one.';

update public.services
   set takes_custody = true
 where name in (
   -- active, and previously ungated
   'Boat storage & winterize',
   'Jet ski winterize & store',
   'Water toy prep & storage',
   -- inactive, and already gated via the seasonal path. Flagged so the two
   -- routes agree, and so switching the storage packages on cannot depend on
   -- a pricing model to stay safe.
   'Winter storage — indoor',
   'Winter storage — outdoor'
 );

-- ------------------------------------------------------ post-conditions ----
--
-- SHIP-TIME ASSERTIONS. They run once and cannot police the next migration —
-- but assertion 3 is the one that would have caught this hole years earlier,
-- and it is worth stating even so.

do $$
declare n int; bad text;
begin
  -- 1. CLOSED BY DEFAULT. A new service does not take custody by accident.
  if exists (select 1 from public.services where takes_custody is null) then
    raise exception '0145: takes_custody is nullable — a null is neither yes nor no';
  end if;

  -- 2. THE FIVE INTENDED, AND ONLY THOSE.
  select count(*) into n from public.services where takes_custody;
  if n <> 5 then
    raise exception '0145: % services take custody, expected 5', n;
  end if;

  -- 3. THE TRIPWIRE. Any ACTIVE service whose name says it keeps something
  --    must say so in the column too. This is the check whose absence let
  --    three services hold boats with no insurance gate.
  select string_agg(name, ', ') into bad
    from public.services
   where active and not takes_custody
     and (name ilike '%storage%' or name ilike '%store%' or name ilike '%custody%');
  if bad is not null then
    raise exception '0145: active and unflagged, but the name says custody: %', bad;
  end if;

  -- 4. TRANSPORT STAYS OUT. Moving a hull is a different policy.
  if exists (
    select 1 from public.services where takes_custody
      and name in ('Boat haul-out (we pick it up)', 'Boat return & splash')
  ) then
    raise exception '0145: a transport leg was flagged as custody — it wants on-hook cover, not garagekeepers';
  end if;

  -- 5. THE THREE THAT WERE OPEN ARE NOW SHUT.
  select string_agg(name, ', ') into bad
    from public.services
   where name in ('Boat storage & winterize', 'Jet ski winterize & store', 'Water toy prep & storage')
     and not takes_custody;
  if bad is not null then
    raise exception '0145: still ungated: %', bad;
  end if;
end $$;
