-- 0198 — MONEY THAT NEVER ARRIVED CANNOT BE SENT BACK.
--
-- Found by an adversarial audit of the money rails on 17 October 2026 and
-- proven against production the same day, inside a block that rolled back:
--
--   1 in_flight(unsettled=t) bill=open/0.00
--   2 REFUND_AGAINST_UNCLEARED_ACCEPTED=t      <-- the hole
--   3 refund_against_returned_refused=t
--
-- ============ THE GUARD'S OWN SENTENCE GIVES IT AWAY ============
--
-- `guard_park_refund` (0155, extended 0167) already refuses a refund against a
-- RETURNED payment, and the words it refuses with are:
--
--   "park_refunds: the bank returned that payment — it never settled, so it
--    cannot also be refunded"
--
-- *It never settled.* That is the reason, and the guard tested the wrong column
-- for it. A bank return is one way a payment fails to settle. The other — far
-- more ordinary — is that it simply has not settled YET: an ACH debit asked for
-- on Monday, three working days from landing, with `settled_at` null,
-- `returned_at` null and `reversed_at` null. That row passed.
--
-- The application said the same thing in the same way. `refundRefusal`
-- (app/park/refund-helpers.ts) opens with a comment naming the exact harm —
-- "Refunding it would send the money out a second time, out of the park's own
-- account, against a debit that never settled" — and then guards only the
-- already-returned half of it.
--
-- ============ WHY IT BECAME REACHABLE THIS WEEK ============
--
-- It did not matter until 17 October, because nothing in the application wrote
-- `method: 'ach'` — the rail had no inlet, so no row could be in flight. The
-- bank rail shipped its outlet (8bc5ae3) and then its inlet (1ecdce4), and the
-- state this guard does not know about became creatable the same day.
--
-- **Widening a rail widens every guard that reads it, whether or not anybody
-- edited them.** `refund-helpers.ts` was not opened by either commit.
--
-- ============ WHAT IT COSTS ============
--
-- Real money, out of the park owner's own bank account, for money that never
-- reached it — and `park_refunds` is append-only (0142), so it cannot be
-- unsaid. A $542.53 rent debit refunded on day two and returned by the bank on
-- day four costs the park $542.53 plus the return fee, and leaves the bill open.
--
-- It is also the one direction a processor cannot be relied on to save us from:
-- whether a credit against a pending debit is declined is a third party's
-- unspecified behaviour, and a product must not depend on it to avoid paying
-- out money it never collected.
--
-- ============ THIS IS AN ADDITION, NOT A REWRITE ============
--
-- The function below is the live definition read from production with ONE
-- CLAUSE ADDED. Everything else is byte-for-byte what was there, and three
-- parts of it are load-bearing in ways a rewrite would have quietly dropped:
--
--   `for update` — stated in its own comment: two refunds submitted at the
--   same moment would each read the same "already given back" total, each pass
--   the ceiling, and together hand back more than was ever taken.
--
--   THE ALLOCATION CEILING — money already applied to bills is not unapplied
--   money and cannot be sent back (0167).
--
--   `security definer` / `set search_path` — the trigger runs on a table the
--   service role writes; dropping either changes who it runs as.
--
-- A first draft of this migration DID rewrite it from memory and lost all
-- three. The lesson is the one already in this repo's vocabulary: read the live
-- definition before replacing a function, because the rules you cannot
-- remember are the ones holding the money.
--
-- ============ ONLY ACH CAN BE IN THIS STATE ============
--
-- 0191's `payment_settles_on_arrival` stamps `settled_at` on insert for cash,
-- cheque, card, transfer and other, and a CHECK enforces it — so an unsettled
-- row is an ACH row by construction. Nothing about cards or January changes
-- here, which is what probe (c) holds down.

