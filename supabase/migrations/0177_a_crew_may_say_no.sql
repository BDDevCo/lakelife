-- ============================================================================
-- 0177 — A CREW MAY SAY NO, AND SAYING SO IS A FACT.
--
-- §11.1 of the crew terms promises that crews "may accept or reject jobs".
-- Josh signs that. Until now `src/app/vendor/actions.ts` exported five actions
-- — upload a photo, complete, flag, record a no-show, read photo URLs — and
-- not one of them was a decline or a release. The promise had no door.
--
-- Under crew pricing it gets sharper: the buyer PICKS a crew off their own
-- rate card, and the crew they picked had no way to say no. The only exits
-- were to ghost the job (a permanent `vendor_no_shows` strike that never
-- clears and counts toward losing the whole lake) or to ring somebody.
--
-- WHY A TABLE AND NOT A COLUMN ON `jobs`. A job can be claimed and released
-- more than once — that is the whole point of the board — and a column would
-- keep only the last answer. It is also append-only for the same reason
-- `job_visit_attempts` is (0089): the release is what makes the difference
-- between "nobody wanted this" and "one crew handed it back on Tuesday
-- because the truck is in the shop", and that difference is invisible the
-- moment the job is re-claimed and `vendor_id` points at somebody else.
--
-- WHAT THIS IS NOT. It is not a no-show and must never be read as one: no
-- strike is written, no trip fee is minted, standing is untouched. A release
-- is advance notice, which is the behaviour we want, and punishing it would
-- make ghosting the cheaper option.
-- ============================================================================

create table if not exists public.job_releases (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  -- WHO HANDED IT BACK. Kept even after the job is re-assigned, which is the
  -- reason this row exists at all — `jobs.vendor_id` will be somebody else.
  vendor_id    uuid not null references public.vendors(id),
  released_on  date not null,
  -- REQUIRED. A release with no reason is a silent no-show with better
  -- manners: the buyer who chose this crew is owed a sentence, and ops needs
  -- to know whether this is a one-off or a crew quietly handing back the same
  -- kind of work every week.
  reason       text not null,
  created_at   timestamptz not null default now(),
  constraint job_releases_has_a_reason
    check (coalesce(btrim(reason), '') <> '')
);

comment on table public.job_releases is
  'A crew handed a future-dated job back to the board, with the reason they '
  'gave. APPEND-ONLY: the job is re-assignable immediately, so jobs.vendor_id '
  'stops being able to answer who released it. NOT a no-show — no strike, no '
  'trip fee, no effect on standing.';

create index if not exists job_releases_job_idx
  on public.job_releases (job_id, released_on desc);
create index if not exists job_releases_vendor_idx
  on public.job_releases (vendor_id, released_on desc);

-- Same posture as every other table here: RLS on, and client writes revoked
-- outright. Every reader and writer goes through the service role in a server
-- action that has already checked whose job this is.
alter table public.job_releases enable row level security;
revoke all on public.job_releases from anon, authenticated;

-- ------------------------------------------------------- post-conditions --
--
-- ADDED BY THE LEAD BEFORE APPLYING. Every other migration in this series
-- proves itself at ship time and this one did not: it asserted a NOT NULL and
-- a CHECK and left whether they BITE to be discovered by the first crew who
-- ever taps "Can't make it". A constraint that exists and permits the thing it
-- names is worse than none, because everything downstream is written against a
-- guarantee that is not there.
--
-- The probes write real rows and the block raises on the way out, so they roll
-- back and leave nothing behind.
do $$
declare
  n    int;
  jid  uuid;
  vid  uuid;
  ok   boolean;
  leak text;
begin
  -- (a) THE SHAPE IS WHAT THE COMMENT PROMISES.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'job_releases'
     and column_name in ('id','job_id','vendor_id','released_on','reason','created_at');
  if n <> 6 then
    raise exception '0177: job_releases has % of its 6 columns', n;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'job_releases_has_a_reason') then
    raise exception '0177: nothing requires a reason — a release with no reason is a silent no-show with better manners';
  end if;

  -- (b) RLS IS ON AND NO CLIENT MAY WRITE. 0100's lesson: RLS is the first
  --     lock and a REVOKE is the second, and the second has to be said.
  if not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = 'job_releases' and c.relrowsecurity
  ) then
    raise exception '0177: row level security is not enabled on job_releases';
  end if;

  select string_agg(grantee || ':' || privilege_type, ', ') into leak
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'job_releases'
     and grantee in ('anon', 'authenticated');
  if leak is not null then
    raise exception '0177: a client can reach job_releases — %', leak;
  end if;

  -- (c) THE REASON RULE BITES, AND IT DOES NOT BITE THE THING IT IS FOR.
  select j.id into jid from public.jobs j limit 1;
  select v.id into vid from public.vendors v limit 1;

  if jid is null or vid is null then
    raise notice '0177: NO PROBE RAN — this database holds no job or no vendor to attempt one against. The constraints exist; that they BITE is unverified here.';
  else
    begin
      -- A release with a blank reason: refused.
      ok := false;
      begin
        insert into public.job_releases (job_id, vendor_id, released_on, reason)
        values (jid, vid, current_date, '   ');
      exception when check_violation then ok := true;
      end;
      if not ok then
        raise exception '0177: a release was recorded with a blank reason — the buyer who chose this crew is owed a sentence';
      end if;

      -- AND THE OTHER HALF: a complete release is accepted. A constraint that
      -- refused everything would pass the probe above and make the door dead.
      insert into public.job_releases (job_id, vendor_id, released_on, reason)
      values (jid, vid, current_date, 'ship-time probe — the truck is in the shop');
      if not exists (
        select 1 from public.job_releases
         where job_id = jid and vendor_id = vid and reason like 'ship-time probe%'
      ) then
        raise exception '0177: a complete release could not be recorded — the door is dead';
      end if;

      raise exception 'ROLLBACK_POSTCONDITION';
    exception
      when others then
        if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
    end;
  end if;

  raise notice '0177: a crew may say no, it must say why, and no client may write it.';
end $$;
