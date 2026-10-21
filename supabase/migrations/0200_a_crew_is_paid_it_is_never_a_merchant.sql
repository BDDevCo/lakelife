-- ===========================================================================
-- 0200  A CREW IS PAID. IT IS NEVER A MERCHANT.
-- ===========================================================================
--
-- Brendon, 20 October 2026:
--
--   "I dont want a crew to have to register for an additional merchant
--    account, it needs to be seemless and have to not credit check or
--    whatever that a typical merchant account needs"
--
-- This REVERSES half of Architecture A as it was written on 14 Oct. That
-- document said "each park owner and each crew is a merchant in their own
-- right". The park-owner half stands and is why 0196 exists: a park owner
-- ACCEPTS rent, so the park owner must be a merchant. The crew half was wrong,
-- and this migration is the half of the correction that a database can hold.
--
-- ---------------------------------------------------------------------------
-- WHY THE OWNER IS RIGHT, STATED SO NOBODY RE-ARGUES IT
-- ---------------------------------------------------------------------------
-- Two different things get called "onboarding" and only one of them is heavy:
--
--   A MERCHANT accepts payments from customers. The processor advances money
--   before settlement and absorbs the chargebacks, so it is carrying CREDIT
--   RISK. That is what buys you the credit pull, the underwriting
--   questionnaire, the processing-history questions, the merchant agreement,
--   the possibility of a reserve, and the days of waiting.
--
--   A PAYOUT RECIPIENT only RECEIVES. There is no chargeback to absorb and no
--   money advanced, so there is no credit risk and therefore no credit check.
--   What remains is identity and sanctions screening, which is law, takes
--   seconds, and is not a credit-bureau inquiry.
--
-- A LakeLife crew NEVER accepts a payment. The homeowner buys from LakeLife at
-- one all-in price; the crew is LakeLife's subcontractor, paid about 70%, and
-- never sees what the customer paid (hard rule 1 in CLAUDE.md). The crew's
-- share is accounts payable out of LakeLife's own revenue. A contractor does
-- not get a merchant account, and asking one to pass underwriting to receive a
-- cheque is asking for the wrong thing entirely.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS TRUE BEFORE THIS FILE — PROVEN ON PRODUCTION, 20 OCT 2026
-- ---------------------------------------------------------------------------
-- Run inside a DO block that rolled back:
--
--   existing vendor rows in processor_accounts : 0
--   existing park rows in processor_accounts   : 0
--   DRAFT crew row, can_accept_card = true     : ACCEPTED
--   ACTIVE crew merchant, card+ach, payouts OFF: ACCEPTED
--
-- So the registry would have recorded a crew as a fully live card- and
-- ACH-accepting merchant with payouts switched off — the precise thing the
-- owner has just forbidden — and nothing would have objected. Not because
-- anybody intended it: because 0196 wrote one table for two kinds of recipient
-- and gave both the same capabilities.
--
-- ZERO ROWS, SO THERE IS NOTHING TO BACKFILL. This closes before the first
-- merchant exists, which is the only cheap moment it was ever going to have.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------
-- It does not gate a payout on `can_receive_payout`. That read belongs in
-- `runMonthlyPayoutBatches` and `requestEarlyPayout` — and it would be a gate
-- that can never open, because NO APPLICATION CODE WRITES A VENDOR ROW HERE AT
-- ALL. Every door in `src/app/parks/processor-actions.ts` is park-scoped:
-- `assertParkOwner(parkId)`, `.insert({ park_id: parkId, provider })`, and a
-- queue that selects `park_id, parks(name)`. `vendor_id` is this repo's own
-- dominant bug class in the very table that was built to end it — a column
-- with no writer — and `can_receive_payout` has no reader that decides
-- anything.
--
-- That is not fixed here on purpose. A crew recipient row can only be written
-- once we know what the processor's recipient API is called and what it
-- accepts, and that is one of the questions going to them. Writing the gate
-- now would add a branch no row can reach, and writing the door now would
-- invent a contract that does not exist. What CAN be true today is the shape
-- of the row, so that whoever builds that door cannot build the wrong thing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- THE GUARANTEE
-- ---------------------------------------------------------------------------
-- `is false` rather than `= false`: the columns are NOT NULL today, and if a
-- later migration ever drops that, `is false` REFUSES a null where `= false`
-- would have evaluated to null and let the row through. This repo has already
-- paid for that lesson once — a CHECK passes on NULL, and only a NULL probe
-- ever detects it.
alter table public.processor_accounts
  drop constraint if exists processor_accounts_a_crew_only_receives;
alter table public.processor_accounts
  add constraint processor_accounts_a_crew_only_receives
  check (
    vendor_id is null
    or (can_accept_ach is false and can_accept_card is false)
  );

