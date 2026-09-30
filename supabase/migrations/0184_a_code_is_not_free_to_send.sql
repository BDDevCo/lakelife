-- ============================================================================
-- 0184 — A CODE IS NOT FREE TO SEND.
--
-- Every gate in front of a message in this app answers the same question: MAY
-- WE CONTACT THIS PERSON AT ALL. Reserved space (contactable.ts), a fixture
-- account (0126), a park holding its notices (0141). Not one of them answers
-- HOW OFTEN, and the Twilio VERIFY path had no answer to that question from
-- either of its two doors — POST /api/verify/start and the park opt-in action.
-- Both walked from a shape check straight into verifications.create.
--
-- That is a loop. Accounts are free, the route is behind a session and nothing
-- else, and every turn is a real text to a real handset and a real line on the
-- Twilio bill. Twilio's own caps are per DESTINATION NUMBER; a loop that walks
-- numbers is unbounded by them. There is no middleware in this tree and no
-- firewall rule in vercel.json, so nothing else was counting either.
--
-- ------------------------------------------- the shape is already ours -----
--
-- The park claim door has counted since 0128 and locks in 0166:
-- claim_code_attempts, and at five tries claim_locked_until is set 24 hours
-- out and the code hash is destroyed. Slip issuance counts a 24-hour window of
-- park_renter_claim_events and refuses at forty (0129). This is that, for a
-- different door, on its own table. Nothing here is a new invention.
--
-- ------------------------------------------------------ what a row holds ---
--
-- One row per ATTEMPT, written before the send and whatever the send does. Not
-- per success: an attempt that Twilio refused still cost a request and still
-- belongs in the window, and counting only what flew would let a rejected loop
-- run for ever.
--
-- THE NUMBER, THE ACCOUNT AND THE ADDRESS, AND NOTHING ELSE. No name, no park,
-- no code, no body. This table answers "how many" and must not become a record
-- of who asked to verify what.
--
-- ------------------------------------------------- why user_id has no FK ---
--
-- On purpose, and it is the one place this migration departs from the house
-- pattern. A session exists before public.users always does, and a foreign key
-- that rejected the insert would UN-RECORD the attempt — which is the limiter
-- failing OPEN at exactly the moment a brand-new account starts looping. The
-- column is written by mayStartVerification and read by the same function;
-- nothing joins on it.
--
-- ------------------------------------------------------------ who may read --
--
-- Nobody but the service role. These rows say which mobile number somebody
-- asked us to text and from where. RLS alone would not do it: in this project
-- a table arrives with write grants for anon and authenticated already
-- attached, so they are REVOKED outright as well (see 0171).
--
-- ---------------------------------------------------------- and who sweeps --
--
-- sweepVerifyAttempts(), called from /api/cron/nightly, deletes anything older
-- than seven days. The widest window this table is ever asked about is 24
-- hours. A counter table with no sweeper grows for ever while looking
-- maintained.
-- ============================================================================

create table if not exists public.verify_attempts (
  id         uuid        primary key default gen_random_uuid(),

  -- Where the code was asked to go, E.164. The number, never the name.
  to_e164    text        not null,

  -- The signed-in account that asked. Nullable and deliberately NOT a foreign
  -- key — see the header. Null is a real value: the opt-in action can reach
  -- this with an expired session.
  user_id    uuid,

  -- The caller's address as the platform wrote it, or null on a local run and
  -- behind anything that strips it. A COARSE SECOND KEY, never the only one.
  ip         text,

  created_at timestamptz not null default now()
);

comment on table public.verify_attempts is
  'One row per verification code somebody asked us to send, written BEFORE the '
  'send and whatever the send does. Written and read by lib/verify-rate.ts '
  '(mayStartVerification); swept nightly by sweepVerifyAttempts. Answers "how '
  'many", never "about what" — no name, no park, no code, no body.';
comment on column public.verify_attempts.user_id is
  'The account that asked. No FK on purpose: a session predates a public.users '
  'row, and a rejected insert would un-record the attempt — the limiter '
  'failing open for a brand-new account.';
comment on column public.verify_attempts.ip is
  'Coarse second key, shared by everyone behind one NAT and null on a local '
  'run. Widens the net; never carries a refusal on its own.';

-- The limiter's only query: the last day's attempts touching this number, this
-- account or this address. created_at leads every one of them.
create index if not exists verify_attempts_number_idx
  on public.verify_attempts (to_e164, created_at desc);
create index if not exists verify_attempts_user_idx
  on public.verify_attempts (user_id, created_at desc)
  where user_id is not null;
create index if not exists verify_attempts_ip_idx
  on public.verify_attempts (ip, created_at desc)
  where ip is not null;
-- And the sweeper's.
create index if not exists verify_attempts_created_idx
  on public.verify_attempts (created_at);

-- ------------------------------------------------------------ who may read --

alter table public.verify_attempts enable row level security;

-- RLS IS NOT ENOUGH IN THIS PROJECT. No policy is created and no client role
-- holds a privilege to exercise: the service role is the only reader and the
-- only writer.
revoke all on public.verify_attempts from anon, authenticated;

-- --------------------------------------------------- post-conditions -------
--
-- Inside a sub-transaction that raises at the end, so the rows never exist.
-- Proves the three things the limiter is built on, against the real table.
do $$
declare
  n      int;
  marker text := '+1260867' || lpad((floor(random() * 10000))::int::text, 4, '0');
begin
  begin
    -- (a) AN ATTEMPT CAN BE FILED, WITH NO ACCOUNT AND NO ADDRESS. The opt-in
    --     door reaches this with a lapsed session; an insert that refused
    --     would un-record the attempt and open the limiter.
    insert into public.verify_attempts (to_e164, user_id, ip)
    values (marker, null, null);

    -- (b) AND WITH AN ACCOUNT ID THAT MATCHES NO public.users ROW. This is the
    --     no-FK decision, asserted rather than commented: a brand-new session
    --     must still be counted.
    insert into public.verify_attempts (to_e164, user_id, ip)
    values (marker, gen_random_uuid(), '203.0.113.7');

    -- (c) THE WINDOW COUNTS THEM BOTH — the query the limiter actually runs.
    select count(*) into n
      from public.verify_attempts
     where to_e164 = marker
       and created_at > now() - interval '1 hour';
    if n <> 2 then
      raise exception '0184: the hour window counted % attempts, not 2', n;
    end if;

    -- (d) NO CLIENT ROLE MAY TOUCH IT. Asked as a GRANT question, because the
    --     service role this runs as would pass any select and prove nothing.
    select count(*) into n
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = 'verify_attempts'
       and grantee in ('anon', 'authenticated');
    if n > 0 then
      raise exception
        '0184: % grant(s) remain for anon/authenticated on a table of who asked for a code', n;
    end if;

    select count(*) into n
      from pg_class
     where relname = 'verify_attempts'
       and relnamespace = 'public'::regnamespace
       and relrowsecurity;
    if n = 0 then
      raise exception '0184: row level security is off on verify_attempts';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  raise notice
    '0184: a verification code now costs an attempt row, and the fourth in an hour is refused.';
end $$;