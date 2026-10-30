-- 0203  AN ACH CREDIT NEEDS TO KNOW CHECKING OR SAVINGS
--
-- "yes add the checking or savings field" — 29 Oct 2026.
--
-- `payout_accounts` has never asked. The CSV rail never needed it: the bank
-- matched on the routing number and sorted the rest out itself. Mercury's API
-- does need it — `electronicAccountType` is part of creating a recipient —
-- and 0202's first run shipped assuming `checking` because there was nothing
-- else to say.
--
-- An assumption is a fine thing to ship when it is written down and nobody is
-- affected yet. It stops being fine the moment a real crew is paid on it: an
-- ACH credit addressed to the wrong account type can be returned, and the
-- money comes back days later having told the crew they were paid. Worse, the
-- failure would look like the crew's details being wrong when it was our
-- guess.
--
-- ZERO CREWS HAVE GIVEN US BANK DETAILS. Verified on production again today:
-- payout_accounts holds no rows at all. So this is NOT NULL rather than
-- nullable-with-a-default, which is only free for exactly as long as that
-- stays true. A default would have been the thing this codebase has a name
-- for — a default that asserts a fact — on the one field whose wrong value
-- bounces somebody's pay.
alter table public.payout_accounts
  add column if not exists account_kind text;

-- Backfill nothing, because there is nothing. If this ever runs against a
-- database that DOES have rows, it fails here rather than inventing an answer
-- for somebody's bank account.
do $$
declare n int;
begin
  select count(*) into n from public.payout_accounts where account_kind is null;
  if n > 0 then
    raise exception '0203: % payout accounts exist with no account_kind. This migration will not guess checking or savings for somebody''s bank account — ask them, then re-run', n;
  end if;
end $$;

alter table public.payout_accounts
  alter column account_kind set not null;

alter table public.payout_accounts
  drop constraint if exists payout_accounts_account_kind_is_known;
alter table public.payout_accounts
  add constraint payout_accounts_account_kind_is_known
  check (account_kind in ('checking', 'savings'));

comment on column public.payout_accounts.account_kind is
  'checking or savings, as the crew told us. Mercury needs it to address an ACH credit (electronicAccountType) and the CSV rail never did, which is why it was missing until 0203. NOT NULL deliberately: a default here would be a guess about somebody''s bank account, and a credit addressed to the wrong type can be returned days later having already told them they were paid.';

-- ===========================================================================
-- POST-CONDITIONS — these FAIL the migration rather than report
-- ===========================================================================
do $$
declare
  u_id uuid;
  without_kind_refused boolean := false;
  bad_kind_refused boolean := false;
  checking_ok boolean := false;
  savings_ok boolean := false;
  msg text;
begin
  select user_id into u_id from public.vendors where user_id is not null limit 1;
  if u_id is null then
    raise exception '0203 post-condition: no user to probe with — the guard is unproven, which is the same as absent';
  end if;

  -- 1. A bank account with no kind is refused outright.
  begin
    insert into public.payout_accounts (user_id, bank_name, account_last4)
    values (u_id, 'Lake Community Bank', '6789');
  exception when others then without_kind_refused := true; msg := sqlerrm;
  end;
  if not without_kind_refused then
    raise exception '0203 FAILED: a payout account was saved without saying checking or savings';
  end if;

  -- 2. And an invented one is refused rather than stored and sent.
  begin
    insert into public.payout_accounts (user_id, bank_name, account_last4, account_kind)
    values (u_id, 'Lake Community Bank', '6789', 'current');
  exception when others then bad_kind_refused := true;
  end;
  if not bad_kind_refused then
    raise exception '0203 FAILED: an account kind Mercury has never heard of was accepted';
  end if;

  -- 3. Both real answers work.
  begin
    insert into public.payout_accounts (user_id, bank_name, account_last4, account_kind)
    values (u_id, 'Lake Community Bank', '6789', 'checking');
    checking_ok := true;
    delete from public.payout_accounts where user_id = u_id;
    insert into public.payout_accounts (user_id, bank_name, account_last4, account_kind)
    values (u_id, 'Lake Community Bank', '6789', 'savings');
    savings_ok := true;
  exception when others then
    raise exception '0203 FAILED: a real account kind was refused. %', sqlerrm;
  end;

  raise exception E'\n0203 PROVEN — rolling back the probe rows\n'
    '  no kind -> REFUSED .......... %\n'
    '  invented kind -> REFUSED .... %\n'
    '  checking accepted ........... %\n'
    '  savings accepted ............ %\n',
    without_kind_refused, bad_kind_refused, checking_ok, savings_ok;
exception when others then
  if sqlerrm like '%0203 PROVEN%' then
    raise notice '%', sqlerrm;
  else
    raise;
  end if;
end $$;
