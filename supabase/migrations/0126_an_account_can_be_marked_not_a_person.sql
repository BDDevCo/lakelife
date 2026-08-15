-- 0126 — AN ACCOUNT CAN BE MARKED NOT A PERSON
--
-- ffc6567 put a recipient gate on both senders, built entirely on the SHAPE of
-- the address: RFC 2606 domains, the 555 exchange, area codes 000 and 999.
-- Everything it refuses is reserved by a published standard as unroutable, so
-- it cannot produce a false positive — and it cannot catch a fixture created
-- with a PLAUSIBLE address. `jane.doe@gmail.com` is a perfectly good mailbox
-- belonging to a perfectly real stranger, and nothing about the string says
-- whether the row using it is a test account.
--
-- That is not a gap a better regex closes. It is the difference between a fact
-- about a string and a fact about a row, so it needs a column.
--
-- ------------------------------------------------------------- what it is --
--
-- `is_fixture` means THIS ACCOUNT IS NOT A PERSON. Not "unverified", not
-- "inactive", not "bounced" — those are all things that can be true of a real
-- customer having a bad week, and folding them together would eventually
-- silence somebody's receipts. It means nobody is behind it.
--
-- It gates BOTH channels, deliberately. A row is an account, and an account is
-- either somebody or it is not; a fixture that may be emailed but not texted is
-- a distinction with no owner. The per-channel judgement already exists one
-- layer down in contactable.ts, where it belongs — that asks "is this ADDRESS
-- routable", which is a different question from "is this ROW a person".
--
-- ------------------------------------------------------- who writes to it --
--
-- Mostly the creator. Fixtures are made by service-role scripts and by
-- sessions like this one, and they can set the column on the way in — that is
-- the whole point, since a plausible address is invisible to any rule.
--
-- The trigger below is a CONVENIENCE FEEDER, not the enforcement. It catches
-- the obvious cases so a fixture built the careless way is still flagged, the
-- same shape as `zz-` feeding `lakes.is_fixture` in 0124. The enforcement is in
-- TypeScript at send time and stays there. That matters because it means this
-- SQL drifting from contactable.ts is untidy rather than dangerous: if the two
-- disagree, the sender still refuses the address on its shape.
--
-- Unlike 0124 this trigger fires only on INSERT and on UPDATE OF email/phone,
-- so it is NOT one-way. `update users set is_fixture = false where id = ...`
-- clears it and stays cleared. A lake is ours to name; a user row may turn out
-- to be a real person we mislabelled, and getting un-mislabelled must not
-- require editing their phone number first.

alter table public.users
  add column if not exists is_fixture boolean not null default false;

comment on column public.users.is_fixture is
  'TRUE = this account is not a person. Both senders refuse it: no email, no '
  'SMS, ever. Set by whoever creates a fixture, and automatically by '
  'mark_fixture_user() when the contact details are in reserved space. Distinct '
  'from unverified or inactive, which are things a real customer can be. '
  'Clearable with a plain UPDATE — see 0126.';

-- ------------------------------------------------------------ the feeder --
create or replace function public.mark_fixture_user()
returns trigger
language plpgsql
as $$
declare
  dom text;
  ten text;
begin
  dom := lower(split_part(coalesce(new.email, ''), '@', 2));
  if dom in ('example.com', 'example.net', 'example.org', 'resend.dev')
     or dom like '%.test' or dom like '%.example'
     or dom like '%.invalid' or dom like '%.localhost' or dom like '%.local'
  then
    new.is_fixture := true;
  end if;

  -- Last ten digits, so +1AAABBBCCCC and AAABBBCCCC are the same number.
  ten := right(regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g'), 10);
  if length(ten) = 10 and (
       substring(ten from 4 for 3) = '555'   -- the whole 555 exchange
    or substring(ten from 1 for 3) in ('000', '999')
    or substring(ten from 4 for 3) = '000'
  ) then
    new.is_fixture := true;
  end if;

  return new;
end $$;

comment on function public.mark_fixture_user() is
  'Feeds users.is_fixture from contact details that are reserved as '
  'unroutable. A convenience so a carelessly-made fixture is still flagged — '
  'the enforcement is the recipient gate in contactable.ts. See 0126.';

drop trigger if exists trg_mark_fixture_user on public.users;
create trigger trg_mark_fixture_user
  before insert or update of email, phone on public.users
  for each row execute function public.mark_fixture_user();

-- ----------------------------------------------------------- the backfill --
--
-- Flags every account whose details are already in reserved space. On 15 Aug
-- 2026 that is four of the six rows — every fixture carrying a 555 number,
-- including the one on 555-1212, which is directory assistance.
--
-- IT DOES NOT FLAG THEM BY EMAIL DOMAIN, because all five fixture addresses
-- sit on lakelife.ai, a domain Brendon owns and may well put real staff on.
-- The 555 numbers are the unambiguous evidence and they are what this uses.
update public.users u
   set is_fixture = true
 where u.is_fixture = false
   and length(right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10)) = 10
   and (
     substring(right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10) from 4 for 3) in ('555', '000')
     or substring(right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10) from 1 for 3) in ('000', '999')
   );

