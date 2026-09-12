-- 0166 — not yet arrived is not the same as gone
--
-- Every household on The Haven's roll is dated from the takeover: the importer
-- writes each tenancy from parks.cutover_date, 1 January 2027, because that is
-- the one date that is actually true (import-helpers.ts rangeForTerm). The
-- rent roll then offers "Print a slip" for exactly those households — the
-- comment beside it says "a household arriving at the takeover date is exactly
-- who needs a slip in the months before it" — and issue_park_claim_code mints
-- one without looking at the dates.
--
-- Then Doris types The Haven, 14 and her code on 20 December and reads
--
--     "We can't match that lot number to a current household."
--
-- because both claim doors required
--
--     t.during @> current_date
--
-- and her tenancy has not started. The comment above that line says what the
-- rule was FOR: "A tenancy that ended is not a door: last year's resident must
-- not reach this year's file." Ended. The predicate said "not in residence
-- today", which also refuses everyone who has not arrived yet — the whole
-- December window the roll screen was built for. The refusal was logged with
-- no household (there is none to name when the lookup finds nothing), so
-- /ops could not see her either, and her slip — good for thirty days from the
-- day it was printed — would be expired by the time the door opened.
--
-- The same rule, one doorway of three: the two ISSUE doors and the roll never
-- checked the dates, the two CLAIM doors did. Proven on prod inside a
-- rolled-back block: a future tenancy on lot 14 issued a slip (issued / open)
-- and was refused at both claim doors (claim_no_open_lot, twice); the same
-- tenancy moved to start today claimed.
--
-- THE CHANGE. In both doors, the test becomes what the comment always meant:
--
--     (upper_inf(t.during) or upper(t.during) > current_date)   -- not ENDED
--
-- A tenancy that ended is still not a door. One that has not started is. And
-- one with no end date at all is not ended either: upper() of an unbounded
-- range is NULL, NULL > today is NULL, and a bare comparison would have shut
-- that household out where the old `@>` let her in. Every TypeScript writer
-- builds a bounded [start,end) today, so nothing live has an open end — the
-- clause is there so the next writer that does is not refused in silence.
--
-- AND A LOT IN TURNOVER CAN NOW HOLD TWO. Once future stays qualify, a lot
-- with a household leaving on the 31st and one arriving on the 1st resolves
-- two files, and the slip door's bare `limit 1` would take whichever the
-- planner returned — then check the code she typed against the OTHER
-- household's hash, count the miss on their file and lock it. So the slip
-- door orders its candidates: the file whose open code matches what she typed
-- first (it is her file, whatever the dates say); then the household in
-- residence today; then the next to arrive. A mistyped code lands on the
-- household in residence — a CHOICE, with a consequence: before this the
-- arriving household could not attempt at all, so on a lot in turnover her
-- five mistypes now count against the departing household's file and lock
-- it for a day. The alternative — counting them on whichever file the
-- planner returned — was worse, and a correctly typed code is never
-- misattributed because the hash match ranks first. Not reachable at The
-- Haven — the importer refuses two rows on one lot and lot_no_double_booking
-- holds — but it ships correct. The invite door resolves its file by token,
-- not by lot, so it needs no ordering.
--
-- NOTHING DOWNSTREAM NEEDED THE OLD TEST. Claiming writes park_renters.user_id
-- and a 'claimed' event; claim-actions.ts sends nothing; the resident's own
-- screen (my-data.ts) already renders an approved or active stay that has not
-- started. The refusal logging is unchanged, line for line.
--
-- Both bodies are copied verbatim from their last definitions — claim_park_file
-- from 0153, claim_park_file_by_invite from 0132 — with only the door lines
-- changed. src/lib/claim-door.test.ts reads the live definitions back out and
-- refuses the old predicate in either door's WHERE, so the next migration
-- cannot put it back.

-- ------------------------------------------------------------ the slip door --

create or replace function public.claim_park_file(p_park_slug text, p_lot_number text, p_code text)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_park uuid; v_lot uuid;
  v_file public.park_renters%rowtype;
  v_reason text;
