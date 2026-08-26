-- ============================================================================
-- 0140 — THE FILE, AND WHO WAS GIVEN IT. NEVER WHO AGREED.
--
-- COURIER, NOT WITNESS. The decision this table implements, in the owner's
-- words: LakeLife hosts no signature it is not a party to. A lease is between
-- the park and the household. LakeLife administers the billing under it, and a
-- platform that collected the signature would be holding itself out as a party
-- to an agreement it has no place in.
--
-- So there are exactly two facts here, and neither of them is agreement:
--
--   WHAT THE FILE IS   — park_documents. The park owner's own lease, rules or
--                        notice, filed with a digest so "this exact file" can
--                        be answered a year later.
--   WHO WAS GIVEN IT   — park_document_deliveries. Sent, and where knowable,
--                        opened.
--
-- The vocabulary is SENT and OPENED. There is no agreed_at, no signed_at and no
-- accepted_at, and the post-condition at the bottom of this file proves these
-- tables SHIP without one.
--
-- THAT CHECK IS A SHIP-TIME ASSERTION, NOT A STANDING GUARD, and the difference
-- matters enough to say out loud. A do-block runs once, in the transaction that
-- applies this file; a later migration adding `signed_at` would never re-run it.
-- The standing guard is a repo test — src/app/park/document-helpers.test.ts
-- walks EVERY file in supabase/migrations and fails on any create/alter/rename
-- that gives either table a column matching the pattern below. Both use the
-- same alternation so they cannot disagree about what they forbid.
--
-- This is not decoration: the single most likely future change here is somebody
-- adding "signed" because a screen would look tidier with it, and the whole
-- legal posture turns on it not being there.
--
-- WHY A DIGEST. 0139 snapshots the WORDS of a clickwrap, because a version
-- string cannot answer what somebody actually read. A PDF cannot be snapshotted
-- into a text column, so its sha256 stands in the same place: the file on disk
-- either hashes to what the row says or it is not the file that was delivered.
--
-- OPENED IS ONLY KNOWABLE FOR A LINK WE SERVED. A document handed over at the
-- office window is delivered and unknowable; a posted one likewise. Recording
-- an `opened_at` for either would be a fact nothing produced. The constraint
-- below makes that structural rather than a matter of care.
-- ============================================================================

-- ------------------------------------------------------------- the file ----

create table if not exists public.park_documents (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,

  -- Same vocabulary as acceptances.document_kind, so the two can be talked
  -- about together — but note they never mix: a thing filed here is a document
  -- the PARK authored, and a row in acceptances is something a person agreed
  -- to with LAKELIFE.
  kind          text not null
                  check (kind in ('park_lease', 'park_rules', 'amenity_rules', 'notice', 'other')),

  -- What the owner calls it, because it prints on a resident's screen.
  title         text not null check (length(trim(title)) between 2 and 120),
  -- His own label, not ours. "2027 lease", "Rev C", "January".
  version       text not null check (length(trim(version)) between 1 and 40),

  storage_path  text not null,
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size     integer not null check (byte_size > 0),
  content_type  text not null,

  filed_by      uuid references public.users(id) on delete set null,
  filed_at      timestamptz not null default now(),

  -- NEVER DELETED, SUPERSEDED. A document that was delivered to nineteen
  -- households is a record of what they were given; removing it would destroy
  -- the only evidence of what was sent, which is the entire point of filing it.
  superseded_at timestamptz,
  superseded_by uuid references public.park_documents(id) on delete set null,
  constraint park_doc_superseded_together
    check ((superseded_at is null) = (superseded_by is null)),

  unique (park_id, kind, version)
);

comment on table public.park_documents is
  'A document the PARK authored, filed by its owner. LakeLife is not a party '
  'to it and holds no signature for it — see park_document_deliveries.';

comment on column public.park_documents.sha256 is
  'The file digest. A version string cannot answer WHICH file was delivered; '
  'this can.';

create index if not exists park_documents_park_idx
  on public.park_documents (park_id, kind) where superseded_at is null;

-- -------------------------------------------------------- who was given it --

