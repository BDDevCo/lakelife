-- 0130 — WHO ACTED, AND WHO SAT BESIDE THEM.
--
-- The go-live rehearsal ran the claim path end to end on a mirror of The
-- Haven's real lot numbering: 19 households filed, a slip printed, a code
-- typed, refusals exercised. The audit trail came out right — code_issued,
-- refused(claim_code_wrong), claimed — except for two columns that were null on
-- every row.
--
-- `park_renter_claim_events.actor_email` and `.assisted_by_user_id` were added
-- in 0128 and NOTHING HAS EVER WRITTEN THEM. That is the dominant bug class in
-- this codebase, committed one migration after writing the note about it. They
-- are dealt with differently here, because only one of them can be filled
-- truthfully today.
--
-- ---------------------------------------------------------------------------
-- actor_email — GETS A WRITER, AND IT IS A TRIGGER.
--
-- This is the only durable record of WHO. `actor_user_id` deliberately carries
-- no foreign key so the log outlives a deleted account — but a bare uuid
-- pointing at a row that is gone answers nothing. The email as it stood at the
-- time is the answer, and it must be snapshotted at write time because it
-- cannot be looked up afterwards.
--
-- A trigger rather than four edited function bodies. The 0129 functions each
-- insert their own event with a slightly different column list, so patching
-- them textually is how you get a column/value mismatch in one of four paths
-- and only find out from a household. A BEFORE INSERT trigger fills the column
-- for every writer that exists now AND every one written later, which is the
-- property that actually stops this recurring.
--
-- ---------------------------------------------------------------------------
-- assisted_by_user_id — DROPPED, ON PURPOSE, UNTIL IT CAN BE TRUE.
--
-- It was meant to record the office sitting down with somebody and working
-- their phone for them — stated policy, not an edge case: the ones who cannot
-- manage it get helped in person.
--
-- But nothing in the claim path can establish it. `claim_park_file` takes no
-- helper argument and could not trust one if it did: the authenticated session
-- is the RESIDENT'S, so a park member standing in the room is invisible to the
-- database, and any value the browser passed would be a claim the caller made
-- about themselves. A column that can only ever hold an unverifiable assertion
-- is worse than no column, because a log with a name in it reads as evidence.
--
-- So it goes, and it comes back with the assisted flow that earns it — where
-- the OFFICE is the authenticated caller and the resident is present, which is
-- a different function with a different proof obligation.

-- ------------------------------------------------------------- the writer --

-- The actor's email as it reads right now, looked up from the id the event
-- already records. SECURITY DEFINER because auth.users is not readable by the
-- caller; it is only ever handed the actor of the row being written.
create or replace function public.park_claim_event_stamp()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.actor_email is null and new.actor_user_id is not null then
    select u.email::text into new.actor_email
    from auth.users u where u.id = new.actor_user_id;
  end if;
  return new;
end
$$;

drop trigger if exists park_claim_events_stamp on public.park_renter_claim_events;
create trigger park_claim_events_stamp
  before insert on public.park_renter_claim_events
  for each row execute function public.park_claim_event_stamp();

-- --------------------------------------------------- NO BACKFILL, ON PURPOSE -
--
-- The first draft of this migration backfilled existing rows from auth.users
-- and the append-only trigger refused the UPDATE — correctly, and it saved a
-- worse mistake. The column holds the email AS IT STOOD AT THE TIME. Filling it
-- in now from today's data would manufacture exactly the snapshot it exists to
-- preserve, and would do it for rows where the true answer is "we did not
-- record this". Rows written before this migration keep a null, which is
-- accurate: nobody captured it then.

-- -------------------------------------------------- retire the other one ----

alter table public.park_renter_claim_events
  drop column if exists assisted_by_user_id;

-- ------------------------------------------------------- post-conditions ----

do $$
declare
  n         int;
  v_renter  uuid;
  v_park    uuid;
  v_actor   uuid;
  v_email   text;
  v_accepted boolean;
begin
  -- 1. The trigger exists.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'park_claim_events_stamp' and not tgisinternal
  ) then
    raise exception 'ROLLBACK_POSTCONDITION: stamp trigger missing';
  end if;

  -- 2. The column that could not be true is gone.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'park_renter_claim_events'
      and column_name = 'assisted_by_user_id'
  ) then
    raise exception 'ROLLBACK_POSTCONDITION: assisted_by_user_id still present';
  end if;

  -- 3. THE WRITER ACTUALLY WRITES — proven on a COPY of the table, never on the
  --    real log.
  --
  --    The first draft inserted a probe event into park_renter_claim_events and
  --    deleted it afterwards. The append-only trigger blocks DELETE as well as
  --    UPDATE, so that probe would have been permanent: a fabricated 'refused'
  --    event standing against a real household forever, in the one table whose
  --    entire job is to be trustworthy. A temp table takes the trigger and the
  --    same insert, and proves the same thing with nothing left behind.
  create temp table probe_claim_events
    (like public.park_renter_claim_events including defaults) on commit drop;
  create trigger probe_stamp before insert on probe_claim_events
    for each row execute function public.park_claim_event_stamp();

  select r.id, r.park_id into v_renter, v_park
  from public.park_renters r
  join public.park_members m on m.park_id = r.park_id
  limit 1;

  if v_renter is not null then
    select m.user_id into v_actor
    from public.park_members m where m.park_id = v_park limit 1;

    insert into probe_claim_events
      (renter_id, park_id, event, actor_user_id)
    values (v_renter, v_park, 'refused', v_actor)
    returning actor_email into v_email;

    if v_email is null then
      raise exception
        'ROLLBACK_POSTCONDITION: actor_email still null after the trigger ran';
    end if;
    if v_email <> (select u.email::text from auth.users u where u.id = v_actor) then
      raise exception 'ROLLBACK_POSTCONDITION: actor_email is not the actor''s email';
    end if;
  end if;

  -- 4. The append-only guard still stands. It is what refused this migration's
  --    first draft, and a stamping trigger must not have quietly weakened it.
  --
  --    The flag matters: a bare `raise` inside the block would be caught by its
  --    own exception handler, so a log that HAD accepted the write would report
  --    success. The verdict is recorded, then acted on outside the handler.
  v_accepted := false;
  begin
    update public.park_renter_claim_events set actor_email = 'probe@example.com'
    where id = (select id from public.park_renter_claim_events limit 1);
    v_accepted := found;
  exception
    when others then v_accepted := false;   -- the guard fired: correct
  end;
  if v_accepted then
    raise exception 'ROLLBACK_POSTCONDITION: the log accepted an UPDATE';
  end if;

  -- 5. Still append-only, still ops-only to read.
  select count(*) into n from pg_policy
  where polrelid = 'public.park_renter_claim_events'::regclass;
  if n <> 1 then
    raise exception 'ROLLBACK_POSTCONDITION: expected exactly 1 policy, found %', n;
  end if;
end
$$;
