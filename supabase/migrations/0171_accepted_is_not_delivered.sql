-- ============================================================================
-- 0171 — ACCEPTED IS NOT DELIVERED.
--
-- Between 19 July and 16 August 2026 this product sent 81 text messages and
-- delivered none of them. Sixty-six were rejected by the carriers with error
-- 30034 — the sending number was not registered for A2P 10DLC — and fifteen
-- with 21268. Booking confirmations, crew dispatch, Autopilot reminders, a
-- crew reporting pier damage: every one accepted by Twilio, every one dropped,
-- for a month, and nothing in this product noticed.
--
-- It hid because acceptance and delivery are DIFFERENT EVENTS, seconds apart.
-- `sendSms` returned the instant Twilio took the message; the carrier's
-- verdict arrived afterwards on a status callback, and this app had no
-- callback route, no record and no screen — so the verdict was addressed to
-- nobody. (Verify codes were never affected: they ride Twilio's managed pool,
-- not the 10DLC long code, which is why sign-in worked all month and nobody
-- had a reason to look.)
--
-- A2P registration is approved now. That fixes the SENDER. It does not fix the
-- blindness, and the blindness is the part that let a dead channel run for a
-- month — so this table is what makes the next outage a sentence in tomorrow
-- morning's digest instead of a discovery in September.
--
-- ------------------------------------------------------ what a row holds ---
--
-- One row per message a carrier took responsibility for, and then the verdict
-- as it arrives. NOT THE BODY AND NOT A NAME — only the body's length and its
-- SHA-256. "Did it arrive" needs no words, and keeping the text would turn an
-- operations table into a store of what residents were told about their homes
-- and their rent. The hash still proves two rows are the same message, or that
-- the message a crew swears they never got is the one we sent.
--
-- A message refused by our OWN gates — a reserved number, a fixture account, a
-- park holding its notices — gets no row at all. It never reached a carrier,
-- it is a different fact with a different fix, and counting refusals as
-- attempts would sink the delivery rate this table exists to watch.
--
-- ----------------------------------------------- why the SID is UNIQUE -----
--
-- Twilio redelivers a status callback whenever its request to us fails or
-- times out, and sends several for one message besides (queued, sent,
-- delivered). Every one of them names the same MessageSid, and every one must
-- land on the same row. The unique index is what makes that true no matter how
-- many arrive at once — a read-then-write in the route would let two
-- simultaneous deliveries both decide the row was missing.
--
-- ------------------------------------- why a receipt can only go FORWARD ---
--
-- Status callbacks arrive out of order. A `sent` posted at 10:00:01 can reach
-- us after the `delivered` posted at 10:00:04 — different requests, different
-- retries — and a naive last-write-wins would walk a delivered message back to
-- "on its way", or stamp an error onto a message that arrived. Worse in the
-- direction that matters: a late `sent` landing on a row that FAILED with
-- 30034 would erase the one row that proves the outage.
--
-- So the rule is in a trigger, not in the route: a receipt that is older news
-- than what we already hold changes NOTHING, and a message that has reached a
-- terminal status is finished. The route can then be as simple as an UPDATE,
-- and a second copy of the same receipt is a no-op by construction.
--
-- ------------------------------------------------------------ who may read --
--
-- Nobody but the service role. These rows say which mobile number was texted
-- about which park and when — a pattern of somebody's life at a lake house —
-- and no client role has any business in it. RLS alone would not do it: in
-- this project a table arrives with write grants for anon and authenticated
-- already attached, so they are REVOKED outright as well.
-- ============================================================================

create table if not exists public.sms_receipts (
  id              uuid primary key default gen_random_uuid(),

  -- Twilio's own id for the message. The row's identity, and the ONLY key a
  -- status callback carries. UNIQUE is the idempotency guard; see above.
  message_sid     text        not null unique,

  -- Where it was sent, E.164. The number, never the name.
  to_e164         text        not null,

  -- What kind of message it was, in the sending code's own words — 'booking
  -- confirmation', 'crew dispatch', 'freeze warning'. So a person reading a
  -- week of failures can see WHICH promises went unkept, not just how many.
  kind            text        not null,

  -- The park or the lake this message was about, when it was about one. Both
  -- nullable and both ON DELETE SET NULL: a receipt is a record of something
  -- that happened and must outlive a park being removed from the platform.
  park_id         uuid        references public.parks(id) on delete set null,
  lake_id         uuid        references public.lakes(id) on delete set null,

  -- The body, as much of it as we are willing to keep. Length and digest only.
  body_length     integer     not null,
  body_sha256     text        not null,

  created_at      timestamptz not null default now(),

  -- What Twilio said when it took the message. Kept separately from `status`
  -- precisely because the two disagreeing IS the story: 'queued' here and
  -- 'undelivered' below is the shape of all 81.
  accepted_status text,

  -- The latest word from the carrier. Starts as the accepted status, because
  -- a null here would make a message awaiting its verdict indistinguishable
  -- from a message nobody ever asked about — which is what the last month
  -- looked like from the inside.
  status          text        not null,

  -- The carrier's reason, and the same reason in English (sms-errors.ts).
  -- 30034 is the one that cost us August.
  error_code      text,
  error_text      text,

  -- When the status last actually moved. Stamped by the trigger, never by a
  -- caller, so it cannot say a row changed on a night it did not.
  status_at       timestamptz
);

