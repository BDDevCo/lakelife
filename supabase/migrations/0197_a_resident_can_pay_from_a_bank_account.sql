-- 0197 — A RESIDENT CAN PAY FROM A BANK ACCOUNT, AND NO BANK NUMBER IS STORED.
--
-- Brendon, 17 October 2026, on the rails: "what about the parks renters long
-- term for their ACH or EFT not just CC processing." And on the money:
-- pay-actions.ts has carried the figure since online rent was built — about
-- $1,860 a year in card fees at The Haven versus roughly $230 on ACH.
--
-- ============ THE RAIL EXISTS EVERYWHERE EXCEPT AT ITS TWO ENDS ============
--
-- Verified against the source the day this was written:
--
--   NOTHING WRITES `method: 'ach'`. All sixteen `'ach'` sites in src/ are
--   READS — a refund rail, a sentence, a refusal. `pay-actions.ts` writes
--   `method: "card"`. The hand-keyed and resident-claim pickers offer
--   check / cash / transfer / other. `payment_methods` has brand, last4,
--   exp_month, exp_year, funding: it is a CARD table, with nowhere to put
--   a bank account at all.
--
--   AND `settled_at` / `returned_at` HAD NO WRITER. That half shipped
--   immediately before this one, so a bank debit can now land or come back.
--   It had to come first: a rail that can start a payment and never finish
--   one is worse than a rail that cannot start one.
--
-- Between those ends sit the DB's own provisional-settlement machinery (0191),
-- a `clearing` pill on two screens, a clearing line on the morning screen, a
-- reminder run that refuses to chase a clearing bill, and RenterHome telling a
-- household "$X is on its way from your bank and takes a few days". This
-- migration is the inlet.
--
-- ============ NO ROUTING NUMBER. NO ACCOUNT NUMBER. NOT ENCRYPTED EITHER ============
--
-- CLAUDE.md rule 4 says card data never touches the database — hosted-fields
-- tokenization only. A bank account is the same kind of secret and gets the
-- same treatment, so this table grows a TOKEN and four digits and nothing else.
--
-- THAT IS A DELIBERATE DEPARTURE FROM `payout_accounts`, which holds
-- `routing_encrypted` / `account_encrypted` as bytea. Those columns were
-- written when LakeLife expected to generate ACH files itself. Under
-- Architecture A it never does: each crew is its own merchant settling to its
-- own bank, so the pattern next door is the wrong pattern to copy and this
-- comment exists so the next reader does not copy it.
--
-- Enforced by SHAPE, not by comment: a post-condition below walks
-- information_schema and FAILS THIS MIGRATION if any column on this table is
-- named like a bank credential. "Just add routing_number" has to break the
-- migration that adds it rather than ship.
--
-- ============ WHY `funding` MUST BE NULL ON A BANK ROW ============
--
-- ============ WHY A BANK ROW'S `funding` IS PINNED TO 'unknown' ============
--
-- Not tidiness. `funding` is the CARD funding type, and `mayBeSurcharged`
-- returns true for exactly one value of it: 'credit'. A bank row carrying
-- funding = 'credit' would be surchargeable — the park's 3% added to a bank
-- debit, which 0109 refuses at the database
-- (`fee_amount is null or (fee_amount > 0 and method = 'card')`) and which
-- would therefore fail AFTER the money had already left the resident's
-- account.
--
-- THE OBVIOUS RULE — "null on a bank row" — IS IMPOSSIBLE, and finding that
-- out took two refused probes. Checked on production afterwards rather than
-- guessed a third time:
--
--   funding | text | NOT NULL | DEFAULT 'unknown'::text
--
-- So no row of any kind can have a null funding, and a bank row written
-- without mentioning it arrives already carrying a card funding type. A
-- constraint alone would have made bank rows unwritable unless every doorway
-- remembered to pass something — a rule in one doorway, waiting for the second
-- doorway to forget it.
--
-- 'unknown' IS THE RIGHT VALUE, not a workaround. It is the column's own word
-- for "nobody has told us how this is funded", which of a bank account is
-- permanently true, and `mayBeSurcharged('unknown')` is false. So the database
-- pins it — a BEFORE trigger in the `stamp_payment_settlement` shape 0191 uses
-- — and the CHECK demands it. A value somebody passed on purpose is overwritten
-- too, and that is correct: 'credit' on a bank account is not a fact about
-- anything, and it is the one value a surcharge could be computed from.

-- ---------------------------------------------------------------------------
-- WHAT KIND OF THING THIS IS
-- ---------------------------------------------------------------------------

