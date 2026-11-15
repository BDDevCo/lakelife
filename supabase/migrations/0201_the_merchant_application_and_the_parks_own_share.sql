-- ===========================================================================
-- 0201  THE MERCHANT APPLICATION, AND A PARK'S SHARE OF SERVICE MONEY
-- ===========================================================================
--
-- Brendon, 29 October 2026, after meeting US Card Solutions on the 28th:
--
--   "...set up the park owners as a merchant with them, where renters would
--    pay rent through credit card or ACH ... directly into and deposit into
--    current existing bank accounts of the park owners ... we're going to make
--    it a one-click touch approval application and API into [their] backend
--    ... And that is just for the rent for the park. So we aren't touching the
--    actual money for any renters, but then for any of the services, ancillary
--    service or anything else, we would then be the only merchant, and it
--    would come into us and then back out to either park owners for the
--    ancillary services or the crew members ... they wouldn't actually, the
--    crew members or any subcontractors would not be merchants."
--
-- ---------------------------------------------------------------------------
-- THREE THINGS THIS CONFIRMS, ALREADY BUILT — recorded so nobody re-opens them
-- ---------------------------------------------------------------------------
--   * A PARK OWNER IS A MERCHANT and rent settles into the bank account they
--     already have, never through us. That is 0196, and the registry it added
--     is exactly the shape this needs.
--   * A CREW IS NEVER A MERCHANT. That is 0200, decided on 20 Oct for our own
--     reasons, and the processor conversation has now independently landed on
--     the same answer.
--   * LAKELIFE IS MERCHANT OF RECORD FOR SERVICES. Verified in code: there is
--     no per-recipient merchant lookup in `charge-gate.ts` at all, so a
--     service charge already settles to us while rent looks up the park's.
--
-- WHAT IS NEW IS THE TWO GAPS BELOW, both proven against production today.
--
-- ===========================================================================
-- GAP 1 — A PARK'S OWN SHARE OF SERVICE MONEY CANNOT BE RECORDED
-- ===========================================================================
--
-- Proven on production, 29 Oct 2026:
--
--   payout_batches.kind allows : 'early', 'monthly', 'referral'
--   batches with no vendor     : 0
--
-- His model has money arriving at LakeLife for an ancillary service and going
-- back out to EITHER a crew OR THE PARK OWNER. The second of those has no
-- `kind` to be recorded under, so the database refuses it outright. Not a
-- missing screen — a missing state.
--
-- `payout_accounts` has always been keyed by `user_id` rather than
-- `vendor_id`, and 0039's own comment says "crew users AND HOA users", so the
-- destination side was built for this on day one and the batch side never
-- caught up. A column with no writer, one table over.
alter table public.payout_batches
  drop constraint if exists payout_batches_kind_check;
alter table public.payout_batches
  add constraint payout_batches_kind_check
  check (kind in ('early', 'monthly', 'referral', 'park_services'));

comment on column public.payout_batches.kind is
  'early = a crew pulled their money forward and paid the dial for it. monthly = the free month-end run. referral = a referral payout, which has no payouts rows because the referral_earnings ARE the money (0199). park_services = a PARK OWNER''s share of an ancillary service LakeLife sold and collected as merchant of record (0201) - never rent, which never touches a LakeLife account at all.';

-- A park-owner payout names no vendor. Make that legible rather than implied,
-- so a reader of a batch row can tell the two apart without joining out.
alter table public.payout_batches
  drop constraint if exists payout_batches_park_services_has_no_vendor;
alter table public.payout_batches
  add constraint payout_batches_park_services_has_no_vendor
  check (kind <> 'park_services' or vendor_id is null);

-- ===========================================================================
-- GAP 2 — "ONE-CLICK APPLICATION" HAS NOTHING TO SUBMIT
-- ===========================================================================
--
-- Proven on production, 29 Oct 2026. `processor_accounts` holds:
--
--   provider, provider_merchant_id, park_id, vendor_id, status,
--   can_accept_ach, can_accept_card, can_receive_payout, settlement_last4,
--   submitted_at, activated_at, disabled_at, disabled_reason,
--   provider_state, created_at
--
-- Every one of those is a record of what the PROCESSOR said. There is not one
-- field an underwriter needs: no legal entity, no tax id, no address, no
-- expected volume, no control person. `startProcessorSetup` inserts
-- `{ park_id, provider }` and nothing else. So "one-click submit" today would
-- post an empty envelope.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE STILL WILL NOT HOLD
-- ---------------------------------------------------------------------------
-- NO FULL TAX ID. NO BANK NUMBERS. Four digits of the TIN so a screen can say
-- "ending 4471" and the owner can tell two entities apart, and nothing more.
-- The full EIN or SSN goes from the form straight to the processor and is
-- never persisted — the same posture 0197 took for a resident's bank account
-- and 0196 took for a park owner's. A post-condition below FAILS THIS
-- MIGRATION if a column here is even NAMED like a full credential.
--
-- That is not caution for its own sake: an underwriting application is the
-- single richest identity document in this product, and the reason to collect
-- it is to hand it to the party who is regulated to hold it.
alter table public.processor_accounts
  add column if not exists legal_name            text,
  add column if not exists dba_name              text,
  add column if not exists entity_type           text,
  add column if not exists tax_id_last4          text,
  add column if not exists address_line1         text,
  add column if not exists address_city          text,
  add column if not exists address_state         text,
  add column if not exists address_postal        text,
  add column if not exists contact_phone         text,
  add column if not exists contact_email         text,
  add column if not exists mcc                   text,
  add column if not exists expected_monthly_cents bigint,
  add column if not exists average_ticket_cents  bigint,
  add column if not exists control_person_name   text,
  add column if not exists control_person_title  text,
  -- Set when every required field is present. The submit gate reads THIS
  -- rather than re-deriving completeness, so the screen and the doorway can
  -- never disagree about whether an application is ready.
  add column if not exists application_ready_at  timestamptz;