create or replace function public.guard_park_refund()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare pay record; given numeric(10,2); given_fee numeric(10,2); allocated numeric(10,2);
begin
  -- FOR UPDATE IS LOAD-BEARING, NOT DECORATION. Two refunds submitted at the
  -- same moment would each read the same "already given back" total, each pass
  -- the ceiling check below, and together hand back more than was ever taken.
  --
  -- `settled_at` JOINS THIS SELECT (0198). A clause widened without its select
  -- reads null and refuses nobody — the exact shape that let `returned_at` go
  -- unfetched in the application for months.
  select p.id, p.park_id, p.amount, p.fee_amount, p.method, p.reversed_at, p.returned_at, p.settled_at
    into pay
    from public.park_payments p
   where p.id = new.payment_id
     for update;
  if not found then
    raise exception 'park_refunds: no such payment';
  end if;

  -- A RETURN IS NOT A REFUND. The debit never settled, so there is nothing of
  -- theirs to send back — this would be the park's own money going out.
  --
  -- FIRST, AND BEFORE THE NOT-YET CLAUSE BELOW, because the two overlap: an
  -- ACH debit can be returned before it ever settles, and "the bank sent it
  -- back" is the more specific and more useful thing to be told.
  if pay.returned_at is not null then
    raise exception 'park_refunds: the bank returned that payment — it never settled, so it cannot also be refunded';
  end if;

  if pay.reversed_at is not null then
    raise exception 'park_refunds: that payment was reversed — it is recorded as never having arrived, so there is nothing to send back';
  end if;

  -- AND IT MAY SIMPLY NOT HAVE LANDED YET (0191, closed by 0198). The ordinary
  -- case, and the one this guard was missing: an ACH debit is provisional for
  -- three to five working days. Refunding it sends real money out of the park's
  -- own account against money that has not reached it, and `park_refunds` is
  -- append-only so it cannot be unsaid.
  --
  -- ITS OWN WORDS, not folded into the return clause: a return is finished and
  -- a refund will never be right, while this one is "not yet" and becomes
  -- allowed the moment the money lands.
  if pay.settled_at is null then
    raise exception 'park_refunds: that payment has not landed yet — it is still on its way from the bank, so there is nothing of theirs to send back. Wait until it clears, or record the bank''s return if it comes back';
  end if;

  if new.park_id <> pay.park_id then
    raise exception 'park_refunds: the refund and the payment belong to different parks';
  end if;

  -- Cash and cheques are handed back across a window by a person. That is a
  -- different act with a different record, and routing it through a processor
  -- reference it does not have would put a fiction in the ledger.
  if pay.method not in ('card', 'ach') then
    raise exception 'park_refunds: only a card or ACH payment can be refunded through the processor (this one was %)', pay.method;
  end if;

  select coalesce(sum(r.amount), 0), coalesce(sum(r.fee_amount), 0)
    into given, given_fee
    from public.park_refunds r
   where r.payment_id = new.payment_id
     and r.id <> new.id;

  select coalesce(sum(a.amount), 0) into allocated
    from public.park_payment_allocations a
   where a.payment_id = new.payment_id
     and a.removed_at is null;

  if allocated > 0 and given + new.amount > pay.amount - allocated then
    raise exception 'park_refunds: that would give back %, and only % of that payment is still unapplied — % of it is against bills', given + new.amount, pay.amount - allocated, allocated;
  end if;
  if given + new.amount > pay.amount then
    raise exception 'park_refunds: that would give back %, and only % was taken', given + new.amount, pay.amount;
  end if;
  if given_fee + new.fee_amount > coalesce(pay.fee_amount, 0) then
    raise exception 'park_refunds: that would give back more card fee than was charged';
  end if;

  return new;
end $function$;

comment on function public.guard_park_refund() is
  'Refuses a refund against money that did not arrive: reversed, bank-returned, '
  'or NOT YET SETTLED (0198). The last was missing until the bank rail gained an '
  'inlet, at which point an in-flight ACH debit became refundable out of the '
  'park owner''s own account.';

-- ---------------------------------------------------------------------------
-- POST-CONDITIONS — every probe rolls back
-- ---------------------------------------------------------------------------
do $$
declare
  pid uuid; lot uuid; ren uuid; res uuid; chg uuid;
  pay uuid; pay_card uuid; pay_ret uuid; pay_cash uuid;
  uid uuid; ok boolean; t text := '';
