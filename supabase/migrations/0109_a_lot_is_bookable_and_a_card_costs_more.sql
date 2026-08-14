-- 0109 — A LOT BECOMES BOOKABLE, AND A CARD COSTS MORE THAN A BANK TRANSFER.
--
-- Two things the resident portal promised and could not do: book a crew, and
-- pay rent by the rail that does not cost 4% of the rent.
--
-- ================== THE FEE, AND THE CEILING ON IT ==================
--
-- Brendon: "ACH is preferred but there will be a 4% convenience fee added if
-- renter wants to use CC."
--
-- IT IS A DIAL, NOT A CONSTANT, and the reason is compliance rather than
-- taste. Visa caps a card surcharge at 3% (reduced from 4% in 2023);
-- Mastercard allows 4%. A blanket 4% is over Visa's ceiling and puts card
-- acceptance at risk, so the column defaults to the number asked for and can
-- be dropped to 3 with one update rather than a deploy.
--
-- TWO THINGS THIS MIGRATION CANNOT ENFORCE, recorded so they are not
-- discovered later:
--   * SURCHARGING A DEBIT CARD IS PROHIBITED by network rules at any rate, in
--     every state. `payment_methods` records a brand but not a funding type,
--     so the processor has to tell us debit-or-credit before the fee is safe
--     to apply. Until it does, this must not be switched on.
--   * Surcharging requires registering with the card networks roughly 30 days
--     in advance, and disclosing the fee at the point of sale and on the
--     receipt. The screen does the disclosing; the registration is paperwork.
--
-- THE FEE IS NOT RENT. It never counts toward what the household owes, it
-- never touches paid_total, and it is not the park's money — it exists to
-- cover the cost of an expensive rail. Hence its own column rather than a
-- larger `amount`, which would silently overstate every rent receipt.

alter table public.parks
  add column if not exists card_fee_pct numeric(4,2) not null default 4.00;

alter table public.parks drop constraint if exists parks_card_fee_is_within_network_rules;
alter table public.parks add constraint parks_card_fee_is_within_network_rules
  check (card_fee_pct >= 0 and card_fee_pct <= 4);

comment on column public.parks.card_fee_pct is
  'Percent added when a resident pays rent by CARD. Never applied to ACH, and '
  'never to rent itself — it is a cost-of-rail charge, not the park''s money. '
  'Visa caps a surcharge at 3%% and Mastercard at 4%%; this column stops at 4 '
  'and 3 is the safe setting. Debit cards may never be surcharged at all.';

-- WHAT THE RESIDENT PAID ON TOP. Separate from `amount` so paid_total, the
-- receipt, the CPA statement and the arrears maths all keep meaning exactly
-- what they meant before online payments existed.
alter table public.park_payments
  add column if not exists fee_amount numeric(10,2);

alter table public.park_payments drop constraint if exists park_payments_fee_is_sane;
alter table public.park_payments add constraint park_payments_fee_is_sane
  check (
    fee_amount is null
    or (fee_amount > 0 and method = 'card')
  );

comment on column public.park_payments.fee_amount is
  'The card convenience fee charged ON TOP of `amount`, or NULL. Card only: a '
  'bank transfer costs cents and is not surcharged. NEVER part of amount, so '
  'it can never be mistaken for rent received.';

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; lot uuid; ren uuid; res uuid; ch uuid;
        ok boolean; paid numeric;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0109 Proof','1 Rd','0109-proof', lid,'mh', false) returning id into pid;

    -- 1. THE FEE CANNOT EXCEED THE NETWORK CEILING.
    ok := false;
    begin
      update public.parks set card_fee_pct = 7.5 where id = pid;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0109: a park set a surcharge above what any card network allows'; end if;

    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'7', true,'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid,'0109 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange('2026-01-01','2027-01-01','[)'),'monthly','active', 500)
    returning id into res;
    insert into public.park_charges
      (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, lines)
    values (pid, lot, res, ren,'2026-08', date '2026-08-01', 500,'[]'::jsonb)
    returning id into ch;

    -- 2. A BANK TRANSFER IS NEVER SURCHARGED.
    ok := false;
    begin
      insert into public.park_payments
        (park_id, renter_id, charge_id, amount, method, received_on, reference, fee_amount)
      values (pid, ren, ch, 500, 'ach', current_date, 'ach_ref', 20);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0109: an ACH payment was surcharged'; end if;

    -- 3. THE FEE IS NOT RENT. A card payment of 500 with a 20 fee settles the
    --    bill for FIVE HUNDRED — the household owes the rent, not the rail.
    insert into public.park_payments
      (park_id, renter_id, charge_id, amount, method, received_on, reference, fee_amount)
    values (pid, ren, ch, 500, 'card', current_date, 'card_ref_0109', 20);

    select paid_total into paid from public.park_charges where id = ch;
    if paid is distinct from 500 then
      raise exception '0109: the convenience fee leaked into rent received (paid_total=%)', paid;
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