begin
  if v_user is null then return 'claim_not_signed_in'; end if;

  -- NO `active` FILTER. That flag is the public-listing switch: it gates the
  -- park's own page and a stranger's application, not a resident redeeming a
  -- code her landlord printed. The two sibling doors never checked it.
  select id into v_park from public.parks where slug = p_park_slug;
  if v_park is null then return 'claim_park_not_open'; end if;

  select id into v_lot from public.park_lots
   where park_id = v_park and lot_number = p_lot_number;
  if v_lot is null then
    insert into public.park_renter_claim_events
      (renter_id, park_id, event, refusal_reason, actor_user_id)
    values (null, v_park, 'refused', 'claim_no_open_lot', v_user);
    return 'claim_no_open_lot';
  end if;

  -- A tenancy that ENDED is not a door: last year's resident must not reach
  -- this year's file. One that has not started yet is — the roll prints slips
  -- for households arriving at the takeover date, in the months before it.
  --
  -- A lot in turnover can hold a leaving household and an arriving one. The
  -- file whose open code matches what she typed comes first; failing that,
  -- the household in residence today, then the next to arrive.
  select r.* into v_file
    from public.park_renters r
    join public.lot_reservations t on t.renter_id = r.id
   where t.park_lot_id = v_lot
     and t.status in ('approved','active')
     and (upper_inf(t.during) or upper(t.during) > current_date)
   order by
     coalesce(
       r.claim_code_hash is not null
       and p_code is not null
       and upper(replace(p_code, '-', '')) ~ '^[2-9A-HJ-NP-TV-Z]{8}$'
       and crypt(upper(replace(p_code, '-', '')), r.claim_code_hash) = r.claim_code_hash,
       false) desc,
     (t.during @> current_date) desc,
     lower(t.during)
   limit 1;
  if v_file.id is null then
    insert into public.park_renter_claim_events
      (renter_id, park_id, event, refusal_reason, actor_user_id)
    values (null, v_park, 'refused', 'claim_no_open_lot', v_user);
    return 'claim_no_open_lot';
  end if;

  -- The file's own state first. It does not depend on what she typed, and
  -- "your code looks wrong" to someone who is locked out invites a retype
  -- that cannot work.
  if    v_file.merged_into is not null   then v_reason := 'claim_file_merged';
  elsif v_file.user_id is not null       then v_reason := 'claim_already_set_up';
  elsif v_file.claim_code_hash is null   then v_reason := 'claim_no_code_open';
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

  -- Then the shape. Mirrors CLAIM_CODE_RE in src/lib/claim-code.ts; the
  -- alphabet excludes O/I/L/U/0/1 so a misread is refused rather than guessed
  -- at. Checked here, below the file lookup, so the refusal can be LOGGED
  -- against the household who mistyped it.
  if v_reason is null
     and (p_code is null or upper(replace(p_code, '-', '')) !~ '^[2-9A-HJ-NP-TV-Z]{8}$') then
    v_reason := 'claim_code_malformed';
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

  update public.park_renters set user_id = v_user where id = v_file.id;
  insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
  values (v_file.id, v_park, 'claimed', v_user);
  return 'claimed';
end $function$;

-- ---------------------------------------------------------- the invite door --

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
  -- A tenancy that ENDED is not a door. One that has not started yet is,
  -- and so is one with no end date. Mirrors the slip door exactly.
  elsif not exists (select 1 from public.lot_reservations t
                     where t.renter_id = v_file.id
                       and t.status in ('approved','active')
                       and (upper_inf(t.during) or upper(t.during) > current_date))
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

-- ------------------------------------------------------- what must hold ----
--
-- SHIP-TIME assertions, run once, now. They cannot police the next migration;
-- `claim-door.test.ts` does that by reading the live definition back out.

do $$
declare v_slip text; v_invite text;
begin
  select pg_get_functiondef(p.oid) into v_slip
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_park_file';
  select pg_get_functiondef(p.oid) into v_invite
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_park_file_by_invite';

  if v_slip is null or v_invite is null then
    raise exception '0166: a claim door is gone';
  end if;

  -- The door test is "not ended" in both doors, and a range with no end is
  -- not ended ...
  if position('upper(t.during) > current_date' in v_slip) = 0
     or position('upper(t.during) > current_date' in v_invite) = 0 then
    raise exception '0166: a claim door still refuses a household who has not arrived';
  end if;
  if position('upper_inf(t.during) or upper(t.during) > current_date' in v_slip) = 0
     or position('upper_inf(t.during) or upper(t.during) > current_date' in v_invite) = 0 then
    raise exception '0166: a claim door shuts out a tenancy with no end date';
  end if;

  -- ... and the old "in residence today" predicate is gone from both. The
  -- slip door's ORDER BY may still rank by residence; that line is not an
  -- `and`, and it opens nothing.
  if position('and t.during @> current_date' in v_slip) > 0
     or position('and t.during @> current_date' in v_invite) > 0 then
    raise exception '0166: the in-residence-today rule is still a door test';
  end if;

  -- 0153's two properties survive the copy: the shape check sits below the
  -- file lookup, and the two no-open-lot refusals still log.
  if position('claim_code_malformed' in v_slip) < position('claim_no_open_lot' in v_slip) then
    raise exception '0166: the shape check moved back above the file lookup';
  end if;
  if (length(v_slip) - length(replace(v_slip, 'return ''claim_no_open_lot''', ''))) / length('return ''claim_no_open_lot''') <> 2 then
    raise exception '0166: the slip door no longer has both no-open-lot branches';
  end if;

  -- Neither door filters on parks.active (0153).
  if v_slip like '%active = true%' or v_invite like '%active = true%' then
    raise exception '0166: a claim door filters on parks.active again';
  end if;

  -- Still not callable anonymously (0128, 0132).
  if has_function_privilege('anon', 'public.claim_park_file(text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.claim_park_file_by_invite(text)', 'execute') then
    raise exception '0166: anon can call a claim door';
  end if;