begin
  select id into uid from public.users where role = 'ops' order by created_at limit 1;
  if uid is null then
    raise notice '0198: no ops user to probe with';
    return;
  end if;

  begin
    insert into public.parks (name, slug, cutover_date)
    values ('0198 proof', '0198-proof-' || gen_random_uuid()::text, date '2027-01-01') returning id into pid;
    insert into public.park_lots (park_id, lot_number, site_type, lifecycle)
    values (pid, '14', 'mh_single', 'live') returning id into lot;
    insert into public.park_renters (park_id, display_name) values (pid, 'H14') returning id into ren;
    insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
    values (lot, ren, daterange(date '2027-01-01', date '2027-02-01', '[)'), 'monthly', 'active') returning id into res;
    insert into public.park_charges (park_id, park_lot_id, renter_id, reservation_id, period_month, due_on, amount, status)
    values (pid, lot, ren, res, '2027-01', date '2027-01-01', 542.53, 'open') returning id into chg;

    -- (a) THE HOLE IS CLOSED. An in-flight ACH debit cannot be refunded.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, reference)
    values (pid, ren, chg, 542.53, 'ach', current_date, 'ch_inflight_0198') returning id into pay;
    ok := false;
    begin
      insert into public.park_refunds (park_id, payment_id, amount, fee_amount, reason, processor_ref, created_by)
      values (pid, pay, 542.53, 0, 'probe', 'rf_0198_a', uid);
    exception when others then ok := (sqlerrm like '%has not landed yet%');
      if not ok then raise; end if;
    end;
    t := t || format('[a in-flight refund refused=%s] ', ok);
    if not ok then raise exception '0198: an in-flight ACH debit was still refundable'; end if;

    -- (b) AND IT BECOMES ALLOWED THE MOMENT THE MONEY LANDS. Collapsed the
    --     other way on purpose: a guard that simply refused every ACH refund
    --     would pass (a) on its own and break the rail it exists to protect.
    update public.park_payments set settled_at = now() where id = pay;
    insert into public.park_refunds (park_id, payment_id, amount, fee_amount, reason, processor_ref, created_by)
    values (pid, pay, 42.53, 0, 'probe', 'rf_0198_b', uid);
    t := t || '[b refund after it landed accepted=true] ';

    -- (c) A CARD PAYMENT IS UNAFFECTED — it settles on arrival (0191), so it
    --     never enters the state above. January and every card refund stand.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, reference, fee_amount)
    values (pid, ren, chg, 100.00, 'card', current_date, 'ch_card_0198', 3.00) returning id into pay_card;
    insert into public.park_refunds (park_id, payment_id, amount, fee_amount, reason, processor_ref, created_by)
    values (pid, pay_card, 100.00, 3.00, 'probe', 'rf_0198_c', uid);
    t := t || '[c card refund still accepted=true] ';

    -- (d) A RETURNED PAYMENT KEEPS ITS OWN, MORE SPECIFIC SENTENCE. The two
    --     clauses overlap, and the order decides which a person reads.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on, reference)
    values (pid, ren, chg, 10.00, 'ach', current_date, 'ch_ret_0198') returning id into pay_ret;
    update public.park_payments set returned_at = now(), return_code = 'R01' where id = pay_ret;
    ok := false;
    begin
      insert into public.park_refunds (park_id, payment_id, amount, fee_amount, reason, processor_ref, created_by)
      values (pid, pay_ret, 10.00, 0, 'probe', 'rf_0198_d', uid);
    exception when others then ok := (sqlerrm like '%the bank returned that payment%');
      if not ok then raise; end if;
    end;
    t := t || format('[d returned keeps its own sentence=%s] ', ok);
    if not ok then raise exception '0198: a returned payment got the not-landed sentence'; end if;

    -- (e) MORE BACK THAN CAME IN IS STILL REFUSED — the ceiling the rewrite
    --     would have dropped.
    ok := false;
    begin
      insert into public.park_refunds (park_id, payment_id, amount, fee_amount, reason, processor_ref, created_by)
      values (pid, pay, 1000.00, 0, 'probe', 'rf_0198_e', uid);
    exception when others then ok := (sqlerrm like '%only % was taken%' or sqlerrm like '%still unapplied%');
      if not ok then raise; end if;
    end;
    t := t || format('[e over-refund refused=%s] ', ok);
    if not ok then raise exception '0198: more was sent back than came in'; end if;

    -- (f) A HAND-KEYED PAYMENT STILL HAS NO RAIL.
    insert into public.park_payments (park_id, renter_id, charge_id, amount, method, received_on)
    values (pid, ren, chg, 5.00, 'cash', current_date) returning id into pay_cash;
    ok := false;
    begin
      insert into public.park_refunds (park_id, payment_id, amount, fee_amount, reason, processor_ref, created_by)
      values (pid, pay_cash, 5.00, 0, 'probe', 'rf_0198_f', uid);
    exception when others then ok := (sqlerrm like '%only a card or ACH payment%');
      if not ok then raise; end if;
    end;
    t := t || format('[f cash refund refused=%s] ', ok);
    if not ok then raise exception '0198: cash was refunded through the processor'; end if;

    -- (g) AND THE FUNCTION STILL RUNS AS IT DID. A rewrite that dropped these
    --     would change who the trigger runs as and remove the race guard.
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'guard_park_refund'
         and p.prosecdef
         and array_to_string(p.proconfig, ',') like '%search_path=public%'
    ) then
      raise exception '0198: guard_park_refund lost security definer or its search_path';
    end if;
    if position('for update' in pg_get_functiondef('public.guard_park_refund'::regproc)) = 0 then
      raise exception '0198: guard_park_refund lost its FOR UPDATE race guard';
    end if;
    if position('still unapplied' in pg_get_functiondef('public.guard_park_refund'::regproc)) = 0 then
      raise exception '0198: guard_park_refund lost the allocation ceiling';
    end if;
    t := t || '[g definer, for-update and allocation ceiling all intact] ';

    raise notice '0198 PROBE_ROLLBACK: %', t;
    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;

  raise notice '0198: money that has not landed cannot be sent back, and money that has still can.';
end $$;
