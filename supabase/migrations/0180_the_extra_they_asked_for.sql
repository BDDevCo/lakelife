-- ============================================================================
-- 0180 — THE EXTRA THEY ASKED FOR.
--
-- Brendon, 23 September 2026, in his own words:
--
--   "if a home owner wants extras on that service, can they type what they want
--    done above and beyond the standard service where the crew would provide
--    pricing on that extra and the home owner would either accept or decline
--    that pricing? then if accepted that pricing would bee added to the standard
--    service...... then for the next time that crew is there an option would
--    auto allow the home owner to pick the standard service with their custom
--    add on populated with that new pricing from the crew previously."
--
-- FIVE STEPS: the owner asks in their own words -> the crew names a price ->
-- the owner accepts or declines -> if accepted it joins THAT VISIT'S price ->
-- and next time it is offered back at the number that crew gave.
--
-- ========================== WHY THIS IS NOT A FLAG ==========================
--
-- "One side proposes a number, the other approves, the price changes
-- atomically" is the vendor-flag flow (CLAUDE.md rule 6) and it is already
-- built. Three things here are genuinely different, and they are the whole
-- reason for a table instead of a `flags` row:
--
--   THE HOMEOWNER INITIATES. Every flag is crew-initiated; `apply_flag_change`
--   writes the PROFILE and the flag carries `proposed_change`. Nothing here
--   touches the profile.
--
--   IT IS WORK, NOT A FACT. A flag corrects something true about the property
--   (ten pier sections, not eight) and persists into every future price. An
--   add-on is a piece of labour on ONE visit.
--
--   IT IS REMEMBERED PER CREW AND PROPERTY. "that new pricing from the crew
--   previously" — the memory is the history of accepted rows, read back by
--   (property, crew, service). There is no second "saved add-on" table: a
--   table nothing writes enforces nothing, and a second one here would be a
--   price with two authors.
--
-- ============================ THE MONEY RIDES 0174 ==========================
--
-- The crew names q. The customer pays round2(q x (1 + fee_customer_pct)); the
-- crew is paid round2(q x (1 - fee_crew_pct)); LakeLife keeps the difference of
-- the two ROUNDED ends, never a separately rounded percentage. That is
-- src/lib/platform-fee.ts and it is the ONLY author of these numbers.
--
-- THE PERCENTAGES ARE FROZEN ONTO THE ADD-ON the way 0174 freezes them onto a
-- job, and for the same reason: tuning a dial must never reprice work already
-- agreed. An add-on agreed in May at 12/12 stays 12/12 forever, even if the
-- dial moves in June and even though the add-on rides on a job whose own
-- frozen three may differ.
--
-- SO WHY STORE customer_price AND crew_payout AT ALL, when q and the two
-- percentages could re-derive them? Because `round2` is a convention, and a
-- stored number is a fact. The CHECK below then makes the database refuse any
-- pair that does not tie to the crew's quote at the frozen percentages — so
-- the database VERIFIES the arithmetic without AUTHORING it. A hand-written
-- customer_price, a drifted second implementation, a future screen doing its
-- own multiplication: all three bounce.
--
-- =================== WHERE THE MONEY ACTUALLY LANDS =========================
--
-- On ACCEPT the two numbers are added to the job itself:
--
--   jobs.customer_price += job_addons.customer_price
--   jobs.vendor_cost    += job_addons.crew_payout
--   jobs.margin          = customer_price - vendor_cost   (guard_job_money_shape)
--
-- Thirty-eight files read `jobs.customer_price`. An add-on that lived only in
-- its own table would be invisible to every invoice, every payout, every
-- statement and every report in the product — a price nobody bills is not a
-- price. Folding it in means the extra is charged by the same charge path and
-- paid by the same payout path as the visit it belongs to.
--
-- AND THAT IS ALSO THE PHOTO GATE'S ANSWER (CLAUDE.md rule 2). An add-on
-- carries NO evidence requirement of its own. It does not need one: its payout
-- is part of `jobs.vendor_cost`, and `vendor_cost` cannot be paid out until the
-- job reaches `complete`, which the photo trigger already refuses below
-- `services.min_photos`. A second gate here would be one rule in two doorways;
-- riding the existing gate is strictly stronger than inventing a weaker twin.
-- Rule 2 is neither widened nor narrowed by this file.
--
-- ===================== WHAT MUST NEVER HAPPEN ===============================
--
-- AN UNANSWERED, DECLINED, OR UNPRICED ADD-ON MUST NOT TOUCH THE VISIT. The
-- mow happens. Nothing in this file writes `jobs.status`, `held_at`,
-- `held_flag_id`, `stood_down_at` or `recovery_state`.
--
-- TWO THINGS HERE TOUCH `jobs` AND BOTH ONLY MOVE MONEY. `accept_job_addon`
-- adds the extra's two numbers for an add-on the owner accepted, and
-- `guard_addons_follow_the_crew` takes them back off when the crew who priced
-- it leaves the visit. Neither writes a status, a hold or a schedule, and
-- neither can be reached except by the owner accepting or by `vendor_id`
-- changing.
--
-- THE CREW MUST NOT READ THE CUSTOMER'S NUMBER (CLAUDE.md rule 1). This table
-- holds `customer_price` on the same row as the crew's quote, so the crew gets
-- NO select policy on it: reads for the property owner and ops only. The crew's
-- own view of an add-on is assembled server-side from an explicit column list
-- that never names `customer_price` — the same shape as `getCrewJobDetail`, and
-- `src/lib/addons-are-not-a-customer-price.test.ts` scans for it.
-- ============================================================================