-- A park owner is UNTOUCHED by the above and must stay untouched: a park row
-- accepting card and ACH is the whole of Flow B. The post-conditions below
-- prove that, because a constraint that quietly broke rent to protect crews
-- would be a worse bug than the one it fixed.

-- ---------------------------------------------------------------------------
-- AND THE SENTENCE A HUMAN READS
-- ---------------------------------------------------------------------------
-- The CHECK is the guarantee — it cannot be switched off without DDL. But a
-- CHECK violation surfaces as a constraint name, and whoever trips this will be
-- a developer wiring up the crew recipient door months from now, who needs to
-- know this was a decision and not an oversight. So the trigger says it in
-- words and the CHECK makes it true.
--
-- COPIED FROM THE LIVE DEFINITION read off production with
-- `pg_get_functiondef`, not reconstructed from 0196. One clause is added and
-- nothing else is altered: every recipient-immutability check, every
-- forward-only status check, every stamp check and the whole active-shape block
-- below are byte-for-byte what was running. The post-conditions re-prove the
-- ones that matter, because a rewrite from memory is how a documented race
-- guard gets silently dropped.
create or replace function public.guard_processor_account()
returns trigger language plpgsql as $$
begin
  -- A CREW IS PAID, NEVER PAID TO. First, because it is the most fundamental
  -- thing about the row: there is no point telling somebody their activated_at
  -- is missing on a row that should not exist in any state.
  if new.vendor_id is not null and (new.can_accept_ach is not false or new.can_accept_card is not false) then
    raise exception 'processor_accounts: a crew receives money, it never accepts it — a crew is paid as a contractor and is not a merchant, so it is never credit-checked or underwritten. If a crew genuinely needs to take payments, that is a product decision and a new migration, not a capability flag';
  end if;

  if tg_op = 'UPDATE' then
    if new.park_id is distinct from old.park_id
       or new.vendor_id is distinct from old.vendor_id
       or new.provider is distinct from old.provider then
      raise exception 'processor_accounts: an account belongs to the recipient it was opened for — disable it and open another';
    end if;

    if old.provider_merchant_id is not null
       and new.provider_merchant_id is distinct from old.provider_merchant_id then
      raise exception 'processor_accounts: that merchant id was assigned by the processor and cannot be changed';
    end if;

    if old.status = 'active' and new.status in ('draft', 'submitted') then
      raise exception 'processor_accounts: that merchant is already live — disable the account rather than reopening it';
    end if;
    if old.status in ('disabled', 'rejected') and new.status not in ('disabled', 'rejected') then
      raise exception 'processor_accounts: that account is closed — open a new one instead of reviving it';
    end if;

    if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
      raise exception 'processor_accounts: submitted_at records when it was sent';
    end if;
    if old.activated_at is not null and new.activated_at is distinct from old.activated_at then
      raise exception 'processor_accounts: activated_at records when it went live';
    end if;
  end if;

  if new.status = 'active' then
    if new.provider_merchant_id is null then
      raise exception 'processor_accounts: an active merchant needs the id the processor gave it';
    end if;
    if new.activated_at is null then
      raise exception 'processor_accounts: an active merchant needs the day it went live';
    end if;
    if new.settlement_last4 is null then
      raise exception 'processor_accounts: an active merchant needs the account its money settles to';
    end if;
  end if;

  return new;
end $$;

-- CREATE OR REPLACE retains the existing ACL, so 0196's revoke still holds on
-- production. Re-issued anyway so this file is correct replayed onto a fresh
-- database, where nothing has revoked it yet.
revoke all on function public.guard_processor_account() from public, anon, authenticated;

comment on table public.processor_accounts is
  'Who a payment settles to. One live account per recipient per provider. Holds NO bank account or routing numbers - the processor holds those under Architecture A - only four digits for display. Capabilities default false and are the processor''s answer, never a local wish. A PARK row may accept card and ACH, because a park owner accepts rent. A VENDOR row may only RECEIVE (0200): a crew is LakeLife''s subcontractor, paid as accounts payable, and is never a merchant, never underwritten and never credit-checked.';

-- ===========================================================================
-- POST-CONDITIONS — these FAIL the migration rather than report
-- ===========================================================================
do $$
declare
  v_id uuid;
  p_id uuid;
  crew_card_refused   boolean := false;
  crew_ach_refused    boolean := false;
  crew_active_refused boolean := false;
  crew_payout_ok      boolean := false;
  park_card_ok        boolean := false;
  park_active_ok      boolean := false;
  msg text;
