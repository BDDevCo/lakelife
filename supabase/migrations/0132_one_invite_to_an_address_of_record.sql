-- 0132 — ONE INVITE, TO AN ADDRESS OF RECORD.
--
-- The slip works and stays: printed by the office, handed over in person, the
-- only channel that exists for a household we have no way to reach. But it was
-- the ONLY path, and nineteen presses of "print a slip" is not automation, it
-- is a chore with a button on it.
--
-- Now the roll carries emails (see the importer), most of them can be reached
-- with one message.
--
-- ---------------------------------------------------------------------------
-- AN ADDRESS ON A FILE IS NOT PERMISSION, AND THIS IS THE ONE EXCEPTION.
--
-- The standing rule in this codebase is that an address handed over with a
-- park's records is not that household asking to be emailed — `contact_pref`
-- stays 'paper' until they say otherwise, and nothing automated ever writes to
-- them. That rule created a trap: they cannot ask to be emailed, because we
-- cannot email them to ask.
--
-- The way out is narrow and it is the whole of what this migration allows: ONE
-- notice, to the address of record, telling them what has happened and how to
-- see their own lot. A landlord writing to a tenant about how rent works from
-- now on is ordinary. It carries no code, asks for nothing, and there is no
-- second one — `invite_sent_at` is what makes "one" true rather than aspired
-- to. Everything after that flows from THEIR account, which is consent by
-- definition.
--
-- ---------------------------------------------------------------------------
-- THE LINK IS BOUND TO THE ADDRESS. This is the difference between an invite
-- and a bearer token in somebody's inbox.
--
-- The token alone opens nothing. Claiming requires being signed in AS the
-- address the invite was sent to, so an office typo — donna@gmial.com — is a
-- dead link rather than a stranger reading a household's rent. That is the
-- crew-invite lesson kept: claimCrewInvite once took the email as an argument
-- and anyone signed in could pass somebody else's.
--
-- SHA-256, NOT BCRYPT, and deliberately. The claim CODE is eight human-typed
-- characters and needs a slow hash to survive guessing. This is 32 bytes of
-- entropy in a URL — brute force is not the threat — and bcrypt's per-row salt
-- would make it impossible to LOOK UP, which is the one thing a link must do.
--
-- NO SMS HERE, EVEN LATER. Texting is a stricter regime, and a recycled mobile
-- number is common enough that a link to a stale one is a real disclosure. A
-- resident may add their own number once they are in.

-- The log's event list is a CHECK, so a new kind of event has to be allowed
-- before anything can write one. Caught before applying: `issue_park_invite`
-- would have passed every check of its own and then died on the audit insert.
alter table public.park_renter_claim_events
  drop constraint if exists park_renter_claim_events_event_check;
alter table public.park_renter_claim_events
  add constraint park_renter_claim_events_event_check
  check (event = any (array[
    'code_issued', 'code_revoked', 'claimed', 'released', 'refused', 'declined',
    'invite_sent'
  ]));

alter table public.park_renters
  add column if not exists invite_email      text,
  add column if not exists invite_token_hash text,
  add column if not exists invite_sent_at    timestamptz,
  add column if not exists invite_expires_at timestamptz,
  add column if not exists invite_sent_by    uuid references public.users(id) on delete set null;

-- A token is looked up by equality on every claim attempt.
create unique index if not exists park_renters_invite_token_idx
  on public.park_renters (invite_token_hash)
  where invite_token_hash is not null;

-- ------------------------------------------------------------- the office --

/**
 * Mint one invite for one household. Returns an outcome string, never throws
 * for an ordinary refusal.
 *
 * The PLAINTEXT token never reaches the database — the caller generates it,
 * sends it, and passes only its digest here.
 */