-- ------------------------------------------------------------ 1. the states --
--
-- SIX, and each is a different sentence on a screen. In particular "the crew
-- has not answered yet", "the crew will not quote this" and "you said no to
-- their price" are three distinct facts, and collapsing any two of them makes
-- a screen say something untrue about somebody's money.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'addon_status') then
    create type addon_status as enum (
      'requested',      -- the owner asked; the crew has not answered
      'quoted',         -- the crew named a number; the owner has not answered
      'crew_declined',  -- the crew will not take this one on
      'accepted',       -- the owner said yes; the money is on the job
      'owner_declined', -- the owner said no to the price
      'withdrawn',      -- the owner took the request back before it was priced
      -- THE CREW THAT AGREED IT IS NO LONGER ON THE VISIT.
      --
      -- Not a seventh state for tidiness: it is the one the money forced. An
      -- accepted add-on's payout rides `jobs.vendor_cost`, and SIX doorways
      -- null that column and hand the job back to the board — releaseJob, the
      -- no-show reschedule, the nightly no-show release, both capacity
      -- backstops and dispatch's custody release. Every one of them then
      -- re-assigns at the NEW crew's own base rate, and every one of them
      -- deliberately leaves `customer_price` alone. So the owner kept paying
      -- for an extra the new crew was never told about and would never be paid
      -- for, and LakeLife kept the whole of it. `jobs_addon_follows_the_crew`
      -- below takes the extra back off the visit and files the row here.
      'crew_left'
    );
  end if;
end $$;


-- ------------------------------------------------------------- 2. the table --

create table if not exists public.job_addons (
  id                   uuid primary key default gen_random_uuid(),

  -- THE VISIT IT BELONGS TO. An add-on is labour on one job, so it dies with
  -- the job. There is no free-floating add-on and no add-on without a crew to
  -- price it (see the vendor_id NOT NULL below).
  job_id               uuid not null references public.jobs(id) on delete cascade,

  -- DENORMALISED ON PURPOSE, AND ONLY THESE THREE. property/vendor/service are
  -- how the memory is read back ("what did THIS crew charge at THIS house for
  -- THIS service"), and the job that carried the original may be long deleted
  -- by then. Every other fact is read through job_id.
  property_id          uuid not null references public.properties(id) on delete cascade,
  vendor_id            uuid not null references public.vendors(id),
  service_id           uuid references public.services(id),

  requested_by         uuid not null references public.users(id),
  -- THE FIRST FREE-TEXT CHANNEL FROM A CUSTOMER TO A CREW IN THIS PRODUCT.
  -- Bounded here as well as in `normaliseAddonRequest`, because a bound only
  -- the application knows is a bound only the doorways somebody remembered.
  -- NOTHING MODERATES IT. There is no review queue, no word list and no human
  -- between the box and the crew's phone: it is escaped (lib/html-safe, via
  -- notify -> asHtml), it is length-bound, it reaches one named crew, and it
  -- is recorded here where ops can read it. That is the whole of the control.
  request_text         text not null,

  status               addon_status not null default 'requested',

  -- ---- the crew's answer ----
  -- WHAT THE CREW TYPED, before either fee. NOT what they are paid.
  crew_quote           numeric,
  quoted_at            timestamptz,
  crew_declined_reason text,

  -- ---- frozen at the instant the owner accepted ----
  fee_customer_pct     numeric,
  fee_crew_pct         numeric,
  customer_price       numeric,   -- what the customer is billed for the extra
  crew_payout          numeric,   -- what the crew is actually paid for it
  decided_at           timestamptz,
  decided_by           uuid references public.users(id),

  -- WHEN THE CREW CHANGE TOOK THIS BACK OFF THE VISIT. Written by
  -- `guard_addons_follow_the_crew` and by nothing else; read by the sentence
  -- the owner is shown and by ops. A `crew_left` row keeps its frozen money on
  -- purpose — what was agreed is a fact, and nulling it would destroy the only
  -- record of what came off the bill.
  unwound_at           timestamptz,

  -- THE MEMORY, NAMED. When an owner taps "add it again", the new row points
  -- at the accepted row whose number it copied — so "that new pricing from the
  -- crew previously" is traceable to the visit it came from rather than being
  -- a number with no provenance.
  --
  -- PROVENANCE ONLY, AND NO SCREEN READS IT. The staleness rule does NOT walk
  -- this chain: a repeat carries the original `quoted_at` forward unchanged,
  -- so the age is on the row itself and nothing has to follow a pointer to
  -- find it. This exists for ops answering "where did that number come from".
  repeat_of            uuid references public.job_addons(id) on delete set null,

  created_at           timestamptz not null default now()
);

comment on table public.job_addons is
  'Work a homeowner asked for beyond the standard service on ONE visit, priced '
  'by the crew and accepted or declined by the owner. Never changes the '
  'property profile (that is `flags`); never blocks the visit. Added 0180.';
comment on column public.job_addons.crew_quote is
  'What the crew TYPED, before either platform fee. The crew is paid '
  'crew_payout = quote x (1 - fee_crew_pct), which is LESS. Every crew-facing '
  'screen must say both numbers in words.';
comment on column public.job_addons.customer_price is
  'What the customer is billed for this extra: quote x (1 + fee_customer_pct), '
  'rounded to cents. NEVER shown to a crew (rule 1) — this table grants no '
  'select to a vendor and the crew loader names an explicit column list.';

