-- 0192 — TELLING THEM AND CHASING THEM ARE NOT THE SAME ACT.
--
-- `runCharges` ends its own success message with the words "Nobody has been
-- told." That is honest and it is the defect: the run raises eighteen bills,
-- and the only resident-facing money message in the whole product is the
-- OVERDUE demand, which by definition fires after somebody is already late.
--
-- On 1 January 2027 every household at The Haven signs at $542.53. The run
-- raises their bills. Nobody is told. Then the first thing any of them hears
-- from the software is a demand.
--
-- WHY THIS NEEDS A COLUMN AND NOT JUST A SENDER. park_reminders is the log that
-- stops a second click sending a second demand: `loadPlan` reads every row with
-- party='resident' and outcome in ('sent','printed') into `alreadyReminded`,
-- and planReminders drops those charges. The table has no way to say WHICH act
-- a row records — so a bill announcement written as a resident row would be
-- read as a chase, and the household who was told their bill exists would
-- never be chased for it. Announcing the bill would quietly cancel the demand.
--
-- 'chase' IS THE DEFAULT SO EVERY EXISTING ROW KEEPS ITS MEANING. Every row in
-- this table today is a demand, which is exactly what the default says it is;
-- nothing is re-interpreted and no backfill is needed. Production holds none
-- yet, but preview shares this database.
--
-- BOTH HALVES LEARN THE WORD IN THE SAME CHANGE (the 0188 lesson): this adds
-- the column, and reminder-actions' `alreadyReminded` read is narrowed to
-- kind='chase' in the same commit. A writer of a new kind beside a reader that
-- cannot see it is how the chase would have gone silent.

alter table public.park_reminders
  add column if not exists kind text not null default 'chase';

alter table public.park_reminders
  drop constraint if exists park_reminders_kind_check;
alter table public.park_reminders
  add constraint park_reminders_kind_check
  check (kind in ('chase', 'raised'));

comment on column public.park_reminders.kind is
  'Which act this row records. ''chase'' is a demand for money already late — '
  'the only thing this table held before 0192, and the default so every '
  'existing row keeps that meaning. ''raised'' is telling a household their '
  'bill exists, which is not a demand and must never suppress one.';

-- ------------------------------------- THE UNIQUE INDEX IS PER ACT, NOT PER BILL --
--
-- THIS IS THE HALF THAT WOULD HAVE BROKEN THE CHASE, and the proof below found
-- it before it shipped. park_reminders_once_idx is UNIQUE on (charge_id, party)
-- where the outcome stands — the hard guarantee behind "never chased twice",
-- doing a job no application check can be trusted with.
--
-- It also means a charge has exactly ONE resident slot for ever. An
-- announcement would have taken it, and the demand that came later could then
-- never be written at all: a bare INSERT returning 23505, which this codebase
-- has already learned reads as `data: null` and puts "try again" on screen for
-- a path that can never succeed. Telling a household their bill exists would
-- have made it impossible to ever record chasing them for it.
--
-- So the guarantee becomes per ACT: one chase per bill, one announcement per
-- bill, neither able to stand in for the other. Widening a unique index is
-- strictly more permissive, so it cannot fail on existing rows.
drop index if exists public.park_reminders_once_idx;
create unique index park_reminders_once_idx
  on public.park_reminders (charge_id, party, kind)
  where outcome = any (array['sent', 'printed']);

-- The read that stops a second demand is keyed on (park, party, outcome) and
-- now on kind too, so it stays as fast as it was once announcements share the
-- table.
create index if not exists park_reminders_kind_idx
  on public.park_reminders (park_id, kind, party, outcome);

-- ------------------------------------------------- the proof, rolled back --
--
-- Collapsed both ways, because a column nothing reads differently is not a
-- distinction: an announcement must NOT look like a chase to the chase's own
-- query, and a chase must still look like one.

do $$
declare
  pid uuid; lot uuid; res uuid; ren uuid; chg uuid;
  chases int; announcements int;
begin
  insert into public.parks (name, slug, cutover_date)
  values ('0192 proof', '0192-proof-' || gen_random_uuid()::text, date '2026-09-01')
  returning id into pid;
  insert into public.park_lots (park_id, lot_number, site_type, lifecycle)
  values (pid, '7', 'mh_single', 'live') returning id into lot;
  insert into public.park_renters (park_id, display_name)
  values (pid, '0192 proof household') returning id into ren;
  insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
  values (lot, ren, daterange(date '2026-10-01', date '2026-11-01', '[)'), 'monthly', 'active')
  returning id into res;
  insert into public.park_charges
    (park_id, park_lot_id, renter_id, reservation_id, period_month, due_on, amount, status)
  values (pid, lot, ren, res, '2026-10', date '2026-10-01', 542.53, 'open')
  returning id into chg;

  -- We told them the bill exists.
  insert into public.park_reminders (park_id, charge_id, party, channel, outcome, kind)
  values (pid, chg, 'resident', 'email', 'sent', 'raised');

  -- THE CHASE'S OWN QUESTION: has this household been chased? It must be no.
  select count(*) into chases
    from public.park_reminders
   where park_id = pid and party = 'resident'
     and outcome in ('sent', 'printed') and kind = 'chase';
  if chases <> 0 then
    raise exception '0192 FAILED: telling them the bill exists reads as a demand, so the demand would never be sent';
  end if;

  -- And the announcement is on the record, not lost.
  select count(*) into announcements
    from public.park_reminders
   where park_id = pid and kind = 'raised';
  if announcements <> 1 then
    raise exception '0192 FAILED: the announcement was not recorded (%)', announcements;
  end if;

  -- THE OTHER DIRECTION: a demand, with no kind given, is still a demand.
  insert into public.park_reminders (park_id, charge_id, party, channel, outcome)
  values (pid, chg, 'resident', 'email', 'sent');
  select count(*) into chases
    from public.park_reminders
   where park_id = pid and party = 'resident'
     and outcome in ('sent', 'printed') and kind = 'chase';
  if chases <> 1 then
    raise exception '0192 FAILED: a row written without a kind is not read as a chase (%)', chases;
  end if;

  -- AND THE ONCE-ONLY GUARANTEE STILL HOLDS, PER ACT. A second chase on the
  -- same bill is still refused — that is the whole point of the index, and
  -- widening it must not have bought the announcement at the demand's expense.
  begin
    insert into public.park_reminders (park_id, charge_id, party, channel, outcome, kind)
    values (pid, chg, 'resident', 'email', 'sent', 'chase');
    raise exception '0192 FAILED: the same bill was chased twice';
  exception when unique_violation then null;
  end;
  -- Nor announced twice.
  begin
    insert into public.park_reminders (park_id, charge_id, party, channel, outcome, kind)
    values (pid, chg, 'resident', 'email', 'sent', 'raised');
    raise exception '0192 FAILED: the same bill was announced twice';
  exception when unique_violation then null;
  end;

  -- And nothing else is allowed to be a kind.
  begin
    insert into public.park_reminders (park_id, charge_id, party, channel, outcome, kind)
    values (pid, chg, 'resident', 'email', 'sent', 'nudge');
    raise exception '0192 FAILED: an unknown kind was accepted';
  exception when check_violation then null;
  end;

  raise exception '0192 proof complete — rolling back';
exception when others then
  if sqlerrm <> '0192 proof complete — rolling back' then
    raise;
  end if;
end $$;
