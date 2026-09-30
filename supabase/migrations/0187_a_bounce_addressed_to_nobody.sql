-- ============================================================================
-- 0187 — A BOUNCE ADDRESSED TO NOBODY.
--
-- 0171 built this exact table for text messages, because for a month this
-- product sent 81 of them, delivered none, and nothing noticed. The reason it
-- hid was structural, not clerical: ACCEPTANCE AND DELIVERY ARE DIFFERENT
-- EVENTS. `sendSms` returned the instant Twilio took the message; the carrier's
-- verdict arrived afterwards on a callback, and there was no route, no record
-- and no screen, so the verdict was addressed to nobody.
--
-- EMAIL HAS THE SAME SHAPE AND IS NOW THE ONLY CHANNEL THAT REACHES ANYBODY.
-- `sendEmail` POSTs to api.resend.com, checks the status code, and records
-- nothing at all — it does not even read the id Resend hands back. Resend
-- accepting a message means a queue took it. Whether a mailbox took it is a
-- separate verdict, arriving later, and until this migration there was nowhere
-- for it to land. Meanwhile texting delivers nothing: the A2P brand is
-- approved but no campaign exists, so every booking confirmation, every crew
-- dispatch, every ops alarm and every notice goes out over the one door whose
-- failures we cannot see.
--
-- So this is 0171 again, for the other channel, deliberately the same table so
-- that the two read the same way. Where it differs, it differs on purpose and
-- says so.
--
-- ------------------------------------------------------ what a row holds ---
--
-- One row per message Resend accepted, and then the verdict as it arrives.
-- NOT THE SUBJECT, NOT THE BODY AND NOT A NAME — only lengths and SHA-256
-- digests. "Did it arrive" needs no words. An email subject line is a sentence
-- about somebody's rent, their lease or their home, and keeping a year of them
-- would turn an operations table into a reading of what residents were told.
-- The digests still prove two rows are the same message, or that the notice a
-- household swears they never got is the one we sent.
--
-- The recipient's address IS kept, exactly as sms_receipts keeps the number.
-- It is the whole point: an address that bounces is the fact somebody has to
-- act on. That is the outer edge of what this table holds, and the precedent
-- for it is already set.
--
-- A message refused by our OWN gates gets NO ROW AT ALL — an unsendable
-- address, a fixture account, or a park whose notices are held. It never
-- reached a provider, it is a different fact with a different fix, and counting
-- refusals as attempts would sink the delivery rate this table exists to watch.
--
-- ------------------------------------------------ why the id is UNIQUE -----
--
-- Same reason `message_sid` is. Providers redeliver a webhook whenever their
-- request to us fails or times out, and send several per message besides. Every
-- one names the same message, and every one must land on the same row. The
-- unique index is also what stops a retried SEND from filing two rows for one
-- message. A read-then-write in application code would let two simultaneous
-- deliveries both decide the row was missing.
--
-- ------------------------------------- why a receipt can only go FORWARD ---
--
-- Webhooks arrive out of order. A `sent` posted at 10:00:01 can reach us after
-- the `delivered` posted at 10:00:04, and a naive last-write-wins would walk a
-- delivered message back to "on its way". Worse in the direction that matters:
-- a late `sent` landing on a row that BOUNCED would erase the one row that
-- proves an address is dead.
--
-- So the rule is a trigger, not a route: a receipt that is older news than what
-- we hold changes NOTHING, and a message that reached a terminal status is
-- finished. The route can then be a plain UPDATE, and a redelivered webhook is
-- a no-op by construction.
--
-- AND ONE THING THAT FOLLOWS FROM THAT, SAID OUT LOUD: because `delivered` is
-- terminal, a spam complaint arriving after a delivery is refused and leaves no
-- mark. That is right for a table whose question is "did it arrive" — it did —
-- but it means THIS IS NOT A SUPPRESSION LIST and must never be read as one.
-- What a complaint obliges us to do is a decision nobody has made yet.
--
-- ------------------------------------ why an unknown status is not stale ---
--
-- This matters more here than it did for texting. NOTHING IN THIS REPOSITORY
-- WRITES DOWN RESEND'S EVENT VOCABULARY, and it was not invented here. The rank
-- function therefore returns NULL for anything it does not recognise, and the
-- trigger treats NULL as "no idea where this sits" — news worth recording
-- rather than news to throw away. A status we have never heard of lands on the
-- row verbatim, where a person can read it, instead of being silently dropped
-- by a guess about a vocabulary we have not confirmed.
--
-- ------------------------------------------------------------ who may read --
--
-- Nobody but the service role. These rows say which address was written to
-- about which park and when. RLS alone would not do it: in this project a table
-- arrives with write grants for anon and authenticated already attached, so
-- they are REVOKED outright as well.
-- ============================================================================

