-- 0129 — THE FOUR DOORS, AND WHO MAY KNOCK
--
-- 0128 gave park_renters the columns, the guards and the ledger. This is the
-- only way to operate them. Split from 0128 because 0128 was applied without
-- these — and a file holding SQL the database never ran is the drift that this
-- repo spent an afternoon recovering from (0022, 0023, 0043c, 0046b, all live
-- with no file). One file, one ledger entry, the same content in both.
--
-- All SECURITY DEFINER with a pinned search_path, and all meant to be called
-- with the USER-SCOPED client via rpc — never the service-role client used
-- almost everywhere else in src/app/park*. That is deliberate and it is the
-- crew-invite lesson kept: `claim_park_file` takes NO user id and NO renter
-- id, so the person is auth.uid(), a fact the database owns, and there is
-- nothing on the wire for a caller to forge.
--
-- REFUSALS RETURN, THEY DO NOT RAISE. A raise rolls the transaction back and
-- takes the attempt counter and the audit row with it — the two things that
-- make guessing expensive and traceable. An expected refusal is a returned
-- reason; a raise in here means a bug, not a wrong code.

-- --------------------------------------------------------- the functions --
--
-- All SECURITY DEFINER with a pinned search_path, and all called with the
-- USER-SCOPED client via rpc — never the service-role client this codebase
-- uses almost everywhere else. That is deliberate and it is the crew-invite
-- lesson kept: `claim_park_file` takes NO user id and NO renter id, so the
-- person is auth.uid() — a fact the database owns — and there is nothing on
-- the wire for a caller to forge.
--
-- REFUSALS RETURN, THEY DO NOT RAISE. A raise rolls the transaction back,
-- taking the attempt counter and the audit row with it — the two things that
-- make guessing expensive and traceable. So an expected refusal is a returned
-- reason; a raise here means a bug, not a wrong code.

create or replace function public.claim_park_file(
  p_park_slug text,
  p_lot_number text,
  p_code text
) returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_park   uuid;
  v_lot    uuid;
  v_file   public.park_renters%rowtype;
  v_reason text;
begin
  if v_user is null then return 'claim_not_signed_in'; end if;

  -- Shape-checked before any table is touched. Mirrors CLAIM_CODE_RE in
  -- src/lib/claim-code.ts; the alphabet excludes O/I/L/U/0/1 so a misread is
  -- refused rather than guessed at.
  if p_code is null or upper(replace(p_code, '-', '')) !~ '^[2-9A-HJ-NP-TV-Z]{8}$' then
    return 'claim_code_malformed';
  end if;

  select id into v_park from public.parks
   where slug = p_park_slug and active = true;
  if v_park is null then return 'claim_park_not_open'; end if;

  select id into v_lot from public.park_lots
   where park_id = v_park and lot_number = p_lot_number;
  if v_lot is null then return 'claim_no_open_lot'; end if;

  -- The file with a LIVE tenancy on that lot. A tenancy that ended is not a
  -- door: last year's resident must not be able to claim this year's file.
  select r.* into v_file
    from public.park_renters r
    join public.lot_reservations t on t.renter_id = r.id
   where t.park_lot_id = v_lot
     and t.status in ('approved','active')
     and t.during @> current_date
   limit 1;
  if v_file.id is null then return 'claim_no_open_lot'; end if;

  if v_file.merged_into is not null then v_reason := 'claim_file_merged';
  elsif v_file.user_id is not null    then v_reason := 'claim_already_set_up';
  elsif v_file.claim_code_hash is null then v_reason := 'claim_no_code_open';
  elsif v_file.claim_locked_until is not null and v_file.claim_locked_until > now()
                                       then v_reason := 'claim_locked';
  elsif v_file.claim_code_expires_at <= now() then v_reason := 'claim_code_expired';
  elsif exists (select 1 from public.park_members m
                 where m.park_id = v_park and m.user_id = v_user)
                                       then v_reason := 'claim_member_may_not_claim';
  elsif exists (select 1 from public.park_renters x
                 where x.park_id = v_park and x.user_id = v_user)
                                       then v_reason := 'claim_already_here';
  end if;

  if v_reason is null then
    if crypt(upper(replace(p_code, '-', '')), v_file.claim_code_hash) <> v_file.claim_code_hash then
      v_reason := 'claim_code_wrong';
      update public.park_renters
         set claim_code_attempts = claim_code_attempts + 1,
             claim_locked_until  = case when claim_code_attempts + 1 >= 5
                                        then now() + interval '24 hours' else claim_locked_until end,
             claim_code_hash     = case when claim_code_attempts + 1 >= 5 then null else claim_code_hash end,
             claim_code_expires_at = case when claim_code_attempts + 1 >= 5 then null else claim_code_expires_at end
       where id = v_file.id;
    end if;
  end if;

  if v_reason is not null then
    insert into public.park_renter_claim_events (renter_id, park_id, event, refusal_reason, actor_user_id)
    values (v_file.id, v_park, 'refused', v_reason, v_user);
    return v_reason;
  end if;

  -- The claim itself. The stamp trigger closes the code and dates it; the
  -- guard trigger refuses anything this statement should not be doing.
  update public.park_renters set user_id = v_user where id = v_file.id;

  insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
  values (v_file.id, v_park, 'claimed', v_user);

  return 'claimed';
end $$;

comment on function public.claim_park_file(text, text, text) is
  'The resident claims their own file with park + lot + slip code. Takes no '
  'user id: the person is auth.uid(). Returns ''claimed'' or a refusal '
  'reason — refusals return rather than raise so the attempt counter and the '
  'audit row survive. See 0128.';

-- ---------------------------------------------------------------------------