create or replace function public.issue_park_invite(
  p_renter_id  uuid,
  p_token_hash text,
  p_email      text,
  p_days       integer default 30
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_file public.park_renters%rowtype;
begin
  if v_user is null then return 'invite_not_signed_in'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return 'invite_bad_token';
  end if;
  if p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    return 'invite_bad_email';
  end if;

  select * into v_file from public.park_renters where id = p_renter_id;
  if v_file.id is null then return 'invite_no_file'; end if;

  if not exists (
    select 1 from public.park_members m
    where m.park_id = v_file.park_id and m.user_id = v_user
  ) then
    return 'invite_not_your_park';
  end if;

  if v_file.user_id is not null       then return 'invite_already_set_up'; end if;
  if v_file.claim_declined_at is not null then return 'invite_declined'; end if;
  if v_file.merged_into is not null   then return 'invite_file_merged'; end if;

  -- ONE PER DAY PER HOUSEHOLD. The bulk action already skips anyone invited;
  -- this is the floor under the deliberate "send it again" for somebody who
  -- says it never arrived. A resident emailed repeatedly about the same thing
  -- stops reading anything from the park.
  if v_file.invite_sent_at is not null and v_file.invite_sent_at > now() - interval '24 hours' then
    return 'invite_too_soon';
  end if;

  update public.park_renters
     set invite_token_hash = p_token_hash,
         invite_email      = lower(trim(p_email)),
         invite_sent_at    = now(),
         invite_expires_at = now() + make_interval(days => greatest(1, least(p_days, 90))),
         invite_sent_by    = v_user
   where id = p_renter_id;

  insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
  values (v_file.id, v_file.park_id, 'invite_sent', v_user);

  return 'invited';
end
$$;

-- ---------------------------------------------------------- the resident ---

/**
 * Follow the link. The token says which file; the SESSION says who you are,
 * and the two must agree.
 */
create or replace function public.claim_park_file_by_invite(p_token text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_email text := lower(coalesce(auth.email(), ''));
  v_file  public.park_renters%rowtype;
  v_reason text;
begin
  if v_user is null then return 'claim_not_signed_in'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return 'invite_bad_token'; end if;

  select * into v_file from public.park_renters
   where invite_token_hash = encode(sha256(p_token::bytea), 'hex');
  if v_file.id is null then return 'invite_unknown'; end if;

  if    v_file.merged_into is not null      then v_reason := 'claim_file_merged';
  elsif v_file.user_id is not null          then v_reason := 'claim_already_set_up';
  elsif v_file.invite_expires_at <= now()   then v_reason := 'invite_expired';
  -- THE BINDING. Signed in as somebody else — including the household's own
  -- second address — is refused, because we cannot tell those two apart and
  -- one of them is a stranger holding a forwarded email.
  elsif v_email <> coalesce(v_file.invite_email, '') then v_reason := 'invite_wrong_account';
  elsif exists (select 1 from public.park_members m
                 where m.park_id = v_file.park_id and m.user_id = v_user)
                                            then v_reason := 'claim_member_may_not_claim';
  elsif exists (select 1 from public.park_renters x
                 where x.park_id = v_file.park_id and x.user_id = v_user)
                                            then v_reason := 'claim_already_here';
  -- A tenancy that ended is not a door. Mirrors the code path exactly.
  elsif not exists (select 1 from public.lot_reservations t
                     where t.renter_id = v_file.id
                       and t.status in ('approved','active')
                       and t.during @> current_date)
                                            then v_reason := 'claim_no_open_lot';
  end if;

  if v_reason is not null then
    insert into public.park_renter_claim_events (renter_id, park_id, event, refusal_reason, actor_user_id)
    values (v_file.id, v_file.park_id, 'refused', v_reason, v_user);
    return v_reason;
  end if;

  -- SPENT ON USE. The link stops working the moment it works, so a forwarded
  -- message cannot be followed by somebody else afterwards.
  update public.park_renters
     set user_id = v_user, invite_token_hash = null
   where id = v_file.id;

  insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
  values (v_file.id, v_file.park_id, 'claimed', v_user);
  return 'claimed';
end
$$;

revoke all on function public.issue_park_invite(uuid, text, text, integer) from public, anon;
revoke all on function public.claim_park_file_by_invite(text) from public, anon;
grant execute on function public.issue_park_invite(uuid, text, text, integer) to authenticated;
grant execute on function public.claim_park_file_by_invite(text) to authenticated;

-- ------------------------------------------------------- post-conditions ----

do $$
declare
  n int;
begin
  -- 1. The columns and the lookup index exist.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'park_renters'
     and column_name in ('invite_email','invite_token_hash','invite_sent_at',
                         'invite_expires_at','invite_sent_by');
  if n <> 5 then raise exception 'ROLLBACK_POSTCONDITION: expected 5 invite columns, found %', n; end if;

  if not exists (select 1 from pg_indexes
                  where tablename = 'park_renters' and indexname = 'park_renters_invite_token_idx') then
    raise exception 'ROLLBACK_POSTCONDITION: token lookup index missing';
  end if;

  -- 2. Neither function is reachable by an anonymous caller. `anon` is the key
  --    in every page bundle, so this is not theoretical.
  if has_function_privilege('anon', 'public.claim_park_file_by_invite(text)', 'execute')
     or has_function_privilege('anon', 'public.issue_park_invite(uuid, text, text, integer)', 'execute') then
    raise exception 'ROLLBACK_POSTCONDITION: anon can call an invite function';
  end if;

  -- 3. NOTHING CLAIMS WITHOUT A SESSION.
  --
  --    A migration runs with no `auth.uid()`, so every call here stops at the
  --    signed-in check — which is precisely the property worth asserting in
  --    this context, and the first draft got it wrong by expecting the SHAPE
  --    refusal and failing when the session check fired first. What must be
  --    true is narrower and more important: an unauthenticated caller, with
  --    any token at all, never comes back holding a file.
  --
  --    The shape check and the address binding are exercised against a real
  --    session in src/lib/park-invite.test.ts and on screen.
  if public.claim_park_file_by_invite('not-a-token') = 'claimed'
     or public.claim_park_file_by_invite(repeat('a', 64)) = 'claimed' then
    raise exception 'ROLLBACK_POSTCONDITION: an unauthenticated call claimed a file';
  end if;
  if public.issue_park_invite(
       '00000000-0000-4000-8000-0000000000aa', repeat('a', 64), 'x@example.com') = 'invited' then
    raise exception 'ROLLBACK_POSTCONDITION: an unauthenticated call issued an invite';
  end if;

  -- 5. The new event kind is actually writable. The CHECK is the reason this
  --    migration exists in the order it does; asserting the constraint text
  --    would pass even if the array were wrong, so write one and read it back.
  begin
    create temp table probe_invite_events
      (like public.park_renter_claim_events including defaults
       including constraints) on commit drop;
    insert into probe_invite_events (renter_id, park_id, event)
    values ('00000000-0000-4000-8000-0000000000aa',
            '00000000-0000-4000-8000-0000000000bb', 'invite_sent');
  exception
    when check_violation then
      raise exception 'ROLLBACK_POSTCONDITION: invite_sent is not an allowed event';
  end;

  -- 6. The event log still has exactly one policy and is ops-read-only.
  select count(*) into n from pg_policy
   where polrelid = 'public.park_renter_claim_events'::regclass;
  if n <> 1 then raise exception 'ROLLBACK_POSTCONDITION: claim log policy changed'; end if;
end
$$;
