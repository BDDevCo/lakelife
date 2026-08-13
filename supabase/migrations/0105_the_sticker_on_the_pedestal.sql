-- 0105 — THE STICKER ON THE PEDESTAL.
--
-- The blueprint's season-one cut keeps exactly TWO renter-facing things, and
-- this is one of them: "the QR sticker on the lot pedestal that opens a
-- pre-filled maintenance request with no login". The other is a verified
-- mobile at the office window. Both were chosen because "both work for a
-- 74-year-old with a flip phone" — no app, no account, no claim code.
--
-- Nothing of it existed: grepping src for maintenance, work_order, repair or
-- ticket returns only fee labels. So 10-25 contacts a month land on the
-- owner's personal cell, and the doc calls this "the cleanest service-capture
-- path in the whole product… it arrives unprompted, from the tenant, at the
-- moment of need".
--
-- ============================ WHAT THE PAGE MUST NOT DO ====================
--
-- A sticker is readable by ANYONE standing in the park. So the page it opens
-- may say the LOT and the PARK and nothing else — never who lives there. That
-- is the same line 0085 drew for the owner's own visit log: a person may learn
-- what they could learn by standing there, and not one thing more. A QR that
-- answered "Dave Smith, Lot 7" would be a tenant directory stapled to a post.
--
-- And the GET must be SAFE. A link-preview fetcher, a messaging app, a school
-- filter — all issue GETs, and a GET that filed a request would fill the
-- owner's queue with ghosts. The page renders a form; only a POST writes.

create table if not exists public.park_requests (
  id            uuid primary key default gen_random_uuid(),
  park_id       uuid not null references public.parks(id) on delete cascade,
  -- Null for a common area — the road, the trash corral, a light. Not
  -- everything wrong in a park is on somebody's lot.
  park_lot_id   uuid references public.park_lots(id) on delete set null,
  category      text not null,
  note          text not null,
  -- OPTIONAL, and that is the point. A report with no name is still a report,
  -- and demanding one is how you get no reports. If they leave a way to be
  -- reached, the office can call back.
  reporter_name text,
  reporter_phone text,
  status        text not null default 'new',
  source        text not null default 'qr',
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolution_note text,
  resolved_by   uuid references public.users(id) on delete set null,
  -- THE HOOK FOR LATER. When a report is really a job — a broken step, a
  -- blocked drain — it becomes one. Nullable now, so the shape is there
  -- before the conversion is.
  job_id        uuid references public.jobs(id) on delete set null
);

comment on table public.park_requests is
  'Maintenance reported from the QR sticker on a lot pedestal — no login, no '
  'account. The page may show the lot and the park and NOTHING about who lives '
  'there: a sticker is readable by anyone standing in the park.';

alter table public.park_requests drop constraint if exists park_requests_status_check;
alter table public.park_requests add constraint park_requests_status_check
  check (status in ('new', 'in_hand', 'done'));

alter table public.park_requests drop constraint if exists park_requests_source_check;
alter table public.park_requests add constraint park_requests_source_check
  check (source in ('qr', 'office', 'phone'));

alter table public.park_requests drop constraint if exists park_requests_category_check;
alter table public.park_requests add constraint park_requests_category_check
  check (category in ('water', 'sewer', 'electric', 'road', 'tree', 'trash', 'lighting', 'other'));

-- A note is the whole report. An empty one is a tap, not a problem.
alter table public.park_requests drop constraint if exists park_requests_note_is_real;
alter table public.park_requests add constraint park_requests_note_is_real
  check (length(btrim(note)) between 3 and 2000);

-- Resolving says what was done, the same rule the rest of the module follows.
alter table public.park_requests drop constraint if exists park_requests_resolved_has_a_note;
alter table public.park_requests add constraint park_requests_resolved_has_a_note
  check (resolved_at is null or coalesce(btrim(resolution_note), '') <> '');

create index if not exists park_requests_open_idx
  on public.park_requests (park_id, created_at desc) where status <> 'done';

-- ------------------------------------------------- the sticker's own token --
-- Per lot, unguessable, stable — it is printed and screwed to a post, so it
-- can never be rotated casually.
alter table public.park_lots add column if not exists qr_token text;

create unique index if not exists park_lots_qr_token_key
  on public.park_lots (qr_token) where qr_token is not null;

comment on column public.park_lots.qr_token is
  'What the pedestal sticker encodes. Printed and screwed to a post — treat as '
  'permanent. Grants NO read of the household: it only names the lot so a '
  'report arrives already knowing where it came from.';

-- ------------------------------------------------------------------ RLS ----
alter table public.park_requests enable row level security;

-- The park's people read their own queue. NOBODY reads it anonymously: the
-- sticker is a way IN, not a way to browse what others have reported.
drop policy if exists park_requests_read on public.park_requests;
create policy park_requests_read on public.park_requests
  for select using (public.ll_is_ops() or public.ll_manages_park(park_id));

-- RLS is not a grant (0100's standing rule).
revoke insert, update, delete on public.park_requests from anon, authenticated;
revoke select on public.park_requests from anon;

do $$
declare lid uuid; pid uuid; lot uuid; req uuid; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0105 Proof','1 Rd','0105-proof', lid,'mh', false) returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle, qr_token)
    values (pid,'Lot 7', true,'live','0105tok') returning id into lot;

    -- 1. A report needs no renter, no account, no name.
    insert into public.park_requests (park_id, park_lot_id, category, note)
    values (pid, lot, 'water', 'Riser is leaking under the step') returning id into req;

    -- 2. A blank note is a tap, not a problem.
    ok := false;
    begin
      insert into public.park_requests (park_id, park_lot_id, category, note)
      values (pid, lot, 'water', '  ');
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0105: an empty report was accepted'; end if;

    -- 3. Resolving demands a note.
    ok := false;
    begin
      update public.park_requests set status='done', resolved_at = now() where id = req;
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0105: a request was closed with no record of what was done'; end if;
    update public.park_requests
       set status='done', resolved_at = now(), resolution_note = 'Replaced the riser'
     where id = req;

    -- 4. A common-area report needs no lot at all.
    insert into public.park_requests (park_id, category, note)
    values (pid, 'road', 'Pothole by the mailboxes');

    -- 5. Two lots cannot share a sticker.
    ok := false;
    begin
      insert into public.park_lots (park_id, lot_number, active, lifecycle, qr_token)
      values (pid,'Lot 8', true,'live','0105tok');
    exception when unique_violation then ok := true;
    end;
    if not ok then raise exception '0105: two lots took the same QR token'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