create or replace function public.issue_park_claim_code(
  p_renter_id uuid,
  p_code text,
  p_days integer default 30
) returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_file public.park_renters%rowtype;
  v_today integer;
begin
  if v_user is null then return 'issue_not_signed_in'; end if;
  if p_code is null or upper(replace(p_code, '-', '')) !~ '^[2-9A-HJ-NP-TV-Z]{8}$' then
    return 'issue_code_malformed';
  end if;

  select * into v_file from public.park_renters where id = p_renter_id;
  if v_file.id is null then return 'issue_no_file'; end if;

  if not (public.ll_is_ops() or exists (
    select 1 from public.park_members m
     where m.park_id = v_file.park_id and m.user_id = v_user
  )) then return 'issue_not_your_park'; end if;

  if v_file.user_id is not null       then return 'issue_already_set_up'; end if;
  if v_file.merged_into is not null   then return 'issue_file_merged'; end if;
  if v_file.claim_declined_at is not null then return 'issue_declined'; end if;

  -- A park printing more codes in a day than it has households is either a
  -- mistake or somebody fishing. Enforced here rather than trusted to a screen.
  select count(*) into v_today from public.park_renter_claim_events
   where park_id = v_file.park_id and event = 'code_issued'
     and occurred_at > now() - interval '24 hours';
  if v_today >= 40 then return 'issue_too_many_today'; end if;

  update public.park_renters
     set claim_code_hash       = crypt(upper(replace(p_code, '-', '')), gen_salt('bf', 8)),
         claim_code_expires_at = now() + make_interval(days => greatest(1, least(90, p_days))),
         claim_code_issued_at  = now(),
         claim_code_issued_by  = v_user,
         claim_code_attempts   = 0,
         claim_locked_until    = null
   where id = p_renter_id;

  insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
  values (p_renter_id, v_file.park_id, 'code_issued', v_user);

  return 'issued';
end $$;

comment on function public.issue_park_claim_code(uuid, text, integer) is
  'The office mints a slip. The PLAINTEXT is generated by the caller so it can '
  'be printed once; only a bcrypt hash is stored. Never text or email the '
  'result — a code arriving by the same channel as the scam it resembles is '
  'not a credential.';

-- ---------------------------------------------------------------------------

create or replace function public.release_park_claim(
  p_renter_id uuid
) returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_file public.park_renters%rowtype;
begin
  if v_user is null then return 'release_not_signed_in'; end if;
  select * into v_file from public.park_renters where id = p_renter_id;
  if v_file.id is null then return 'release_no_file'; end if;
  if v_file.user_id is null then return 'release_not_set_up'; end if;

  -- The claimant themselves, a manager of that park, or ops.
  if not (v_file.user_id = v_user or public.ll_is_ops() or exists (
    select 1 from public.park_members m
     where m.park_id = v_file.park_id and m.user_id = v_user
  )) then return 'release_not_yours'; end if;

  update public.park_renters set user_id = null where id = p_renter_id;
  insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
  values (p_renter_id, v_file.park_id, 'released', v_user);
  return 'released';
end $$;

-- ---------------------------------------------------------------------------

create or replace function public.decline_park_claim(
  p_renter_id uuid
) returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_file public.park_renters%rowtype;
begin
  if v_user is null then return 'decline_not_signed_in'; end if;
  select * into v_file from public.park_renters where id = p_renter_id;
  if v_file.id is null then return 'decline_no_file'; end if;
  if not (public.ll_is_ops() or exists (
    select 1 from public.park_members m
     where m.park_id = v_file.park_id and m.user_id = v_user
  )) then return 'decline_not_your_park'; end if;

  -- "She said no." A permanent, respectable answer — 0055 is explicit that a
  -- paper household who pays on time is not a lesser one. This stops the
  -- asking, it does not mark anybody down.
  update public.park_renters
     set claim_declined_at = now(), claim_code_hash = null, claim_code_expires_at = null
   where id = p_renter_id;
  insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
  values (p_renter_id, v_file.park_id, 'declined', v_user);
  return 'declined';
end $$;

-- ---------------------------------------------------------------------------
-- What the OWNER may know: a fact about the code, never a fact about a person.

create or replace function public.park_claim_code_status(p_renter_id uuid)
returns text
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select case
    when r.user_id is not null then 'used'
    when r.claim_declined_at is not null then 'declined'
    when r.claim_locked_until is not null and r.claim_locked_until > now() then 'locked'
    when r.claim_code_hash is null then 'none'
    when r.claim_code_expires_at <= now() then 'expired'
    else 'open'
  end
  from public.park_renters r
  where r.id = p_renter_id
    and (public.ll_is_ops() or exists (
      select 1 from public.park_members m
       where m.park_id = r.park_id and m.user_id = auth.uid()));
$$;

-- ------------------------------------------------------------- the grants --
--
-- A SECURITY DEFINER function is callable by PUBLIC unless told otherwise, and
-- `anon` is the key in every page bundle. Revoke first, then grant narrowly.

revoke execute on function public.claim_park_file(text, text, text) from public, anon;
revoke execute on function public.issue_park_claim_code(uuid, text, integer) from public, anon;
revoke execute on function public.release_park_claim(uuid) from public, anon;
revoke execute on function public.decline_park_claim(uuid) from public, anon;
revoke execute on function public.park_claim_code_status(uuid) from public, anon;

grant execute on function public.claim_park_file(text, text, text) to authenticated;
grant execute on function public.issue_park_claim_code(uuid, text, integer) to authenticated;
grant execute on function public.release_park_claim(uuid) to authenticated;
grant execute on function public.decline_park_claim(uuid) to authenticated;
grant execute on function public.park_claim_code_status(uuid) to authenticated;