alter table public.processor_accounts
  drop constraint if exists processor_accounts_tax_id_is_four_digits;
alter table public.processor_accounts
  add constraint processor_accounts_tax_id_is_four_digits
  check (tax_id_last4 is null or tax_id_last4 ~ '^[0-9]{4}$');

alter table public.processor_accounts
  drop constraint if exists processor_accounts_entity_type_is_known;
alter table public.processor_accounts
  add constraint processor_accounts_entity_type_is_known
  check (entity_type is null or entity_type in
    ('sole_proprietor', 'llc', 's_corp', 'c_corp', 'partnership', 'non_profit', 'trust'));

-- Volumes are what the owner ESTIMATES, and an underwriter reads them. A
-- negative one is a typo that would be submitted verbatim.
alter table public.processor_accounts
  drop constraint if exists processor_accounts_volumes_are_not_negative;
alter table public.processor_accounts
  add constraint processor_accounts_volumes_are_not_negative
  check (coalesce(expected_monthly_cents, 0) >= 0
     and coalesce(average_ticket_cents, 0) >= 0);

-- A SUBMITTED APPLICATION WAS COMPLETE WHEN IT WENT.
--
-- Not a UI rule. "One-click" means the click is the only ceremony, which puts
-- the whole weight on the state being right BEFORE it — and an application
-- that reaches an underwriter half-filled comes back rejected, which under
-- 0196 means opening a whole new account rather than fixing a field.
alter table public.processor_accounts
  drop constraint if exists processor_accounts_submitted_means_ready;
alter table public.processor_accounts
  add constraint processor_accounts_submitted_means_ready
  check (submitted_at is null or application_ready_at is not null);

comment on column public.processor_accounts.application_ready_at is
  'When the application last had every required field. The submit doorway reads this rather than re-deriving completeness, so a screen and a server action cannot disagree about whether it is ready. Cleared by the trigger whenever a field changes, so editing a ready application makes it un-ready until it is checked again.';

-- ---------------------------------------------------------------------------
-- EDITING AN APPLICATION UN-READIES IT
-- ---------------------------------------------------------------------------
-- Otherwise `application_ready_at` becomes a column that is true once and then
-- lies: change the legal name on a ready application and it stays "ready" with
-- a name nobody checked. Read the LIVE definition first and add one clause.
create or replace function public.guard_processor_account()
returns trigger language plpgsql as $$
begin
  if new.vendor_id is not null and (new.can_accept_ach is not false or new.can_accept_card is not false) then
    raise exception 'processor_accounts: a crew receives money, it never accepts it — a crew is paid as a contractor and is not a merchant, so it is never credit-checked or underwritten. If a crew genuinely needs to take payments, that is a product decision and a new migration, not a capability flag';
  end if;

  -- 0201: any change to an application field makes it un-ready, UNLESS this
  -- update is the one setting application_ready_at itself.
  if tg_op = 'UPDATE' and new.application_ready_at is not distinct from old.application_ready_at then
    if (new.legal_name, new.dba_name, new.entity_type, new.tax_id_last4,
        new.address_line1, new.address_city, new.address_state, new.address_postal,
        new.contact_phone, new.contact_email, new.mcc,
        new.expected_monthly_cents, new.average_ticket_cents,
        new.control_person_name, new.control_person_title)
       is distinct from
       (old.legal_name, old.dba_name, old.entity_type, old.tax_id_last4,
        old.address_line1, old.address_city, old.address_state, old.address_postal,
        old.contact_phone, old.contact_email, old.mcc,
        old.expected_monthly_cents, old.average_ticket_cents,
        old.control_person_name, old.control_person_title)
    then
      if old.submitted_at is not null then
        raise exception 'processor_accounts: that application has already gone to the processor — a change now would not reach them. Record what they said, or disable this account and open another';
      end if;
      new.application_ready_at := null;
    end if;
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

revoke all on function public.guard_processor_account() from public, anon, authenticated;

-- ===========================================================================
-- POST-CONDITIONS — these FAIL the migration rather than report
-- ===========================================================================
do $$
declare
  p_id uuid; v_id uuid; u_id uuid;
  bad_col text;
  park_services_ok boolean := false;
  park_services_with_vendor_refused boolean := false;
  half_application_refused boolean := false;
  edit_unreadies boolean := false;
  edit_after_submit_refused boolean := false;
  crew_card_still_refused boolean := false;
  rid uuid;
  msg text;
