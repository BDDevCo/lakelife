-- 0124 — A FIXTURE SHOULD NOT NEED A GOOD NAME
--
-- Until now, the only thing keeping a test lake off the live public site was
-- its NAME. Eight hand-written filters each spelled out `zz-%`:
--
--   src/app/page.tsx:26          homepage lake list      filtered NAME
--   src/app/lakes/page.tsx:20    public lake directory   filtered SLUG
--   src/app/sitemap.ts:14        sitemap.xml             filtered SLUG
--   src/app/ops/crews-invite.ts  crew invitation EMAIL   filtered NAME
--   src/app/ops/page.tsx:121     ops header              startsWith() in JS
--   src/lib/lake-birth.ts:58     season donor lookup     filtered NAME
--   src/lib/lake-name.ts:14      rejects a typed zz- name (pure, stays)
--
-- Three things were wrong with that.
--
-- ONE: half the guards read `name` and half read `slug`, so a fixture named
-- correctly but slugged wrongly was hidden from some surfaces and visible on
-- the others. There was no single answer to "is this row real?".
--
-- TWO: a NULL slug passes none of them. `NOT (NULL ILIKE 'zz-%')` is NULL, not
-- TRUE, so PostgREST drops the row — the fixture is hidden by ACCIDENT rather
-- than by decision, and the accident reverses the moment somebody fills the
-- slug in.
--
-- THREE, and the reason this is a migration and not a tidy-up: the rule lived
-- entirely in the readers. Nothing stopped anyone CREATING an unfenced
-- fixture. On 14 Aug 2026 a parallel session did exactly that — inserted
-- "Scratch Test Lake", no prefix, null slug — and it went straight onto the
-- production homepage. It missed /lakes and sitemap.xml only because of the
-- NULL above. The sitemap is the one that would have lasted: it hands Google a
-- crawlable URL that outlives any fixture cleanup.
--
-- ------------------------------------------------------------------ what --
--
-- `is_fixture` is one not-null boolean. Not `is_test`: there is ONE database
-- here, shared by every session and by production, so "test" invites the
-- reading "belongs to the test environment", which is never true of anything
-- in this table. This row is a fixture living in the real database.
--
-- It is NOT `active`. Parks already use `parks.active` as a launch switch, and
-- "not launched yet" is a different fact from "not real" — a genuine lake
-- being onboarded must be able to sit unlaunched without being branded fake,
-- and a fixture must stay fenced even when everything about it looks ready.
-- Conflating the two would make one of the two facts unsayable.

alter table public.lakes
  add column if not exists is_fixture boolean not null default false;

comment on column public.lakes.is_fixture is
  'TRUE = a scratch row that exists to exercise the system; never shown to the '
  'public, never named in an outbound email, never put in the sitemap. Set '
  'automatically by mark_fixture_lake() for any name or slug starting with '
  '"zz-", so the old naming convention still works and can no longer be the '
  'ONLY thing standing between a fixture and the live site. Distinct from a '
  'launch switch: this says the lake is not real, not that it is not ready.';

-- ----------------------------------------------------------- the backfill --
-- Every row the convention was already covering, including the one renamed by
-- hand this afternoon.

update public.lakes
   set is_fixture = true
 where is_fixture = false
   and (coalesce(name, '') ilike 'zz-%' or coalesce(slug, '') ilike 'zz-%');

-- -------------------------------------------------- the convention, kept --
--
-- The habit is good and half the codebase's comments teach it, so it keeps
-- working — it just stops being load-bearing on its own. Name a lake `zz-`
-- anything and it is fenced whether or not you remembered the column.
--
-- ONE-WAY ON PURPOSE. The trigger sets TRUE and never sets FALSE. Renaming a
-- fixture to something respectable must not quietly promote it onto the
-- homepage; un-fencing a row is a deliberate act, `update lakes set
-- is_fixture = false`, typed by somebody who means it. The asymmetry is the
-- safety: every automatic path leads toward hidden, never toward published.

create or replace function public.mark_fixture_lake()
returns trigger
language plpgsql
as $$
begin
  if coalesce(new.name, '') ilike 'zz-%' or coalesce(new.slug, '') ilike 'zz-%' then
    new.is_fixture := true;
  end if;
  return new;
