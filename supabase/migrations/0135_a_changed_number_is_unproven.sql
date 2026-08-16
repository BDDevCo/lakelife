-- 0135 — A NUMBER THAT CHANGED IS A NUMBER NOBODY HAS PROVED.
--
-- I went looking for two holes on the office's Edit button and found one.
--
-- THE ONE THAT WASN'T THERE. I believed renaming a CLAIMED file left the old
-- resident inside it — lot turns over, office retypes the name instead of
-- doing a move-out, previous resident keeps looking at the new household's
-- rent. It is a real-sounding failure and it is already impossible:
-- `park_renters_claim_guard` has refused exactly that since 0128, with a better
-- sentence than the one I was about to write. This migration's own probe hit
-- that guard and corrected me, which is the argument for probes that try the
-- thing rather than assertions that describe it.
--
-- THE ONE THAT WAS. That same guard checks contact details only at the MOMENT
-- OF CLAIMING — its block is gated on `old.user_id is null and new.user_id is
-- not null`. Once a household is claimed, nothing stops `mobile_e164` being
-- changed, and `mobile_verified_at` / `sms_consent_operational_at` are left
-- exactly as they were.
--
-- So: the office presses Edit on a resident who has verified her own mobile and
-- agreed to texts, types the number they have on their sheet, and that number
-- inherits her verification and her consent. It becomes textable without
-- anybody proving it and without anybody agreeing to it — which is the whole
-- thing the consent design exists to prevent, reached through a side door
-- nobody would think to look at.
--
-- The invariant belongs to the column rather than to any caller: if the number
-- changes, nobody has proved the new one. Whoever changed it, by whatever path,
-- for whatever reason.

create or replace function public.park_renters_claim_stamp()
returns trigger
language plpgsql
as $$
begin
  -- A NUMBER THAT CHANGED IS A NUMBER NOBODY HAS PROVED.
  --
  -- First, so it applies on every path — including the office typing over a
  -- resident's own verified mobile on a file she has already claimed, which is
  -- the gap this migration exists for.
  if tg_op = 'UPDATE' and new.mobile_e164 is distinct from old.mobile_e164 then
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
  v_refused boolean;
begin
  insert into public.parks (id, name, slug, address, park_type, active)
  values ('0135dead-0000-4000-8000-000000000001', 'zz-0135 probe', 'zz-0135-probe',
          'nowhere', 'mh', false);
  insert into public.park_lots (park_id, lot_number, site_type, lifecycle, active, rental_mode)
  values ('0135dead-0000-4000-8000-000000000001', '1', 'mh_single', 'live', true, 'long_term');

  select id into v_user from public.users limit 1;

  insert into public.park_renters (park_id, display_name, source, contact_pref)
  values ('0135dead-0000-4000-8000-000000000001', 'Probe, One', 'prior_roll', 'paper')
  returning id into v_renter;

  -- 1. THE ACTUAL GAP: a CLAIMED household with her own proven number, and the
  --    office types a different one over it.
  update public.park_renters
     set mobile_e164 = '+12605550100', mobile_verified_at = now(),
         sms_consent_operational_at = now(), sms_consent_text = 'agreed'
   where id = v_renter;
  update public.park_renters set user_id = v_user where id = v_renter;

  update public.park_renters set mobile_e164 = '+12605550101' where id = v_renter;

  select mobile_verified_at, sms_consent_operational_at, sms_consent_text into r
    from public.park_renters where id = v_renter;
  if r.mobile_verified_at is not null then
    raise exception
      'ROLLBACK_POSTCONDITION: a number typed over a claimed file kept its verification';
  end if;
  if r.sms_consent_operational_at is not null or r.sms_consent_text is not null then
    raise exception
      'ROLLBACK_POSTCONDITION: a number typed over a claimed file kept its consent';
  end if;

  -- 2. AND ON AN UNCLAIMED FILE TOO — the rule is about the column, not about
  --    who happens to be signed in.
  update public.park_renters set user_id = null where id = v_renter;
  update public.park_renters
     set mobile_e164 = '+12605550102', mobile_verified_at = now(),
         sms_consent_operational_at = now()
   where id = v_renter;
  update public.park_renters set mobile_e164 = '+12605550103' where id = v_renter;
  select mobile_verified_at into r from public.park_renters where id = v_renter;
  if r.mobile_verified_at is not null then
    raise exception 'ROLLBACK_POSTCONDITION: an unclaimed file kept a stale verification';
  end if;

  -- 3. THE SAME NUMBER WRITTEN AGAIN IS NOT A CHANGE. Otherwise every save of
  --    an unrelated field would quietly revoke a consent she gave.
  update public.park_renters
     set mobile_verified_at = now(), sms_consent_operational_at = now()
   where id = v_renter;
  update public.park_renters set notes = 'unrelated edit' where id = v_renter;
  update public.park_renters set mobile_e164 = '+12605550103' where id = v_renter;
  select mobile_verified_at, sms_consent_operational_at into r
    from public.park_renters where id = v_renter;
  if r.mobile_verified_at is null or r.sms_consent_operational_at is null then
    raise exception
      'ROLLBACK_POSTCONDITION: an unrelated save revoked a consent she had given';
  end if;

  -- 4. THE GUARD I THOUGHT WAS MISSING IS STILL THERE. Asserted so that a
  --    future edit to this trigger cannot quietly remove what 0128 built.
  update public.park_renters set user_id = v_user where id = v_renter;
  v_refused := false;
  begin
    update public.park_renters set display_name = 'Probe, Two' where id = v_renter;
  exception when others then v_refused := true;
  end;
  if not v_refused then
    raise exception
      'ROLLBACK_POSTCONDITION: a claimed file can now be renamed — 0128 guard lost';
  end if;

  delete from public.park_renters where park_id = '0135dead-0000-4000-8000-000000000001';
  delete from public.park_lots where park_id = '0135dead-0000-4000-8000-000000000001';
  delete from public.parks where id = '0135dead-0000-4000-8000-000000000001';
end
$$;
