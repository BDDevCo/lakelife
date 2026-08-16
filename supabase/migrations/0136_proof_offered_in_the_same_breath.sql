-- 0136 — PROOF OFFERED IN THE SAME BREATH STILL COUNTS.
--
-- 0135 said: if the number changes, nobody has proved the new one. Correct,
-- and it broke the only path that ever legitimately proves one.
--
-- `confirmTextOptIn` writes all four columns in a single UPDATE — the number,
-- the verification, the consent and the wording — because they belong together
-- and a half-written consent is worse than none. 0135's trigger sees
-- `mobile_e164` changing in that statement and nulls the three proofs being
-- set BY that statement. The number saves; the verification and consent do not.
-- The resident types a real code from a real handset and the panel comes back
-- still asking her to turn texts on.
--
-- Found by texting an actual phone. It survived unit tests, a typecheck, a
-- lint pass and a migration full of post-conditions — because every one of
-- those probes wrote the number FIRST and the proof SECOND, in two statements,
-- which is not how the real caller does it. The probe has to move like the
-- caller or it is testing a different program.
--
-- THE DISTINCTION THE RULE ACTUALLY WANTED:
--
--   number changed, no fresh proof supplied  → the office typed it → clear
--   number changed, fresh proof in the same
--   statement                                → she just proved it → keep
--
-- Not a loophole. `buildTenant` — the only thing behind the office's Edit
-- button — produces display_name, email, mobile_e164, contact_pref and source,
-- and cannot express `mobile_verified_at` at all. There is no path from that
-- screen to a self-certified number. The service-role callers that CAN set it
-- are the opt-in and this migration, which is the point.

create or replace function public.park_renters_claim_stamp()
returns trigger
language plpgsql
as $$
begin
  -- A NUMBER THAT CHANGED IS A NUMBER NOBODY HAS PROVED —
  -- unless proof arrived in the same statement that changed it.
  if tg_op = 'UPDATE'
     and new.mobile_e164 is distinct from old.mobile_e164
     and new.mobile_verified_at is not distinct from old.mobile_verified_at
  then
    new.mobile_verified_at         := null;
    new.sms_consent_operational_at := null;
    new.sms_consent_marketing_at   := null;
    new.sms_consent_text           := null;
  end if;

  if old.user_id is null and new.user_id is not null then
    new.claimed_at            := now();
    new.claim_code_hash       := null;
    new.claim_code_expires_at := null;
    new.claim_code_attempts   := 0;
    new.claim_locked_until    := null;
    new.invite_token_hash     := null;
    new.invite_expires_at     := null;
  end if;

  if old.user_id is not null and new.user_id is null then
    new.claim_code_hash       := null;
    new.claim_code_expires_at := null;
    new.invite_token_hash     := null;
    new.invite_expires_at     := null;
    new.invite_sent_at        := null;
  end if;

  if old.user_id is null and new.display_name is distinct from old.display_name then
    new.mobile_e164                := null;
    new.mobile_verified_at         := null;
    new.sms_consent_operational_at := null;
    new.sms_consent_marketing_at   := null;
    new.sms_consent_text           := null;
    new.confirmed_at               := null;
    new.claim_code_hash            := null;
    new.claim_code_expires_at      := null;
    new.invite_token_hash          := null;
    new.invite_expires_at          := null;
    new.invite_sent_at             := null;
    new.invite_email               := null;
  end if;

  return new;
end
$$;

-- ------------------------------------------------------- post-conditions ----

do $$
declare
  v_renter uuid;
  v_user   uuid;
  r        record;
begin
  insert into public.parks (id, name, slug, address, park_type, active)
  values ('0136dead-0000-4000-8000-000000000001', 'zz-0136 probe', 'zz-0136-probe',
          'nowhere', 'mh', false);
  insert into public.park_lots (park_id, lot_number, site_type, lifecycle, active, rental_mode)
  values ('0136dead-0000-4000-8000-000000000001', '1', 'mh_single', 'live', true, 'long_term');
  select id into v_user from public.users limit 1;

  insert into public.park_renters (park_id, display_name, source, contact_pref, user_id)
  values ('0136dead-0000-4000-8000-000000000001', 'Probe, One', 'prior_roll', 'paper', v_user)
  returning id into v_renter;

  -- 1. THE REGRESSION, WRITTEN THE WAY THE REAL CALLER WRITES IT.
  --    One statement, all four columns — which is what 0135 broke and what no
  --    probe in 0135 attempted.
  update public.park_renters
     set mobile_e164 = '+16025550100',
         mobile_verified_at = now(),
         sms_consent_operational_at = now(),
         sms_consent_text = 'she agreed to this'
   where id = v_renter;

  select mobile_e164, mobile_verified_at, sms_consent_operational_at, sms_consent_text into r
    from public.park_renters where id = v_renter;
  if r.mobile_verified_at is null then
    raise exception
      'ROLLBACK_POSTCONDITION: a verification supplied with the number was thrown away';
  end if;
  if r.sms_consent_operational_at is null or r.sms_consent_text is null then
    raise exception
      'ROLLBACK_POSTCONDITION: a consent supplied with the number was thrown away';
  end if;

  -- 2. AND 0135'S ACTUAL RULE STILL HOLDS: a number typed over her proven one,
  --    with no fresh proof, loses everything.
  update public.park_renters set mobile_e164 = '+16025550101' where id = v_renter;
  select mobile_verified_at, sms_consent_operational_at, sms_consent_text into r
    from public.park_renters where id = v_renter;
  if r.mobile_verified_at is not null
     or r.sms_consent_operational_at is not null
     or r.sms_consent_text is not null then
    raise exception
      'ROLLBACK_POSTCONDITION: a number typed over hers kept the old proof';
  end if;

  -- 3. Re-proving after that works, so a resident whose number the office
  --    clobbered is not locked out of ever turning texts on again.
  update public.park_renters
     set mobile_e164 = '+16025550102', mobile_verified_at = now(),
         sms_consent_operational_at = now(), sms_consent_text = 'agreed again'
   where id = v_renter;
  select mobile_verified_at into r from public.park_renters where id = v_renter;
  if r.mobile_verified_at is null then
    raise exception 'ROLLBACK_POSTCONDITION: she could not re-prove her number';
  end if;

  -- 4. An unrelated save still leaves her consent alone.
  update public.park_renters set notes = 'unrelated' where id = v_renter;
  select mobile_verified_at, sms_consent_operational_at into r
    from public.park_renters where id = v_renter;
  if r.mobile_verified_at is null or r.sms_consent_operational_at is null then
    raise exception 'ROLLBACK_POSTCONDITION: an unrelated save revoked her consent';
  end if;

  delete from public.park_renters where park_id = '0136dead-0000-4000-8000-000000000001';
  delete from public.park_lots where park_id = '0136dead-0000-4000-8000-000000000001';
  delete from public.parks where id = '0136dead-0000-4000-8000-000000000001';
end
$$;