end $$;

-- THE RULE, PROVEN BOTH WAYS ON A REAL LOT, THEN ROLLED BACK.
--
-- A file with a tenancy that starts twenty days from now must reach its own
-- state checks ('claim_no_code_open' — no slip is out for it); one whose
-- tenancy ended last month must not ('claim_no_open_lot'). Run under a
-- fabricated session, which auth.uid() reads from request.jwt.claim.sub; no
-- path here reaches the final UPDATE that would need a real users row. The
-- sub-block raises out at the end, so the fixture file, its tenancy and the
-- refusal rows it logged all vanish. Skipped, with a notice, on a database
-- with no live lot to prove it on.
do $$
declare
  v_park uuid; v_slug text; v_lot uuid; v_lot_no text;
  v_file uuid;
  v_future text; v_ended text; v_invite_future boolean := false; v_invite_ended text;
  v_open_ended text; v_invite_open_ended boolean := false;
  v_done boolean := false;
begin
  select pl.park_id, p.slug, pl.id, pl.lot_number
    into v_park, v_slug, v_lot, v_lot_no
    from public.park_lots pl
    join public.parks p on p.id = pl.park_id
   where pl.lifecycle = 'live'
     and not exists (select 1 from public.lot_reservations t
                      where t.park_lot_id = pl.id
                        and t.status in ('approved','active')
                        and t.during && daterange(current_date - 400, current_date + 400))
   order by p.created_at, pl.lot_number
   limit 1;
  if v_lot is null then
    raise notice '0166: no free live lot to prove the door on; skipped';
    return;
  end if;

  begin
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000166', true);
    perform set_config('request.jwt.claim.email', 'probe-0166@example.invalid', true);

    insert into public.park_renters (park_id, display_name)
    values (v_park, '0166 probe household')
    returning id into v_file;

    -- Arrives in twenty days. The importer's shape: active, grandfathered.
    insert into public.lot_reservations
      (park_lot_id, renter_id, during, term, status, origin)
    values (v_lot, v_file, daterange(current_date + 20, current_date + 385), 'monthly', 'active', 'grandfathered');

    v_future := public.claim_park_file(v_slug, v_lot_no, 'ABCDEFGH');

    -- The invite door on the same future file. Every refusal before the
    -- tenancy test is satisfied, so the only way it can stop short of the
    -- final UPDATE is that test — and the final UPDATE fails on the FK to a
    -- users row the probe session does not have. That failure IS the proof
    -- the door opened.
    update public.park_renters
       set invite_token_hash = encode(sha256(repeat('a', 64)::bytea), 'hex'),
           invite_email = 'probe-0166@example.invalid',
           invite_sent_at = now(), invite_expires_at = now() + interval '1 day'
     where id = v_file;
    begin
      perform public.claim_park_file_by_invite(repeat('a', 64));
    exception
      when foreign_key_violation then v_invite_future := true;
    end;

    -- Ended last month.
    update public.lot_reservations
       set during = daterange(current_date - 400, current_date - 30)
     where renter_id = v_file;

    v_ended := public.claim_park_file(v_slug, v_lot_no, 'ABCDEFGH');
    v_invite_ended := public.claim_park_file_by_invite(repeat('a', 64));

    -- Began, and has no end date at all. upper() of this range is NULL.
    update public.lot_reservations
       set during = daterange(current_date - 10, null)
     where renter_id = v_file;
    v_open_ended := public.claim_park_file(v_slug, v_lot_no, 'ABCDEFGH');
    begin
      perform public.claim_park_file_by_invite(repeat('a', 64));
    exception
      when foreign_key_violation then v_invite_open_ended := true;
    end;

    v_done := true;
    raise exception 'll_rollback_proof';
  exception
    when others then
      if sqlerrm <> 'll_rollback_proof' then raise; end if;
  end;

  if not v_done then
    raise exception '0166: the proof never ran to the end';
  end if;
  if v_future <> 'claim_no_code_open' then
    raise exception '0166: a household arriving in twenty days still cannot reach her file at the slip door (got %)', v_future;
  end if;
  if not v_invite_future then
    raise exception '0166: a household arriving in twenty days still cannot reach her file at the invite door';
  end if;
  if v_ended <> 'claim_no_open_lot' then
    raise exception '0166: a tenancy that ended is a door at the slip door (got %)', v_ended;
  end if;
  if v_invite_ended <> 'claim_no_open_lot' then
    raise exception '0166: a tenancy that ended is a door at the invite door (got %)', v_invite_ended;
  end if;
  if v_open_ended <> 'claim_no_code_open' then
    raise exception '0166: a tenancy with no end date is shut out at the slip door (got %)', v_open_ended;
  end if;
  if not v_invite_open_ended then
    raise exception '0166: a tenancy with no end date is shut out at the invite door';
  end if;
end $$;