alter table public.payment_methods
  -- DEFAULT 'card', so every row that exists today is already right. The two
  -- live rows are both well-formed Visas.
  add column if not exists kind         text not null default 'card',
  -- The institution, for "Chase ••••1234". Not a secret and not an identifier.
  add column if not exists bank_name    text,
  -- ACH needs it in the entry, and a resident knows which one they picked.
  add column if not exists account_kind text;

comment on column public.payment_methods.kind is
  'card | bank. A card row carries brand/exp/funding; a bank row carries '
  'bank_name/account_kind and has funding pinned to ''unknown'' — funding is '
  'CARD funding, and ''credit'' is the one value that makes a payment '
  'surchargeable, so a bank row must never be able to hold it.';

comment on column public.payment_methods.account_kind is
  'checking | savings, required on a bank row because the ACH entry carries '
  'it. NOT a credential: it says which of two kinds, not which account.';

alter table public.payment_methods
  drop constraint if exists payment_methods_kind_is_known;
alter table public.payment_methods
  add constraint payment_methods_kind_is_known check (kind in ('card', 'bank'));

-- ONE ROW IS ONE KIND OF THING. A `case` rather than a conjunction so the
-- `else false` arm refuses a kind nobody has taught it — a third value added
-- to the vocabulary above without teaching this constraint is refused rather
-- than waved through with no shape at all.
alter table public.payment_methods
  drop constraint if exists payment_methods_is_one_kind_of_thing;
alter table public.payment_methods
  add constraint payment_methods_is_one_kind_of_thing check (
    case kind
      when 'card' then
        bank_name is null and account_kind is null
      when 'bank' then
        brand is null and exp_month is null and exp_year is null
        -- THE LOAD-BEARING ONE. 'unknown' is the only funding a bank row may
        -- hold, and it is the one `mayBeSurcharged` refuses. Null is not an
        -- option: the column is NOT NULL.
        and funding = 'unknown'
        -- `is not null` FIRST, AND THAT IS NOT BELT AND BRACES. `null in
        -- (...)` is NULL, `true and null` is NULL, and a CHECK PASSES on
        -- NULL — so without it a bank row with no account_kind was accepted.
        -- The probe below caught exactly that, in this migration's own draft.
        and account_kind is not null
        and account_kind in ('checking', 'savings')
      else false
    end
  );

-- THE TRIGGER THAT MAKES THE RULE ABOVE REACHABLE.
--
-- `funding` is NOT NULL and defaults to 'unknown', so a bank row written
-- without mentioning it arrives carrying a card funding type, and no row can
-- carry none. Asking every doorway to pass the right value is a rule in one
-- doorway; this is the rule. A value somebody passed on purpose is overwritten
-- too, because 'credit' on a bank account is not a fact about anything and it
-- is the one value a surcharge could be computed from.
create or replace function public.ll_bank_method_has_no_card_funding()
returns trigger language plpgsql as $fn$
begin
  if new.kind = 'bank' then
    new.funding := 'unknown';
  end if;
  return new;
end $fn$;

comment on function public.ll_bank_method_has_no_card_funding() is
  'Pins funding to ''unknown'' on a bank payment method — the one value '
  'mayBeSurcharged refuses. Exists because the column is NOT NULL and DEFAULTS '
  'to ''unknown'', so neither a null nor a forgetful doorway is available.';

drop trigger if exists payment_methods_bank_has_no_card_funding on public.payment_methods;
create trigger payment_methods_bank_has_no_card_funding
  before insert or update on public.payment_methods
  for each row execute function public.ll_bank_method_has_no_card_funding();

-- FOUR DIGITS, AS FOUR DIGITS. `last4` has been free text since 0007 and is
-- the only thing a resident sees to tell two accounts apart; both live rows
-- already comply. On a bank row it is the only identifying fragment that
-- exists at all, which is the point.
alter table public.payment_methods
  drop constraint if exists payment_methods_last4_is_four_digits;
alter table public.payment_methods
  add constraint payment_methods_last4_is_four_digits
  check (last4 is null or last4 ~ '^[0-9]{4}$');

-- A BANK ROW MUST SAY WHICH ACCOUNT IT IS, because with no brand and no expiry
-- a bank row with no last4 is indistinguishable from any other on the screen
-- where a resident chooses which one to pay from.
alter table public.payment_methods
  drop constraint if exists payment_methods_bank_says_which_account;