-- ------------------------------------------------------- post-conditions --
--
-- These UPDATE an existing row rather than inserting one, because
-- `users_id_fkey` points at `auth.users` — a public.users row cannot exist
-- without an auth row behind it, and manufacturing one here would test the
-- fixture rule by first faking a login. The trigger fires on INSERT and on
-- UPDATE OF email/phone with the same function body, so an update exercises
-- exactly the code an insert would. Everything is inside the rolled-back
-- block, so the row is handed back untouched.
do $$
declare
  c uuid;
  flag boolean;
  n integer;
begin
  -- THE GUINEA PIG IS NEVER THE OWNER. The first draft of this took the oldest
  -- row, which IS the owner, mutated its address through six assertions and
  -- then checked that the owner's address was still unflagged — a check that
  -- could only pass by accident and would have failed loudly here. Rolled back
  -- either way, but a post-condition that fails for its own reasons teaches
  -- the next reader to ignore it.
  select id into c from public.users
   where coalesce(email, '') <> 'brendonlochert@gmail.com'
   order by created_at limit 1;
  if c is null then return; end if;   -- nothing but the owner: nothing to prove

  begin
    -- REAL-DATA ASSERTIONS FIRST, before anything below edits a row.
    --
    -- A. THE BACKFILL LEFT NOTHING BEHIND: no unflagged account still holds a
    --    number that reaches nobody.
    select count(*) into n from public.users
     where is_fixture = false
       and length(right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)) = 10
       and substring(right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) from 4 for 3) = '555';
    if n > 0 then raise exception '0126: % account(s) still hold a 555 number unflagged', n; end if;

    -- B. AND THE ONE REAL PERSON IN THIS DATABASE IS STILL REACHABLE. The most
    --    important line in the file: if this ever fails, the owner has stopped
    --    receiving his own receipts.
    select count(*) into n from public.users
     where email = 'brendonlochert@gmail.com' and is_fixture = false;
    if n <> 1 then raise exception '0126: the owner account was flagged as a fixture'; end if;

    -- 1. A RESERVED EMAIL FLAGS ITSELF, unasked.
    update public.users set is_fixture = false where id = c;
    update public.users set email = 'nobody@example.com' where id = c;
    select is_fixture into flag from public.users where id = c;
    if not flag then raise exception '0126: a reserved email did not flag itself'; end if;

    -- 2. SO DOES A RESERVED NUMBER, including outside NANP's fiction block —
    --    5551212 is directory assistance and 5550000 is not in the block at
    --    all, and both are in this database right now.
    update public.users set email = 'real-looking@wolcottville-marine.com' where id = c;
    update public.users set is_fixture = false where id = c;
    update public.users set phone = '+12605551212' where id = c;
    select is_fixture into flag from public.users where id = c;
    if not flag then raise exception '0126: a 555 number did not flag itself'; end if;

    -- 3. AND A REAL PERSON IS LEFT ALONE. A gate that flags everybody is an
    --    outage with a good excuse.
    update public.users set email = 'a.customer@gmail.com', phone = '+12604631234' where id = c;
    update public.users set is_fixture = false where id = c;
    update public.users set phone = '+12604631234' where id = c;
    select is_fixture into flag from public.users where id = c;
    if flag then raise exception '0126: a real account was flagged'; end if;

    -- 4. THE PLAUSIBLE FIXTURE — the whole reason this column exists. Nothing
    --    about the address betrays it, so the creator says so and it sticks.
    update public.users set is_fixture = true where id = c;
    select is_fixture into flag from public.users where id = c;
    if not flag then raise exception '0126: an explicit flag did not stick'; end if;

    -- 5. AND IT CAN BE TAKEN BACK. Unlike 0124's one-way lake trigger: a user
    --    row may be a real person we mislabelled, and un-mislabelling them
    --    must not require editing their phone number first.
    update public.users set is_fixture = false where id = c;
    select is_fixture into flag from public.users where id = c;
    if flag then raise exception '0126: a mislabelled account could not be cleared'; end if;

    -- 6. CHANGING THE ADDRESS RE-JUDGES IT. Moving a real account onto a
    --    reserved number is somebody turning it into a fixture.
    update public.users set phone = '+12605550100' where id = c;
    select is_fixture into flag from public.users where id = c;
    if not flag then raise exception '0126: an edit into reserved space was missed'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
