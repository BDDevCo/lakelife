-- 0139 — ONE ROW PER THING AGREED TO
--
-- Acceptance has been two columns on `users` since 0038: `tos_version` and
-- `tos_accepted_at`, both OVERWRITTEN IN PLACE. Three consequences, and each
-- one is load-bearing:
--
--   1. A PERSON CAN ACCEPT EXACTLY ONE DOCUMENT, EVER. Accepting a second
--      destroys the record of the first. A renter who must acknowledge our
--      terms AND a park lease AND a rulebook is not representable at all.
--   2. THE WORDS WERE NEVER KEPT. A version string cannot answer what somebody
--      agreed to. 0133 already settled this for SMS consent — "the exact words
--      are snapshotted beside the timestamp, at the moment of the tap, in the
--      same write" — and the ToS never got the same treatment.
--   3. TWO OF FOUR ROLES HAVE ACCEPTED NOTHING. There is no acceptance path
--      for a park owner or a renter, and neither is mentioned in the terms.
--
-- So: a ledger. One row per act, never updated, never deleted.
--
-- WHY NOT A FOREIGN KEY ON THE PERSON. Same reasoning 0128 gives for the claim
-- log: an FK with ON DELETE CASCADE would let closing an account erase the
-- evidence that its owner ever agreed to anything, and ON DELETE SET NULL
-- would leave a row that says somebody agreed without saying who. Evidence
-- must outlive the account it is about. The email is snapshotted beside the id
-- for the same reason.
--
-- WHY TWO SUBJECT COLUMNS. 0055 holds a rule mechanically: no park_* table may
-- make `users.id` its only pointer to a person, because a renter file exists
-- before any login does — at The Haven, nineteen households will have a file
-- and no account for weeks. An acceptance must be able to hang off the FILE.
-- Exactly one of the two is set, and the check below enforces it.
--
-- WITHDRAWAL IS AN APPEND, NOT AN ERASURE. `stopTexts()` currently nulls
-- `sms_consent_text`, so withdrawing consent destroys the record of what was
-- consented to. That is the wrong shape and this table refuses to repeat it:
-- withdrawing is a new row with act='withdrawn'. "She agreed, then moved out"
-- stays answerable forever.

create table if not exists public.acceptances (
  id           uuid primary key default gen_random_uuid(),

  -- WHO. Exactly one, never both, never neither.
  user_id        uuid,          -- deliberately no FK: see the header
  park_renter_id uuid,          -- a household with a file and no login yet
  actor_email    text,          -- snapshotted; the account may be gone later

  -- WHAT. `document_version` is free text because a park's own rulebook has no
  -- version scheme we control; ours carry TOS_VERSION.
  document_kind    text not null
    check (document_kind in ('tos', 'privacy', 'park_rules', 'park_lease', 'amenity_rules')),
  document_version text,
  -- The words themselves. Nullable ONLY for rows migrated from the two columns
  -- that never stored them — see the check below, which forbids it otherwise.
  document_text    text,
  -- sha256 of document_text. Cheap proof that two acceptances were of
  -- identical terms without comparing blobs, and the thing to compare when
  -- somebody asks whether the document changed under them.
  text_sha256      text,

  -- WHICH PARK, for a document a park authored. Null for LakeLife's own.
  park_id uuid references public.parks(id) on delete set null,

  -- THE ACT.
  act text not null default 'accepted' check (act in ('accepted', 'withdrawn')),
  -- How it was given. Not a signature: LakeLife hosts no signature it is not a
  -- party to (owner decision, 20 Aug 2026). A clickwrap is a person tapping a
  -- button under words we showed them.
  method text not null default 'clickwrap'
    check (method in ('clickwrap', 'imported_record')),

  occurred_at timestamptz not null default now(),

  -- WHERE IT CAME FROM. 'live' means this row was written at the moment of the
  -- act and its words are the words on screen. 'migrated_pre_ledger' means it
  -- was reconstructed from users.tos_version, which never stored any text —
  -- and that row must not pretend otherwise.
  provenance text not null default 'live'
    check (provenance in ('live', 'migrated_pre_ledger')),

  -- Exactly one subject.
  constraint acceptances_one_subject check (
    (user_id is not null) <> (park_renter_id is not null)
  ),

  -- A LIVE ROW CARRIES ITS WORDS. This is the whole point of the table, so it
  -- is a constraint rather than a convention. A migrated row is exempt and is
  -- marked as such, because inventing the text somebody saw in July would be
  -- worse than admitting it was never captured.
  constraint acceptances_live_rows_carry_their_words check (
    provenance <> 'live'
    or (document_text is not null and length(btrim(document_text)) > 0
        and text_sha256 is not null)
  )
);

comment on table public.acceptances is
  'Append-only ledger of every agreement anybody has given: one row per act, '
  'never updated, never deleted. Supersedes users.tos_version/tos_accepted_at, '
  'which held one acceptance per person and none of the words. A withdrawal is '
  'a new row with act=''withdrawn'', never an erasure of the acceptance.';

comment on column public.acceptances.document_text is
  'The words EXACTLY as shown, snapshotted at the moment of the act. NULL only '
  'on rows migrated from the pre-ledger columns, which never stored any text.';