alter table public.payment_methods
  add constraint payment_methods_bank_says_which_account
  -- `is not null` FIRST. `null ~ '...'` is NULL and a CHECK passes on NULL, so
  -- the obvious spelling of this accepted a bank row with no last4 at all —
  -- which the probe below caught. Three-valued logic, in the one constraint
  -- whose whole job is "say which account this is".
  check (kind <> 'bank' or (last4 is not null and last4 ~ '^[0-9]{4}$'));

-- ---------------------------------------------------------------------------
-- WHO MAY READ IT
-- ---------------------------------------------------------------------------
-- `anon` HOLDS SELECT ON THIS TABLE and has since 0007 — verified on
-- production before this was written:
--
--   anon          | SELECT
--   authenticated | SELECT
--
-- Today it reaches nothing: policy `pm_owner` is
-- `user_id = auth.uid() or ll_is_ops()`, and a signed-out caller's auth.uid()
-- is null, so no row matches. It is still a grant that should not exist on the
-- table holding every payment token on the platform — the one permissive
-- policy anybody ever adds for a public surface would turn it into a read.
-- A signed-out visitor has no payment methods, so nothing needs it.
revoke select on public.payment_methods from anon;

-- Writes were never granted to either role (checked, same query), so the
-- standing default-privileges revoke has them. Stated here so a later reader
-- does not have to go and look.

-- ---------------------------------------------------------------------------
-- POST-CONDITIONS — every probe rolls back
-- ---------------------------------------------------------------------------
do $$
declare
  ok     boolean;
  n      integer;
  leaked text;
  uid    uuid;
  t      text := '';