begin
  select id into v_id from public.vendors limit 1;
  select id into p_id from public.parks   limit 1;
  if v_id is null or p_id is null then
    raise exception '0200 post-condition: no vendor or no park to probe with — the guard is unproven, which is the same as absent';
  end if;

  -- 1. THE THING THAT WAS ACCEPTED BEFORE THIS FILE IS NOW REFUSED.
  begin
    insert into public.processor_accounts (provider, vendor_id, status, can_accept_card)
    values ('post', v_id, 'draft', true);
  exception when others then
    crew_card_refused := true;
    msg := sqlerrm;
  end;
  if not crew_card_refused then
    raise exception '0200 FAILED: a crew row claiming it accepts cards was still accepted';
  end if;
  if msg not like '%receives money, it never accepts it%' then
    raise exception '0200 FAILED: refused, but with the wrong sentence — a developer tripping this learns nothing. Got: %', msg;
  end if;

  -- 2. ACH TOO. Separate probe, because one clause covering both is exactly
  --    the shape where a mutation to the second half goes unnoticed.
  begin
    insert into public.processor_accounts (provider, vendor_id, status, can_accept_ach)
    values ('post2', v_id, 'draft', true);
  exception when others then crew_ach_refused := true; msg := sqlerrm;
  end;
  if not crew_ach_refused then
    raise exception '0200 FAILED: a crew row claiming it accepts ACH was still accepted';
  end if;
  -- REFUSED FOR THE RIGHT REASON. `when others` catches a foreign-key
  -- violation and a typo too, and an assertion that passes for the wrong
  -- reason proves nothing about the clause it was written for.
  if msg not like '%receives money, it never accepts it%' then
    raise exception '0200 FAILED: the ACH probe was refused by something OTHER than the crew guard. Got: %', msg;
  end if;

  -- 3. AND THE FULLY LIVE VERSION, which is the one that would actually have
  --    taken somebody's money.
  begin
    insert into public.processor_accounts
      (provider, vendor_id, status, can_accept_ach, can_accept_card, can_receive_payout,
       provider_merchant_id, submitted_at, activated_at, settlement_last4)
    values ('post3', v_id, 'active', true, true, false, 'M', now(), now(), '4471');
  exception when others then crew_active_refused := true; msg := sqlerrm;
  end;
  if not crew_active_refused then
    raise exception '0200 FAILED: a crew could still be switched on as a live card-accepting merchant';
  end if;
  -- And by the CREW clause, not by the active-shape checks further down the
  -- trigger. This row carries a merchant id, both stamps and a last4
  -- precisely so that the only thing left to object to is what it claims to
  -- be able to DO.
  if msg not like '%receives money, it never accepts it%' then
    raise exception '0200 FAILED: the live-merchant probe was refused for the wrong reason. Got: %', msg;
  end if;

  -- 4. BUT A CREW CAN STILL BE PAID. If this fails, 0200 has closed the one
  --    door the decision exists to keep open, and crews can never be set up.
  begin
    insert into public.processor_accounts
      (provider, vendor_id, status, can_receive_payout,
       provider_merchant_id, submitted_at, activated_at, settlement_last4)
    values ('post4', v_id, 'active', true, 'M', now(), now(), '4471');
    crew_payout_ok := true;
  exception when others then
    raise exception '0200 FAILED: a crew can no longer be recorded as a payout recipient — that is the opposite of the decision. %', sqlerrm;
  end;

  -- 5. A PARK OWNER IS UNTOUCHED. The assertion that matters most: a
  --    constraint that protected crews by breaking rent would be the worse bug.
  begin
    insert into public.processor_accounts (provider, park_id, status, can_accept_card, can_accept_ach)
    values ('post5', p_id, 'draft', true, true);
    park_card_ok := true;
  exception when others then
    raise exception '0200 FAILED: a PARK can no longer be recorded as accepting card and ACH — this has broken Flow B. %', sqlerrm;
  end;
  begin
    insert into public.processor_accounts
      (provider, park_id, status, can_accept_ach, can_accept_card,
       provider_merchant_id, submitted_at, activated_at, settlement_last4)
    values ('post6', p_id, 'active', true, true, 'M', now(), now(), '4471');
    park_active_ok := true;
  exception when others then
    raise exception '0200 FAILED: a park owner can no longer go live as a merchant. %', sqlerrm;
  end;

  raise exception E'\n0200 PROVEN — rolling back the probe rows\n'
    '  crew: card refused .................. %\n'
    '  crew: ach refused ................... %\n'
    '  crew: live card merchant refused .... %\n'
    '  crew: payout recipient ACCEPTED ..... %\n'
    '  park: card+ach draft ACCEPTED ....... %\n'
    '  park: live merchant ACCEPTED ........ %\n',
    crew_card_refused, crew_ach_refused, crew_active_refused,
    crew_payout_ok, park_card_ok, park_active_ok;
exception when others then
  if sqlerrm like '%0200 PROVEN%' then
    raise notice '%', sqlerrm;
  else
    raise;
  end if;
end $$;
