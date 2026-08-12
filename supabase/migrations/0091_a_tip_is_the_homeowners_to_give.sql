-- 0091 — A TIP IS THE HOMEOWNER'S TO GIVE.
--
-- Brendon: "its a tip, so its at the home owners discretion, but the
-- suggestion needs to be within reason and probably shouldn't be based on the
-- $$ amount."
--
-- He is right, and our own seeded numbers make the case harder than an
-- instinct could. At 20% of the bill, the implied tip PER HOUR OF WORK runs
-- from $9.60 to $126.67:
--
--   Housekeeping, 4,200 sq ft   2h 30m   $24 at 20%    $9.60/hour
--   Boat winterize, 19 ft       1h 30m   $190 at 20%   $126.67/hour
--
-- The cleaner works two and a half hours for twenty-four dollars. A percentage
-- is nearly RANDOM with respect to effort, and random in a way that always
-- favours whoever touched the most expensive object.
--
-- So the suggestion is anchored to TIME ON SITE — which 0083 made real — and
-- capped. Time is what a tip is actually about: somebody's afternoon.
--
-- THE TIP IS NOT THE TRIP FEE. They are different instruments and both exist:
--
--   TRIP FEE (0090) is COMPENSATION for a cost the crew incurred on a visit
--   that produced no work. Owed, not asked for. Never discretionary — a crew
--   should not have to hope for goodwill to cover fuel we or the customer cost
--   them.
--
--   A TIP is a THANK-YOU for work that WAS done, and done well. Discretionary
--   by definition, zero is the commonest and most acceptable answer, and it is
--   only ever offered after the job is complete.
--
-- Conflating them would put the crew's fuel money at the mercy of a prompt,
-- which is precisely the thing 0090 exists to stop.

alter table public.jobs
  add column if not exists tip_amount numeric(10,2),
  add column if not exists tipped_at  timestamptz;

comment on column public.jobs.tip_amount is
  'What the homeowner chose to add for the crew, after the work was done. '
  'NULL = never asked or never answered; 0 = asked and declined, which is a '
  'perfectly good answer and must never be rendered as a failing.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_tip_is_sane') then
    -- The ceiling is a fat-finger guard, not a policy: the suggestion ladder
    -- tops out at $50 and lives in code, where it can be tuned without a
    -- migration. This only stops $2000 arriving from a mistyped field.
    alter table public.jobs add constraint jobs_tip_is_sane
      check (tip_amount is null or (tip_amount >= 0 and tip_amount <= 500));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jobs_tip_has_a_when') then
    alter table public.jobs add constraint jobs_tip_has_a_when
      check ((tip_amount is null) = (tipped_at is null));
  end if;
end $$;

-- ---------------------------------------------------- a fourth kind of pay --
alter table public.payouts drop constraint if exists payouts_kind_check;
alter table public.payouts add constraint payouts_kind_check
  check (kind in ('earning', 'adjustment', 'trip', 'tip'));

alter table public.payouts drop constraint if exists payouts_amount_sign;
alter table public.payouts add constraint payouts_amount_sign
  check ((kind in ('earning', 'trip', 'tip') and amount >= 0)
      or (kind = 'adjustment' and amount <= 0));

-- ONE TIP PER JOB. Unlike a trip — a job can be attempted twice and each trip
-- is real — a job is completed once, so it is thanked once.
create unique index if not exists payouts_one_tip_per_job
  on public.payouts (job_id) where (job_id is not null and kind = 'tip');

-- ------------------------------------------------------- SERVER-ENFORCED ---
-- EVERY CENT GOES TO THE CREW. LakeLife's 30% is on the WORK; taking a cut of
-- a thank-you is the kind of thing crews find out about and never forgive.
-- The app says so in `tipSplit`, and this makes it true whatever the app
-- believes: a tip payout must equal the tip the customer gave.
create or replace function public.guard_tip_reaches_the_crew()
returns trigger language plpgsql as $function$
declare given numeric;
begin
  if new.kind <> 'tip' or new.job_id is null then return new; end if;

  select tip_amount into given from public.jobs where id = new.job_id;
  if given is null then
    raise exception 'payouts: a tip payout with no tip on the job';
  end if;
  if new.amount is distinct from given then
    raise exception
      'payouts: a tip payout must equal the tip the homeowner gave (% vs %) — LakeLife takes no share of a thank-you',
      new.amount, given;
  end if;
  return new;
end $function$;

drop trigger if exists trg_guard_tip_reaches_the_crew on public.payouts;
create trigger trg_guard_tip_reaches_the_crew
  before insert or update on public.payouts
  for each row execute function public.guard_tip_reaches_the_crew();

-- ------------------------------------------------------ post-conditions ----
do $$
declare ok boolean; jid uuid; vid uuid;
begin
  select id into jid from public.jobs limit 1;
  select id into vid from public.vendors limit 1;
  if jid is null or vid is null then return; end if;

  update public.jobs set tip_amount = 20, tipped_at = now() where id = jid;

  insert into public.payouts (vendor_id, job_id, amount, original_amount, status, kind)
  values (vid, jid, 20, 20, 'released', 'tip');

  -- SKIMMING IS REFUSED. This is the one that matters.
  ok := false;
  begin
    update public.payouts set amount = 17 where job_id = jid and kind = 'tip';
  exception when others then ok := true;
  end;
  if not ok then raise exception '0091: LAKELIFE TOOK A CUT OF A TIP and the database allowed it'; end if;

  ok := false;
  begin
    insert into public.payouts (vendor_id, job_id, amount, original_amount, status, kind)
    values (vid, jid, 20, 20, 'released', 'tip');
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception '0091: a second tip on one job was accepted'; end if;

  ok := false;
  begin
    update public.jobs set tip_amount = 10, tipped_at = null where id = jid;
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception '0091: a tip with no timestamp was accepted'; end if;

  delete from public.payouts where job_id = jid and kind = 'tip';
  update public.jobs set tip_amount = null, tipped_at = null where id = jid;
end $$;
