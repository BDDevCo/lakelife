-- ============================================================================
-- 0172 — TAX AND INSURANCE BELONG IN THE POOL.
--
-- Brendon, 22 September 2026, in as many words: "tax and insurance belong in
-- the pool." The pool is the recurring fee. A park charges one flat amount per
-- lot to recover what running the park costs, and the property tax on the
-- parcels under it and the premium on the policy over it are shared costs in
-- exactly the way the sewer bill is shared. He was not asking for a feature.
-- He was pointing out that the product refused to let him say something true.
--
-- WHAT WAS WRONG. Four lists describe what a park spends money on, and by
-- today they disagreed about two words:
--
--   park_costs.category (0144)        tax ✓  insurance ✓   — a bill can be filed
--   park_cost_schedules (0144)        tax ✓  insurance ✓   — a reminder can be set
--   SCHEDULABLE_CATEGORIES, the       tax ✓  insurance ✓   — and the costs screen
--     costs dropdown, the labels                             offers both by name
--   park_fees.covers, THIS CHECK      tax ✗  insurance ✗   — and a fee could not
--                                                             claim either
--
-- So a park could record the tax bill, be reminded of the tax bill, and never
-- say the fee it charges is what pays it. `checkCoverage` names every recorded
-- cost no active fee claims, which means the month he filed the premium it was
-- GUARANTEED to appear under "you pay for this and no fee covers it — is that
-- deliberate, or a gap?" — about a gap this constraint had made, under a
-- question he had no way to answer. The card printed the bare word `tax` in
-- that sentence for a while too, a column name in an English line, because the
-- label map had no entry for something no fee was ever supposed to claim.
--
-- WHAT THE RULE IS NOW. A fee may claim any cost the park SPREADS across its
-- lots. That is the whole rule, and it already has a name on the code side:
-- `canSplit`, which refuses exactly one category — `unit_electric`, the power
-- bill for a home the park itself owns and rents out. Brendon settled that one
-- in August: "electrical is seperately metered and will be billed directly to
-- renter (park take the STR bills directly but not allocated to rest of the
-- renters)." One building's cost belongs against that building's income; a fee
-- is spread over every lot. Those two can never meet, and this CHECK still
-- refuses the word, as it always has.
--
-- The three words that are not cost categories at all — maintenance, pest,
-- amenities — stay. They are things a fee may promise that no bill is filed
-- against; they show up as "claimed but unverified" and that is correct.
--
-- WHAT THIS DOES NOT DO. It does not tick a box. Which costs a fee covers is
-- the owner's decision on his own screen, fee by fee: this widens the door and
-- changes nobody's list. The post-conditions below prove that, because a
-- migration that quietly enrolled every existing fee in two new categories
-- would change what `recordCost` does with the next tax bill — a covered
-- category is absorbed whole into the park and never split across the lots.
-- ============================================================================

-- ------------------------------------------------ the vocabulary, widened --
--
-- Ten words become twelve. The order is the costs screen's own reading order
-- — the splittable categories as the label map declares them, then the three
-- promises that are not categories.
alter table public.park_fees drop constraint if exists park_fees_covers_known;
alter table public.park_fees add constraint park_fees_covers_known check (
  covers <@ array[
    'water', 'sewer', 'trash', 'common_electric', 'grounds', 'snow',
    'tax', 'insurance', 'other',
    'maintenance', 'pest', 'amenities'
  ]::text[]
);

comment on table public.park_fees is
  'A recurring charge on top of rent. `covers` uses park_costs.category '
  'vocabulary so what the fee CLAIMS to cover can be reconciled against what '
  'the park actually paid. Any cost the park SPREADS may be claimed, including '
  'property tax and insurance (0172); unit_electric may not, because power for '
  'a home the park owns is never split across the lots.';


-- ---------------------------------------------------------------- grants ---
--
-- Unchanged from 0067 and restated rather than assumed. A CHECK is not a
-- permission: the rule that keeps a browser out of this table is the REVOKE,
-- and the house lesson is that it has to be said per table rather than left to
-- a default. The only writer is `saveFee` through the service role.
revoke all on public.park_fees from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.park_fees from authenticated;
grant select on public.park_fees to authenticated;