comment on column public.acceptances.park_renter_id is
  'For a household that has a park file but no login yet. 0055 forbids making '
  'users.id the only pointer to a person, and nineteen Haven households will '
  'have a file and no account.';

comment on column public.acceptances.provenance is
  'live = written at the moment of the act, words are what was on screen. '
  'migrated_pre_ledger = reconstructed from users.tos_version; the version and '
  'the timestamp are real, the text was never captured and stays NULL.';

-- "What has this person agreed to, latest first" is the only read shape.
create index if not exists acceptances_user_idx
  on public.acceptances (user_id, document_kind, occurred_at desc)
  where user_id is not null;

create index if not exists acceptances_renter_idx
  on public.acceptances (park_renter_id, document_kind, occurred_at desc)
  where park_renter_id is not null;

-- ------------------------------------------------------------ append-only ---
-- A grant can drift; a trigger holds. Copied from 0128, for the same reason.

create or replace function public.acceptances_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'acceptances is append-only (attempted %) — withdraw by appending act=''withdrawn''', tg_op;
end $$;

drop trigger if exists acceptances_no_edit on public.acceptances;
create trigger acceptances_no_edit
  before update or delete on public.acceptances
  for each row execute function public.acceptances_append_only();

-- ------------------------------------------------------------------ access ---
--
-- A person may read their OWN acceptances — the design calls for showing
-- everyone what they agreed to, and that promise needs a readable row. Writes
-- are service-role only, everywhere, as with every other park table.

alter table public.acceptances enable row level security;

drop policy if exists acceptances_read_own on public.acceptances;
create policy acceptances_read_own on public.acceptances
  for select using (
    (user_id is not null and user_id = auth.uid())
    or public.ll_is_ops()
  );

revoke all on public.acceptances from anon;
revoke insert, update, delete, truncate on public.acceptances from authenticated;
grant select on public.acceptances to authenticated;

-- --------------------------------------------------------------- backfill ---
--
-- The four existing acceptances move in, honestly. We know WHO, WHICH VERSION
-- and WHEN. We do not know the words — 0038 never stored them — so
-- document_text stays NULL and provenance says exactly why. Inventing today's
-- terms here would assert that four people read wording that may not have
-- existed when they tapped, which is the defect this whole table exists to end.
--
-- The old columns are left in place and untouched. Nothing reads them after
-- this migration; they are the recovery copy until the ledger has been running
-- long enough to trust, and a later migration drops them.

insert into public.acceptances
  (user_id, actor_email, document_kind, document_version, occurred_at,
   act, method, provenance)
select
  u.id,
  u.email,
  'tos',
  u.tos_version,
  coalesce(u.tos_accepted_at, now()),
  'accepted',
  'imported_record',
  'migrated_pre_ledger'
from public.users u
where u.tos_version is not null
  and not exists (
    select 1 from public.acceptances a
     where a.user_id = u.id
       and a.document_kind = 'tos'
       and a.provenance = 'migrated_pre_ledger'
  );

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  n int;
  expected int;
begin
  -- The table is append-only in fact, not just in intention.
  select count(*) into n
    from pg_trigger
   where tgrelid = 'public.acceptances'::regclass
     and tgname = 'acceptances_no_edit'
     and not tgisinternal;
  if n <> 1 then
    raise exception '0139: acceptances is not append-only';
  end if;

  -- Both invariants are checks, not conventions.
  for n in
    select 1 from (values
      ('acceptances_one_subject'),
      ('acceptances_live_rows_carry_their_words')
    ) as want(name)
    where not exists (
      select 1 from pg_constraint
       where conrelid = 'public.acceptances'::regclass
         and conname = want.name
    )
  loop
    raise exception '0139: a required check constraint is missing';
  end loop;

  -- EVERYBODY WHO HAD AN ACCEPTANCE STILL HAS ONE.
  --
  -- Asserted as "no user with a version lacks a row", NOT as a count match
  -- between the two tables. Counting would contradict this table's own design:
  -- the ledger row deliberately has no FK and OUTLIVES the account it is about
  -- (see the header), so the first time somebody closes their account the
  -- `users` count drops, the `acceptances` count does not, and a replay of this
  -- migration aborts on a database that is perfectly correct. The rule worth
  -- asserting is that nobody was LOST, and that is a one-sided check.
  select count(*) into expected
    from public.users u
   where u.tos_version is not null
     and not exists (
       select 1 from public.acceptances a
        where a.user_id = u.id
          and a.document_kind = 'tos'
          and a.provenance = 'migrated_pre_ledger'
     );
  if expected <> 0 then
    raise exception '0139: backfill lost somebody — % users with a version have no ledger row',
      expected;
  end if;

  -- And no migrated row is pretending to know words it never had.
  select count(*) into n
    from public.acceptances
   where provenance = 'migrated_pre_ledger' and document_text is not null;
  if n <> 0 then
    raise exception '0139: % migrated rows claim to carry text that was never stored', n;
  end if;

  -- anon holds nothing at all. Easier to verify than a list of six privileges.
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'acceptances' and grantee = 'anon';
  if n <> 0 then
    raise exception '0139: anon still holds % grants on acceptances', n;
  end if;
end $$;