comment on table public.sms_receipts is
  'One row per text message a carrier accepted, and the delivery verdict as it '
  'arrives on Twilio''s status callback. Holds the body''s length and SHA-256, '
  'never the body and never a name. Written by sendSms and by /api/twilio/'
  'status; read by the nightly digest. A message our own gates refused gets no '
  'row — it never reached a carrier.';
comment on column public.sms_receipts.message_sid is
  'Twilio''s message SID. UNIQUE — this index is what makes several callbacks '
  'for one message land on one row instead of racing to create several.';
comment on column public.sms_receipts.accepted_status is
  'What Twilio said at accept time. Kept apart from status on purpose: the two '
  'disagreeing is exactly the July-to-August outage (queued, then undelivered).';
comment on column public.sms_receipts.status is
  'The latest carrier verdict. delivered is the only value that means a person '
  'got it. Only ever moves forward — see sms_receipt_only_advances().';

-- The digest's question, from both ends: what went out this week, and what
-- came back. `created_at desc` serves the window scan.
create index if not exists sms_receipts_created_idx
  on public.sms_receipts (created_at desc);

-- And the one somebody asks in a hurry: what is failing, and why. Partial,
-- because on a healthy channel almost every row is delivered and should cost
-- nothing to skip.
create index if not exists sms_receipts_failed_idx
  on public.sms_receipts (created_at desc)
  where status in ('failed', 'undelivered');

-- --------------------------------------------------- forward only, ever ----

/**
 * How far along a message is. Higher is later. NULL for a status we have never
 * heard of — Twilio adds statuses without notice, and the honest answer for an
 * unrecognised one is "no idea where this sits", which the trigger then treats
 * as news worth recording rather than as news to throw away.
 */
create or replace function public.sms_status_rank(s text)
returns integer
language sql
immutable
as $$
  select case lower(coalesce(s, ''))
    when 'accepted'    then 1
    when 'scheduled'   then 2
    when 'queued'      then 3
    when 'sending'     then 4
    when 'sent'        then 5
    when 'delivered'   then 6
    when 'undelivered' then 6
    when 'failed'      then 6
    when 'canceled'    then 6
    else null
  end;
$$;

/**
 * A RECEIPT MAY ADVANCE A MESSAGE. IT MAY NEVER WALK ONE BACK.
 *
 * Two rules, and the second is the one that protects the record of an outage:
 *   - once a message is terminal (delivered, undelivered, failed, canceled)
 *     the carrier has finished with it and nothing later may change it;
 *   - otherwise a status that ranks BELOW what we already hold is stale news.
 *
 * A refused receipt is a no-op, not an error. Out-of-order callbacks are
 * ordinary Twilio behaviour, not a caller's mistake, and raising here would
 * turn a normal Tuesday into a 500 and a redelivery storm.
 *
 * The whole verdict moves together — status, both error fields and the stamp —
 * because they are one statement from the carrier. Letting a stale `sent` blank
 * the error code off a row that failed with 30034 would leave a row that says
 * a message failed for no reason at all.
 */
create or replace function public.sms_receipt_only_advances()
returns trigger
language plpgsql
as $$
declare
  old_rank integer := public.sms_status_rank(old.status);
  new_rank integer := public.sms_status_rank(new.status);
  stale    boolean := false;
begin
  if lower(coalesce(old.status, '')) = lower(coalesce(new.status, ''))
     and new.error_code is not distinct from old.error_code then
    -- The same receipt twice. Nothing to say and no stamp to move.
    new.status_at := old.status_at;
    return new;
  end if;

  if lower(coalesce(old.status, '')) in ('delivered', 'undelivered', 'failed', 'canceled') then
    stale := true;
  elsif old_rank is not null and new_rank is not null and new_rank < old_rank then
    stale := true;
  end if;

  if stale then
    new.status     := old.status;
    new.accepted_status := old.accepted_status;
    new.error_code := old.error_code;
    new.error_text := old.error_text;
    new.status_at  := old.status_at;
    return new;
  end if;

  new.status_at := now();
  return new;
end $$;

drop trigger if exists sms_receipts_only_advances on public.sms_receipts;
create trigger sms_receipts_only_advances
  before update on public.sms_receipts
  for each row execute function public.sms_receipt_only_advances();