begin
  select id into p_id from public.parks limit 1;
  select id into v_id from public.vendors limit 1;
  select user_id into u_id from public.vendors where user_id is not null limit 1;
  if p_id is null or v_id is null or u_id is null then
    raise exception '0201 post-condition: nothing to probe with — the guards are unproven, which is the same as absent';
  end if;

  -- 1. NO COLUMN HERE IS NAMED LIKE A FULL CREDENTIAL.
  select column_name into bad_col
  from information_schema.columns
  where table_schema = 'public' and table_name = 'processor_accounts'
    and (column_name ~* '(^|_)(routing|account_number|acct|iban|swift|bic|ssn|ein)($|_)'
         or column_name ~* 'encrypted|pan|cvv|cvc'
         or (column_name ~* 'tax_id' and column_name !~* 'last4'))
  limit 1;
  if bad_col is not null then
    raise exception '0201 FAILED: processor_accounts grew a column named like a full credential: %. The application goes to the processor; it does not live here', bad_col;
  end if;

  -- 2. A PARK'S SHARE OF SERVICE MONEY CAN NOW BE RECORDED.
  begin
    insert into public.payout_batches (user_id, kind, status) values (u_id, 'park_services', 'queued');
    park_services_ok := true;
  exception when others then
    raise exception '0201 FAILED: a park_services batch is still refused — the gap this migration exists to close. %', sqlerrm;
  end;

  -- 3. AND IT NAMES NO VENDOR, because it is not a crew's money.
  begin
    insert into public.payout_batches (user_id, vendor_id, kind, status)
    values (u_id, v_id, 'park_services', 'queued');
  exception when others then park_services_with_vendor_refused := true;
  end;
  if not park_services_with_vendor_refused then
    raise exception '0201 FAILED: a park_services batch was accepted with a vendor on it';
  end if;

  -- 4. A HALF-FILLED APPLICATION CANNOT BE SUBMITTED.
  begin
    insert into public.processor_accounts (provider, park_id, status, legal_name, submitted_at)
    values ('post', p_id, 'submitted', 'Half Filled LLC', now());
  exception when others then half_application_refused := true; msg := sqlerrm;
  end;
  if not half_application_refused then
    raise exception '0201 FAILED: an application with no application_ready_at was submitted anyway';
  end if;

  -- 5. EDITING A READY APPLICATION MAKES IT UN-READY.
  insert into public.processor_accounts
    (provider, park_id, status, legal_name, application_ready_at)
  values ('post2', p_id, 'draft', 'The Haven LLC', now())
  returning id into rid;
  update public.processor_accounts set legal_name = 'A Different Name LLC' where id = rid;
  select application_ready_at is null into edit_unreadies
  from public.processor_accounts where id = rid;
  if not edit_unreadies then
    raise exception '0201 FAILED: an application stayed ready after its legal name changed — ready would be a column that is true once and then lies';
  end if;

  -- 6. AND AFTER IT HAS GONE, EDITING IS REFUSED RATHER THAN SILENT.
  update public.processor_accounts
    set application_ready_at = now() where id = rid;
  update public.processor_accounts
    set status = 'submitted', submitted_at = now() where id = rid;
  begin
    update public.processor_accounts set legal_name = 'Too Late LLC' where id = rid;
  exception when others then edit_after_submit_refused := true; msg := sqlerrm;
  end;
  if not edit_after_submit_refused then
    raise exception '0201 FAILED: an application was edited after it went to the processor, where the change reaches nobody';
  end if;
  if msg not like '%would not reach them%' then
    raise exception '0201 FAILED: refused, but with the wrong sentence. Got: %', msg;
  end if;

  -- 7. AND 0200 SURVIVED THE FUNCTION REWRITE. This migration replaces
  --    guard_processor_account, and the crew clause must still be in it.
  begin
    insert into public.processor_accounts (provider, vendor_id, status, can_accept_card)
    values ('post3', v_id, 'draft', true);
  exception when others then crew_card_still_refused := true; msg := sqlerrm;
  end;
  if not crew_card_still_refused or msg not like '%receives money, it never accepts it%' then
    raise exception '0201 FAILED: 0200''s crew guard did not survive the rewrite of guard_processor_account';
  end if;

  raise exception E'\n0201 PROVEN — rolling back the probe rows\n'
    '  no credential-shaped column ............ t\n'
    '  park_services batch accepted ........... %\n'
    '  park_services with a vendor refused .... %\n'
    '  half-filled application refused ........ %\n'
    '  editing un-readies ..................... %\n'
    '  editing after submit refused ........... %\n'
    '  0200 crew guard survived ............... %\n',
    park_services_ok, park_services_with_vendor_refused, half_application_refused,
    edit_unreadies, edit_after_submit_refused, crew_card_still_refused;
exception when others then
  if sqlerrm like '%0201 PROVEN%' then
    raise notice '%', sqlerrm;
  else
    raise;
  end if;
end $$;
