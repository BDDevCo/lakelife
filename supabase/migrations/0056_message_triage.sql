-- ============================================================================
-- 0056 — MESSAGE TRIAGE: a held message must appear somewhere.
--
-- THE GAP, verified in src/app/messages/actions.ts before writing this: when a
-- customer sends a message we insert it and call maybeAutoReply(). If the
-- safety fence refuses to let the model answer, that function simply RETURNS.
-- Nothing is flagged, nobody is notified, no digest counts it. The code even
-- says "a human will see the message on the ops board regardless" — but the
-- ops board is a list of threads nobody watches, and the nightly digest only
-- reports messages the MACHINE wrote.
--
-- So the fence shipped in 4c0b2a9 made the right decision and then dropped it
-- on the floor. "I smell gas by the trailer" would be correctly refused an
-- automated reply and then sit silently in a thread. That is QUIETER than the
-- behaviour it replaced, which is the one outcome a safety change must never
-- have.
--
-- This migration gives a message somewhere to be. Three columns, no logic:
-- the app decides, the database remembers.
-- ============================================================================

-- The fence's verdict, stored at the moment of the decision rather than
-- recomputed later. Recomputing would silently rewrite history every time the
-- rule table changes, and "what did we know when we chose not to answer?" is
-- exactly the question worth being able to answer.
alter table public.messages
  add column if not exists fence_outcome text
    check (fence_outcome is null or fence_outcome in ('allow', 'hold', 'never_ai', 'emergency'));

-- The one line ops reads. Denormalised on purpose: it is the text that was
-- shown to a human at the time, and it must not change under them when the
-- wording of a rule is edited.
alter table public.messages
  add column if not exists fence_reason text;

-- When a human was paged out of band, and when one picked it up. Null
-- paged_at on an `emergency` row means the page never went out — which is a
-- monitorable failure, and the whole reason this is a timestamp and not a
-- boolean.
alter table public.messages
  add column if not exists paged_at    timestamptz;
alter table public.messages
  add column if not exists handled_at  timestamptz;
alter table public.messages
  add column if not exists handled_by  uuid references public.users(id) on delete set null;

comment on column public.messages.fence_outcome is
  'The safety fence''s verdict when this message arrived: allow | hold | '
  'never_ai | emergency. Stored, never recomputed — recomputing would rewrite '
  'history whenever the rule table changes. See docs/ai-safety-fence.md.';

comment on column public.messages.paged_at is
  'When a human was paged OUT OF BAND for this message. Null on an emergency '
  'row means the page did not go out — monitor for that.';

-- The ops queue: anything the fence did not wave through, oldest first, with
-- emergencies on top. Partial, so it stays small and fast no matter how big
-- the messages table gets.
create index if not exists messages_needs_human_idx
  on public.messages (created_at)
  where fence_outcome in ('hold', 'never_ai', 'emergency') and handled_at is null;

-- Unhandled emergencies, for the monitor that asks "did anyone actually go?"
create index if not exists messages_open_emergency_idx
  on public.messages (created_at)
  where fence_outcome = 'emergency' and handled_at is null;


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='messages'
     and column_name in ('fence_outcome','fence_reason','paged_at','handled_at','handled_by');
  if n <> 5 then
    raise exception '0056: expected 5 triage columns on messages, found %', n;
  end if;

  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='messages_needs_human_idx'
  ) then
    raise exception '0056: the ops queue index did not land';
  end if;

  raise notice '0056: message triage ready. A held message now has somewhere to be.';
end $$;
