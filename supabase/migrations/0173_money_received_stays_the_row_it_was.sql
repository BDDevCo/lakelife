-- 0173 — MONEY RECEIVED STAYS THE ROW IT WAS.
--
-- His standing rule, in his words: money received stays the row it was.
-- Corrections are NEW ROWS, removals, or stamps with reasons — never an edit
-- of the amount, the day or the method, and never a delete. That sentence is
-- written in comments all over this module. `park_charges`' own table comment
-- calls `lines` "a FROZEN snapshot". `park_payments` is described everywhere
-- as the record you argue from.
--
-- The database enforced almost none of it. Rehearsing the whole of The Haven's
-- January inside a rolled-back block on production, and then re-deriving the
-- trigger bodies from `pg_get_functiondef`, turned up seven holes — every one
-- of them a way for the ledger to say something different tomorrow about money
-- that already arrived:
--
--   · A PAYMENT COULD BE EDITED AND DELETED. `guard_park_payment` compares
--     charge_id, the hand-back stamp and the reversal stamp, and nothing else:
--     amount, received_on, method, kind and reference were all writable in
--     place, and the row could be DELETEd outright — its trigger has no DELETE
--     in its event list, while the sibling allocation trigger does.
--
--   · A REVERSAL COULD BE RUBBED OUT. The guard refuses SETTING reversed_at in
--     the wrong circumstances and never looked at `old.reversed_at -> null`.
--     So a bounced cheque could be made never to have bounced — and because
--     its allocations survive a reversal as record, the bills it had settled
--     quietly read paid again. That is the worst of the seven: the household
--     stops being chased for money the park never got.
--
--   · A RAISED BILL WAS NOT A SNAPSHOT. `guard_park_charge_void`'s body only
--     acts when `new.status = 'void'`, so amount, lines, due_on, period_month
--     and reservation_id were all rewritable in place, and a bill could be
--     DELETEd. Re-rate somebody in June and May's charge was one UPDATE away
--     from moving, which is precisely what 0070's comment promises it cannot.
--
--   · THE GO-LIVE RULE HAD ONE DOORWAY OF TWO. `park_charges_not_before_go_live`
--     is BEFORE INSERT only, so `period_month` could be UPDATEd into a month
--     before the park went live — the very thing raising a bill there is
--     refused for by name. The ledger starts at go-live, and that is his rule
--     about whose money December is, not a formatting preference.
--
--   · AN ALLOCATION COULD COME OFF A BILL BY NOBODY. The allocation guard
--     requires a non-empty `removed_reason` and never looked at `removed_by`.
--
--   · THE RECEIPT DATE COULD WALK. `park_payments_received_on_is_sane` allows
--     received_on anywhere from 730 days before created_at to 31 days after,
--     so a cheque keyed today could be edited to have arrived two years ago
--     and land in a month nobody is looking at any more. Probed at HEAD: that
--     edit is accepted. The rule's other half — moving `created_at` itself to
--     shift the window — is in fact refused today, because the CHECK
--     constrains the PAIR and a lone created_at move breaks it from the other
--     side. Both columns are frozen below all the same: the rule should not
--     depend on an attacker only ever taking one step.
--
--   · AND TWO TABLE COMMENTS HAD GONE FALSE. Corrected at the bottom.
--
-- WHAT THIS MIGRATION DOES. It makes the database enforce the rule the
-- comments already claim: every column that records what arrived is frozen
-- after the INSERT, every stamp is written once and can never be unsaid, and
-- neither a payment nor a bill can be deleted by anybody, by any path.
--
-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY STAYS CHANGEABLE, AND WHY. A guard that refuses a
-- legitimate write breaks January, so every writer was enumerated first —
-- every `.update(` in src against these three tables, and every trigger
-- function on production whose body writes them.
--
--   park_charges.paid_total — THE ONLY DERIVED COLUMN HERE. It is not a record
--     of anything; `recompute_charge_paid` rebuilds it from the payments and
--     allocations on every write that could move it. Freezing it would freeze
--     the ledger itself: no payment could ever settle a bill again.
--
--   park_charges.status — moves open <-> paid under recompute, and open -> void
--     under `voidCharge` and the run's own rollback. VOID IS TERMINAL below: a
--     cancelled bill released its money onto the household's account, and
--     un-cancelling it would claim that money twice.
--
--   park_charges.reservation_id, renter_id, created_by — ON DELETE SET NULL.
--     Deleting a tenancy, a household file or a user account makes the database
--     itself write NULL here, and 0070 chose that on purpose ("removing a
--     tenancy must not erase the money it owed"). So the NULL DIRECTION ONLY is
--     allowed; pointing a raised bill at a different tenancy or a different
--     household is refused.
--
--   park_payments.renter_id, recorded_by, amenity_booking_id — the same FK
--     write, the same one direction. WITH ONE CORRECTION TO THE SENTENCE
--     ABOVE, because it is only half true here: for money ON ACCOUNT the
--     database does NOT get to write that NULL. `park_payments_is_anchored`
--     (0102) requires `charge_id is not null or renter_id is not null`, so on
--     a payment with no charge_id the FK's own SET NULL breaks the CHECK and
--     deleting the household file is refused — today, at HEAD, with this
--     migration nowhere in sight (proved in a rolled-back block with none of
--     0173 installed). 0173 neither causes that nor worsens it: the guard
--     below lets the NULL through, and the CHECK refuses it afterwards. It is
--     named here so the next person reads "deleting a household file is
--     refused" and looks at 0102's CHECK, not at these triggers.
--
--   park_payment_allocations.applied_by, removed_by — the same again, and the
--     reason the allocation guard gains a pass-through below: without it,
--     deleting the account of anybody who ever applied or removed an
--     allocation was refused outright, because the guard read the FK's NULL as
--     an edit of the record.
--
--   The four stamps — a reversal, a hand-back across the window, a bank
--     return, and the household's confirmation — go from nothing to something
--     ONCE. Each is allowed on the write that sets it and frozen for ever
--     after, together with the columns that belong to it.
--
--   AND ONE THING THIS MIGRATION DOES MAKE HARDER, said plainly: DELETING A
--     LOT THAT CARRIES BILLS IS NOW REFUSED. `park_charges.park_lot_id` is
--     ON DELETE CASCADE (0070), so removing a lot tries to delete its bills,
--     and the cascade lands on `park_charge_is_never_deleted` — which refuses
--     by name, as it should: a lot's bills are the record of the months it
--     was rented, and they must outlive the pad. 0072 already made a lot with
--     MONEY on it undeletable; this widens that to a lot with any bill at all.
--     The only live door is the import undo (src/app/park/import-actions.ts),
--     which deletes the lots an import made ONE AT A TIME, reads each refusal,
--     and counts the pad as left behind — "2 lots this import made are still
--     on your roll — check them on Lots & rates". So it degrades honestly and
--     needs no change: a lot that has been billed is no longer a lot an undo
--     can take away, and the sentence says so on the screen.
--
--   park_payments.returned_at / return_code have no writer in the app yet
--     (0155 said so and it is still true — the processor webhook is his call).
--     They are stamped here as one-way rather than frozen, so the handler that
--     is coming writes them exactly once and no hand can unsay a bank return.
--
-- EVERY COLUMN OF BOTH TABLES IS ACCOUNTED FOR BY ONE OF THOSE RULES, and a
-- test scans this file to keep it that way: add a column to either table and
-- ledger-is-the-row-it-was.test.ts goes red until somebody has decided whether
-- it can move. Exactly one is decided somewhere else, and this is the line the
-- scan reads it off:
--
-- ACCOUNTED FOR ELSEWHERE: park_payments.charge_id — guard_park_payment has
-- refused every move of it since 0169, in both directions, with a better
-- sentence than a generic freeze could give ("a payment stays on the bill it
-- was recorded against"). One copy of the rule, and it is that one.
-- ---------------------------------------------------------------------------


-- ------------------------------------------------ a payment is the record ---

create or replace function public.park_payment_is_the_row_it_was()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare moved text;
begin
  -- WHAT ARRIVED. Named one at a time, because "the ledger refused it" is not
  -- a sentence anybody in an office can act on — `dbSaid` strips the table
  -- prefix and shows the rest, so each of these reaches the screen as English.
  moved := case
    when new.amount          is distinct from old.amount          then 'the amount'
    when new.received_on     is distinct from old.received_on     then 'the day it arrived'
    when new.method          is distinct from old.method          then 'how it was paid'
    when new.kind            is distinct from old.kind            then 'what it was for'
    when new.reference       is distinct from old.reference       then 'the cheque or transfer reference'
    when new.note            is distinct from old.note            then 'the note that went on the receipt'
    when new.fee_amount      is distinct from old.fee_amount      then 'the card fee'
    when new.park_id         is distinct from old.park_id         then 'the park it belongs to'
    when new.receipt_no      is distinct from old.receipt_no      then 'the receipt number'
    when new.drop_slip_no    is distinct from old.drop_slip_no    then 'the drop-slip number'
    when new.confirm_token   is distinct from old.confirm_token   then 'the confirmation link'
    when new.idempotency_key is distinct from old.idempotency_key then 'the key that stops it being keyed twice'
    -- CREATED_AT IS FROZEN BECAUSE A CHECK CONSTRAINT MEASURES AGAINST IT.
    -- park_payments_received_on_is_sane pins received_on to a window either
    -- side of created_at. A lone move of created_at is already refused (it
    -- breaks the pair from the other side), but a rule that holds only while
    -- nobody takes two steps is not a rule; freezing both ends it.
    when new.created_at      is distinct from old.created_at      then 'when it was keyed'
    when new.id              is distinct from old.id              then 'the row''s own id'
    else null
  end;
  if moved is not null then
    raise exception
      'park_payments: % of a payment is not edited — money received stays the row it was. Take it back (it never arrived), hand it back, or refund it, and record what really happened as its own row',
      moved;
  end if;

  -- THE THREE THE DATABASE ITSELF NULLS. Deleting a household file, a user
  -- account or an amenity booking sets these to NULL by FK, and that write
  -- must not be refused — but pointing the money at a DIFFERENT household is
  -- exactly the edit this table exists to prevent.
  if new.renter_id is distinct from old.renter_id and new.renter_id is not null then
    raise exception 'park_payments: whose money this is was settled when it was recorded — it is not moved to another household';
  end if;
  if new.recorded_by is distinct from old.recorded_by and new.recorded_by is not null then
    raise exception 'park_payments: who took this money in is part of the record — the only hand that changes it is the database''s, when that account is deleted';
  end if;
  if new.amenity_booking_id is distinct from old.amenity_booking_id and new.amenity_booking_id is not null then
    raise exception 'park_payments: the booking this money was for is part of the record — it is not moved to another booking';
  end if;

  -- ---- THE FOUR STAMPS. Nothing, then something, once, for ever. ----------

  -- A REVERSAL SAYS THE MONEY NEVER ARRIVED, AND CANNOT BE UNSAID. This is the
  -- hole that mattered most: an allocation survives a reversal as record, so
  -- clearing reversed_at made every bill that cheque had settled read paid
  -- again, and nobody would ever be chased for it.
  if old.reversed_at is not null then
    if new.reversed_at     is distinct from old.reversed_at
    or new.reversed_reason is distinct from old.reversed_reason
    or new.reversed_by     is distinct from old.reversed_by then
      raise exception
        'park_payments: that payment was taken back on % — a reversal is recorded once. Unsaying it would make every bill it had settled read paid again',
        to_char(old.reversed_at, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.reversed_at is null
    and (new.reversed_reason is distinct from old.reversed_reason
      or new.reversed_by     is distinct from old.reversed_by) then
    raise exception 'park_payments: that is a reason for a reversal that has not happened — take the payment back, or leave the row alone';
  end if;

  -- MONEY HANDED BACK ACROSS THE WINDOW (0168). The existing guard already
  -- refuses a second hand-back; the note that says WHY was left changeable,
  -- and in six months that note is the only record of the reason.
  if old.returned_on is not null then
    if new.returned_on     is distinct from old.returned_on
    or new.returned_amount is distinct from old.returned_amount
    or new.return_note     is distinct from old.return_note then
      raise exception
        'park_payments: % of that payment was handed back on % — a hand-back is recorded once, the reason it carries included',
        coalesce(old.returned_amount::text, 'some'), to_char(old.returned_on, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.returned_on is null and new.return_note is distinct from old.return_note then
    raise exception 'park_payments: that is a reason for a hand-back that has not happened — record the hand-back itself, or leave the row alone';
  end if;

  -- THE BANK SAID IT NEVER SETTLED (0155). No door writes this yet; the one
  -- that is coming writes it once, and no later hand turns a returned ACH back
  -- into money the park has.
  if old.returned_at is not null then
    if new.returned_at  is distinct from old.returned_at
    or new.return_code  is distinct from old.return_code then
      raise exception
        'park_payments: the bank returned that payment on % — a return is recorded once, and it cannot be unsaid',
        to_char(old.returned_at, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.returned_at is null and new.return_code is distinct from old.return_code then
    raise exception 'park_payments: a return code with no return behind it — record the return itself, or leave the row alone';
  end if;

  -- THE HOUSEHOLD SAID THEY HANDED IT OVER. Their word about their own money;
  -- the office does not get to take it back or restate how it was given.
  if old.renter_confirmed_at is not null then
    if new.renter_confirmed_at  is distinct from old.renter_confirmed_at
    or new.renter_confirmed_via is distinct from old.renter_confirmed_via then
      raise exception
        'park_payments: the household confirmed that payment on % — their confirmation is theirs, and it is recorded once',
        to_char(old.renter_confirmed_at, 'FMDDth FMMonth YYYY');
    end if;
  elsif new.renter_confirmed_at is null
    and new.renter_confirmed_via is distinct from old.renter_confirmed_via then
    raise exception 'park_payments: a how with no confirmation behind it — record the confirmation itself, or leave the row alone';
  end if;

  return new;
end $$;

comment on function public.park_payment_is_the_row_it_was() is
  'Freezes everything a payment records about what arrived, and makes each of '
  'its four stamps — reversal, hand-back, bank return, household confirmation '
  '— one-way. charge_id is left to guard_park_payment, which has the better '
  'sentence for it.';


create or replace function public.park_payment_is_never_deleted()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  raise exception
    'park_payments: money received is never deleted — take it back if it never arrived, hand it back, or refund it. The row stays as the record of what happened';
end $$;

comment on function public.park_payment_is_never_deleted() is
  'The sibling allocation trigger has covered DELETE since 0167; this table did '
  'not, so a receipt could be made never to have existed — leaving a hole in '
  'the receipt-number sequence and a bank statement nobody could reconcile.';


drop trigger if exists trg_park_payment_is_the_row_it_was on public.park_payments;
create trigger trg_park_payment_is_the_row_it_was
  before update on public.park_payments
  for each row execute function public.park_payment_is_the_row_it_was();

drop trigger if exists trg_park_payment_is_never_deleted on public.park_payments;
create trigger trg_park_payment_is_never_deleted
  before delete on public.park_payments
  for each row execute function public.park_payment_is_never_deleted();


-- --------------------------------------------------- a bill is a snapshot ---

create or replace function public.park_charge_is_the_row_it_was()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare moved text;
begin
  -- THE MONTH FIRST, AND WITH ITS OWN SENTENCE, because editing it is the
  -- second doorway onto a rule that only ever had one guard:
  -- park_charges_not_before_go_live is BEFORE INSERT, so a bill raised in a
  -- live month could be walked backwards into one the seller was collecting.
  -- Freezing the column shuts that door without re-judging every existing bill
  -- on every write of paid_total, which widening the trigger's event list
  -- would have done.
  if new.period_month is distinct from old.period_month then
    raise exception
      'park_charges: the month a bill is for is not edited — cancel it with a reason and raise the right month. Moving it is also how a bill reaches a month before the park went live, and raising one there is already refused';
  end if;

  moved := case
    when new.amount      is distinct from old.amount      then 'what a bill came to'
    when new.lines       is distinct from old.lines       then 'the statement the household was shown'
    when new.due_on      is distinct from old.due_on      then 'the day a bill fell due'
    when new.park_id     is distinct from old.park_id     then 'the park a bill belongs to'
    when new.park_lot_id is distinct from old.park_lot_id then 'the lot a bill was raised on'
    when new.created_at  is distinct from old.created_at  then 'when a bill was raised'
    when new.id          is distinct from old.id          then 'the row''s own id'
    else null
  end;
  if moved is not null then
    raise exception
      'park_charges: % is not edited — a raised bill is the snapshot the ledger argues from. Cancel it with a reason and raise the right one',
      moved;
  end if;

  -- THE THREE THE DATABASE ITSELF NULLS (0070). Deleting a tenancy, a
  -- household file or a user account must not erase the money owed, so the FK
  -- writes NULL here — but pointing a raised bill at a different tenancy or a
  -- different household is the edit this guard exists to refuse.
  if new.reservation_id is distinct from old.reservation_id and new.reservation_id is not null then
    raise exception 'park_charges: the tenancy a bill was raised against is part of the bill — it is not moved to another one';
  end if;
  if new.renter_id is distinct from old.renter_id and new.renter_id is not null then
    raise exception 'park_charges: whose bill this is was settled when it was raised — it is not moved to another household';
  end if;
  if new.created_by is distinct from old.created_by and new.created_by is not null then
    raise exception 'park_charges: who raised the bill is part of the record — the only hand that changes it is the database''s, when that account is deleted';
  end if;

  -- A CANCELLATION IS FINAL. Cancelling a bill releases the money taken
  -- against it onto the household's account (0169); bringing the bill back
  -- would claim that money twice, on two bills at once.
  if old.status = 'void' and new.status is distinct from 'void' then
    raise exception
      'park_charges: that bill was cancelled — its money went back onto the household''s account, so bringing it back would claim the same money twice. Raise the month again instead';
  end if;

  -- AND IT SAYS WHEN AND WHY, ON THE WRITE THAT MAKES IT. 0070's CHECK is
  -- satisfied vacuously by a void with no timestamp: voided_at null, so no
  -- reason is required, and the accountant finds a cancelled bill and nothing
  -- saying why. Scoped to the cancelling write so recompute_charge_paid can
  -- still touch a bill that was cancelled before this rule existed.
  if new.status = 'void' and old.status is distinct from 'void'
     and (new.voided_at is null or coalesce(btrim(new.void_reason), '') = '') then
    raise exception 'park_charges: a cancelled bill says when it was cancelled and why — both, on the same write';
  end if;

  if old.voided_at is not null then
    if new.voided_at   is distinct from old.voided_at
    or new.void_reason is distinct from old.void_reason then
      raise exception
        'park_charges: that bill was cancelled on % — a cancellation is recorded once, the reason it carries included',
        to_char(old.voided_at, 'FMDDth FMMonth YYYY');
    end if;
  end if;

  -- PAID IS A FACT ABOUT MONEY, NOT A WORD SOMEBODY TYPES. paid_total stays
  -- changeable because recompute_charge_paid rebuilds it from the payments and
  -- allocations — but the two must agree, or a bill reads settled with nothing
  -- behind it and nobody is ever chased. recompute writes exactly this
  -- relation; so does the void guard, and void is excluded here because a
  -- cancelled bill holds nothing by definition.
  if new.status = 'paid' and new.paid_total < new.amount then
    raise exception
      'park_charges: a bill is paid when the money is on it — this one came to % and has % on it',
      new.amount, new.paid_total;
  end if;
  if new.status = 'open' and new.amount > 0 and new.paid_total >= new.amount then
    raise exception 'park_charges: that bill has been paid in full — it cannot be left reading as owing';
  end if;

  return new;
end $$;

comment on function public.park_charge_is_the_row_it_was() is
  'Makes `lines` the frozen snapshot 0070''s table comment has always claimed '
  'it is, closes the second doorway onto the go-live rule (period_month by '
  'UPDATE), makes a cancellation final and complete, and stops "paid" being a '
  'word somebody can type onto a bill with no money on it.';


create or replace function public.park_charge_is_never_deleted()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  raise exception
    'park_charges: a raised bill is never deleted — cancel it with a reason. The row stays, so the month it covered can be explained a year from now';
end $$;

comment on function public.park_charge_is_never_deleted() is
  'Closes the delete 0072 left open. 0072 made a lot with MONEY on it '
  'undeletable by FK; a bill with no payment yet was still one DELETE from '
  'never having been raised, and the run would then bill that month again.';


drop trigger if exists trg_park_charge_is_the_row_it_was on public.park_charges;
create trigger trg_park_charge_is_the_row_it_was
  before update on public.park_charges
  for each row execute function public.park_charge_is_the_row_it_was();

drop trigger if exists trg_park_charge_is_never_deleted on public.park_charges;
create trigger trg_park_charge_is_never_deleted
  before delete on public.park_charges
  for each row execute function public.park_charge_is_never_deleted();


-- ------------------------------------ a removal has somebody's name on it ---
--
-- 0167's guard requires a non-empty `removed_reason` and never looked at
-- `removed_by`, so money could come off a bill for a stated reason by nobody.
-- The same rewrite adds the pass-through the FK needs: `applied_by` and
-- `removed_by` are ON DELETE SET NULL, and the old body read that NULL as an
-- edit — so deleting the account of anybody who had ever applied or removed an
-- allocation was refused outright, with a sentence about editing allocations.

create or replace function public.guard_park_payment_allocation()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare pay record; ch record; src_st text; left_on_payment numeric(10,2); left_on_bill numeric(10,2);
        fk_set_null boolean;
begin
  -- THE ONLY UPDATE IS A REMOVAL, ONCE, WITH A REASON. Every other column is
  -- the record of what was applied and must read the same in a year. A
  -- removal on a reversed payment or a cancelled bill is allowed — the row
  -- already counts toward nothing, and refusing the correction would leave
  -- the office unable to say why it came off.
  if tg_op = 'UPDATE' then
    -- THE DATABASE'S OWN WRITE, NOT A HAND'S. Exactly one thing changed and it
    -- was a person's id going to NULL because their account was deleted.
    fk_set_null :=
          new.id             =                old.id
      and new.park_id        =                old.park_id
      and new.payment_id     =                old.payment_id
      and new.charge_id      =                old.charge_id
      and new.amount         =                old.amount
      and new.applied_at     =                old.applied_at
      and new.applied_via    =                old.applied_via
      and new.removed_at     is not distinct from old.removed_at
      and new.removed_reason is not distinct from old.removed_reason
      and (new.applied_by is not distinct from old.applied_by or new.applied_by is null)
      and (new.removed_by is not distinct from old.removed_by or new.removed_by is null)
      and (new.applied_by is distinct from old.applied_by
        or new.removed_by is distinct from old.removed_by);
    if fk_set_null then
      return new;
    end if;

    if new.id <> old.id
       or new.park_id <> old.park_id
       or new.payment_id <> old.payment_id
       or new.charge_id <> old.charge_id
       or new.amount <> old.amount
       or new.applied_at <> old.applied_at
       or new.applied_by is distinct from old.applied_by
       or new.applied_via <> old.applied_via then
      raise exception 'park_payment_allocations: an allocation is not edited — take it off the bill (with a reason) and apply again';
    end if;
    if old.removed_at is not null then
      raise exception 'park_payment_allocations: that allocation was already taken off its bill';
    end if;
    if new.removed_at is null then
      raise exception 'park_payment_allocations: an allocation is not edited — take it off the bill (with a reason) and apply again';
    end if;
    if length(btrim(coalesce(new.removed_reason, ''))) = 0 then
      raise exception 'park_payment_allocations: say why it is coming off the bill — the record has to carry the reason';
    end if;
    -- AND WHO. A reason with nobody behind it is the office reading "wrong
    -- month" in March with no one to ask what happened. Every door onto this
    -- is behind assertMyPark, so a signed-in person is always to hand.
    if new.removed_by is null then
      raise exception 'park_payment_allocations: say who is taking it off the bill — a removal nobody signed is a correction nobody can be asked about';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'park_payment_allocations: an allocation is never deleted — take it off the bill with a reason, and the row stays as the record';
  end if;

  -- A NEW ROW IS LIVE. Inserting one already removed would be a record of a
  -- correction to an application that never happened.
  if new.removed_at is not null or new.removed_reason is not null or new.removed_by is not null then
    raise exception 'park_payment_allocations: a new allocation cannot arrive already taken off its bill';
  end if;

  -- FOR UPDATE ON BOTH ROWS. Two allocations from the same payment submitted
  -- at once — the run and the office, say — would each read the same
  -- remainder and together apply more than there is. Locking the payment
  -- serialises them; locking the bill does the same for two payments landing
  -- on one bill.
  select p.id, p.park_id, p.renter_id, p.kind, p.charge_id, p.reversed_at, p.returned_at, p.amount
    into pay
    from public.park_payments p
   where p.id = new.payment_id
     for update;
  if not found then
    raise exception 'park_payment_allocations: no such payment';
  end if;

  if pay.kind = 'deposit' then
    raise exception 'park_payment_allocations: a deposit is held money — it cannot pay a bill';
  end if;
  if pay.kind <> 'rent' then
    raise exception 'park_payment_allocations: only rent on account can be put against a bill (this was %)', pay.kind;
  end if;
  -- A LIVE BILL'S MONEY IS THAT BILL'S (0169). A void bill's is released onto
  -- account, and this is the door it reaches the next bill through.
  if pay.charge_id is not null then
    select c.status into src_st from public.park_charges c where c.id = pay.charge_id;
    if src_st is distinct from 'void' then
      raise exception 'park_payment_allocations: that payment is against a live bill — it is that bill''s money';
    end if;
  end if;
  if pay.reversed_at is not null then
    raise exception 'park_payment_allocations: that payment was reversed — there is nothing to apply';
  end if;
  if pay.returned_at is not null then
    raise exception 'park_payment_allocations: the bank returned that payment — it never settled, so it cannot pay a bill';
  end if;
  if new.park_id <> pay.park_id then
    raise exception 'park_payment_allocations: the allocation and the payment belong to different parks';
  end if;

  select c.id, c.park_id, c.renter_id, c.status, c.amount
    into ch
    from public.park_charges c
   where c.id = new.charge_id
     for update;
  if not found then
    raise exception 'park_payment_allocations: no such bill';
  end if;
  if ch.status = 'void' then
    raise exception 'park_payment_allocations: that bill was cancelled — put the money against a live one';
  end if;
  if ch.park_id <> pay.park_id then
    raise exception 'park_payment_allocations: the payment and the bill belong to different parks';
  end if;
  -- SOMEBODY ELSE'S BILL. The ids come from a browser, and one household's
  -- cheque on another's rent is found only by the household who gets chased.
  if pay.renter_id is not null and ch.renter_id is not null and pay.renter_id <> ch.renter_id then
    raise exception 'park_payment_allocations: that money is a different household''s — it cannot pay this bill';
  end if;

  -- BOTH CEILINGS, LIVE. Read through the same two functions every other
  -- reader uses, not off paid_total — an AFTER trigger's write is not visible
  -- to a later row's BEFORE trigger in the same statement.
  left_on_payment := public.park_payment_remaining(pay.id);
  if new.amount > left_on_payment then
    raise exception 'park_payment_allocations: only % is left on that payment, and this would apply %', left_on_payment, new.amount;
  end if;
  left_on_bill := ch.amount - public.park_charge_paid_total(ch.id);
  if new.amount > left_on_bill then
    raise exception 'park_payment_allocations: that bill only has % left on it, and this would apply %', left_on_bill, new.amount;
  end if;

  return new;
end $$;


-- --------------------------------------------- two comments that had lied ---
--
-- A comment nobody can trust is worse than no comment: the next person reads
-- it, believes it, and writes code against a rule that is not there.

comment on table public.park_payment_allocations is
  'Which dollars of a payment paid which bill. Each allocation is a separate '
  'fact about the payment, so one payment can settle several months. THE '
  'PAYMENT ROW NEVER MOVES: money taken on account keeps charge_id null, and '
  'money taken against a bill keeps THAT bill''s id even after the bill is '
  'cancelled — 0169 releases a cancelled bill''s money onto account as a '
  'derived fact rather than by rewriting the row, and this is the door it '
  'reaches the next bill through. (The old comment here said charge_id stays '
  'null, which 0169 deliberately changed.) recompute_charge_paid counts these '
  'toward paid_total for payments that still stand — a reversed or '
  'bank-returned payment drops out of every bill it was put against. Written '
  'only by the service role: the run (applied_via run) and the office '
  '(applied_via office). Never deleted and never edited: an office correction '
  'sets removed_at/removed_reason/removed_by once, with a reason AND a name '
  '(0173), and every reader ignores a removed row.';

comment on table public.park_charges is
  'One household, one month. `lines` is a FROZEN snapshot of the statement — '
  're-rating somebody in June must not move May''s charge, or the ledger '
  'cannot be reconciled against a bank statement. Frozen is now enforced and '
  'not merely claimed: park_charge_is_the_row_it_was (0173) refuses an edit of '
  'the lines, the amount, the month, the due day or the lot, and '
  'park_charge_is_never_deleted refuses the delete. A bill that should not '
  'have been raised is CANCELLED, with a reason, and the row stays.';

comment on table public.park_payments is
  'Money actually received. Cash and check are first-class, because that is '
  'how most park residents pay; a card payment is one more method, not the '
  'assumed one. A recorded payment is never edited and never deleted (0173): '
  'what arrived — amount, day, method, kind, reference — is frozen at the '
  'insert, and the four stamps (reversal, hand-back, bank return, household '
  'confirmation) are written once and cannot be unsaid. A correction is a new '
  'row, a reversal, a hand-back or a refund.';


-- ------------------------------------------------------ post-conditions -----
--
-- The whole thing, on real tables, and then rolled back: every refusal proved
-- BY NAME, and every legitimate write proved to still land — because a guard
-- that breaks the run is worse than the hole it closes.

do $$
declare
  lid uuid; pid uuid; lot uuid; rnt uuid; usr uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid;
  pay_bill uuid; pay_acct uuid; pay_ach uuid; alloc uuid;
  m0 text; m1 text; m2 text; cut date; ok boolean;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then
    raise notice '0173: no lake to hang a fixture on — post-conditions skipped';
    return;
  end if;
  select id into usr from public.users limit 1;

  -- Dates come from today because park_payments_received_on_is_sane pins
  -- received_on to a window either side of created_at, and go-live has to be
  -- on or before the month billed.
  cut := date_trunc('month', current_date)::date;
  m0  := to_char(cut, 'YYYY-MM');
  m1  := to_char(cut + interval '1 month', 'YYYY-MM');
  m2  := to_char(cut + interval '2 months', 'YYYY-MM');

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active, cutover_date)
    values ('0173 Proof', '1 Rd', '0173-proof', lid, 'mh', false, cut)
    returning id into pid;
    insert into public.park_lots (park_id, lot_number) values (pid, 'P') returning id into lot;
    insert into public.park_renters (park_id, display_name) values (pid, '0173 Household')
      returning id into rnt;

    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount, lines)
    values (pid, lot, rnt, m0, cut, 542.53, '[{"label":"Lot rent","amount":400}]'::jsonb) returning id into c1;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount)
    values (pid, lot, rnt, m1, cut + interval '1 month', 542.53) returning id into c2;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount)
    values (pid, lot, rnt, m2, cut + interval '2 months', 542.53) returning id into c3;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount)
    values (pid, lot, rnt, m0, cut, 100.00) returning id into c4;
    insert into public.park_charges (park_id, park_lot_id, renter_id, period_month, due_on, amount)
    values (pid, lot, rnt, m0, cut, 100.00) returning id into c5;

    -- (1) THE ORDINARY THING STILL WORKS. A cheque against January's bill, and
    --     the trigger's own UPDATE of paid_total and status passes the new
    --     guard — if it did not, no payment could settle a bill ever again.
    insert into public.park_payments (charge_id, park_id, renter_id, kind, amount, method, received_on, note)
    values (c1, pid, rnt, 'rent', 542.53, 'check', current_date, 'cheque 1001')
    returning id into pay_bill;
    if (select status from public.park_charges where id = c1) <> 'paid'
    or (select paid_total from public.park_charges where id = c1) <> 542.53 then
      raise exception '0173: a payment no longer settles its bill';
    end if;

    -- (2) WHAT ARRIVED IS FROZEN. Each refused by name.
    ok := false;
    begin update public.park_payments set amount = 1.00 where id = pay_bill;
    exception when others then ok := sqlerrm like '%the amount%'; end;
    if not ok then raise exception '0173: a payment''s amount can still be edited'; end if;

    ok := false;
    begin update public.park_payments set received_on = current_date - 5 where id = pay_bill;
    exception when others then ok := sqlerrm like '%the day it arrived%'; end;
    if not ok then raise exception '0173: the day money arrived can still be edited'; end if;

    ok := false;
    begin update public.park_payments set method = 'cash' where id = pay_bill;
    exception when others then ok := sqlerrm like '%how it was paid%'; end;
    if not ok then raise exception '0173: a payment''s method can still be edited'; end if;

    ok := false;
    begin update public.park_payments set kind = 'deposit' where id = pay_bill;
    exception when others then ok := sqlerrm like '%what it was for%'; end;
    if not ok then raise exception '0173: what a payment was for can still be edited'; end if;

    ok := false;
    begin update public.park_payments set reference = 'rewritten' where id = pay_bill;
    exception when others then ok := sqlerrm like '%reference%'; end;
    if not ok then raise exception '0173: a payment''s reference can still be edited'; end if;

    ok := false;
    begin update public.park_payments set note = 'rewritten' where id = pay_bill;
    exception when others then ok := sqlerrm like '%note that went on the receipt%'; end;
    if not ok then raise exception '0173: the note on a receipt can still be edited'; end if;

    -- (3) AND created_at WITH THEM — otherwise the received_on sanity rule is
    --     defeated by moving the post rather than the ball.
    ok := false;
    begin update public.park_payments set created_at = now() - interval '800 days' where id = pay_bill;
    exception when others then ok := sqlerrm like '%when it was keyed%'; end;
    if not ok then raise exception '0173: created_at is still writable, so received_on_is_sane is still defeatable'; end if;

    -- (4) A PAYMENT IS NEVER DELETED.
    ok := false;
    begin delete from public.park_payments where id = pay_bill;
    exception when others then ok := sqlerrm like '%never deleted%'; end;
    if not ok then raise exception '0173: a payment can still be deleted outright'; end if;

    -- (5) THE HOUSEHOLD'S CONFIRMATION LANDS, THEN CANNOT BE TAKEN BACK.
    update public.park_payments
       set renter_confirmed_at = now(), renter_confirmed_via = 'link'
     where id = pay_bill;
    ok := false;
    begin update public.park_payments set renter_confirmed_at = null where id = pay_bill;
    exception when others then ok := sqlerrm like '%confirmation is theirs%'; end;
    if not ok then raise exception '0173: a household''s confirmation can still be rubbed out'; end if;

    -- (6) A REVERSAL LANDS, REOPENS THE BILL, AND CANNOT BE UNSAID. This is
    --     the hole that mattered: with reversed_at clearable, a bounced cheque
    --     could be made never to have bounced.
    update public.park_payments
       set reversed_at = now(), reversed_reason = 'the cheque bounced'
     where id = pay_bill;
    if (select status from public.park_charges where id = c1) <> 'open'
    or (select paid_total from public.park_charges where id = c1) <> 0 then
      raise exception '0173: reversing a payment no longer reopens its bill';
    end if;
    ok := false;
    begin update public.park_payments set reversed_at = null where id = pay_bill;
    exception when others then ok := sqlerrm like '%recorded once%'; end;
    if not ok then raise exception '0173: a reversal can still be rubbed out'; end if;
    ok := false;
    begin update public.park_payments set reversed_reason = 'actually it cleared' where id = pay_bill;
    exception when others then ok := sqlerrm like '%recorded once%'; end;
    if not ok then raise exception '0173: a reversal''s reason can still be rewritten'; end if;

    -- (7) THE FK'S OWN WRITE STILL LANDS, AND ONLY IN THE NULL DIRECTION.
    update public.park_payments set renter_id = null where id = pay_bill;
    ok := false;
    begin update public.park_payments set renter_id = rnt where id = pay_bill;
    exception when others then ok := sqlerrm like '%another household%'; end;
    if not ok then raise exception '0173: money can still be moved to another household'; end if;

    -- (8) MONEY ON ACCOUNT, PUT AGAINST A BILL, TAKEN OFF IT BY A NAMED HAND.
    insert into public.park_payments (charge_id, park_id, renter_id, kind, amount, method, received_on)
    values (null, pid, rnt, 'rent', 1085.06, 'check', current_date) returning id into pay_acct;
    insert into public.park_payment_allocations (park_id, payment_id, charge_id, amount, applied_by, applied_via)
    values (pid, pay_acct, c2, 542.53, usr, 'office') returning id into alloc;
    if (select status from public.park_charges where id = c2) <> 'paid' then
      raise exception '0173: an allocation no longer settles its bill';
    end if;

    ok := false;
    begin
      update public.park_payment_allocations
         set removed_at = now(), removed_reason = 'wrong month'
       where id = alloc;
    exception when others then ok := sqlerrm like '%say who%'; end;
    if not ok then raise exception '0173: money can still come off a bill by nobody'; end if;

    if usr is not null then
      -- The FK's own write: exactly one id going to NULL because an account
      -- was deleted. The old body read this as an edit and refused it.
      update public.park_payment_allocations set applied_by = null where id = alloc;

      update public.park_payment_allocations
         set removed_at = now(), removed_reason = 'wrong month', removed_by = usr
       where id = alloc;
      if (select status from public.park_charges where id = c2) <> 'open' then
        raise exception '0173: taking an allocation off a bill no longer reopens it';
      end if;
    else
      raise notice '0173: no user row to sign a removal — that half skipped';
    end if;

    -- (9) A HAND-BACK LANDS, AND ITS REASON IS FROZEN WITH IT.
    update public.park_payments
       set returned_on = current_date, returned_amount = 542.53,
           return_note = 'handed back at the window'
     where id = pay_acct;
    ok := false;
    begin update public.park_payments set return_note = 'something else' where id = pay_acct;
    exception when others then ok := sqlerrm like '%handed back on%'; end;
    if not ok then raise exception '0173: the reason money was handed back can still be rewritten'; end if;

    -- (10) A BANK RETURN LANDS ONCE — the stamp the webhook that is coming
    --      will write, proved before it has a writer.
    insert into public.park_payments (charge_id, park_id, renter_id, kind, amount, method, reference, received_on)
    values (c3, pid, rnt, 'rent', 542.53, 'ach', 'ACH-0173', current_date) returning id into pay_ach;
    update public.park_payments set returned_at = now(), return_code = 'R01' where id = pay_ach;
    if (select status from public.park_charges where id = c3) <> 'open' then
      raise exception '0173: a bank return no longer reopens its bill';
    end if;
    ok := false;
    begin update public.park_payments set returned_at = null where id = pay_ach;
    exception when others then ok := sqlerrm like '%bank returned%'; end;
    if not ok then raise exception '0173: a bank return can still be unsaid'; end if;

    -- (11) A RAISED BILL IS THE SNAPSHOT IT CLAIMS TO BE.
    ok := false;
    begin update public.park_charges set amount = 1.00 where id = c4;
    exception when others then ok := sqlerrm like '%what a bill came to%'; end;
    if not ok then raise exception '0173: a bill''s amount can still be edited'; end if;

    ok := false;
    begin update public.park_charges set lines = '[]'::jsonb where id = c1;
    exception when others then ok := sqlerrm like '%statement the household was shown%'; end;
    if not ok then raise exception '0173: a bill''s frozen lines can still be edited'; end if;

    ok := false;
    begin update public.park_charges set due_on = cut + 40 where id = c4;
    exception when others then ok := sqlerrm like '%day a bill fell due%'; end;
    if not ok then raise exception '0173: a bill''s due day can still be edited'; end if;

    -- (12) AND THE MONTH WITH THEM — the second doorway onto the go-live rule,
    --      which BEFORE INSERT alone could never see.
    ok := false;
    begin
      update public.park_charges
         set period_month = to_char(cut - interval '1 month', 'YYYY-MM')
       where id = c4;
    exception when others then ok := sqlerrm like '%before the park went live%'; end;
    if not ok then raise exception '0173: a bill can still be walked back into a month before go-live'; end if;

    -- (13) A BILL IS NEVER DELETED. c5 carries no money at all, so this is the
    --      new trigger refusing it and not 0072's foreign key.
    ok := false;
    begin delete from public.park_charges where id = c5;
    exception when others then ok := sqlerrm like '%never deleted%'; end;
    if not ok then raise exception '0173: a raised bill can still be deleted outright'; end if;

    -- (14) CANCELLING STILL WORKS, AND IS FINAL AND COMPLETE.
    ok := false;
    begin update public.park_charges set status = 'void' where id = c5;
    exception when others then ok := sqlerrm like '%when it was cancelled and why%'; end;
    if not ok then raise exception '0173: a bill can still be cancelled with no date and no reason'; end if;

    update public.park_charges
       set status = 'void', voided_at = now(), void_reason = 'raised in error'
     where id = c5;
    ok := false;
    begin update public.park_charges set status = 'open' where id = c5;
    exception when others then ok := sqlerrm like '%claim the same money twice%'; end;
    if not ok then raise exception '0173: a cancelled bill can still be brought back'; end if;
    ok := false;
    begin update public.park_charges set voided_at = now(), void_reason = 'something else' where id = c5;
    exception when others then ok := sqlerrm like '%cancelled on%'; end;
    if not ok then raise exception '0173: a cancellation''s reason can still be rewritten'; end if;

    -- (15) "PAID" IS A FACT ABOUT MONEY, NOT A WORD SOMEBODY TYPES.
    ok := false;
    begin update public.park_charges set status = 'paid' where id = c4;
    exception when others then ok := sqlerrm like '%paid when the money is on it%'; end;
    if not ok then raise exception '0173: a bill can still be marked paid with nothing on it'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  raise notice '0173: money received stays the row it was — and the ledger still bills, settles, cancels and hands back.';
end $$;