create table if not exists public.park_document_deliveries (
  id             uuid primary key default gen_random_uuid(),
  document_id    uuid not null references public.park_documents(id) on delete cascade,
  park_renter_id uuid not null references public.park_renters(id) on delete cascade,

  channel        text not null check (channel in ('email', 'hand', 'post')),

  sent_at        timestamptz not null default now(),

  -- OPENED IS ONLY KNOWABLE FOR A LINK WE SERVED. Handed over at the window or
  -- put in the post, the park knows it was delivered and cannot know it was
  -- read. A nullable column filled for those channels would be a number
  -- somebody would later average.
  opened_at      timestamptz,
  constraint park_doc_opened_only_by_link
    check (opened_at is null or channel = 'email'),

  -- What makes 'opened' knowable at all: one link per household per document.
  -- Without it opened_at would be a column with no writer, which is this
  -- codebase's most-repaired defect.
  token          text unique,
  constraint park_doc_email_has_token
    check (channel <> 'email' or token is not null),

  unique (document_id, park_renter_id)
);

comment on table public.park_document_deliveries is
  'SENT, and where knowable OPENED. Never agreed: LakeLife is a courier here, '
  'not a witness, and no column on this table may record assent.';

create index if not exists park_doc_deliveries_doc_idx
  on public.park_document_deliveries (document_id);
create index if not exists park_doc_deliveries_renter_idx
  on public.park_document_deliveries (park_renter_id);

-- ------------------------------------------------------------- the bucket --
--
-- PRIVATE, like every other bucket here. A lease carries names, rents and
-- addresses; every read is a short-lived signed URL minted server-side after
-- an authorization check. There is no public-URL code path in this app and
-- adding one would expose all three buckets.
insert into storage.buckets (id, name, public, file_size_limit)
values ('park-docs', 'park-docs', false, 10485760)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- ------------------------------------------------------------------- rls ---
--
-- Both tables are served through the service role after assertMyPark, the same
-- as the rest of the park module. Clients get nothing: a lease names other
-- households' business, and a delivery log is a record about a person.
--
-- REVOKE, not just RLS. A default grant survives RLS being enabled and this
-- codebase has been bitten by exactly that before.
alter table public.park_documents           enable row level security;
alter table public.park_document_deliveries enable row level security;

revoke all on public.park_documents           from anon, authenticated;
revoke all on public.park_document_deliveries from anon, authenticated;

-- ------------------------------------------------------- post-conditions ---
do $$
declare n int; bad text;
begin
  -- THE ONE THAT MATTERS — but read what it is. This proves the two tables are
  -- BORN without a column recording assent. It runs once, here, and cannot
  -- catch a later migration that adds one; the standing guard for that is the
  -- all-migrations scanner in src/app/park/document-helpers.test.ts, which
  -- applies this same alternation to every .sql in the directory.
  select string_agg(column_name, ', ') into bad
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('park_documents', 'park_document_deliveries')
     and (
       column_name ~ '(sign|agree|accept|consent|assent|acknowledg)'
     );
  if bad is not null then
    raise exception
      '0140: a column recording ASSENT appeared on the document tables (%). '
      'LakeLife is a courier here, not a witness — a signature belongs between '
      'the park and the household, not in this database.', bad;
  end if;

  -- The digest, without which a filed document cannot answer "which file".
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'park_documents'
       and column_name = 'sha256'
  ) then
    raise exception '0140: park_documents.sha256 missing — a version string cannot say which file was delivered';
  end if;

  -- Opened must stay unknowable for a channel that cannot know it.
  if not exists (
    select 1 from pg_constraint where conname = 'park_doc_opened_only_by_link'
  ) then
    raise exception '0140: park_doc_opened_only_by_link missing — a handed-over document could be recorded as read';
  end if;

  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('park_documents', 'park_document_deliveries')
     and grantee in ('anon', 'authenticated');
  if n > 0 then
    raise exception '0140: % client grants remain on the document tables', n;
  end if;

  select count(*) into n from storage.buckets where id = 'park-docs' and public;
  if n > 0 then
    raise exception '0140: park-docs bucket is PUBLIC — a lease would be readable by anyone with the path';
  end if;

  raise notice '0140: the park files its own documents, and the log says sent and opened — never agreed.';
end $$;
