-- 0116 — THREE PERCENT IS THE REAL CEILING, AND FOUR WAS MY NUMBER
--
-- 0109 defaulted `parks.card_fee_pct` to 4.00 and capped it at 4, reasoning that
-- Mastercard allows 4 and Visa allows 3. That is true of the networks and false
-- of the world: a park does not get to know which network a resident's card
-- rides before the charge, so the only rate that is safe on every card is the
-- LOWEST cap. 4.00 was Brendon's stated preference for The Haven, and I let a
-- preference become the product's default for every park that will ever sign up.
--
-- See the standing rule: nothing learned from The Haven may be baked in as a
-- default a new owner cannot see or edit. This migration fixes the number; the
-- code in this same commit gives every owner the editor, because a dial with no
-- editor is the dial's default, forever.
--
-- WHAT THIS DOES
--   * ceiling 4 -> 3, so an unsafe rate cannot be stored at all
--   * default 4.00 -> 3.00, so a new park starts legal
--   * pulls existing rows above 3 down to 3.00 — required before the CHECK can
--     be added, and the right direction to move: we would rather undercharge
--     the rail than surcharge a Visa above its cap.
--
-- DELIBERATELY NOT DONE: zeroing the fee. Zero would read as "this park has
-- decided not to surcharge", which is a real and different choice, and not one
-- I get to make for anybody. 3.00 is the safe setting 0109's own comment named.
--
-- STILL BLOCKED, and this migration does not pretend otherwise: surcharging a
-- DEBIT card is forbidden at any rate, `payment_methods` records a brand but not
-- a funding type, and network registration is ~30 days of paperwork. The
-- processor questions are in docs/processor-questions.md. What this changes is
-- that the number is no longer wrong before we start.

-- Existing rows first — the CHECK below would refuse to attach otherwise.
update public.parks set card_fee_pct = 3.00 where card_fee_pct > 3;

alter table public.parks alter column card_fee_pct set default 3.00;

alter table public.parks drop constraint if exists parks_card_fee_is_within_network_rules;
alter table public.parks add constraint parks_card_fee_is_within_network_rules
  check (card_fee_pct >= 0 and card_fee_pct <= 3);

comment on column public.parks.card_fee_pct is
  'Percent added when a resident pays rent by CARD. Never applied to ACH, and '
  'never to rent itself — it is a cost-of-rail charge, not the park''s money. '
  'Capped at 3: Visa''s surcharge ceiling is 3%% and we cannot know which '
  'network a card rides before charging it, so the lowest cap is the only safe '
  'one. Editable per park on /park/setup. Debit cards may never be surcharged '
  'at all, which is why accepts_online_rent stays off until the processor can '
  'tell us a card''s funding type.';

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; ok boolean; got numeric;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    -- 1. A NEW PARK STARTS AT THE SAFE RATE, not at The Haven's preference.
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0116 Proof','1 Rd','0116-proof', lid,'mh', false) returning id into pid;

    select card_fee_pct into got from public.parks where id = pid;
    if got <> 3.00 then
      raise exception '0116: a new park defaulted to %, expected 3.00', got;
    end if;

    -- 2. FOUR PERCENT IS NOW REFUSED BY THE DATABASE, not just by a screen.
    ok := false;
    begin
      update public.parks set card_fee_pct = 4.00 where id = pid;
    exception when check_violation then ok := true;
    end;
    if not ok then
      raise exception '0116: 4%% was accepted; the ceiling did not move';
    end if;

    -- 3. THREE IS ALLOWED, and so is zero — a park may decline to surcharge.
    update public.parks set card_fee_pct = 3.00 where id = pid;
    update public.parks set card_fee_pct = 0 where id = pid;

    -- 4. NO PARK IS LEFT ABOVE THE CEILING. If this fires, the backfill above
    --    missed a row and every card payment on it would breach Visa's cap.
    if exists (select 1 from public.parks where card_fee_pct > 3) then
      raise exception '0116: a park is still above 3%%';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