-- ------------------------------------------------------ post-conditions ----
--
-- SHIP-TIME ASSERTIONS. They run once, against a park invented here and thrown
-- away; everything inside rolls back and nothing survives to be cleaned up.
do $$
declare
  lid uuid; pid uuid; ok boolean; drifted int;
begin
  if not exists (select 1 from pg_constraint where conname = 'park_fees_covers_known') then
    raise exception '0172: a fee could claim to cover something nothing can reconcile';
  end if;

  -- (a) NOBODY'S LIST CHANGED. The widening is a door, not a decision, and
  --     this proves it without needing a snapshot to compare against. A few
  --     statements ago the CHECK above refused 'tax' and 'insurance', so no
  --     row in this table CAN be holding either word unless this file put it
  --     there. Asserting that every fee still claims only the old ten words
  --     is therefore exactly the assertion "this migration enrolled nobody",
  --     and it catches a hand that slipped an UPDATE in here as well.
  --
  --     It matters more than it looks. A covered category changes what
  --     `recordCost` DOES with the next bill in it: a hit is absorbed whole
  --     into the park, marked fee_covered, and never split across the lots.
  --     Ticking a box is a money decision, and it is his.
  select count(*) into drifted
    from public.park_fees
   where not (covers <@ array[
     'water', 'sewer', 'trash', 'common_electric', 'grounds',
     'maintenance', 'snow', 'pest', 'amenities', 'other'
   ]::text[]);
  if drifted > 0 then
    raise exception '0172: % existing fee row(s) gained coverage nobody ticked', drifted;
  end if;

  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0172: no lake to hang a fixture on — the rest of the post-conditions are skipped';
    return;
  end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0172 Proof', '1 Rd', '0172-proof', lid, 'mh', false)
    returning id into pid;
    -- `active` false and rolled back either way: nothing here can reach a
    -- public surface even for the length of this transaction.

    -- (b) THE ASK, IN ONE STATEMENT. A fee may now claim the property tax and
    --     the insurance premium alongside the bills it always could.
    insert into public.park_fees (park_id, label, amount, covers)
    values (pid, 'Grounds fee', 100.00,
            array['water','sewer','trash','common_electric','grounds','snow',
                  'tax','insurance','other']::text[]);
    if not exists (
      select 1 from public.park_fees
       where park_id = pid and covers @> array['tax','insurance']::text[]
    ) then
      raise exception '0172: a fee still cannot claim tax and insurance';
    end if;

    -- (c) AND THE DOOR IS STILL A DOOR. A word nothing can be reconciled
    --     against is refused, which is the reason this CHECK exists at all —
    --     a fee covering "utilities and stuff" could never be checked against
    --     a bill.
    ok := false;
    begin
      insert into public.park_fees (park_id, label, amount, covers)
      values (pid, 'Vague fee', 10.00, array['utilities_and_stuff']::text[]);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0172: the allowlist stopped refusing nonsense'; end if;

    -- (d) UNIT_ELECTRIC IS STILL REFUSED, and this is the assertion most
    --     likely to be lost by a future widening done in a hurry. Power for a
    --     home the park owns is metered to that home and set against its own
    --     income. A fee is spread across every lot, so claiming it would move
    --     five park-owned homes' power bills onto nineteen households —
    --     several times larger than the vacancy question and pointing the
    --     wrong way. `canSplit` says the same thing in TypeScript.
    ok := false;
    begin
      insert into public.park_fees (park_id, label, amount, covers)
      values (pid, 'Everything fee', 10.00, array['unit_electric']::text[]);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0172: a fee could claim a park-owned home''s power'; end if;

    -- (e) THE THREE PROMISES THAT ARE NOT COST CATEGORIES SURVIVED. They were
    --     in the list before today and dropping one while adding two would be
    --     a silent narrowing.
    insert into public.park_fees (park_id, label, amount, covers)
    values (pid, 'Amenity fee', 10.00,
            array['maintenance','pest','amenities']::text[]);

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  raise notice '0172: a fee may claim the tax and the premium, and still not a park-owned home''s power.';
end $$;
