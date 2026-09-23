-- ============================================================================
-- 0178 — EVERY CREW ON ONE SCREEN, AND THE BUYER CHOOSES.
--
-- Brendon, 23 September 2026, in his own words:
--
--   "Just like a home owner that has their own crews that they can add, I want
--    that to happen to the park, we will add josh, but then josh will be on the
--    platform and he can have access to more homeowners/clients who need pier
--    installs. And that will go for any crew who is added onto the platform.
--    but the owner needing the service should still see all the options, if
--    any, for the crews available and their pricing"
--
-- and, on the pricing itself:
--
--   "now if there is more than one crew that has been onboarded at a lower rate
--    the homeowner should be given the options available, and what days and the
--    crew rating....then they make the decision."
--
-- THREE RULES COME OUT OF THAT:
--
--   1. ANYBODY CAN BRING A CREW — a homeowner already could; a park now can.
--   2. BRINGING A CREW IS NOT A LOCK. The crew joins THE PLATFORM and becomes
--      available to everyone. That is the answer to "why would Josh give up
--      12%": access to every pier owner on three lakes instead of one park.
--   3. THE PERSON BUYING SEES EVERY OPTION, including the person who brought
--      the crew. No exclusivity, no hidden alternatives.
--
-- Rule 3 is a BEHAVIOUR CHANGE, not a new screen. `properties.preferred_vendor`
-- gave a crew first right of refusal out of the affordable pool, which under
-- the old model was invisible — the router picked and the customer never saw
-- options at all. Under a model where the customer chooses, first refusal is a
-- soft exclusivity. So on the crew-priced path preferred becomes A BADGE AND A
-- SORT and never a filter (src/lib/dispatch.ts, decideDispatch). On the MENU
-- path nothing moves: there is nothing to choose between when the price is the
-- same whoever comes.
--
-- NOTHING HERE WIDENS RLS. A homeowner still has no read on `vendors` or
-- `vendor_rates` and must never gain one: widening either would let a crew who
-- opens a homeowner account read every competitor's rate card. The offers
-- screen is served by a SERVER-ONLY builder (src/app/book/crew-offers.ts) that
-- returns a hand-built row per crew — name, the customer's price, the days they
-- work, standing, whether it is the viewer's own crew — and never a crew's own
-- quote or another crew's card.
-- ============================================================================


-- ----------------------------------------------- 1. the customer's own pick --
--
-- A COLUMN WITH A WRITER AND A READER, both named, because this codebase's
-- dominant bug class is a column with neither.
--   WRITER: createBookingBatch (src/app/book/actions.ts), on the crew-priced
--           path only, from the offers screen.
--   READER: autoAssignJob (src/app/book/dispatch.ts) -> decideDispatch, which
--           honours it or refuses with `chosen_crew_unavailable`. It NEVER
--           substitutes a different crew: the customer chose a name and a
--           number, and a swap would be a price they never agreed to.
--
-- ON DELETE SET NULL rather than CASCADE: a crew row disappearing must not take
-- a customer's booking with it. The job falls back to the ranked pool, which is
-- where a job with no recorded pick already lives.
alter table public.jobs
  add column if not exists chosen_vendor_id uuid references public.vendors(id) on delete set null;

comment on column public.jobs.chosen_vendor_id is
  'The crew the CUSTOMER picked off the offers screen (0178). Crew-priced work only — on the menu path the price is identical whoever comes and the router picks. Written by createBookingBatch; read by autoAssignJob, which refuses rather than substituting when that crew can no longer take the day. NULL on autopilot, the nightly self-heal, and everything booked before the offers screen existed: those rank the pool as they always did.';

-- Dispatch reads this per job while assigning. Tiny table today, but the
-- lookup is by vendor on the release paths.
create index if not exists jobs_chosen_vendor_idx on public.jobs (chosen_vendor_id)
  where chosen_vendor_id is not null;


-- --------------------------------------------- 2. the standing dial, at OFF --
--
-- HIS TWO MESSAGES, 23 September 2026, in order:
--   "then all crews should start out somewhere nuetral because we wont have
--    data in to rate them."
--   "we also dont want to hinder any crews from onboarding and staying on the
--    platform right away, so maybe its a feature we toggle on at a later
--    saturation date."
--
-- SO IT SHIPS OFF. Until he turns it on the offers screen shows PRICE AND DAYS
-- and nothing else — his original list minus the part nothing can yet support.
-- That is a commercial decision, not a technical one: the crew bench is the
-- blocker, every crew on it is new, and a screen that silently sorts newcomers
-- to the bottom costs him the crews he is about to recruit.
--
-- READER: getPlatformSettings (src/lib/settings.ts) -> buildCrewOffers, which
--         does not even COMPUTE a standing while this is 0. A payload carrying
--         a standing the screen does not draw is data leaving the server for no
--         reason.
-- WRITER: setCrewStandingPublic (src/app/ops/standing-actions.ts), the switch
--         on the ops pricing-dials card. A dial with no writer is decorative
--         and a dial with no reader is dead; both shapes have bitten here.
--
-- ON CONFLICT DO NOTHING, like every other dial insert, so re-running this file
-- can never stamp over a decision he has since made.
insert into public.platform_settings (key, value) values
  ('crew_standing_public', '0'::jsonb)