create table if not exists public.email_receipts (
  id              uuid primary key default gen_random_uuid(),

  -- Resend's own id for the message. The row's identity, and the only key a
  -- webhook carries. UNIQUE is the idempotency guard; see above.
  message_id      text        not null unique,

  -- Where it was sent. The address, never the name.
  to_email        text        not null,

  -- What kind of message it was, in the sending code's own words — 'booking
  -- confirmation', 'crew invitation', 'nightly digest'. So a person reading a
  -- week of bounces can see WHICH promises went unkept, not just how many.
  kind            text        not null,

  -- The park or the lake this message was about, when it was about one. Both
  -- nullable and both ON DELETE SET NULL: a receipt records something that
  -- happened and must outlive a park leaving the platform.
  park_id         uuid        references public.parks(id) on delete set null,
  lake_id         uuid        references public.lakes(id) on delete set null,

  -- The subject, as much of it as we are willing to keep: a digest and nothing
  -- else. Enough to prove two rows are the same message, not enough to read
  -- what a household was told.
  subject_sha256  text        not null,

  -- The body, same bargain. Length and digest only.
  body_length     integer     not null,
  body_sha256     text        not null,

  created_at      timestamptz not null default now(),

  -- What Resend said when it took the message. Kept separately from `status`
  -- precisely because the two disagreeing IS the story — that disagreement is
  -- the exact shape of the 81 texts, and it is invisible in one column.
  accepted_status text,

  -- The latest verdict. Starts as the accepted status, because a null here
  -- would make a message awaiting its answer indistinguishable from a message
  -- nobody ever asked about — which is what two months of email looked like
  -- from the inside.
  status          text        not null,

  -- The provider's reason, and the provider's own words for it. There is no
  -- email equivalent of sms-errors.ts and none is invented here: a bounce code
  -- dictionary written from guesswork would be worse than the raw string.
  error_code      text,
  error_text      text,

  -- When the status last actually moved. Stamped by the trigger, never by a
  -- caller, so it cannot say a row changed on a night it did not.
  status_at       timestamptz,

  -- THE ONE COLUMN THAT HAS NO TWIN IN sms_receipts, and the divergence is
  -- argued rather than silent: that channel HAS no sandbox. sms.ts says so in
  -- as many words — "This door has no sandbox behind it. Email had a sandbox
  -- sender to fall back on." A sandbox message only ever reaches the Resend
  -- account owner, so counting one as having reached a person is the same
  -- false comfort this whole table exists to remove.
  -- WRITER: recordEmailAttempt, as (from === SANDBOX_FROM), on every insert.
  -- READER: emailDeliveryReport and the ops panel, both of which exclude it.
  sandbox         boolean     not null default false
);

comment on table public.email_receipts is
  'One row per email a provider accepted, and the delivery verdict as it '
  'arrives on the provider webhook. Holds digests of the subject and body, '
  'never the subject, never the body and never a name. Written by sendEmail '
  'and by /api/resend/webhook. A message our own gates refused gets no row — '
  'it never reached a provider. NOT a suppression list: a complaint arriving '
  'after a delivery is refused by the forward-only rule.';
comment on column public.email_receipts.message_id is
  'Resend''s id for the message. UNIQUE — this index is what makes several '
  'webhook deliveries for one message land on one row instead of racing to '
  'create several.';
comment on column public.email_receipts.accepted_status is
  'What the provider said at accept time. Kept apart from status on purpose: '
  'the two disagreeing is exactly the July-to-August outage on the other '
  'channel (queued, then undelivered).';
comment on column public.email_receipts.status is
  'The latest verdict. delivered is the only value that means a mailbox took '
  'it. Only ever moves forward — see email_receipt_only_advances().';
comment on column public.email_receipts.subject_sha256 is
  'SHA-256 of the subject line. The subject itself is never stored: it is a '
  'sentence about somebody''s home or their rent.';

-- The digest's question, from both ends: what went out this week, and what
-- came back. `created_at desc` serves the window scan.
create index if not exists email_receipts_created_idx
  on public.email_receipts (created_at desc);
-- The readers only ever ask about real sends, so the index they ride excludes
-- the sandbox rather than making every query filter it out by hand.
create index if not exists email_receipts_real_idx
  on public.email_receipts (created_at desc)
  where not sandbox;

-- And the one somebody asks in a hurry: what is failing. Partial, because on a
-- healthy channel almost every row is delivered and should cost nothing to
-- skip. Four spellings because the provider's vocabulary is unconfirmed and a
-- word missing from this list costs a slower query, never a wrong answer.
create index if not exists email_receipts_failed_idx
  on public.email_receipts (created_at desc)
  where status in ('bounced', 'failed', 'complained', 'undelivered');

