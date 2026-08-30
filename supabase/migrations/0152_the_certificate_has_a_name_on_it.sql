-- 0152 — THE CERTIFICATE HAS A NAME ON IT.
--
-- The owner settled the insurance posture on 30 Aug 2026, in his own words:
--
--   "we look at the certs and make sure they aren't expired, make sure they
--    match the business that turned them in and that is it. we do not
--    validate coverage, we do not determine if the policy is enough $$ —
--    that's not our job."
--
-- That is the ordinary third-party-administrator position, it is defensible,
-- and the live terms already describe something like it to every customer.
--
-- IT WAS ALSO TWO-THIRDS UNTRUE.
--
--   * "make sure they aren't expired" — enforced, but against a date the CREW
--     TYPES INTO A FORM (`uploadVendorDoc` reads `form.get("expiry")`).
--     Nobody opens the certificate. A crew who types 2030 is unexpired until
--     2030.
--   * "make sure they match the business that turned them in" — DID NOT EXIST.
--     Not in any form. `vendors.company` is free text and no code had ever
--     read it for this purpose; a grep for named_insured / insured_name /
--     entity match across src and supabase returned nothing at all.
--   * "we do not validate coverage" — correctly, faithfully silent. The one
--     part the build already got right.
--
-- So this migration is what makes the stated policy true, and nothing beyond
-- it. It does not read a document, score a policy, or hold an opinion about a
-- limit. Those remain deliberately absent, and the addenda say so to the
-- customer in plain words.
--
-- ============ WHAT THIS ADDS ============
--
--   vendors.coi_named_insured / garagekeepers_named_insured
--     The business name as it appears ON the certificate, typed by the crew.
--     Compared against `vendors.company` by `checkNamedInsured`
--     (src/lib/named-insured.ts) — case, punctuation, `&`/`and` and legal
--     suffixes folded, then EXACT. No fuzzy matching: a loose rule fails open
--     on the one document that exists to say whose insurance this is.
--
--   vendors.*_expiry_confirmed_at / _by
--     Somebody at LakeLife opened the file and agreed the typed date is the
--     date on it. Nullable and unset by default, because on the day this ships
--     nobody has confirmed anything and a default of "confirmed" would be the
--     pre-ticked box that wrote nineteen unsigned leases (0133).
--
-- ============ AND ONE RULE THE DATABASE KEEPS ============
--
-- A confirmation is about a SPECIFIC FILE. Replace the file and the
-- confirmation is meaningless — it attests to a document nobody is looking at
-- any more. Leaving that to the application would make it exactly the defect
-- this codebase keeps paying for: a column read everywhere and cleared in only
-- the one code path somebody remembered.
--
-- So the trigger below clears the confirmation whenever the document URL
-- changes. `uploadVendorDoc` also clears it, deliberately — belt and braces,
-- because the action is where the crew-facing message lives. The trigger is
-- what makes it TRUE regardless of who writes.

-- ------------------------------------------------------------ 1. columns ---

alter table public.vendors
  add column if not exists coi_named_insured                text,
  add column if not exists coi_expiry_confirmed_at          timestamptz,
  add column if not exists coi_expiry_confirmed_by          uuid references public.users(id) on delete set null,
  add column if not exists garagekeepers_named_insured      text,
  add column if not exists garagekeepers_expiry_confirmed_at timestamptz,
  add column if not exists garagekeepers_expiry_confirmed_by uuid references public.users(id) on delete set null;

comment on column public.vendors.coi_named_insured is
  'The insured business name as it appears on the certificate, TYPED BY THE '
  'CREW — nobody at LakeLife reads the document. Compared to vendors.company '
  'by checkNamedInsured(); a mismatch is an activation gap, not a refused '
  'upload, because a genuine DBA is a conversation and the paperwork should '
  'still be on file while it happens.';

comment on column public.vendors.coi_expiry_confirmed_at is
  'When a person at LakeLife opened the certificate and agreed the typed '
  'expiry is the one printed on it. NULL means nobody has looked. Cleared '
  'automatically whenever the document is replaced (see the trigger below) — '
  'a confirmation is about one specific file.';

-- --------------------------------------- 2. a confirmation cannot outlive ---
--                                            the document it was about

