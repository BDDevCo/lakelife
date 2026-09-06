-- ============================================================================
-- 0157 — SOMEBODY HAS TO HEAR THE PROCESSOR.
--
-- Today every charge declines, because `charge-gate.ts` refuses until
-- LAKELIFE_PAYMENTS_LIVE is set. The question this migration answers is the
-- one for the day it stops declining: a real processor does not only take
-- money, it TALKS BACK. A capture settles. A refund completes. A cardholder
-- disputes. And, three to five business days after an ACH debit looked final,
-- the bank RETURNS it.
--
-- Before this, `src/app/api/` held cron, ics, ops and verify — no webhook
-- endpoint of any kind. Every one of those messages would have arrived at a
-- 404, been retried a few times, and been dropped on the floor. The screen
-- would still say the January rent was PAID for money that had gone back.
--
-- ------------------------------------------------------- what this is not ---
--
-- This is NOT the pending → cleared → returned state machine. That is ours to
-- build and it is the real work, but the owner's own brief says it "cannot be
-- designed until we know what they send us", and a state machine invented
-- against guessed event names is policy nobody chose. So this table holds the
-- events verbatim with `processed_at` NULL, and the thing that drains it is
-- written after the processor call, against the names they actually send.
--
-- A row here changes NOTHING. No payment, no invoice, no park_payment, no
-- payout. That restraint is enforced in the route and scanned for in its test.
--
-- ------------------------------------------------------ why event_id UNIQUE --
--
-- Redelivery is normal processor behaviour, not an error: if our 200 is lost
-- in transit they send the same event again, sometimes for days. The unique
-- index IS the replay guard, and it has to be the guard rather than a
-- read-then-write in the route, because two deliveries arriving together would
-- both read "not there yet" and both insert. The route reads 23505 as "already
-- heard" and answers 200.
--
-- `payments` has taught this lesson the expensive way: its only dedupe is a
-- partial unique index that refuses the second ROW after the second DEBIT. A
-- webhook has no such excuse — nothing has moved yet when this row is written.
--
-- ------------------------------------------------------------- who may read --
--
-- Nobody but the service role. These are raw processor payloads: they will
-- carry card brands, last-fours, bank return codes, dispute reasons and
-- whatever else a processor chooses to include, about named residents. RLS
-- alone would not do it — in this project a table arrives with client write
-- grants already attached — so the grants are REVOKED outright as well.
-- ============================================================================

create table if not exists public.processor_events (
  id           uuid primary key default gen_random_uuid(),

  -- Which processor said it. Two processors will one day be live at once (a
  -- card one and an ACH one is the likeliest shape), and their event ids come
  -- from different sequences; without this, an event is an id with no author.
  provider     text        not null,

  -- The processor's own id for this delivery. UNIQUE is the whole replay
  -- guard. When a payload carries no id of its own the route stores
  -- 'body:<sha256 of the exact bytes>', so a byte-identical redelivery is
  -- still one row.
  event_id     text        not null unique,

  -- 'ach.return', 'charge.succeeded', whatever they call it. NULLABLE on
  -- purpose: an unfamiliar shape is recorded with no type rather than filed
  -- under an invented one.
  event_type   text,

  -- The event as sent. Never a chosen few fields — the reason to keep it is
  -- precisely the parts we did not know to expect.
  payload      jsonb       not null,

  received_at  timestamptz not null default now(),

  -- NULL until something acts on it. Every row starts NULL and, until the
  -- state machine exists, stays NULL — which is the honest record of an event
  -- heard and not yet answered.
  processed_at timestamptz
);

comment on table public.processor_events is
  'Every event a payment processor sends us, recorded verbatim and acted on by '
  'nothing. The webhook door writes here and returns 200; the pending/cleared/'
  'returned state machine is a separate build and reads processed_at IS NULL.';
comment on column public.processor_events.event_id is
  'The processor''s own id for the delivery, or body:<sha256> when it sends none. '
  'UNIQUE — this index is what makes a redelivery a no-op instead of a second row.';
comment on column public.processor_events.processed_at is
  'NULL means nobody has acted on this event yet. Nothing writes it today.';

-- The drain queue, and the only question the future handler asks: what have we
-- heard and not answered? Partial, because the answered rows are the majority
-- and should cost nothing to skip.
create index if not exists processor_events_unprocessed_idx
  on public.processor_events (received_at)
  where processed_at is null;

-- Support's question, from the other direction: what did they send us about
-- this account this week?
create index if not exists processor_events_received_idx
  on public.processor_events (received_at desc);

alter table public.processor_events enable row level security;

-- RLS IS NOT ENOUGH IN THIS PROJECT. Tables arrive with write grants for anon
-- and authenticated attached by default, and a policy-less table with a live
-- grant is one policy away from readable. No policy is created here, and no
-- client role holds a privilege to exercise: the service role is the only
-- reader and the only writer.
revoke all on public.processor_events from anon, authenticated;

-- ------------------------------------------------------- post-conditions ---
do $$
declare
  n_unique int;
  n_grants int;
  n_rls    int;
begin
  select count(*) into n_unique
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(i.indkey)
   where t.relname = 'processor_events'
     and t.relnamespace = 'public'::regnamespace
     and i.indisunique
     and a.attname = 'event_id';
  if n_unique = 0 then
    raise exception
      '0157: event_id is not unique — a redelivered event would be a second row, '
      'and the route reads 23505 as "already heard"';
  end if;

  select count(*) into n_grants
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'processor_events'
     and grantee in ('anon', 'authenticated');
  if n_grants > 0 then
    raise exception
      '0157: % grant(s) remain for anon/authenticated on a table of raw processor '
      'payloads', n_grants;
  end if;

  select count(*) into n_rls
    from pg_class
   where relname = 'processor_events'
     and relnamespace = 'public'::regnamespace
     and relrowsecurity;
  if n_rls = 0 then
    raise exception '0157: row level security is off on processor_events';
  end if;

  raise notice
    '0157: the processor now has somewhere to talk to. Nothing reads these rows yet.';
end $$;