on conflict (key) do nothing;

-- WHEN HE TURNS IT ON, standing is a DERIVED STATUS and never a stored score
-- (src/lib/crew-standing.ts):
--     no completed jobs -> "New to LakeLife"
--     some              -> the count, and which lakes
-- There is deliberately NO COLUMN here. A neutral VALUE stops being neutral the
-- day somebody earns a real one: start everyone at 3 stars and on day ninety a
-- crew nobody has hired still reads "3.0 — average" against Josh's twelve real
-- jobs, which is the platform judging a business that has never worked for us.
-- "New to LakeLife" is true on day one and still true on day ninety. And a
-- stored standing is a column with a writer nobody remembers.


-- -------------------------------------------------------------- 3. grants --
--
-- Restated rather than assumed: RLS is the first lock and the REVOKE is the
-- second, and the second has to be said per table rather than left to a
-- default (0100). The grants are table-wide, so `chosen_vendor_id` is covered
-- the moment it exists — but a migration that adds a column to `jobs` and says
-- nothing about who may write it is how the gap reopens.
--
-- NOTHING BELOW WIDENS ANYTHING, and in particular nothing here touches
-- `vendors` or `vendor_rates`. The post-conditions prove it.
revoke insert, update, delete, truncate, references, trigger
  on public.jobs, public.platform_settings from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.jobs, public.platform_settings from authenticated;


-- ------------------------------------------------------- 4. post-conditions --
--
-- SHIP-TIME ASSERTIONS. Everything above is inside one transaction; a failure
-- here rolls the whole file back rather than leaving a half-built dial.
do $$
declare
  n int;
begin
  -- the column exists, and it is a uuid
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'jobs'
     and column_name = 'chosen_vendor_id' and data_type = 'uuid';
  if n <> 1 then
    raise exception '0178: jobs.chosen_vendor_id is missing or is not a uuid (found %)', n;
  end if;

  -- the dial exists and is OFF. Not "exists": OFF. Shipping this on would do
  -- the exact harm he named.
  select count(*) into n
    from public.platform_settings
   where key = 'crew_standing_public' and value::text in ('0', '0.0', 'false');
  if n <> 1 then
    raise exception '0178: crew_standing_public must exist and be off, found % row(s) at off', n;
  end if;

  -- NO CLIENT WRITE ON A CREW'S CARD.
  -- The whole offers design rests on a customer never reading vendor_rates.
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('vendors', 'vendor_rates')
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if n <> 0 then
    raise exception '0178: client write grants exist on vendors/vendor_rates (% found)', n;
  end if;

  -- AND NO CLIENT READ WIDENED — asserted, not asserted-by-heading.
  --
  -- The heading above used to claim this and the query under it filtered
  -- INSERT/UPDATE/DELETE/TRUNCATE: reads were never checked, so a later
  -- migration adding an unconditional read policy on vendor_rates would have
  -- passed this block in silence, on the one guarantee the whole screen rests
  -- on.
  --
  -- A table-level `select` grant to anon/authenticated is NORMAL here and is
  -- not the lock — Supabase grants it on every table and RLS is what holds the
  -- door. So what is asserted is the door itself: row security ON, and no read
  -- policy that lets everyone in.
  select count(*) into n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('vendors', 'vendor_rates')
     and c.relrowsecurity;
  if n <> 2 then
    raise exception '0178: row security must be ON for vendors and vendor_rates (found % of 2)', n;
  end if;

  -- polcmd 'r' = SELECT, '*' = ALL. A null or literal-true USING clause on
  -- either is an unconditional read: every signed-in account would see every
  -- crew's card, which is exactly the leak this package refuses.
  select count(*) into n
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('vendors', 'vendor_rates')
     and p.polcmd in ('r', '*')
     and (p.polqual is null or btrim(pg_get_expr(p.polqual, p.polrelid)) in ('true', '(true)'));
  if n <> 0 then
    raise exception '0178: an unconditional read policy exists on vendors/vendor_rates (% found)', n;
  end if;

  -- and no client write on jobs or the dials
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('jobs', 'platform_settings')
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if n <> 0 then
    raise exception '0178: client write grants exist on jobs/platform_settings (% found)', n;
  end if;
end $$;