-- --------------------------------------------------- forward only, ever ----

/**
 * How far along a message is. Higher is later. NULL for a status we have never
 * heard of — and for email that is the common case, not the exotic one, because
 * nothing in this repository records the provider's event names. The honest
 * answer for an unrecognised status is "no idea where this sits", which the
 * trigger then treats as news worth recording rather than as news to discard.
 *
 * The ladder mirrors sms_status_rank so the two channels read the same way, and
 * adds the one rung email has that texting does not: a delayed message, which
 * is later than sent and earlier than any verdict.
 */
create or replace function public.email_status_rank(s text)
returns integer
language sql
immutable
as $$
  select case lower(coalesce(s, ''))
    when 'accepted'         then 1
    when 'scheduled'        then 2
    when 'queued'           then 3
    when 'sending'          then 4
    when 'sent'             then 5
    when 'delivery_delayed' then 6
    when 'delayed'          then 6
    when 'delivered'        then 7
    when 'bounced'          then 7
    when 'complained'       then 7
    when 'failed'           then 7
    when 'canceled'         then 7
    when 'cancelled'        then 7
    else null
  end;
$$;

/**
 * A RECEIPT MAY ADVANCE A MESSAGE. IT MAY NEVER WALK ONE BACK.
 *
 * Two rules, and the second protects the record of an outage:
 *   - once a message is terminal (delivered, bounced, complained, failed,
 *     canceled) the provider has finished with it and nothing later changes it;
 *   - otherwise a status ranking BELOW what we hold is stale news.
 *
 * A refused receipt is a no-op, not an error. Out-of-order deliveries are
 * ordinary webhook behaviour, not a caller's mistake, and raising here would
 * turn a normal Tuesday into a 500 and a redelivery storm.
 *
 * The whole verdict moves together — status, both error fields and the stamp —
 * because they are one statement from the provider. Letting a stale `sent`
 * blank the error off a row that bounced would leave a row saying a message
 * failed for no reason at all.
 */
create or replace function public.email_receipt_only_advances()
returns trigger
language plpgsql
as $$
declare
  old_rank integer := public.email_status_rank(old.status);
  new_rank integer := public.email_status_rank(new.status);
  stale    boolean := false;
begin
  if lower(coalesce(old.status, '')) = lower(coalesce(new.status, ''))
     and new.error_code is not distinct from old.error_code then
    -- The same receipt twice. Nothing to say and no stamp to move. This is the
    -- whole replay guard for the webhook: a redelivered event is a byte-for-
    -- byte identical UPDATE, and it lands here.
    new.status_at := old.status_at;
    return new;
  end if;

  if lower(coalesce(old.status, '')) in
       ('delivered', 'bounced', 'complained', 'failed', 'canceled', 'cancelled') then
    stale := true;
  elsif old_rank is not null and new_rank is not null and new_rank < old_rank then
    stale := true;
  end if;

  if stale then
    new.status          := old.status;
    new.accepted_status := old.accepted_status;
    new.error_code      := old.error_code;
    new.error_text      := old.error_text;
    new.status_at       := old.status_at;
    return new;
  end if;

  new.status_at := now();
  return new;
end $$;

drop trigger if exists email_receipts_only_advances on public.email_receipts;
create trigger email_receipts_only_advances
  before update on public.email_receipts
  for each row execute function public.email_receipt_only_advances();

-- ------------------------------------------------------------ who may read --

alter table public.email_receipts enable row level security;

-- RLS IS NOT ENOUGH IN THIS PROJECT. Tables arrive with write grants for anon
-- and authenticated attached by default, and a policy-less table with a live
-- grant is one policy away from readable. No policy is created here and no
-- client role holds a privilege to exercise: the service role is the only
-- reader and the only writer.
revoke all on public.email_receipts from anon, authenticated;

-- --------------------------------------------------- post-conditions -------
--
-- Everything below runs inside a sub-transaction that raises at the end, so the
-- rows it writes never exist. It proves what the route and the digest are built
-- on, against the real table rather than a description of it.
do $$
declare
  mid  text := 're_0187_proof_' || gen_random_uuid()::text;
  got  text;
  gotc text;
  ok   boolean;
  n    int;
