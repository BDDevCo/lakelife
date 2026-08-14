-- 0113 — A MOW IS A HUNDRED DOLLARS, NOT SIX.
--
-- 0107 seeded "Park grounds mowing & trim" at base 140 + $22/lot = $602 for a
-- 21-lot park. I made that number up, then later "validated" it by dividing
-- The Haven's 2023 cleaning-and-maintenance line ($17,109) by a season's cuts
-- to get $611-658 a visit. That was the same invented number arrived at twice:
-- the 2023 line is not mowing.
--
-- The seller's own 2024 sheet relabels it by hand — line 7 struck from
-- "Cleaning and maintenance" to "Groundskeeping", $2,377 — and Brendon
-- confirms the contract: "$100 to mow once a week." $2,377 over 24 cuts is $99.
--
-- base 16 + $4/lot = $100.00 at 21 lots, and still scales: $176 at 40.
--
-- WHAT THE 2023 LINE ACTUALLY WAS is the open question, and it is worth more
-- than this price. The same sheet annotates line 17 "Sewer / Electric" at
-- $17,198 — the LaGrange County grinder pump — which is 82% of the park's
-- shared operating cost. Grounds is 11%. The dominant cost of running The
-- Haven is sewer, not the lawn, and that also moves the utility sub-billing
-- question (170 IAC 15) onto the biggest line rather than a rounding item.

update public.services
   set base = 16, unit_rate = 4
 where name = 'Park grounds mowing & trim';

-- The two common-area cleanups are STILL INVENTED ($632 and $592 at 21 lots),
-- and next to a $100 mow they are now conspicuously out of proportion. Left
-- alone deliberately rather than guessed at a second time: a quote replaces
-- them, not another inference.

do $$
declare n int; mow numeric;
begin
  select base + unit_rate * 21 into mow
    from public.services where name = 'Park grounds mowing & trim';
  if mow is distinct from 100 then
    raise exception '0113: the grounds mow is % at 21 lots, not the $100 he actually pays', mow;
  end if;

  -- It must still scale with the park. A flat rate would charge a 40-lot park
  -- the same as this one, which is the error the per_section model exists to
  -- avoid.
  select count(*) into n from public.services
   where name = 'Park grounds mowing & trim' and unit_rate <= 0;
  if n > 0 then
    raise exception '0113: the mow stopped scaling with the lot count';
  end if;
end $$;