-- ------------------------------------------------------------ who may read --

alter table public.sms_receipts enable row level security;

-- RLS IS NOT ENOUGH IN THIS PROJECT. Tables arrive with write grants for anon
-- and authenticated attached by default, and a policy-less table with a live
-- grant is one policy away from readable. No policy is created here and no
-- client role holds a privilege to exercise: the service role is the only
-- reader and the only writer.
revoke all on public.sms_receipts from anon, authenticated;

-- --------------------------------------------------- post-conditions -------
--
-- Everything below happens inside a sub-transaction that raises at the end, so
-- the rows it writes never exist. It proves the four things the route and the
-- digest are built on top of, against the real table rather than a description
-- of it.
do $$
declare
  sid  text := 'SM_0171_proof_' || gen_random_uuid()::text;
  got  text;
  gotc text;
  ok   boolean;
  n    int;
begin
  begin
    -- (a) A ROW CAN BE WRITTEN — the send path's half of this.
    insert into public.sms_receipts
      (message_sid, to_e164, kind, body_length, body_sha256, accepted_status, status)
    values (sid, '+12605550143', 'proof', 42,
            repeat('a', 64), 'queued', 'queued');
    if (select count(*) from public.sms_receipts where message_sid = sid) <> 1 then
      raise exception '0171: the attempt did not file a row';
    end if;

    -- (b) A CALLBACK ADVANCES IT.
    update public.sms_receipts set status = 'delivered' where message_sid = sid;
    select status into got from public.sms_receipts where message_sid = sid;
    if got <> 'delivered' then
      raise exception '0171: a delivered receipt did not advance the row (got %)', got;
    end if;
    if (select status_at from public.sms_receipts where message_sid = sid) is null then
      raise exception '0171: the row advanced without stamping when';
    end if;

    -- (c) AND A LATE ONE CANNOT WALK IT BACK. This is the out-of-order case:
    --     the `sent` callback posted three seconds earlier, arriving now.
    update public.sms_receipts set status = 'sent' where message_sid = sid;
    select status into got from public.sms_receipts where message_sid = sid;
    if got <> 'delivered' then
      raise exception '0171: a stale receipt walked a delivered message back to %', got;
    end if;

    -- (c2) NOR MAY A LATE FAILURE OVERWRITE AN ARRIVAL, error code and all —
    --      the shape that would erase the record of an outage if reversed.
    update public.sms_receipts
       set status = 'undelivered', error_code = '30034'
     where message_sid = sid;
    select status, error_code into got, gotc
      from public.sms_receipts where message_sid = sid;
    if got <> 'delivered' or gotc is not null then
      raise exception '0171: a terminal row was overwritten (% / %)', got, gotc;
    end if;

    -- (d) THE UNIQUE INDEX REFUSES A SECOND ROW FOR ONE MESSAGE. Without it,
    --     two callbacks arriving together would each insert their own.
    ok := false;
    begin
      insert into public.sms_receipts
        (message_sid, to_e164, kind, body_length, body_sha256, status)
      values (sid, '+12605550143', 'proof', 42, repeat('a', 64), 'queued');
    exception when unique_violation then ok := true;
    end;
    if not ok then
      raise exception '0171: a second row was accepted for one message SID';
    end if;

    -- (e) A FAILURE IS RECORDED WITH ITS REASON — the 30034 path, on a row
    --     that had not already finished.
    insert into public.sms_receipts
      (message_sid, to_e164, kind, body_length, body_sha256, accepted_status, status)
    values (sid || '_b', '+12605550143', 'proof', 42, repeat('b', 64), 'queued', 'queued');
    update public.sms_receipts
       set status = 'undelivered', error_code = '30034',
           error_text = 'the sending number is not registered for business texting'
     where message_sid = sid || '_b';
    select status, error_code into got, gotc
      from public.sms_receipts where message_sid = sid || '_b';
    if got <> 'undelivered' or gotc <> '30034' then
      raise exception '0171: the carrier rejection did not stick (% / %)', got, gotc;
    end if;

    -- (f) NO CLIENT ROLE MAY READ IT. Checked as a GRANT question rather than
    --     by trying a select, because the service role this runs as would pass
    --     any select and prove nothing.
    select count(*) into n
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = 'sms_receipts'
       and grantee in ('anon', 'authenticated');
    if n > 0 then
      raise exception
        '0171: % grant(s) remain for anon/authenticated on a table of who we texted', n;
    end if;

    select count(*) into n
      from pg_class
     where relname = 'sms_receipts'
       and relnamespace = 'public'::regnamespace
       and relrowsecurity;
    if n = 0 then
      raise exception '0171: row level security is off on sms_receipts';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  raise notice
    '0171: every text now leaves a receipt, and a receipt can only move forward.';
end $$;