begin
  -- (a) NO COLUMN ON THIS TABLE COULD HOLD A BANK CREDENTIAL. Absence is the
  --     enforcement: this makes "just add routing_number" fail the migration
  --     that adds it. The same shape as 0182's household-column check.
  select string_agg(column_name, ', ') into leaked
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'payment_methods'
     and (
       column_name ~* 'rout'
       or column_name ~* 'account_number'
       or column_name ~* 'acct'
       or column_name ~* '(iban|swift|bic)'
       or column_name ~* 'encrypted'
       or column_name ~* '(^|_)(pan|cvv|cvc)($|_)'
     );
  if leaked is not null then
    raise exception '0197: payment_methods grew a column that could hold a bank credential — %', leaked;
  end if;

  -- (b) EVERY EXISTING ROW IS A WELL-FORMED CARD. If this fails the
  --     constraints above would have been added against rows that break them.
  select count(*) into n from public.payment_methods where kind <> 'card';
  if n <> 0 then
    raise exception '0197: % row(s) are not cards before anything made a bank row possible', n;
  end if;

  -- (c) ANON CANNOT READ IT.
  select string_agg(grantee || ':' || privilege_type, ', ') into leaked
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'payment_methods' and grantee = 'anon';
  if leaked is not null then
    raise exception '0197: anon can still reach payment_methods — %', leaked;
  end if;

  -- (d) AND NO CLIENT MAY WRITE IT.
  select string_agg(grantee || ':' || privilege_type, ', ') into leaked
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'payment_methods'
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if leaked is not null then
    raise exception '0197: a client can write payment_methods — %', leaked;
  end if;

  -- (e) THE SHAPES BITE, probed against real rows and rolled back.
  begin
    select id into uid from public.users order by created_at limit 1;
    if uid is null then
      raise notice '0197: no user to probe against';
      raise exception 'ROLLBACK_POSTCONDITION';
    end if;

    -- A GOOD BANK ROW IS ACCEPTED, AND ARRIVES WITH NO CARD FUNDING — which
    -- is the trigger's whole job, because the column DEFAULTS to 'unknown'.
    -- The first run of this probe was refused by the constraint for exactly
    -- that reason. Nothing mentions `funding` here, deliberately: that is what
    -- every doorway will do.
    insert into public.payment_methods (user_id, kind, token, last4, bank_name, account_kind)
    values (uid, 'bank', 'tok_bank_0197', '6789', 'Farmers State Bank', 'checking')
    returning funding into leaked;
    t := t || format('[good bank row accepted, funding=%s] ', leaked);
    if leaked <> 'unknown' then
      raise exception '0197: a bank row carries funding % — mayBeSurcharged only refuses ''unknown''', leaked;
    end if;

    -- THE ONE THAT MATTERS: a funding type passed ON PURPOSE is erased too,
    -- so the surcharge arithmetic cannot come out above zero for a bank debit
    -- whatever any doorway sends.
    insert into public.payment_methods (user_id, kind, token, last4, account_kind, funding)
    values (uid, 'bank', 'tok_bank_0197_b', '6789', 'checking', 'credit')
    returning funding into leaked;
    t := t || format('[credit funding on a bank row overwritten=%s] ', leaked = 'unknown');
    if leaked <> 'unknown' then
      raise exception '0197: a bank account stayed marked as credit-funded, which makes it surchargeable';
    end if;

    -- AND IT CANNOT BE PUT BACK BY AN UPDATE. The trigger fires on update too;
    -- without that, the row could be written clean and then surcharged later.
    update public.payment_methods set funding = 'credit' where token = 'tok_bank_0197';
    select funding into leaked from public.payment_methods where token = 'tok_bank_0197';
    t := t || format('[credit funding added later overwritten=%s] ', leaked = 'unknown');
    if leaked <> 'unknown' then
      raise exception '0197: a bank account was made credit-funded after the fact';
    end if;

    -- A bank row cannot carry a brand or an expiry either.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, last4, account_kind, brand)
      values (uid, 'bank', 'tok_bank_0197_c', '6789', 'checking', 'Visa');
    exception when check_violation then ok := true;
    end;
    t := t || format('[bank row with a brand refused=%s] ', ok);
    if not ok then raise exception '0197: a bank account carried a card brand'; end if;

    -- A bank row must say checking or savings.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, last4, account_kind)
      values (uid, 'bank', 'tok_bank_0197_d', '6789', 'brokerage');
    exception when check_violation then ok := true;
    end;
    t := t || format('[unknown account kind refused=%s] ', ok);
    if not ok then raise exception '0197: a bank account claimed a kind the ACH entry has no field for'; end if;

    -- ...and must say WHICH account.
    -- NULL, NOT A WRONG VALUE. This is the probe that caught the three-valued
    -- logic hole: `null ~ '^[0-9]{4}$'` is NULL, not false, and a CHECK passes
    -- on NULL. A wrong value ('last', below) would have been refused whatever
    -- the constraint said, so it could not tell the two spellings apart.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, account_kind)
      values (uid, 'bank', 'tok_bank_0197_e', 'checking');
    exception when check_violation then ok := true;
    end;
    t := t || format('[bank row with no last4 refused=%s] ', ok);
    if not ok then raise exception '0197: a bank account with nothing to tell it apart was accepted'; end if;

    -- THE SAME HOLE IN THE OTHER CONSTRAINT: `null in ('checking','savings')`
    -- is NULL too, so a bank row with no account kind was accepted as well.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, last4)
      values (uid, 'bank', 'tok_bank_0197_g', '6789');
    exception when check_violation then ok := true;
    end;
    t := t || format('[bank row with no account kind refused=%s] ', ok);
    if not ok then raise exception '0197: a bank account that did not say checking or savings was accepted'; end if;

    -- A card row cannot carry bank fields.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, last4, brand, account_kind)
      values (uid, 'card', 'tok_card_0197', '4242', 'Visa', 'checking');
    exception when check_violation then ok := true;
    end;
    t := t || format('[card row with an account kind refused=%s] ', ok);
    if not ok then raise exception '0197: a card row carried a bank account kind'; end if;

    -- An unknown kind is refused by the `else false` arm, not waved through.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, last4)
      values (uid, 'wallet', 'tok_wallet_0197', '4242');
    exception when check_violation then ok := true;
    end;
    t := t || format('[unknown kind refused=%s] ', ok);
    if not ok then raise exception '0197: a kind nothing has been taught about was accepted'; end if;

    -- last4 is four digits, not a word.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, last4, account_kind)
      values (uid, 'bank', 'tok_bank_0197_f', 'last', 'checking');
    exception when check_violation then ok := true;
    end;
    t := t || format('[last4 as a word refused=%s] ', ok);
    if not ok then raise exception '0197: last4 took something that was not four digits'; end if;

    -- AND THE PAN GUARD FROM 0007 STILL HOLDS for a bank token.
    ok := false;
    begin
      insert into public.payment_methods (user_id, kind, token, last4, account_kind)
      values (uid, 'bank', '4242424242424242', '6789', 'checking');
    exception when check_violation then ok := true;
    end;
    t := t || format('[a long digit run as a token refused=%s] ', ok);
    if not ok then raise exception '0197: a token that looked like an account number was accepted'; end if;

    raise notice '0197 PROBE_ROLLBACK: %', t;
    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  -- (f) NOTHING LEAKED.
  select count(*) into n from public.payment_methods where kind <> 'card';
  if n <> 0 then raise exception '0197: % probe row(s) survived', n; end if;

  raise notice '0197: a resident can be given a bank account to pay from, it holds four digits and a token, and no column here could hold a routing number.';
end $$;
