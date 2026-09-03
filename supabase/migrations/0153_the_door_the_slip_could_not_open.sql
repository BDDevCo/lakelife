-- THE DOOR THE SLIP COULD NOT OPEN
--
-- On 1 January twenty households get a printed slip and are told to claim
-- their file. Every one of them would have been refused, and nothing anywhere
-- would have recorded it.
--
-- ============ ONE: A RULE ENFORCED IN ONE DOORWAY OUT OF THREE ============
--
-- `claim_park_file` resolved the park with:
--
--     select id into v_park from public.parks where slug = p_park_slug
--        and active = true;
--     if v_park is null then return 'claim_park_not_open'; end if;
--
-- The Haven is `active = false` today and stays that way until he is ready to
-- be listed publicly. So the slip door was shut. The other two doors onto the
-- same file were not:
--
--   issue_park_claim_code()      no active check — all 21 slips print fine
--   claim_park_file_by_invite()  no active check — the emailed door opens
--
-- So the product MINTS a code through a door with no such rule and REFUSES it
-- at a door that has one. That is this codebase's dominant defect in its
-- purest form: a rule living in the gap between two doorways.
--
-- Which door is right? `parks.active` gates exactly two things in the rest of
-- the app, and both are about the PUBLIC:
--
--   src/app/parks/public-data.ts   the park's own public page and listings
--   src/app/parks/apply-actions.ts a STRANGER applying for an open lot
--
-- The owner's own banner says as much — "Only you can see it. Publish it when
-- your lots and rates look right — that puts your park on its own page where
-- people can see what's open and apply." A resident redeeming a code her
-- landlord printed and handed her is neither of those things. The check is
-- removed here, and the three doors now agree.
--
-- It also makes an existing sentence true. `claim_park_not_open` renders as
-- "We can't find that park. Check the name on your slip" — a lie when the park
-- was found and merely unpublished, and honest now that the only way to reach
-- it is a slug that matches no park at all.
--
-- ============ TWO: FOUR REFUSALS THAT COULD NOT BE LOGGED ============
--
-- The refusal INSERT sat below every early return, and `renter_id` was NOT
-- NULL, so `claim_code_malformed` and both `claim_no_open_lot` branches could
-- not be recorded even in principle. /ops has one screen that answers "who
-- cannot get in?" and it counts rows in this table. With none written it
-- renders its green branch — "Nobody is stuck. No refusals at all." — which is
-- the most reassuring possible way to be wrong.
--
-- Two changes make those refusals visible:
--
--   * The code's SHAPE is now checked AFTER the file is resolved, so a
--     mistyped code — the likeliest real failure on 1 January — is logged
--     against the household who mistyped it. It was first only as a cheap
--     guard before touching a table; at 21 lots that saving is worth less than
--     knowing she is stuck. The file's own state is now checked BEFORE the
--     shape too, which is the better order on its own merits: telling someone
--     whose file is LOCKED that their code looks wrong invites them to retype
--     it, which cannot help.
--
--   * `renter_id` becomes nullable so a refusal that never reached a file can
--     still name its PARK. A CHECK keeps that narrow: only a 'refused' row may
--     omit the household. Every other event still names the file it moved.
--
-- `claim_not_signed_in` remains unlogged and unloggable — there is no park, no
-- file and no actor to attribute it to. It is also unreachable in practice;
-- the caller checks the session first.
--
-- NOTHING HERE WIDENS WHAT THE PARK OWNER SEES. The table's only policy is
-- still ll_is_ops(). A failed attempt must never become a durable note about a
-- resident rendered on her landlord's screen (0128), and it still isn't.

-- ------------------------------------------------------------------ two ----

alter table public.park_renter_claim_events
  alter column renter_id drop not null;

alter table public.park_renter_claim_events
  drop constraint if exists park_renter_claim_events_refused_may_lack_file;
alter table public.park_renter_claim_events
  add constraint park_renter_claim_events_refused_may_lack_file
  check (renter_id is not null or event = 'refused');

comment on column public.park_renter_claim_events.renter_id is
  'The household file this event moved. NULL only on a refusal that never '
  'reached a file — a wrong lot number, or a code typed against a park that '
  'has no such lot. park_id is always known; the CHECK keeps every other '
  'event naming its file.';

-- ------------------------------------------------------------------ one ----

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

  -- A tenancy that ended is not a door: last year's resident must not reach
  -- this year's file.
  select r.* into v_file
    from public.park_renters r
    join public.lot_reservations t on t.renter_id = r.id
   where t.park_lot_id = v_lot
     and t.status in ('approved','active')
     and t.during @> current_date
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

-- ------------------------------------------------------- what must hold ----
--
-- SHIP-TIME assertions. These run once, now. They cannot police the next
-- migration — only `claim-door.test.ts` does that, by reading the live
-- definition back out.

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_park_file';

  if v_def is null then
    raise exception '0153: claim_park_file is gone';
  end if;

  if v_def like '%active = true%' then
    raise exception '0153: the slip door still filters on parks.active';
  end if;

  -- The whole point of moving the shape check: it must sit BELOW the file
  -- lookup, so a mistyped code lands in the log.
  if position('claim_code_malformed' in v_def) < position('claim_no_open_lot' in v_def) then
    raise exception '0153: the shape check is still above the file lookup';
  end if;

  if (select count(*) from pg_constraint
       where conname = 'park_renter_claim_events_refused_may_lack_file') <> 1 then
    raise exception '0153: the refused-may-lack-file check is missing';
  end if;

  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'park_renter_claim_events'
         and column_name = 'renter_id') <> 'YES' then
    raise exception '0153: renter_id is still NOT NULL — refusals stay unloggable';
  end if;

  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'park_renter_claim_events'
         and column_name = 'park_id') <> 'NO' then
    raise exception '0153: park_id must stay NOT NULL — a refusal always knows its park';
  end if;
end $$;

-- The CHECK actually refuses. Proven on a real row against a real park, then
-- rolled back — the table is append-only, so nothing here may survive.
do $$
declare v_park uuid; v_ok boolean := false;
begin
  select id into v_park from public.parks limit 1;
  if v_park is null then
    raise notice '0153: no park to prove the CHECK against; skipped';
    return;
  end if;

  -- The forbidden shape is refused. A sub-block is its own savepoint, so the
  -- attempt leaves nothing behind either way.
  begin
    insert into public.park_renter_claim_events (renter_id, park_id, event)
    values (null, v_park, 'claimed');
  exception when check_violation then
    v_ok := true;
  end;

  if not v_ok then
    raise exception '0153: a claimed event without a file was accepted';
  end if;

  -- And the permitted shape is permitted. The table is append-only — no
  -- DELETE, no UPDATE — so the only way to undo a proof row is to raise out
  -- of the sub-block that wrote it. Assignments survive the rollback;
  -- database changes do not.
  v_ok := false;
  begin
    insert into public.park_renter_claim_events (renter_id, park_id, event, refusal_reason)
    values (null, v_park, 'refused', 'claim_no_open_lot');
    v_ok := true;
    raise exception 'll_rollback_proof';
  exception
    when check_violation then
      raise exception '0153: a refusal with no file was rejected — they stay unloggable';
    when others then
      if sqlerrm <> 'll_rollback_proof' then raise; end if;
  end;

  if not v_ok then
    raise exception '0153: the permitted refusal never inserted';
  end if;
end $$;
