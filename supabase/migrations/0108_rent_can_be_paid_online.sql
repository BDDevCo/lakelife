-- 0108 — RENT CAN BE PAID ONLINE, AND IT IS STILL THE PARK'S MONEY.
--
-- A resident could see what they owed and had no way to pay it. The office
-- window and a cheque in the mail were the whole payment surface, on a product
-- whose customers already pay for services with a saved card.
--
-- ============ TWO LEDGERS, AND THIS DOES NOT JOIN THEM ============
--
-- A service booking is money owed to LAKELIFE: we are the merchant, we pay the
-- crew, we keep the margin. RENT IS THE PARK'S MONEY and LakeLife only moves
-- it. This migration adds no FK between park_payments and invoices/jobs, and
-- no path by which a service debt could be settled from rent or the reverse.
-- 0052's prohibition stands untouched.
--
-- It follows that a late rent bill may NEVER hold back a service, and a
-- service debt may never hold back a rent receipt. A platform that withheld a
-- mow over arrears would have become a debt collector with nobody deciding it.
--
-- ============ WHY THE RAIL MATTERS, IN DOLLARS ============
--
-- The Haven is ~$5,200 a month. On card rates that is roughly $155/month —
-- about $1,860 a year — to move money that ACH moves for about $19. Rent is
-- large and recurring and belongs on ACH; cards suit the small impulsive
-- service purchase. `method` already allows both (0102), so the rail is a
-- processor decision and not a schema one. Nothing here forces the expensive
-- choice.
--
-- ============ NOT A CREDIT FILE ============
--
-- No score, no reliability rating, no payment-history grade — not now and not
-- as a later column. A rating about a housing tenant is a consumer report, and
-- LakeLife is a facilitator, never a consumer reporting agency.

-- ----------------------------------------------- 1. the park's own switch --
alter table public.parks
  add column if not exists accepts_online_rent boolean not null default false;

comment on column public.parks.accepts_online_rent is
  'Whether residents may pay rent through LakeLife. Default FALSE: taking a '
  'household''s rent is the park owner''s decision and his money, so it is '
  'opt-in per park. Read by the resident portal — the pay button does not '
  'render without it, so a resident is never offered a payment the park has '
  'not agreed to accept.';

-- ------------------------------- 2. an online payment must carry its proof --
-- Cash and cheques are recorded by a person who was there; card and ACH are
-- recorded by a machine, and a machine-recorded payment with no processor
-- reference is a row nobody can trace, reconcile or refund. The nightly
-- reconciler and the CPA statement both work from this.
alter table public.park_payments
  drop constraint if exists park_payments_online_has_a_reference;
alter table public.park_payments
  add constraint park_payments_online_has_a_reference
  check (
    method not in ('card', 'ach')
    or coalesce(btrim(reference), '') <> ''
  );

-- ------------------------------------------------------ post-conditions ----
do $$
declare lid uuid; pid uuid; lot uuid; ren uuid; res uuid; ch uuid;
        ok boolean; n int; paid numeric;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0108 Proof','1 Rd','0108-proof', lid,'mh', false) returning id into pid;

    -- 1. ONLINE RENT IS OFF UNTIL THE OWNER TURNS IT ON.
    if (select accepts_online_rent from public.parks where id = pid) then
      raise exception '0108: a new park accepts online rent by default';
    end if;

    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'7', true,'live') returning id into lot;
    insert into public.park_renters (park_id, display_name)
    values (pid,'0108 Household') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status, quoted_amount)
    values (lot, ren, daterange('2026-01-01','2027-01-01','[)'),'monthly','active', 500)
    returning id into res;
    insert into public.park_charges
      (park_id, park_lot_id, reservation_id, renter_id, period_month, due_on, amount, lines)
    values (pid, lot, res, ren,'2026-08', date '2026-08-01', 500,'[]'::jsonb)
    returning id into ch;

    -- 2. A CARD PAYMENT WITH NO PROCESSOR REFERENCE IS REFUSED.
    ok := false;
    begin
      insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on)
      values (pid, ren, ch, 500, 'card', current_date);
    exception when check_violation then ok := true;
    end;
    if not ok then
      raise exception '0108: an online payment was recorded with nothing to trace it by';
    end if;

    -- 3. WITH ONE, IT LANDS — AND THE BILL SETTLES THROUGH THE EXISTING
    --    TRIGGER, exactly as a cheque does. Online is a METHOD, not a
    --    parallel money path.
    insert into public.park_payments
      (park_id, renter_id, charge_id, amount, method, received_on, reference)
    values (pid, ren, ch, 500, 'card', current_date, 'mock_ref_0108');

    select paid_total into paid from public.park_charges where id = ch;
    if paid is distinct from 500 then
      raise exception '0108: an online payment did not settle the bill (paid_total=%)', paid;
    end if;

    -- 4. CASH AND CHEQUES ARE UNAFFECTED — they are recorded by a person who
    --    was standing there, and demanding a reference would break the window.
    insert into public.park_payments (park_id, renter_id, amount, method, received_on)
    values (pid, ren, 25, 'cash', current_date);

    -- 5. NO SCORE COLUMN EXISTS, AND THIS FILE ADDS NONE.
    select count(*) into n from information_schema.columns
     where table_schema='public'
       and table_name in ('park_renters','lot_reservations','park_payments')
       and (column_name like '%score%' or column_name like '%reliab%' or column_name like '%rating%');
    if n > 0 then
      raise exception '0108: something is scoring residents — LakeLife is not a consumer reporting agency';
    end if;

    -- 6. THE TWO LEDGERS ARE STILL UNJOINED.
    select count(*) into n
      from information_schema.columns
     where table_schema='public' and table_name='park_payments'
       and column_name in ('invoice_id','job_id');
    if n > 0 then
      raise exception '0108: rent and service money now share a column';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
