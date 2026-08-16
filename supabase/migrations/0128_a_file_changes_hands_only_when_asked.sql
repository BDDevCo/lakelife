-- 0128 — A FILE CHANGES HANDS ONLY WHEN ASKED
--
-- 0055 built park_renters with claim_code, claimed_at and user_id, wrote down
-- exactly how they were meant to work — "short, single-use, handed over
-- deliberately by the park owner, never guessable" — and then nothing ever
-- wrote any of them. Nineteen households at the first park have a file the
-- office typed and no way to reach it. The park screen already counts
-- `unclaimed` and says so; it has simply never had an answer.
--
-- ===========================================================================
-- THE RULE THIS IS ALL DERIVED FROM
--
--   A park file changes hands ONLY when the resident does something. There is
--   no sequence of events in which a household who does nothing loses theirs.
--
-- ===========================================================================
-- WHAT THAT RULE KILLED, and it was the obvious idea
--
-- The tempting route: the park already has her mobile on file, so let her
-- verify that number and hand her the matching file. It is one tap, it uses
-- machinery that already exists, and it is wrong.
--
-- Kyle in Fort Wayne is given a recycled number that used to be Doris's. He
-- verifies HIS OWN phone, honestly, with no intent at all — and is handed
-- Doris's ledger, her lot, her balance. Doris did nothing and had no moment in
-- which she could have intervened. That is the only route proposed where a
-- resident who does nothing can lose their file, and it is disqualifying on
-- its own.
--
-- Three more, each sufficient by itself:
--   * `mobile_e164` is typed by the park owner. Making it the credential means
--     the credential is a field written by the party it exists to exclude —
--     the crew-invite defect (src/lib/sql-like.ts) one storey up.
--   * `mobile_verified_at` has NO WRITER anywhere in src/. The gate would be a
--     column nothing sets, so it would gate nothing.
--   * The column holds two formats — `2605550142` from add, `+12605550142`
--     from edit — so matching would miss most of the nineteen, and the
--     pressure fix is a LIKE on the last ten digits, which is the takeover
--     again wearing a different hat.
--
-- It saved the owner thirty seconds in a conversation he is having in person
-- anyway. It is not built, and it is not built in any shape.
--
-- ===========================================================================
-- THE ONE ROUTE: A SLIP OF PAPER, AND THE LOT IT BELONGS TO
--
-- The office prints a code for one lot and hands it over. The resident signs
-- in and gives PARK + LOT NUMBER + CODE. We look up park → lot → the file with
-- a live tenancy on that lot, and only then check the code against that single
-- row.
--
-- Looking up by lot rather than by code is the whole trick:
--   * There is no `where claim_code = $1` anywhere in this file, so no pattern
--     operator can ever touch a code column. The bug that took a crew account
--     this week cannot be written here.
--   * The code stops being a global namespace — a Haven code is not an input
--     that means anything at another park.
--   * It lets the code be stored SALTED AND HASHED, which a unique index on
--     the plaintext could never allow. The plaintext is shown once, on the
--     slip, and is not recoverable from this database afterwards.
--   * The second factor arrives free. She knows her own lot number without
--     being asked a single personal question.
--
-- NEVER TEXTED, NEVER EMAILED. A code that travels the same channel as the
-- scam it will be mistaken for is not a credential. It is handed over.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------ the columns --

do $$
declare n integer;
begin
  select count(*) into n from public.park_renters where claim_code is not null;
  if n > 0 then
    raise exception '0128: % file(s) hold a plaintext claim_code; migrate them before dropping', n;
  end if;
end $$;

-- Plaintext, globally unique, and unused. Everything below replaces it.
alter table public.park_renters drop column if exists claim_code;

alter table public.park_renters
  add column if not exists claim_code_hash       text,
  add column if not exists claim_code_expires_at timestamptz,
  add column if not exists claim_code_issued_at  timestamptz,
  add column if not exists claim_code_issued_by  uuid references public.users(id) on delete set null,
  add column if not exists claim_code_attempts   smallint not null default 0,
  add column if not exists claim_locked_until    timestamptz,
  add column if not exists claim_declined_at     timestamptz;

