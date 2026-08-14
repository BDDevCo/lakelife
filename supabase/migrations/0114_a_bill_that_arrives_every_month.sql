-- 0114 — A BILL THAT ARRIVES EVERY MONTH SHOULD NOT BE REMEMBERED.
--
-- The Haven's sewer and electric is $17,198/yr — 82% of everything the park
-- spends on behalf of its residents — and it arrives monthly. Today the owner
-- has to remember it exists, find it, and type it into the costs screen. Miss
-- a month and nineteen households are never billed their share of it; miss it
-- twice and the gap is invisible, because a cost nobody entered leaves no
-- trace anywhere.
--
-- ================== WHY THIS REMINDS AND DOES NOT CHARGE ==================
--
-- A recurring bill has a knowable SHAPE — sewer, monthly, around the 5th — and
-- an unknowable AMOUNT. Inventing the amount from last month would push a
-- number onto nineteen rent bills that nobody read off an invoice, and the
-- household who overpaid would have no way to know.
--
-- So this stores the shape and nothing else. The nightly run turns it into a
-- line on his Today screen — "the sewer bill for August isn't in yet, last one
-- was $1,433" — and he enters the real figure. That is the park autonomy rule
-- this module has followed throughout: unattended only when the worst case is
-- a sentence on a screen.
--
-- `typical_amount` is a HINT for that sentence, never a value that gets
-- billed. It exists so the reminder can say what to expect, which is what
-- makes a wrong invoice noticeable.
--
-- ================== NOTHING HERE KNOWS ABOUT THE HAVEN ==================
--
-- Every row is per-park and created by that park's owner. There is no seed, no
-- default schedule and no default amount: a new park owner starts with an
-- empty list and a screen that says so. The Haven is customer number one, not
-- the specification.

create table if not exists public.park_cost_schedules (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,

  -- Which cost this is, using the same vocabulary the costs screen uses.
  category      text not null,

  -- Monthly is the only cadence with a reader today. Quarterly and annual are
  -- deliberately absent rather than stored-and-ignored.
  cadence       text not null default 'monthly' check (cadence in ('monthly')),

  -- Roughly when it lands. Clamped to 28 so February always has the day.
  due_day       integer not null default 5 check (due_day between 1 and 28),

  -- What it usually comes to. A HINT for the reminder, never billed.
  typical_amount numeric(10,2) check (typical_amount is null or typical_amount > 0),

  label         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on table public.park_cost_schedules is
  'The SHAPE of a bill that arrives every month — sewer, trash, common '
  'electric. Never the amount: that is read off the invoice by a person. The '
  'nightly run turns a schedule with no matching cost into a line on the '
  'owner''s Today screen. Per-park, owner-created, no seeds.';

comment on column public.park_cost_schedules.typical_amount is
  'What it usually comes to, shown in the reminder so a wrong invoice is '
  'noticeable. NEVER billed and never written to park_costs — the amount on a '
  'resident''s bill is always one a person read off a real invoice.';

-- One live schedule per category per park. Two sewer reminders is two people
-- entering the same bill.
create unique index if not exists park_cost_schedules_one_per_category
  on public.park_cost_schedules (park_id, category) where active;

alter table public.park_cost_schedules enable row level security;
revoke all on public.park_cost_schedules from anon, authenticated;

do $$
declare lid uuid; pid uuid; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0114 Proof','1 Rd','0114-proof', lid,'mh', false) returning id into pid;

    -- 1. A NEW PARK HAS NO SCHEDULES. No seed, no inherited Haven shape.
    if (select count(*) from public.park_cost_schedules where park_id = pid) <> 0 then
      raise exception '0114: a brand-new park was given schedules it never asked for';
    end if;

    insert into public.park_cost_schedules (park_id, category, due_day, typical_amount)
    values (pid, 'sewer', 5, 1433.17);

    -- 2. ONE LIVE SCHEDULE PER CATEGORY.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, due_day)
      values (pid, 'sewer', 20);
    exception when unique_violation then ok := true;
    end;
    if not ok then
      raise exception '0114: a park got two sewer reminders — two people would enter the same bill';
    end if;

    -- 3. Retiring one frees the category, so he can re-add it later.
    update public.park_cost_schedules set active = false where park_id = pid;
    insert into public.park_cost_schedules (park_id, category, due_day)
    values (pid, 'sewer', 20);

    -- 4. A due day must exist in February.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, due_day)
      values (pid, 'trash', 31);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0114: a schedule could fall on a day February does not have'; end if;

    -- 5. The hint can never be zero or negative — it is shown as money.
    ok := false;
    begin
      insert into public.park_cost_schedules (park_id, category, due_day, typical_amount)
      values (pid, 'trash', 5, 0);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0114: a schedule carried a nonsense typical amount'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