begin
  begin
    -- (a) A ROW CAN BE WRITTEN — the send path's half of this.
    insert into public.email_receipts
      (message_id, to_email, kind, subject_sha256, body_length, body_sha256,
       accepted_status, status)
    values (mid, 'proof@lakelife.test', 'proof', repeat('c', 64), 42,
            repeat('a', 64), 'accepted', 'accepted');
    if (select count(*) from public.email_receipts where message_id = mid) <> 1 then
      raise exception '0187: the attempt did not file a row';
    end if;

    -- (b) A WEBHOOK ADVANCES IT.
    update public.email_receipts set status = 'delivered' where message_id = mid;
    select status into got from public.email_receipts where message_id = mid;
    if got <> 'delivered' then
      raise exception '0187: a delivered receipt did not advance the row (got %)', got;
    end if;
    if (select status_at from public.email_receipts where message_id = mid) is null then
      raise exception '0187: the row advanced without stamping when';
    end if;

    -- (c) AND A LATE ONE CANNOT WALK IT BACK. The out-of-order case: the `sent`
    --     event posted three seconds earlier, arriving now.
    update public.email_receipts set status = 'sent' where message_id = mid;
    select status into got from public.email_receipts where message_id = mid;
    if got <> 'delivered' then
      raise exception '0187: a stale receipt walked a delivered message back to %', got;
    end if;

    -- (c2) NOR MAY ANYTHING OVERWRITE AN ARRIVAL, error and all. Two shapes at
    --      once: a late bounce, which would erase the record of a delivery, and
    --      a complaint, which is refused BY DESIGN — this table answers "did it
    --      arrive" and it did. That is why it is not a suppression list.
    update public.email_receipts
       set status = 'bounced', error_code = 'hard'
     where message_id = mid;
    select status, error_code into got, gotc
      from public.email_receipts where message_id = mid;
    if got <> 'delivered' or gotc is not null then
      raise exception '0187: a terminal row was overwritten (% / %)', got, gotc;
    end if;

    update public.email_receipts set status = 'complained' where message_id = mid;
    select status into got from public.email_receipts where message_id = mid;
    if got <> 'delivered' then
      raise exception '0187: a complaint rewrote a delivery to %', got;
    end if;

    -- (d) THE UNIQUE INDEX REFUSES A SECOND ROW FOR ONE MESSAGE. Without it,
    --     two deliveries arriving together would each insert their own.
    ok := false;
    begin
      insert into public.email_receipts
        (message_id, to_email, kind, subject_sha256, body_length, body_sha256, status)
      values (mid, 'proof@lakelife.test', 'proof', repeat('c', 64), 42,
              repeat('a', 64), 'accepted');
    exception when unique_violation then ok := true;
    end;
    if not ok then
      raise exception '0187: a second row was accepted for one message id';
    end if;

    -- (e) A BOUNCE IS RECORDED WITH ITS REASON, on a row that had not finished.
    insert into public.email_receipts
      (message_id, to_email, kind, subject_sha256, body_length, body_sha256,
       accepted_status, status)
    values (mid || '_b', 'gone@lakelife.test', 'proof', repeat('c', 64), 42,
            repeat('b', 64), 'accepted', 'accepted');
    update public.email_receipts
       set status = 'bounced', error_code = 'hard',
           error_text = 'the receiving server said this mailbox does not exist'
     where message_id = mid || '_b';
    select status, error_code into got, gotc
      from public.email_receipts where message_id = mid || '_b';
    if got <> 'bounced' or gotc <> 'hard' then
      raise exception '0187: the bounce did not stick (% / %)', got, gotc;
    end if;

    -- (f) A STATUS WE HAVE NEVER HEARD OF IS RECORDED, NOT DISCARDED. This one
    --     is not in 0171 and it is the reason this table can ship before the
    --     provider's vocabulary is confirmed: an unranked status is "no idea
    --     where this sits", which is news, and it lands on the row verbatim
    --     where a person can read it.
    insert into public.email_receipts
      (message_id, to_email, kind, subject_sha256, body_length, body_sha256,
       accepted_status, status)
    values (mid || '_c', 'odd@lakelife.test', 'proof', repeat('c', 64), 42,
            repeat('d', 64), 'accepted', 'accepted');
    update public.email_receipts
       set status = 'a_word_resend_had_not_invented_yet'
     where message_id = mid || '_c';
    select status into got from public.email_receipts where message_id = mid || '_c';
    if got <> 'a_word_resend_had_not_invented_yet' then
      raise exception '0187: an unrecognised status was thrown away (got %)', got;
    end if;

    -- (g) NO CLIENT ROLE MAY READ IT. Checked as a GRANT question rather than
    --     by trying a select, because the service role this runs as would pass
    --     any select and prove nothing.
    select count(*) into n
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = 'email_receipts'
       and grantee in ('anon', 'authenticated');
    if n > 0 then
      raise exception
        '0187: % grant(s) remain for anon/authenticated on a table of who we wrote to', n;
    end if;

    select count(*) into n
      from pg_class
     where relname = 'email_receipts'
       and relnamespace = 'public'::regnamespace
       and relrowsecurity;
    if n = 0 then
      raise exception '0187: row level security is off on email_receipts';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  raise notice
    '0187: the other door leaves receipts too, and a receipt can only move forward.';
end $$;