comment on column public.park_renters.claim_code_hash is
  'bcrypt of the slip code. The plaintext is rendered ONCE when issued and is '
  'not recoverable here. Never compared with =; see claim_park_file, which '
  'finds the row by lot and then verifies against this one row.';
comment on column public.park_renters.claim_declined_at is
  'She was asked and said no. Blocks issuing and nudging. Declining is a '
  'first-class answer, not a lapsed state — see 0055 on paper being '
  'permanent and respectable.';

-- A CODE WITHOUT AN EXPIRY IS NOT AN EXPIRING CODE. Making the pair
-- inseparable is what stops "single-use, expiring" from being a comment that
-- every future caller has to remember.
alter table public.park_renters drop constraint if exists park_renters_code_has_expiry;
alter table public.park_renters add constraint park_renters_code_has_expiry
  check ((claim_code_hash is null) = (claim_code_expires_at is null));

alter table public.park_renters drop constraint if exists park_renters_code_has_issuer;
alter table public.park_renters add constraint park_renters_code_has_issuer
  check (claim_code_hash is null or claim_code_issued_by is not null);

-- ONE SHAPE FOR A PHONE NUMBER. Not for the claim path — that route is dead —
-- but because this column is a SEND TARGET and holding two formats is a live
-- bug: the reminder that goes to +12605550142 does not go to 2605550142.
-- Normalise first, assert zero survivors, then make it structural.
update public.park_renters
   set mobile_e164 = '+1' || regexp_replace(mobile_e164, '[^0-9]', '', 'g')
 where mobile_e164 is not null
   and mobile_e164 !~ '^\+'
   and length(regexp_replace(mobile_e164, '[^0-9]', '', 'g')) = 10;

do $$
declare n integer;
begin
  select count(*) into n from public.park_renters
   where mobile_e164 is not null and mobile_e164 !~ '^\+[1-9][0-9]{9,14}$';
  if n > 0 then raise exception '0128: % mobile(s) still not E.164 after backfill', n; end if;
end $$;

alter table public.park_renters drop constraint if exists park_renters_mobile_e164_shape;
alter table public.park_renters add constraint park_renters_mobile_e164_shape
  check (mobile_e164 is null or mobile_e164 ~ '^\+[1-9][0-9]{9,14}$');

-- DELIBERATELY NOT ADDED: check ((user_id is null) = (claimed_at is null)).
-- user_id is ON DELETE SET NULL, so deleting an auth account fires an UPDATE
-- that nulls user_id and leaves claimed_at — that check would make account
-- deletion fail with an error nobody can act on, breaking the exact thing 0055
-- protects. "claimed_at set, user_id null" is true and useful: this file was
-- set up once and is not now.

-- ------------------------------------------------------------ the ledger --
--
-- Who took a file, when, and every refusal. Append-only.