create index if not exists job_addons_job_idx on public.job_addons (job_id);
-- THE MEMORY LOOKUP, and the only reason the three ids are on the row.
create index if not exists job_addons_memory_idx
  on public.job_addons (property_id, vendor_id, service_id, status, decided_at desc);


-- -------------------------------------------------------- 3. the refusals --

-- A REQUEST IS WORDS, AND WORDS HAVE A CEILING. 500 characters is roughly a
-- paragraph — enough to describe "trim the four cedars along the seawall and
-- haul the clippings", not enough to paste a novel into a crew's SMS.
alter table public.job_addons drop constraint if exists job_addons_request_is_bounded;
alter table public.job_addons add constraint job_addons_request_is_bounded
  check (char_length(btrim(request_text)) between 1 and 500);

alter table public.job_addons drop constraint if exists job_addons_decline_reason_is_bounded;
alter table public.job_addons add constraint job_addons_decline_reason_is_bounded
  check (crew_declined_reason is null or char_length(crew_declined_reason) <= 300);

-- AN UNPRICED ADD-ON IS THE SAFE STATE, AND ZERO IS NOT A PRICE. Zero is
-- already this platform's word for "cannot be priced" — dispatch refuses a
-- crew whose rate is not strictly positive, `usableQuote` floors a bad read to
-- 0, and every booking surface treats $0 as not-bookable. A $0 add-on would be
-- free labour that looks deliberate.
alter table public.job_addons drop constraint if exists job_addons_quote_is_a_price;
alter table public.job_addons add constraint job_addons_quote_is_a_price
  check (crew_quote is null or crew_quote > 0);

-- A QUOTE IS DOLLARS AND CENTS, AND THAT IS NOT PEDANTRY. `round()` in
-- Postgres breaks an exact half away from zero and `Math.round` in JavaScript
-- breaks it upward; on a quote carrying a third decimal the two can land a
-- cent apart, and `job_addons_money_ties_to_the_quote` below would then reject
-- a correctly computed price. Holding the quote at two places means the
-- verifier and the author can never disagree.
alter table public.job_addons drop constraint if exists job_addons_quote_is_whole_cents;
alter table public.job_addons add constraint job_addons_quote_is_whole_cents
  check (crew_quote is null or crew_quote = round(crew_quote, 2));

-- A QUOTED OR ACCEPTED ADD-ON HAS A NUMBER AND A DATE ON IT. The date is not
-- decoration: it is what the staleness rule reads, and a quote with no date
-- can never be shown to have gone stale.
alter table public.job_addons drop constraint if exists job_addons_a_quote_has_a_number;
alter table public.job_addons add constraint job_addons_a_quote_has_a_number
  check (
    status not in ('quoted', 'accepted')
    or (crew_quote is not null and quoted_at is not null)
  );

-- A CREW WHO WOULD NOT QUOTE HAS NOT QUOTED. Otherwise "they said no" could
-- ship a number, and the offer-it-back reader would remember a price nobody
-- ever agreed to.
alter table public.job_addons drop constraint if exists job_addons_a_refusal_has_no_number;
alter table public.job_addons add constraint job_addons_a_refusal_has_no_number
  check (status <> 'crew_declined' or crew_quote is null);

-- ALL THE FROZEN MONEY OR NONE OF IT — 0174's rule, on its own table. A
-- half-frozen add-on is a price nobody can reproduce, and the half that is
-- missing is always the half somebody needs in December.
-- `crew_left` is on the MONEY side of this rule, not the empty side. The row
-- was accepted: somebody agreed those numbers, and the trigger below has since
-- taken them off the visit. Nulling the recipe would leave "an extra was
-- removed" with no way to say what it was worth, which is the one question
-- anybody asks afterwards.
alter table public.job_addons drop constraint if exists job_addons_money_all_or_nothing;
alter table public.job_addons add constraint job_addons_money_all_or_nothing
  check (
    (status in ('accepted', 'crew_left')
       and fee_customer_pct is not null and fee_crew_pct is not null
       and customer_price   is not null and crew_payout   is not null
       and decided_at is not null and decided_by is not null)
    or
    (status not in ('accepted', 'crew_left')
       and fee_customer_pct is null and fee_crew_pct is null
       and customer_price   is null and crew_payout   is null)
  );

-- A COLUMN WITH A WRITER AND A READER, OR IT IS NOT A FACT. `unwound_at` is
-- set only by `guard_addons_follow_the_crew` and it is what the owner's
-- sentence names; a `crew_left` row without one could not say WHEN, and a row
-- in any other state carrying one would be claiming something that never
-- happened.
alter table public.job_addons drop constraint if exists job_addons_unwound_means_crew_left;
alter table public.job_addons add constraint job_addons_unwound_means_crew_left
  check ((status = 'crew_left') = (unwound_at is not null));

-- THE LAST DOORWAY BEFORE A CONTRACTOR IS PAID NOTHING, restated from 0174.
alter table public.job_addons drop constraint if exists job_addons_frozen_fees_are_fractions;
alter table public.job_addons add constraint job_addons_frozen_fees_are_fractions
  check (
    (fee_customer_pct is null or (fee_customer_pct >= 0 and fee_customer_pct < 1))
    and
    (fee_crew_pct is null or (fee_crew_pct >= 0 and fee_crew_pct < 1))
  );

