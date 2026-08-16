-- 0134 — A RELEASED FILE FORGETS EVERY KEY, NOT JUST THE OLD ONE.
--
-- Found by auditing this session's own work, which is where it should have been
-- found: 0132 invented a second way to claim a household file — an emailed link
-- — and `park_renters_claim_stamp`, the trigger whose entire job is keeping
-- credentials in step with `user_id`, was written in 0128 and has never heard
-- of it.
--
-- The trigger already does exactly the right thing for the PRINTED CODE in
-- three places. All three were silently half-done from the moment 0132 landed:
--
--   ON CLAIM. Code cleared, invite token left live. Harmless on its own — the
--   file now has a user_id and every claim path refuses — but it leaves a
--   working key in somebody's inbox, waiting for the release below.
--
--   ON RELEASE. This is the hole. The office detaches an account that claimed
--   in error; the code is cleared, the emailed link is not. The person just
--   removed can re-open the same file from their inbox, seconds later. A
--   release that leaves a working key is not a release.
--
--   ON RENAME. When an UNCLAIMED file's display_name changes, the trigger wipes
--   contact details, consent and the code — the correct reading of "this is a
--   different household now". It did not wipe the invite, so lot 14 changing
--   hands and the office retyping the name left the PREVIOUS tenant holding a
--   live link to the NEW tenant's record. That one is worse than the release
--   case, because nobody involved would ever suspect it.
--
-- The fix belongs here rather than in the four calling functions. This trigger
-- is where "a credential must not outlive the state it belongs to" already
-- lives; putting the invite anywhere else guarantees the next channel added
-- repeats this exactly.

create or replace function public.park_renters_claim_stamp()
returns trigger
language plpgsql
as $$
begin
  -- CLAIMED: every key spent, whichever one they used.
  if old.user_id is null and new.user_id is not null then
    new.claimed_at            := now();
    new.claim_code_hash       := null;
    new.claim_code_expires_at := null;
    new.claim_code_attempts   := 0;
    new.claim_locked_until    := null;
    new.invite_token_hash     := null;
    new.invite_expires_at     := null;
  end if;

  -- RELEASED: the same, or the person just detached walks back in.
  if old.user_id is not null and new.user_id is null then
    new.claim_code_hash       := null;
    new.claim_code_expires_at := null;
    new.invite_token_hash     := null;
    new.invite_expires_at     := null;
    -- `invite_sent_at` is deliberately CLEARED too: it is what makes the bulk
    -- invite skip somebody as already-written-to. A released file is a
    -- household to reach again, not one to pass over forever.
    new.invite_sent_at        := null;
  end if;

  -- RENAMED WHILE UNCLAIMED: a different household on the same lot.
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
    -- The address belonged to the previous household as much as the number did.
    new.invite_email               := null;
  end if;

  return new;
end
$$;

-- ------------------------------------------------------- post-conditions ----

do $$
declare
  v_park   uuid;
  v_lot    uuid;
  v_renter uuid;
  v_user   uuid;
  r        record;
begin
  -- A scratch park of our own, so nothing real is touched and the three cases
  -- can actually be exercised. Torn down at the end of this block either way.
  insert into public.parks (id, name, slug, address, park_type, active)
  values ('0134dead-0000-4000-8000-000000000001', 'zz-0134 probe', 'zz-0134-probe',
          'nowhere', 'mh', false);
  insert into public.park_lots (park_id, lot_number, site_type, lifecycle, active, rental_mode)
  values ('0134dead-0000-4000-8000-000000000001', '1', 'mh_single', 'live', true, 'long_term')
  returning id into v_lot;

  select id into v_user from public.users limit 1;

  insert into public.park_renters
    (park_id, display_name, source, contact_pref,
     claim_code_hash, claim_code_expires_at, claim_code_issued_by,
     invite_token_hash, invite_expires_at, invite_sent_at, invite_email)
  -- `park_renters_code_has_issuer` requires an issuer beside any code hash.
  -- The first draft omitted it and the constraint refused the probe, which is
  -- the constraint doing precisely its job.
  values ('0134dead-0000-4000-8000-000000000001', 'Probe, One', 'prior_roll', 'paper',
          'notarealhash', now() + interval '30 days', v_user,
          repeat('a', 64), now() + interval '30 days', now(), 'probe@example.com')
  returning id into v_renter;

  -- 1. CLAIM spends both keys.
  update public.park_renters set user_id = v_user where id = v_renter;
  select claim_code_hash, invite_token_hash into r
    from public.park_renters where id = v_renter;
  if r.claim_code_hash is not null or r.invite_token_hash is not null then
    raise exception 'ROLLBACK_POSTCONDITION: a key survived the claim';
  end if;

  -- 2. RELEASE leaves nothing usable behind — the actual hole this fixes.
  update public.park_renters
     set invite_token_hash = repeat('b', 64),
         invite_expires_at = now() + interval '30 days',
         invite_sent_at = now(),
         -- Both guards apply: a code hash needs an issuer AND an expiry.
         -- The claim above cleared the expiry, so it is set again here.
         claim_code_hash = 'anotherhash', claim_code_issued_by = v_user,
         claim_code_expires_at = now() + interval '30 days'
   where id = v_renter;
  update public.park_renters set user_id = null where id = v_renter;

  select claim_code_hash, invite_token_hash, invite_sent_at into r
    from public.park_renters where id = v_renter;
  if r.invite_token_hash is not null then
    raise exception 'ROLLBACK_POSTCONDITION: a released file kept a live invite link';
  end if;
  if r.claim_code_hash is not null then
    raise exception 'ROLLBACK_POSTCONDITION: a released file kept a live slip code';
  end if;
  if r.invite_sent_at is not null then
    raise exception 'ROLLBACK_POSTCONDITION: a released file still counts as invited';
  end if;

  -- 3. RENAME while unclaimed forgets the previous household entirely.
  update public.park_renters
     set invite_token_hash = repeat('c', 64),
         invite_expires_at = now() + interval '30 days',
         invite_email = 'previous@example.com',
         mobile_e164 = '+12605550100',
         sms_consent_operational_at = now(),
         sms_consent_text = 'something they agreed to'
   where id = v_renter;
  update public.park_renters set display_name = 'Probe, Two' where id = v_renter;

  select invite_token_hash, invite_email, mobile_e164,
         sms_consent_operational_at, sms_consent_text into r
    from public.park_renters where id = v_renter;
  if r.invite_token_hash is not null or r.invite_email is not null then
    raise exception
      'ROLLBACK_POSTCONDITION: a renamed file kept the previous household''s invite';
  end if;
  if r.mobile_e164 is not null or r.sms_consent_operational_at is not null
     or r.sms_consent_text is not null then
    raise exception
      'ROLLBACK_POSTCONDITION: a renamed file kept the previous household''s consent';
  end if;

  -- Teardown. The probe park is ours and goes completely.
  delete from public.lot_reservations t using public.park_lots l
   where l.id = t.park_lot_id and l.park_id = '0134dead-0000-4000-8000-000000000001';
  delete from public.park_renters where park_id = '0134dead-0000-4000-8000-000000000001';
  delete from public.park_lots where park_id = '0134dead-0000-4000-8000-000000000001';
  delete from public.parks where id = '0134dead-0000-4000-8000-000000000001';
end
$$;