create or replace function public.clear_stale_doc_confirmations()
returns trigger
language plpgsql
as $$
begin
  if new.coi_url is distinct from old.coi_url then
    new.coi_expiry_confirmed_at := null;
    new.coi_expiry_confirmed_by := null;
  end if;
  if new.garagekeepers_url is distinct from old.garagekeepers_url then
    new.garagekeepers_expiry_confirmed_at := null;
    new.garagekeepers_expiry_confirmed_by := null;
  end if;
  return new;
end $$;

revoke all on function public.clear_stale_doc_confirmations() from public, anon, authenticated;

drop trigger if exists vendors_clear_stale_doc_confirmations on public.vendors;
create trigger vendors_clear_stale_doc_confirmations
  before update on public.vendors
  for each row
  execute function public.clear_stale_doc_confirmations();

-- ------------------------------------------------------ post-conditions ----
--
-- SHIP-TIME ASSERTIONS. They run once and cannot police the next migration —
-- except the trigger above, which is a standing rule and is proved here.

do $$
declare n int; vid uuid; confirmed timestamptz;
begin
  -- 1. THE COLUMNS EXIST AND ARE OPTIONAL. Every vendor row predates them,
  --    and a NOT NULL would refuse every write to an existing crew.
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='vendors'
     and column_name in ('coi_named_insured','coi_expiry_confirmed_at','coi_expiry_confirmed_by',
                         'garagekeepers_named_insured','garagekeepers_expiry_confirmed_at',
                         'garagekeepers_expiry_confirmed_by');
  if n <> 6 then
    raise exception '0152: expected 6 new columns, found %', n;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='vendors'
       and column_name like '%_named_insured' and is_nullable = 'NO'
  ) then
    raise exception '0152: a named-insured column is NOT NULL — every existing crew predates it';
  end if;

  -- 2. NOTHING IS RETROSPECTIVELY CONFIRMED. Nobody has opened a certificate
  --    as of this migration, and saying otherwise would be the pre-ticked box.
  select count(*) into n from public.vendors
   where coi_expiry_confirmed_at is not null or garagekeepers_expiry_confirmed_at is not null;
  if n <> 0 then
    raise exception '0152: % crew(s) arrived already confirmed — nobody has looked at anything yet', n;
  end if;

  -- 3. THE TRIGGER ACTUALLY FIRES. Proved on a throwaway crew that is rolled
  --    back with the rest of this block — a trigger nobody exercised is a rule
  --    nobody has.
  -- NO USER IS CREATED. `users.id` has no default (it mirrors the auth row),
  -- and `vendors.user_id` is nullable — so the cheapest honest fixture for a
  -- trigger that only reads vendor columns is a crew with no account behind it.
  begin
    insert into public.vendors (company, status, coi_url, coi_expiry, coi_named_insured)
    values ('0152 Proof Co', 'invited', 'proof/coi-a.pdf', current_date + 30, '0152 Proof Co')
    returning id into vid;

    -- Confirm it, the way ops will.
    update public.vendors set coi_expiry_confirmed_at = now() where id = vid;
    select coi_expiry_confirmed_at into confirmed from public.vendors where id = vid;
    if confirmed is null then
      raise exception '0152: the confirmation could not be written at all';
    end if;

    -- An UNRELATED update must LEAVE IT ALONE, or every ordinary edit to a
    -- crew row would silently unconfirm their paperwork.
    update public.vendors set daily_capacity = 4 where id = vid;
    select coi_expiry_confirmed_at into confirmed from public.vendors where id = vid;
    if confirmed is null then
      raise exception '0152: an unrelated update cleared the confirmation — the trigger is too greedy';
    end if;

    -- REPLACING THE DOCUMENT MUST CLEAR IT. This is the rule.
    update public.vendors set coi_url = 'proof/coi-b.pdf' where id = vid;
    select coi_expiry_confirmed_at into confirmed from public.vendors where id = vid;
    if confirmed is not null then
      raise exception '0152: a new certificate kept the old confirmation — it attests to a file nobody is looking at';
    end if;

    raise exception 'ROLLBACK_0152_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_0152_PROOF' then raise; end if;
  end;
end $$;