-- THE DATABASE VERIFIES THE ARITHMETIC; src/lib/platform-fee.ts AUTHORS IT.
--
-- This is the constraint that makes a second implementation impossible to ship
-- quietly. Any customer_price or crew_payout that is not the crew's quote at
-- the frozen percentages, rounded to cents, is refused — so a screen that does
-- its own multiplication, a drifted helper, or a hand-edited row all bounce at
-- the write instead of billing somebody.
--
-- The 0.005 tolerance is half a cent: it admits exactly the two correctly
-- rounded values and nothing else.
alter table public.job_addons drop constraint if exists job_addons_money_ties_to_the_quote;
alter table public.job_addons add constraint job_addons_money_ties_to_the_quote
  check (
    status not in ('accepted', 'crew_left')
    or (
      abs(customer_price - round(crew_quote * (1 + fee_customer_pct), 2)) <= 0.005
      and
      abs(crew_payout    - round(crew_quote * (1 - fee_crew_pct),     2)) <= 0.005
    )
  );


-- ------------------------------------------------- 4. accepting, atomically --
--
-- ONE FUNCTION, THE WAY `apply_flag_change` IS ONE FUNCTION. The add-on's
-- status flip and the job's three money columns move together or not at all —
-- an owner tapping Approve on two devices, or a crash between the two writes,
-- must not be able to leave an accepted add-on that nobody is billed for or a
-- job carrying money no add-on explains.
--
-- IT DOES NOT COMPUTE THE PRICE. The caller passes the frozen percentages and
-- the two rounded numbers, straight out of `platform-fee.ts`; the CHECK above
-- refuses them if they do not tie. Computing them here would be a second
-- author for the same arithmetic, which is how the customer's invoice and the
-- crew's payout end up a cent apart forever.
create or replace function public.accept_job_addon(
  p_addon_id         uuid,
  p_user             uuid,
  p_fee_customer_pct numeric,
  p_fee_crew_pct     numeric,
  p_customer_price   numeric,
  p_crew_payout      numeric
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  a        public.job_addons%rowtype;
  owner    uuid;
  j_status text;
  j_group  uuid;
begin
  -- FOR UPDATE is the lock. Two taps race here, not on a status column read a
  -- moment earlier — that is the shape `declineFlag` was fixed for, where a
  -- homeowner on a phone and a laptop paid a trip fee twice.
  select * into a from public.job_addons where id = p_addon_id for update;
  if not found then
    raise exception 'no such add-on';
  end if;
  if a.status <> 'quoted' then
    -- Named, not generic: "already decided" is a different sentence from
    -- "your crew has not priced this yet", and the screen prints both.
    raise exception 'this add-on is %, not waiting on your answer', a.status;
  end if;

  -- ONLY THE PERSON WHO OWNS THE PROPERTY. The same test `assertOwnerFlag`
  -- applies, said again here because a rule in one doorway of two is not a
  -- rule — and this is the doorway that moves money.
  select p.owner_id into owner
    from public.properties p where p.id = a.property_id;
  if owner is distinct from p_user then
    raise exception 'that add-on is not yours to accept';
  end if;

  -- AN EXTRA CANNOT BE ADDED TO A VISIT THAT IS OVER. Once a job is complete
  -- or paid its money is settled: the customer has been billed and the crew's
  -- payout has been computed from `vendor_cost`. Adding to it afterwards would
  -- either bill somebody for a job they already paid, or hand a crew money
  -- with no evidence behind it (rule 2 gates `complete`, not what follows it).
  select j.status::text, j.group_id into j_status, j_group
    from public.jobs j where j.id = a.job_id;
  if j_status is null then
    raise exception 'that visit no longer exists';
  end if;
  if j_status not in ('requested', 'scheduled', 'in_progress') then
    raise exception 'that visit is already % — an extra cannot be added to it now', j_status;
  end if;

  -- A PACKAGE VISIT'S BILL IS THE SUM OF ITS LEGS, AND AN EXTRA IS NOT A LEG.
  --
  -- On a job carrying a `group_id` the owner reads a breakdown assembled from
  -- `job_items` (src/app/requests/package-data.ts) while the invoice is raised
  -- off `jobs.customer_price`. Folding an extra into the second without the
  -- first leaves the legs short of the bill by exactly the extra, with no line
  -- explaining the gap — and `approveFlag` already excludes group jobs from
  -- repricing for the same reason. Refused here rather than shipping a
  -- breakdown that does not add up; a package extra is its own package.
  if j_group is not null then
    raise exception 'that visit is part of a package, and an extra cannot be added to a package visit yet';
  end if;

  update public.job_addons
     set status           = 'accepted',
         fee_customer_pct = p_fee_customer_pct,
         fee_crew_pct     = p_fee_crew_pct,
         customer_price   = p_customer_price,
         crew_payout      = p_crew_payout,
         decided_at       = now(),
         decided_by       = p_user
   where id = p_addon_id;

  -- THE THREE MONEY COLUMNS, AND NOTHING ELSE ON THE JOB. No status, no hold,
  -- no schedule. `coalesce` on the two sides because a job may legitimately
  -- carry no vendor_cost yet; margin is written as the difference so
  -- guard_job_money_shape reconciles to the cent rather than to a convention.
  update public.jobs
     set customer_price = coalesce(customer_price, 0) + p_customer_price,
         vendor_cost    = coalesce(vendor_cost, 0)    + p_crew_payout,
         margin         = (coalesce(customer_price, 0) + p_customer_price)
                        - (coalesce(vendor_cost, 0)    + p_crew_payout)
   where id = a.job_id;
end $$;

revoke execute on function public.accept_job_addon(uuid, uuid, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;


-- ------------------------------------- 4b. the extra follows the crew off --
--
-- THE HOLE THIS CLOSES, IN ONE SENTENCE: an accepted extra's money lives in
-- `jobs.customer_price` and `jobs.vendor_cost`, and SEVEN writes across FIVE
-- files null `vendor_cost`, hand the job back to the board and re-assign it at
-- a different crew's base rate — while deliberately leaving `customer_price`
-- alone. Counted, not estimated: `grep -rn "vendor_cost: null" src/` minus the
-- tests, and `the-extra-follows-the-crew.test.ts` re-counts it.
--
--   src/app/vendor/actions.ts        releaseJob (a crew hands the job back)   1
--   src/app/requests/actions.ts      rescheduleAfterNoShow                    1
--   src/lib/automation.ts            the nightly no-show release              1
--   src/app/book/dispatch.ts         releaseCols + the custody release        2
--   src/app/vendor/open-actions.ts   both capacity backstops                  2
--
-- After any of them the owner is still billed base + $44.80, the replacement
-- crew is paid base and is never told an extra exists, and LakeLife silently
-- keeps the whole of the extra. On a CREW-PRICED job the same event is a
-- different bug: `customer_price` now carries an extra that no crew's rate
-- card can reproduce, so dispatch's agreed-price guard (book/dispatch.ts) and
-- the claim board's (vendor/open-actions.ts) refuse EVERY crew on the lake,
-- for ever, with nothing on any screen naming the add-on as the cause.
--
-- A RULE IN ONE DOORWAY OF SEVEN IS NOT A RULE, so it is not written in any of
-- them. `vendor_id` is the one column all six move, and this is a BEFORE
-- UPDATE trigger on it: the extra comes back off the visit in the same
-- statement that takes the crew off it, whatever called it and whoever writes
-- the seventh doorway next year.
--
-- WHY IT UNWINDS RATHER THAN REFUSES. Refusing the release would trap a crew
-- on a job they cannot do. Re-folding the money onto the next crew would be
-- worse still: it would commit somebody who never saw the request, never named
-- that number and never agreed to it — which is the whole thing this feature
-- exists not to do. The honest answer is that the agreement was with THAT
-- crew: it comes off, the owner is not billed, and the row says so.
--
-- IT RUNS BEFORE `jobs_money_shape` (0050) by name — 'jobs_a...' sorts before
-- 'jobs_m...' — so the margin this writes is the one that guard reconciles.
create or replace function public.guard_addons_follow_the_crew()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  c_sum numeric;
  p_sum numeric;
begin
  if old.vendor_id is null or old.vendor_id is not distinct from new.vendor_id then
    return new;
  end if;

  select coalesce(sum(customer_price), 0), coalesce(sum(crew_payout), 0)
    into c_sum, p_sum
    from public.job_addons
   where job_id = new.id
     and vendor_id = old.vendor_id
     and status = 'accepted';

  if c_sum = 0 and p_sum = 0 then
    return new;
  end if;

  update public.job_addons
     set status = 'crew_left', unwound_at = now()
   where job_id = new.id
     and vendor_id = old.vendor_id
     and status = 'accepted';

  -- THE CUSTOMER SIDE COMES OFF FIRST, because that is the one nobody was
  -- taking off. `null` is left null: dispatch's own release path nulls
  -- `customer_price` on a job it had just frozen, and subtracting from nothing
  -- would invent a negative price out of an absent one.
  if new.customer_price is not null then
    new.customer_price := round(new.customer_price - c_sum, 2);
  end if;
  -- The crew side is usually already null (every release path nulls it). When
  -- a doorway reassigns in place it carries the NEW crew's base cost, so the
  -- old crew's extra has to come off that too or the new crew is paid for work
  -- they never quoted.
  -- The `>= p_sum` is a floor, not a condition worth reaching: a job carrying
  -- an accepted extra always carries at least its payout, because
  -- `accept_job_addon` added it. If it somehow does not, leaving the column
  -- alone is right — a NEGATIVE vendor_cost is a crew invoiced for working,
  -- which is strictly worse than an overstated one, and the margin below is
  -- re-derived either way so `jobs_money_shape` still reconciles.
  if new.vendor_cost is not null and new.vendor_cost >= p_sum then
    new.vendor_cost := round(new.vendor_cost - p_sum, 2);
  end if;
  if new.customer_price is not null and new.vendor_cost is not null then
    new.margin := round(new.customer_price - new.vendor_cost, 2);
  end if;

  return new;
end $$;

drop trigger if exists jobs_addon_follows_the_crew on public.jobs;
create trigger jobs_addon_follows_the_crew
  before update of vendor_id on public.jobs
  for each row execute function public.guard_addons_follow_the_crew();


-- ------------------------------------------------- 5. who may read; nobody --
--                                                      may write from a client

alter table public.job_addons enable row level security;

-- THE OWNER AND OPS. DELIBERATELY NOT THE CREW — this row holds
-- `customer_price` beside the crew's own quote, and rule 1 is enforced at the
-- data layer, not by remembering which columns a screen selected. The crew's
-- view is assembled by server code from a fixed column list.
drop policy if exists job_addons_read on public.job_addons;
create policy job_addons_read on public.job_addons
  for select to authenticated using (
    public.ll_is_ops()
    or exists (
      select 1 from public.properties p
       where p.id = job_addons.property_id and p.owner_id = auth.uid()
    )
  );

-- RLS IS THE FIRST LOCK AND A REVOKE IS THE SECOND. Supabase grants the client
-- roles table DML by default; an add-on a client could insert as 'accepted'
-- would add money to a job nobody quoted.
revoke all on public.job_addons from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.job_addons from authenticated;
grant select on public.job_addons to authenticated;


-- --------------------------------------------------------- 6. postconditions --
--
-- SHIP-TIME ASSERTIONS. Everything that writes a row does it inside a block
-- that raises on the way out, so every probe rolls back and leaves nothing.
-- A constraint asserted to EXIST is not a constraint asserted to BITE, and
-- refusals alone would pass on a table that refuses everything — so both
-- halves are proved: the bad rows bounce AND a complete row is accepted.
do $$
declare
  n        integer;
  ok       boolean;
  leaked   text;
  jid      uuid;
  pid      uuid;
  vid      uuid;
  sid      uuid;
  uid      uuid;
  aid      uuid;
  jprice   numeric;
  jcost    numeric;
  jmargin  numeric;
  jstatus  text;
  unwound_price numeric;
  unwound_cost  numeric;
  gjob     uuid;
  guser    uuid;
  gaid     uuid;
begin
  -- (a) THE TABLE AND ITS ENUM EXIST, with the six states named.
  if not exists (select 1 from pg_type where typname = 'addon_status') then
    raise exception '0180: addon_status is missing';
  end if;
  select count(*) into n from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'addon_status'
     and e.enumlabel in ('requested','quoted','crew_declined','accepted','owner_declined','withdrawn','crew_left');
  if n <> 7 then
    raise exception '0180: addon_status names % of the 7 states — a state with no label is a screen with no sentence', n;
  end if;

  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'job_addons'
     and column_name in ('crew_quote','fee_customer_pct','fee_crew_pct','customer_price','crew_payout')
     and data_type = 'numeric';
  if n <> 5 then
    raise exception '0180: % of the 5 money columns exist as numeric', n;
  end if;

  -- (b) EVERY REFUSAL IS PRESENT BY NAME.
  foreach leaked in array array[
    'job_addons_request_is_bounded',
    'job_addons_decline_reason_is_bounded',
    'job_addons_quote_is_a_price',
    'job_addons_quote_is_whole_cents',
    'job_addons_a_quote_has_a_number',
    'job_addons_a_refusal_has_no_number',
    'job_addons_money_all_or_nothing',
    'job_addons_frozen_fees_are_fractions',
    'job_addons_money_ties_to_the_quote',
    'job_addons_unwound_means_crew_left'
  ] loop
    if not exists (select 1 from pg_constraint where conname = leaked) then
      raise exception '0180: the constraint % is missing', leaked;
    end if;
  end loop;

  -- (b2) THE TRIGGER THAT TAKES AN EXTRA BACK OFF WHEN THE CREW LEAVES, AND
  --      THE ORDER IT FIRES IN. Postgres runs same-timing row triggers in
  --      NAME order, so this one has to sort before `jobs_money_shape` (0050)
  --      or that guard reconciles the margin this one is about to change.
  if not exists (
    select 1 from pg_trigger where tgname = 'jobs_addon_follows_the_crew' and not tgisinternal
  ) then
    raise exception '0180: jobs_addon_follows_the_crew is missing — six doorways would keep billing an extra to a crew that has gone';
  end if;
  if 'jobs_addon_follows_the_crew' >= 'jobs_money_shape' then
    raise exception '0180: jobs_addon_follows_the_crew sorts after jobs_money_shape, so the margin it writes is checked before it writes it';
  end if;

  -- (c) THE CREW GETS NO POLICY AND NO CLIENT WRITE.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'job_addons' and cmd <> 'SELECT'
  ) then
    raise exception '0180: job_addons has a non-SELECT policy — every write goes through the service role';
  end if;
  select string_agg(grantee || ':' || privilege_type, ', ') into leaked
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'job_addons'
     and grantee in ('anon','authenticated')
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');
  if leaked is not null then
    raise exception '0180: a client can write job_addons — %', leaked;
  end if;

  -- RULE 1, THE SAME WAY 0174 ASSERTS IT: nothing crew-readable may project a
  -- customer number. `vendor_jobs` is the crew's surface; the obvious next
  -- convenience is to join an add-on onto it.
  select string_agg(column_name, ', ') into leaked
    from information_schema.columns
   where table_schema = 'public' and table_name = 'vendor_jobs'
     and column_name in ('customer_price','margin','crew_quote','addon_customer_price');
  if leaked is not null then
    raise exception '0180: vendor_jobs projects % to crews', leaked;
  end if;

  -- (d) THE REFUSALS BITE, AND A COMPLETE ROW IS ACCEPTED.
  --     A job that will not set off the other before-update triggers on
  --     `jobs`: not finished, and carrying a crew.
  select j.id, j.property_id, j.vendor_id, j.service_id,
         j.customer_price, j.vendor_cost, j.status::text
    into jid, pid, vid, sid, jprice, jcost, jstatus
    from public.jobs j
    left join public.services s on s.id = j.service_id
   where coalesce(s.is_water_work, false) = false
     and j.vendor_id is not null
     and j.status::text in ('requested','scheduled')
   limit 1;

  if jid is null then
    raise notice '0180: NO PROBE RAN — this database holds no unfinished non-water job with a crew on it. The constraints exist (asserted above); that they BITE is unverified here.';
  else
    select p.owner_id into uid from public.properties p where p.id = pid;

    begin
      -- i. an empty request is not a request.
      ok := false;
      begin
        insert into public.job_addons (job_id, property_id, vendor_id, service_id, requested_by, request_text)
        values (jid, pid, vid, sid, uid, '   ');
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: an empty add-on request was accepted'; end if;

      -- ii. a request longer than the bound is refused.
      ok := false;
      begin
        insert into public.job_addons (job_id, property_id, vendor_id, service_id, requested_by, request_text)
        values (jid, pid, vid, sid, uid, repeat('x', 501));
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: a 501-character add-on request was accepted — the bound is not a bound'; end if;

      -- iii. THE ROW THAT MUST BE ACCEPTED. A plain request, inside the bound.
      insert into public.job_addons (job_id, property_id, vendor_id, service_id, requested_by, request_text)
      values (jid, pid, vid, sid, uid, 'Trim the four cedars along the seawall and haul the clippings.')
      returning id into aid;
      if aid is null then raise exception '0180: a valid add-on request could not be filed'; end if;

      -- iv. a $0 quote is not a price.
      ok := false;
      begin
        update public.job_addons set status = 'quoted', crew_quote = 0, quoted_at = now() where id = aid;
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: a $0 add-on was quoted — zero is this platform''s word for unpriceable'; end if;

      -- iv-b. a quote carrying a third decimal would make the verifier and the
      --       author of the arithmetic disagree by a cent.
      ok := false;
      begin
        update public.job_addons set status = 'quoted', crew_quote = 40.125, quoted_at = now() where id = aid;
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: a quote of $40.125 was accepted — Postgres and JavaScript round that half differently'; end if;

      -- v. a quote with no date can never be shown to have gone stale.
      ok := false;
      begin
        update public.job_addons set status = 'quoted', crew_quote = 40 where id = aid;
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: an add-on was quoted with no quoted_at — nothing could ever call that price stale'; end if;

      -- vi. THE OTHER HALF: a real quote lands.
      update public.job_addons set status = 'quoted', crew_quote = 40, quoted_at = now() where id = aid;
      if not exists (select 1 from public.job_addons where id = aid and status = 'quoted' and crew_quote = 40) then
        raise exception '0180: a crew could not quote an add-on';
      end if;

      -- vii. accepted with half the recipe: refused.
      ok := false;
      begin
        update public.job_addons
           set status = 'accepted', fee_customer_pct = 0.12, decided_at = now(), decided_by = uid
         where id = aid;
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: a half-frozen add-on was accepted — that price can never be re-derived'; end if;

      -- viii. accepted with a customer_price that does NOT tie to the quote:
      --       refused. $40 at 12% is $44.80; $50 is somebody''s own arithmetic.
      ok := false;
      begin
        update public.job_addons
           set status = 'accepted', fee_customer_pct = 0.12, fee_crew_pct = 0.12,
               customer_price = 50.00, crew_payout = 35.20,
               decided_at = now(), decided_by = uid
         where id = aid;
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: an add-on billed $50 on a $40 quote — the database is not checking the arithmetic'; end if;

      -- ix. a crew fee of 1.0 pays a real person nothing for real work.
      ok := false;
      begin
        update public.job_addons
           set status = 'accepted', fee_customer_pct = 0.12, fee_crew_pct = 1,
               customer_price = 44.80, crew_payout = 0,
               decided_at = now(), decided_by = uid
         where id = aid;
      exception when check_violation then ok := true;
      end;
      if not ok then raise exception '0180: an add-on took a 100%% crew fee — the crew would be paid $0'; end if;

      -- x. THE HAPPY PATH THROUGH THE REAL FUNCTION, end to end. $40 at 12/12
      --    is $44.80 to the customer and $35.20 to the crew, and both land on
      --    the job. A function that refused everything would pass every probe
      --    above and make the whole feature unusable.
      perform public.accept_job_addon(aid, uid, 0.12, 0.12, 44.80, 35.20);

      select customer_price, vendor_cost, margin, status::text
        into jprice, jcost, jmargin, jstatus
        from public.jobs where id = jid;
      if jstatus not in ('requested','scheduled') then
        raise exception '0180: accepting an add-on moved the visit to % — an extra must never touch the visit''s status', jstatus;
      end if;
      if abs(jmargin - (jprice - jcost)) > 0.01 then
        raise exception '0180: the job''s margin stopped reconciling after an add-on (% vs % - %)', jmargin, jprice, jcost;
      end if;
      if not exists (
        select 1 from public.job_addons
         where id = aid and status = 'accepted' and customer_price = 44.80 and crew_payout = 35.20
      ) then
        raise exception '0180: accept_job_addon did not write the frozen money';
      end if;

      -- xi. AND IT CANNOT BE ACCEPTED TWICE. The second tap must find the row
      --     already decided rather than add $44.80 to the visit again.
      ok := false;
      begin
        perform public.accept_job_addon(aid, uid, 0.12, 0.12, 44.80, 35.20);
      exception when others then
        -- A PROBE THAT PASSES FOR THE WRONG REASON IS WORSE THAN NO PROBE.
        -- `when others then ok := true` counts a typo'd function name, a
        -- permission error or a renamed column as proof the rule bit. Match the
        -- function's OWN sentence; re-raise anything else.
        if sqlerrm not like '%not waiting on your answer%' then
          raise exception '0180: the accepted-twice probe failed for a reason that is NOT the rule — the rule is unverified: %', sqlerrm;
        end if;
        ok := true;
      end;
      if not ok then raise exception '0180: an add-on was accepted twice — the visit would carry the extra twice over'; end if;

      -- xii. AND SOMEBODY ELSE'S ADD-ON IS NOT THEIRS TO ACCEPT.
      update public.job_addons
         set status = 'quoted', fee_customer_pct = null, fee_crew_pct = null,
             customer_price = null, crew_payout = null, decided_at = null, decided_by = null
       where id = aid;
      ok := false;
      begin
        perform public.accept_job_addon(aid, gen_random_uuid(), 0.12, 0.12, 44.80, 35.20);
      exception when others then
        -- Same rule: the sentinel is the function's own refusal, not any error.
        if sqlerrm not like '%not yours to accept%' then
          raise exception '0180: the stranger probe failed for a reason that is NOT the rule — the rule is unverified: %', sqlerrm;
        end if;
        ok := true;
      end;
      if not ok then raise exception '0180: a stranger accepted an add-on on somebody else''s property'; end if;

      -- xiii. AND THE EXTRA FOLLOWS THE CREW OFF THE VISIT.
      --
      -- The row is back at 'quoted' after xii, so accept it again for real and
      -- then do what every one of the six release doorways does: take the crew
      -- off. The extra must come BACK OFF the customer's price in the same
      -- statement. Both directions are proved — the money moves, and the row
      -- keeps the record of what it was worth.
      perform public.accept_job_addon(aid, uid, 0.12, 0.12, 44.80, 35.20);
      select customer_price, vendor_cost into jprice, jcost from public.jobs where id = jid;
      if jprice is null or jcost is null then
        raise exception '0180: the probe job carries no money after an accepted add-on';
      end if;

      update public.jobs set vendor_id = null where id = jid;

      select customer_price, vendor_cost, margin into unwound_price, unwound_cost, jmargin
        from public.jobs where id = jid;
      if abs(unwound_price - (jprice - 44.80)) > 0.005 then
        raise exception '0180: the crew left and the owner is STILL billed the extra (% before, % after — expected %)',
          jprice, unwound_price, jprice - 44.80;
      end if;
      if abs(unwound_cost - (jcost - 35.20)) > 0.005 then
        raise exception '0180: the crew left and the visit still carries their payout for the extra (% before, % after)', jcost, unwound_cost;
      end if;
      if abs(jmargin - (unwound_price - unwound_cost)) > 0.01 then
        raise exception '0180: the margin stopped reconciling after an extra was unwound (% vs % - %)', jmargin, unwound_price, unwound_cost;
      end if;
      if not exists (
        select 1 from public.job_addons
         where id = aid and status = 'crew_left' and unwound_at is not null
           and customer_price = 44.80 and crew_payout = 35.20
      ) then
        raise exception '0180: the add-on was not filed as crew_left with its frozen money intact — nothing could say what came off the bill';
      end if;

      -- xiv. AND IT IS NOT OFFERED BACK. The memory reads 'accepted' only, so
      --      a price that was taken off a visit cannot be tapped onto the next
      --      one as if it had stood.
      if exists (
        select 1 from public.job_addons
         where id = aid and status = 'accepted'
      ) then
        raise exception '0180: an unwound add-on is still readable as accepted — the memory would offer it back';
      end if;

      raise exception 'ROLLBACK_POSTCONDITION';
    exception
      when others then
        if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
    end;
  end if;

  -- (e) A PACKAGE VISIT REFUSES AN EXTRA, because its bill is the sum of its
  --     legs and an extra is not a leg. Needs a real group job; if this
  --     database holds none, that is said out loud rather than passed over.
  select j.id, p.owner_id into gjob, guser
    from public.jobs j
    join public.properties p on p.id = j.property_id
   where j.group_id is not null
     and j.vendor_id is not null
     and j.status::text in ('requested','scheduled')
   limit 1;

  if gjob is null then
    raise notice '0180: NO PACKAGE PROBE RAN — this database holds no open package visit with a crew, so that accept_job_addon refuses one is unverified here.';
  else
    begin
      insert into public.job_addons (job_id, property_id, vendor_id, service_id, requested_by, request_text, status, crew_quote, quoted_at)
      select j.id, j.property_id, j.vendor_id, j.service_id, guser, 'Probe: an extra on a package visit.', 'quoted', 40, now()
        from public.jobs j where j.id = gjob
      returning id into gaid;

      ok := false;
      begin
        perform public.accept_job_addon(gaid, guser, 0.12, 0.12, 44.80, 35.20);
      exception when others then
        -- The sentinel is the function's own sentence. `when others` here would
        -- pass on the INSERT above having built a row the function rejects for
        -- some unrelated reason — proving nothing about packages at all.
        if sqlerrm not like '%part of a package%' then
          raise exception '0180: the package probe failed for a reason that is NOT the rule — the rule is unverified: %', sqlerrm;
        end if;
        ok := true;
      end;
      if not ok then
        raise exception '0180: an extra was added to a package visit — the legs the owner reads would no longer sum to the bill';
      end if;

      raise exception 'ROLLBACK_POSTCONDITION';
    exception
      when others then
        if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
    end;
  end if;

  raise notice '0180: the extra they asked for. The owner asks, the crew prices, the owner decides, the money ties to the crew''s own number or the database refuses it — and it comes back off the visit the moment that crew does.';
end $$;
