-- 0176 — A PARK IS A CUSTOMER LIKE ANY OTHER.
--
-- ============ THE SENTENCE THIS DROPS, AND WHOSE IT WASN'T ============
--
-- 0174 added `services_park_is_never_crew_priced`:
--
--     check (not (park_only and crew_priced))
--
-- and wrote, in the column comment above it, "Never true for a park_only
-- service — the park's own negotiated rate wins there, and a CHECK enforces
-- it." That sentence was MINE. I briefed three builders on it and shipped a
-- constraint plus three code fences under it. Four hours later the owner said
-- what the model actually is, 23 September 2026:
--
--   "well josh would be a contractor uploaded onto lake life that the park then
--    would be able to see his services offeren on LakeLife, just like any crew
--    for any home owner or renter in the park needing services."
--
-- JOSH IS NOT A SPECIAL PARK ARRANGEMENT. He is a contractor onboarded onto
-- LakeLife like any other crew, and THE PARK IS A CUSTOMER who sees his
-- services and books them the same way a homeowner or a renter in that park
-- does. A constraint that says a park may never meet a crew's price
-- contradicts the model, so it comes out.
--
-- ============ WHAT THE FENCE COST, CHECKED AGAINST PRODUCTION ============
--
-- Four services are `park_only`. Exactly ONE of them has a negotiated park
-- rate: `Park grounds mowing & trim`, base 20 + $5 a lot, which is Mike's real
-- Advantage Lawn Care arrangement ($100 a cut across five 2026 invoices;
-- $125 x 0.80 = $100.00 through the margin floor). The other three have NO
-- rate at all:
--
--     Snow clearing — roads & common drives
--     Common-area spring cleanup
--     Common-area fall cleanup & leaf haul
--
-- THE HAVEN HAS NO SNOW CREW, NO SNOW PRICE, AND THE SELLER'S LAWN GUY SOLD
-- HIS PLOW. Closing is 15 December. A snow contractor onboarding with their
-- own rate card, the park seeing it on LakeLife and booking it, is how that
-- gets solved — and this CHECK forbade exactly that, in the database, for the
-- one class of service it is most urgently needed for.
--
-- ============ WHAT REPLACES IT ============
--
--     A PARK'S OWN NEGOTIATED RATE BEATS A CREW'S CARD.
--     WHERE THE PARK HAS NO RATE OF ITS OWN, THE CREW'S CARD IS THE PRICE —
--     THE SAME AS FOR ANYBODY ELSE.
--
-- PRECEDENCE IS A CODE RULE AND CANNOT BE A CHECK. It is not a fact about a
-- `services` row at all — it is a fact about one PARK and one SERVICE
-- together, and the answer differs park by park for the same row. The Haven's
-- mow is governed by The Haven's rate; a second park with no rate on the same
-- service is governed by whichever crew quotes it. No constraint on `services`
-- can express that, and a constraint that tried would have to ban the thing
-- the owner just asked for.
--
-- So it lives in `pricingPathFor` (src/lib/park-rates.ts), ONE exported
-- function returning one of four answers — `menu`, `crew_card`, `park_rate`,
-- `park_no_rate` — and NINE doorways ask it. The first draft of this file said
-- three, because three was the number the brief named:
--
--     createBooking            src/app/book/actions.ts
--     assignJob                src/app/book/dispatch.ts
--     the /book menu           src/app/profile/data.ts
--     enrollAutopilot          src/app/book/autopilot-actions.ts
--     approveFlag              src/app/approvals/actions.ts
--     claimJob                 src/app/vendor/open-actions.ts
--     the open board           src/app/vendor/open-data.ts
--     assignJobManual          src/app/ops/actions.ts
--     computeScarcityOffer     src/app/requests/offer-data.ts
--
-- (plus `summariseCorrection`, src/lib/arrival.ts, which is the quote the owner
-- taps Approve under and has to agree with what approveFlag then bills).
--
-- The six beyond the brief's three each carried the old fence in a spelling of
-- its own — `!grounds`, `!parkRates`, or the bare flag with no park question at
-- all — and `claimJob` is the one that matters most: its guarded UPDATE WRITES
-- `customer_price` from the claiming crew's card, so on a service somebody
-- flagged crew_priced it would have written a stranger's number straight over
-- The Haven's $125. "The mow cannot move" was true of the rule and false of
-- that door until this commit.
--
-- It is tested in src/lib/park-precedence.test.ts, and the tests that matter
-- are the one that flips the mow to crew_priced and asserts the park's own $125
-- still wins, and the tree-wide scan that refuses the old fence in ANY file —
-- the scan this file's first draft ran over three hard-coded paths.
--
-- ============ WHY THE MOW CANNOT MOVE ============
--
-- Because it HAS A NUMBER, not because a fence stood in front of it. 21
-- households sign new leases on 1 January against $400 rent + a $142.53
-- monthly share of park costs, and the mow sits inside that share. Under
-- precedence the mow resolves `park_rate` on every path, whatever anybody
-- flags the service tomorrow — which is a stronger guarantee than the CHECK
-- gave, since the CHECK only ever covered `park_only` rows and the mow is one
-- of four.
--
-- ============ AND THE TRAP THE OLD MODEL SET ============
--
-- `park_service_rates` holds the ALL-IN CUSTOMER PRICE. To pay Josh his real
-- $840 an operation through the menu path the owner would have to type $1,050,
-- because the 0.20 margin floor caps any crew at $672 against an $840 quote —
-- so NO CREW COULD TAKE THE JOB and it would sit on "Finding a crew" forever.
-- ($1,050 x 0.80 = $840.00. The mow's $125 exists for exactly that reason.)
-- The owner would be doing LakeLife's margin arithmetic in his head to pay his
-- own contractor what the man charges. On the crew's card nobody grosses
-- anything up: Josh's card says $840, the park pays $840 x 1.12 = $940.80,
-- Josh receives $739.20, LakeLife keeps $201.60.
--
-- ============ WHAT THIS FILE DELIBERATELY DOES NOT DO ============
--
-- 1. IT SWITCHES NOTHING ON. No service is flipped `crew_priced`, no park rate
--    is set, and The Haven's pier rate is still unset. Both are his decisions
--    and this only builds the doors.
-- 2. IT DOES NOT REWRITE 0175'S REASONING. 0175 (still unapplied) widens
--    `park_service_rates` from `park_only` to anything the park may buy, and
--    its trigger, its probes and its table comment are all still correct under
--    precedence — a park may price anything it can buy, and where it has
--    priced nothing a crew may quote. The ONE sentence in 0175 his correction
--    invalidates is its section 2 note, "IT DOES NOT WIDEN
--    `services_park_is_never_crew_priced` ... the CHECK is left exactly as
--    0174 wrote it": that CHECK is dropped here, and the three code fences that
--    note lists are all gone. The note is left standing as the record of what
--    was believed when it was written, and this paragraph is the correction.
--
--    What WAS changed in 0175, before it ever ran, is its probe handlers: two
--    `exception when others then bit := true` blocks counted ANY error as
--    proof the trigger bit. A NOT NULL violation, a typo, a dropped column —
--    all of them would have read as "the rule works". They now match the
--    trigger's own sentence and re-raise anything else. A probe that passes for
--    the wrong reason is worse than no probe, and an unapplied migration is
--    still a draft.
--
--    APPLY 0175 FIRST, THEN THIS ONE.

-- ----------------------------------------------------- 1. drop the fence --

alter table public.services
  drop constraint if exists services_park_is_never_crew_priced;

comment on column public.services.crew_priced is
  'FALSE (the default, and every service today) = the menu price and the '
  'margin floor, unchanged. TRUE = the crew''s own rate card IS the price: '
  'the customer is billed quote x (1 + platform_fee_customer_pct) and the crew '
  'is paid quote x (1 - platform_fee_crew_pct), and there is no menu price for '
  'this service at all. Added 0174. TRUE IS LEGAL ON A park_only SERVICE since '
  '0176 — a park is a customer, and a contractor onboarded onto LakeLife sells '
  'to it the way they sell to a homeowner. What protects a park''s negotiated '
  'rate is PRECEDENCE, not this flag: where the park holds a park_service_rates '
  'row that row governs, and only where it holds none does a crew''s card price '
  'the work. That rule is code (pricingPathFor, src/lib/park-rates.ts) because '
  'it is a fact about a park and a service together, which no CHECK on this '
  'table can express.';

-- ------------------------------------------------ 2. prove it, loudly ------
--
-- WHAT A do-BLOCK CAN AND CANNOT PROMISE HERE.
--
-- It CANNOT assert precedence. Precedence is not in this database — it is in
-- `pricingPathFor`, and the place it is proved is src/lib/park-precedence.test.ts
-- ("the park's rate wins even when the service is crew_priced" / "a park with
-- no rate on a crew-priced service takes the crew's card"). A post-condition
-- here that seemed to check it would be the worst shape this codebase has: a
-- rule whose code, comment and test all agree and none of which enforces
-- anything.
--
-- What it CAN promise is that the fence is gone, that dropping it moved no
-- money, and that the one number the whole safety argument rests on is still
-- on file. That is what follows.

do $$
declare
  n     int;
  base_ numeric;
  unit_ numeric;
begin
  -- (a) THE CONSTRAINT IS ACTUALLY GONE. `drop ... if exists` succeeds whether
  --     or not it was there, so the statement above is not evidence.
  if exists (select 1 from pg_constraint
              where conname = 'services_park_is_never_crew_priced') then
    raise exception '0176: the CHECK is still on services — a park still cannot book a crew-priced service';
  end if;

  -- (b) NOTHING WAS SWITCHED ON. Dropping a constraint must not be the same
  --     commit as changing data it used to refuse; if a row is already
  --     park_only AND crew_priced, somebody flipped a service and this
  --     migration is carrying a pricing decision it was told not to make.
  select count(*) into n from public.services where park_only and crew_priced;
  if n > 0 then
    raise exception '0176: % service(s) are already park_only AND crew_priced — this migration only opens the door, it does not walk through it', n;
  end if;

  -- (c) THE MOW STILL HAS ITS NUMBER, which is the entire safety argument for
  --     (a). The mow is protected by HAVING a park rate, so if this row were
  --     missing the argument would be void and January would be exposed.
  --     Asserted against the seeded inputs (base 20, unit 5), never against a
  --     total this block computed for itself.
  -- SCOPED TO THE PARK, not `limit 1` over every park that ever prices a mow.
  -- Today `park_service_rates` holds exactly one row, so an unscoped lookup
  -- happens to be right — and the day a second park sets a mow rate it would
  -- assert The Haven's numbers against an arbitrary park's row and either
  -- false-alarm or false-pass. The count is checked first for the same reason:
  -- `into` takes one row silently whatever the query matched.
  select count(*) into n
    from public.park_service_rates r
    join public.services s on s.id = r.service_id
    join public.parks p on p.id = r.park_id
   where s.name = 'Park grounds mowing & trim'
     and p.name = 'The Haven';
  if n <> 1 then
    raise exception '0176: The Haven holds % rate row(s) for the grounds mow, not 1 — the number January rests on is not where this migration can see it', n;
  end if;

  select r.base, r.unit_rate into base_, unit_
    from public.park_service_rates r
    join public.services s on s.id = r.service_id
    join public.parks p on p.id = r.park_id
   where s.name = 'Park grounds mowing & trim'
     and p.name = 'The Haven';

  if base_ is null then
    -- A FAILED/EMPTY LOOKUP IS NOT A PASS. Without this the `if` below reads
    -- NULL, is not true, and the migration announces the mow is safe when the
    -- row it rests on is not there.
    raise exception '0176: no park rate on file for the grounds mow — precedence has nothing to prefer, and the mow would fall to whatever prices it next';
  end if;
  if base_ <> 20 or unit_ <> 5 then
    raise exception '0176: the grounds mow rate reads base % / unit % — it was base 20 / unit 5 (Mike''s $100 a cut through the 0.20 floor). Something moved it; do not ship this until it is explained', base_, unit_;
  end if;

  raise notice '0176: the fence is gone, nothing was flipped, and the park rate the mow depends on is still base 20 / unit 5. Precedence is enforced in src/lib/park-rates.ts and tested in src/lib/park-precedence.test.ts.';
end $$;