create table if not exists public.park_renter_claim_events (
  id          uuid primary key default gen_random_uuid(),
  renter_id   uuid not null references public.park_renters(id) on delete cascade,
  park_id     uuid not null references public.parks(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  event       text not null
    check (event in ('code_issued','code_revoked','claimed','released','refused','declined')),
  -- Fixed vocabulary, never free text: a refusal reason is read by code and by
  -- a person months later, and free text becomes neither.
  refusal_reason text,
  -- NO FOREIGN KEY on the actor columns, on purpose. An FK with ON DELETE SET
  -- NULL would let deleting an account erase the only record of who took a
  -- file, and park_payments has no paid-by-account column to fall back on.
  actor_user_id      uuid,
  actor_email        text,
  assisted_by_user_id uuid
);

create index if not exists park_renter_claim_events_renter_idx
  on public.park_renter_claim_events(renter_id, occurred_at desc);

comment on table public.park_renter_claim_events is
  'Append-only record of a park file changing hands. OPS READ ONLY: a failed '
  'attempt must never become a durable record about a person rendered on '
  'their landlord''s screen. What an owner legitimately needs is whether a '
  'code is open, which park_claim_code_status answers without naming anybody.';

alter table public.park_renter_claim_events enable row level security;

drop policy if exists park_renter_claim_events_read on public.park_renter_claim_events;
create policy park_renter_claim_events_read on public.park_renter_claim_events
  for select using (public.ll_is_ops());

revoke insert, update, delete, truncate on public.park_renter_claim_events
  from anon, authenticated;
revoke select on public.park_renter_claim_events from anon;
grant select on public.park_renter_claim_events to authenticated;

-- A grant can drift; a trigger holds.
create or replace function public.park_claim_events_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'park_renter_claim_events is append-only (attempted %)', tg_op;
end $$;

drop trigger if exists park_renter_claim_events_no_edit on public.park_renter_claim_events;
create trigger park_renter_claim_events_no_edit
  before update or delete on public.park_renter_claim_events
  for each row execute function public.park_claim_events_append_only();

-- ----------------------------------------------------------- the guards ----
--
-- The design lives here rather than in any caller. Every rule below is one a
-- reasonable-looking UPDATE on a Tuesday would otherwise walk straight past.

create or replace function public.park_renters_claim_guard()
returns trigger language plpgsql as $$
begin
  if new.park_id is distinct from old.park_id then
    raise exception 'a file cannot move between parks';
  end if;

  -- A re-claim is release-then-claim, never an overwrite. Overwriting hands a
  -- live ledger to a second person with no record that the first one held it.
  if old.user_id is not null and new.user_id is not null
     and new.user_id is distinct from old.user_id then
    raise exception 'that file is already set up — release it first';
  end if;

  -- The office may not rename a claimed file. Renaming is how every other
  -- control here gets bypassed: the household becomes a different household
  -- while keeping the account, the ledger and the tenancy. The correct path is
  -- to end the tenancy and open a new one, and this error is the teaching.
  if old.user_id is not null and new.display_name is distinct from old.display_name then
    raise exception 'end the tenancy and open a new household instead of renaming a file someone is signed in to';
  end if;

  -- SETTING UP AN ACCOUNT IS NOT CONFIRMING A RENT FIGURE, and it is not
  -- consent. Both are separate acts with a person's name on them.
  if old.user_id is null and new.user_id is not null then
    if new.confirmed_at is distinct from old.confirmed_at
       or new.source is distinct from old.source
       or new.display_name is distinct from old.display_name
       or new.email is distinct from old.email
       or new.mobile_e164 is distinct from old.mobile_e164
       or new.contact_pref is distinct from old.contact_pref
       or new.sms_consent_operational_at is distinct from old.sms_consent_operational_at
       or new.sms_consent_marketing_at is distinct from old.sms_consent_marketing_at then
      raise exception 'claiming a file may not also change what the park knows about the household';
    end if;

    -- A park manager claiming a resident file is the shape of the abuse this
    -- whole design exists to prevent. A genuine owner-resident — The Haven's
    -- Lot 11 is one — goes through ops, deliberately, because that case is
    -- rarer than the abuse.
    if exists (
      select 1 from public.park_members m
       where m.park_id = new.park_id and m.user_id = new.user_id
    ) and coalesce(current_setting('lakelife.ops_claim_override', true), '') <> 'on' then
      raise exception 'a park manager cannot claim a resident file — ask ops';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists park_renters_claim_guard on public.park_renters;
create trigger park_renters_claim_guard
  before update on public.park_renters
  for each row execute function public.park_renters_claim_guard();

create or replace function public.park_renters_claim_stamp()
returns trigger language plpgsql as $$
begin
  -- Single-use is a property of the table, not of every future caller.
  if old.user_id is null and new.user_id is not null then
    new.claimed_at            := now();
    new.claim_code_hash       := null;
    new.claim_code_expires_at := null;
    new.claim_code_attempts   := 0;
    new.claim_locked_until    := null;
  end if;

  -- Released: keep claimed_at (it is true — this was set up once) and close
  -- any code, so releasing never leaves a live door open behind it.
  if old.user_id is not null and new.user_id is null then
    new.claim_code_hash       := null;
    new.claim_code_expires_at := null;
  end if;

  -- Renaming an UNCLAIMED file means a new household moved in. The previous
  -- household's contact facts and confirmations must not survive that, or the
  -- park ends up texting the person who moved out about the rent of the person
  -- who moved in.
  if old.user_id is null and new.display_name is distinct from old.display_name then
    new.mobile_e164                := null;
    new.mobile_verified_at         := null;
    new.sms_consent_operational_at := null;
    new.sms_consent_marketing_at   := null;
    new.confirmed_at               := null;
    new.claim_code_hash            := null;
    new.claim_code_expires_at      := null;
  end if;

  return new;
end $$;

drop trigger if exists park_renters_claim_stamp on public.park_renters;
create trigger park_renters_claim_stamp
  before update on public.park_renters
  for each row execute function public.park_renters_claim_stamp();

-- ------------------------------------------------------- post-conditions --
--
-- The refusals are the feature, so they are PROVEN to fire rather than
-- assumed. Everything below runs inside a savepoint that is rolled back.

do $$
declare
  v_park uuid; v_a uuid; v_b uuid; v_file uuid;
  ok boolean; n integer;
begin
  -- 1. THE PLAINTEXT COLUMN IS GONE.
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='park_renters' and column_name='claim_code';
  if n <> 0 then raise exception '0128: park_renters.claim_code still exists'; end if;

  -- 2. anon CANNOT CALL ANY OF IT. `anon` is the key in every page bundle, and
  --    a SECURITY DEFINER function is world-callable unless revoked.
  if has_function_privilege('anon', 'public.claim_park_file(text,text,text)', 'execute')
  then raise exception '0128: anon can call claim_park_file'; end if;
  if has_function_privilege('anon', 'public.issue_park_claim_code(uuid,text,integer)', 'execute')
  then raise exception '0128: anon can issue codes'; end if;
  if not has_function_privilege('authenticated', 'public.claim_park_file(text,text,text)', 'execute')
  then raise exception '0128: signed-in users cannot claim'; end if;

  -- 3. THE CLIENT STILL CANNOT WRITE park_renters DIRECTLY. Everything goes
  --    through the functions above; a direct UPDATE would bypass every guard.
  if has_table_privilege('authenticated', 'public.park_renters', 'update')
  then raise exception '0128: authenticated regained UPDATE on park_renters'; end if;
  if has_table_privilege('authenticated', 'public.park_renter_claim_events', 'insert')
  then raise exception '0128: authenticated can write claim events'; end if;

  -- 4. park_renters HAS EXACTLY ONE POLICY, and it is the read one. An UPDATE
  --    policy here would read as "you may claim an unclaimed file" and mean
  --    "any signed-in person may rewrite any unclaimed file".
  select count(*) into n from pg_policy where polrelid = 'public.park_renters'::regclass;
  if n <> 1 then raise exception '0128: park_renters has % policies, expected exactly 1', n; end if;

  -- 5. THE TRIGGERS EXIST BY NAME.
  foreach ok in array array[
    (select count(*) = 1 from pg_trigger where tgname = 'park_renters_claim_guard' and not tgisinternal),
    (select count(*) = 1 from pg_trigger where tgname = 'park_renters_claim_stamp' and not tgisinternal),
    (select count(*) = 1 from pg_trigger where tgname = 'park_renter_claim_events_no_edit' and not tgisinternal)
  ] loop
    if not ok then raise exception '0128: a claim trigger is missing'; end if;
  end loop;

  -- ---- behavioural proofs, on a throwaway file ---------------------------
  --
  -- THE CLAIMANTS MUST NOT MANAGE THIS PARK, and the first draft of this got
  -- it wrong in a way worth keeping a note about: it took the oldest user,
  -- who is the owner of the only park in the database, and the migration
  -- failed with "a park manager cannot claim a resident file". The guard was
  -- right and the test was wrong — which is the best possible way to find out
  -- a guard works.
  select id into v_park from public.parks limit 1;
  select id into v_a from public.users u
   where not exists (select 1 from public.park_members m
                      where m.user_id = u.id and m.park_id = v_park)
   order by u.created_at limit 1;
  select id into v_b from public.users u
   where u.id <> v_a
     and not exists (select 1 from public.park_members m
                      where m.user_id = u.id and m.park_id = v_park)
   order by u.created_at limit 1;
  if v_park is null or v_a is null or v_b is null then return; end if;

  begin
    insert into public.park_renters (park_id, display_name, source)
    values (v_park, 'zz-0128 proof', 'prior_roll') returning id into v_file;

    -- 6. CLAIMING STAMPS AND CLOSES THE CODE IN ONE MOVE.
    update public.park_renters
       set claim_code_hash = crypt('ABCDEFGH', gen_salt('bf', 4)),
           claim_code_expires_at = now() + interval '30 days',
           claim_code_issued_by = v_a
     where id = v_file;
    update public.park_renters set user_id = v_a where id = v_file;
    select count(*) into n from public.park_renters
     where id = v_file and claimed_at is not null and claim_code_hash is null;
    if n <> 1 then raise exception '0128: claiming did not stamp and close the code'; end if;

    -- 7. A SECOND PERSON CANNOT OVERWRITE A CLAIMED FILE. Overwriting hands a
    --    live ledger to somebody else with no record the first person had it.
    ok := false;
    begin
      update public.park_renters set user_id = v_b where id = v_file;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0128: a claimed file was overwritten'; end if;

    -- 8. AND A CLAIMED FILE CANNOT BE RENAMED. This is the cheap guard that
    --    stops every other control being bypassed by a reasonable edit.
    ok := false;
    begin
      update public.park_renters set display_name = 'Someone Else' where id = v_file;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0128: a claimed file was renamed'; end if;

    -- 9. RELEASING KEEPS claimed_at — it is true that this was set up once.
    update public.park_renters set user_id = null where id = v_file;
    select count(*) into n from public.park_renters
     where id = v_file and user_id is null and claimed_at is not null;
    if n <> 1 then raise exception '0128: releasing lost the fact it was ever set up'; end if;

    -- 10. RENAMING AN UNCLAIMED FILE WIPES THE OLD HOUSEHOLD'S CONTACT FACTS.
    --     Otherwise the park texts whoever moved out about the rent of
    --     whoever moved in.
    update public.park_renters
       set mobile_e164 = '+12604631234', confirmed_at = now() where id = v_file;
    update public.park_renters set display_name = 'zz-0128 new household' where id = v_file;
    select count(*) into n from public.park_renters
     where id = v_file and mobile_e164 is null and confirmed_at is null;
    if n <> 1 then raise exception '0128: a rename carried the old household forward'; end if;

    -- 11. A CODE CANNOT BE STORED WITHOUT AN EXPIRY.
    ok := false;
    begin
      update public.park_renters set claim_code_hash = 'x', claim_code_expires_at = null
       where id = v_file;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0128: a code without an expiry was accepted'; end if;

    -- 12. A BADLY SHAPED PHONE NUMBER IS REFUSED — the send target stays one
    --     shape, so a reminder cannot silently go nowhere.
    ok := false;
    begin
      update public.park_renters set mobile_e164 = '2605550142' where id = v_file;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0128: a non-E.164 mobile was accepted'; end if;

    -- 13. A PARK MANAGER CANNOT CLAIM A RESIDENT FILE. Pinned because it is
    --     the shape of the abuse this whole design exists to prevent, and
    --     because it fired for real on the first run of this migration.
    ok := false;
    begin
      update public.park_renters set user_id = (
        select m.user_id from public.park_members m where m.park_id = v_park limit 1
      ) where id = v_file and exists (select 1 from public.park_members where park_id = v_park);
      -- No members at this park: nothing to prove, treat as passed.
      if not exists (select 1 from public.park_members where park_id = v_park) then ok := true; end if;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0128: a park manager claimed a resident file'; end if;
    update public.park_renters set user_id = null where id = v_file;

    -- 14. THE EVENT LOG IS APPEND-ONLY.
    insert into public.park_renter_claim_events (renter_id, park_id, event, actor_user_id)
    values (v_file, v_park, 'code_issued', v_a);
    ok := false;
    begin
      update public.park_renter_claim_events set event = 'claimed' where renter_id = v_file;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0128: a claim event was edited'; end if;
    ok := false;
    begin
      delete from public.park_renter_claim_events where renter_id = v_file;
    exception when others then ok := true;
    end;
    if not ok then raise exception '0128: a claim event was deleted'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