end $$;

comment on function public.mark_fixture_lake() is
  'Makes the zz- naming convention feed lakes.is_fixture. Sets true, never '
  'false — see 0124. A fixture renamed to a real-looking name stays fenced '
  'until a human clears the flag explicitly.';

drop trigger if exists trg_mark_fixture_lake on public.lakes;
create trigger trg_mark_fixture_lake
  before insert or update of name, slug, is_fixture on public.lakes
  for each row execute function public.mark_fixture_lake();

-- ------------------------------------------------------- post-conditions --
do $$
declare
  a uuid; b uuid; c uuid; d uuid;
  flag boolean;
  stray integer;
begin
  begin
    -- 1. THE CONVENTION STILL WORKS, unasked. Nobody mentions is_fixture.
    insert into public.lakes (name, slug) values ('zz-Post Condition', 'zz-post-condition')
      returning id into a;
    select is_fixture into flag from public.lakes where id = a;
    if not flag then raise exception '0124: a zz- name did not fence itself'; end if;

    -- 2. THE SLUG ALONE IS ENOUGH. Half the old guards read only this one.
    insert into public.lakes (name, slug) values ('Post Condition Two', 'zz-post-condition-2')
      returning id into b;
    select is_fixture into flag from public.lakes where id = b;
    if not flag then raise exception '0124: a zz- slug did not fence itself'; end if;

    -- 3. AND A REAL LAKE IS STILL REAL. A fence that catches everything is
    --    just a switched-off website.
    insert into public.lakes (name, slug) values ('Post Condition Lake', 'post-condition-lake')
      returning id into c;
    select is_fixture into flag from public.lakes where id = c;
    if flag then raise exception '0124: a real lake was fenced'; end if;

    -- 4. A NULL SLUG IS THE EXACT CASE THAT LEAKED. It must be decided by the
    --    name, not left to NOT(NULL) to swallow.
    insert into public.lakes (name) values ('zz-Null Slug') returning id into d;
    select is_fixture into flag from public.lakes where id = d;
    if not flag then raise exception '0124: the null-slug case leaked again'; end if;

    -- 5. RENAMING INTO THE CONVENTION FENCES IT.
    update public.lakes set name = 'zz-Renamed' where id = c;
    select is_fixture into flag from public.lakes where id = c;
    if not flag then raise exception '0124: renaming to zz- did not fence it'; end if;

    -- 6. RENAMING OUT OF IT DOES NOT UNFENCE IT. This is the whole asymmetry:
    --    a fixture that acquires a respectable name is still a fixture.
    update public.lakes set name = 'Perfectly Normal Lake', slug = 'perfectly-normal'
      where id = c;
    select is_fixture into flag from public.lakes where id = c;
    if not flag then raise exception '0124: a fixture unfenced itself by rename'; end if;

    -- 7. AND YOU CANNOT LIE YOUR WAY PAST IT ON THE WAY IN. Passing false
    --    explicitly with a zz- name is the same mistake as forgetting.
    update public.lakes set is_fixture = false where id = a;
    select is_fixture into flag from public.lakes where id = a;
    if not flag then raise exception '0124: a zz- row accepted is_fixture=false'; end if;

    -- 8. BUT A DELIBERATE PROMOTION IS STILL POSSIBLE — rename first, then
    --    clear the flag. Otherwise a fixture could never become a real lake.
    update public.lakes set name = 'Promoted Lake', slug = 'promoted-lake' where id = a;
    update public.lakes set is_fixture = false where id = a;
    select is_fixture into flag from public.lakes where id = a;
    if flag then raise exception '0124: a renamed lake could not be promoted'; end if;

    -- 9. THE BACKFILL LEFT NOTHING BEHIND. Real data, not fixtures: no row
    --    matching the old convention may still read as real.
    select count(*) into stray from public.lakes
     where is_fixture = false
       and (coalesce(name, '') ilike 'zz-%' or coalesce(slug, '') ilike 'zz-%');
    if stray > 0 then raise exception '0124: % zz- row(s) survived the backfill', stray; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
