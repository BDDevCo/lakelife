-- 0074 — A PAYMENT IS A TWO-PARTY EVENT. THE LEDGER RECORDED ONE PARTY.
--
-- `park_payments` has exactly one writer: the park. So a household that handed
-- over cash on the 1st and a household that paid nothing are the SAME ROW until
-- somebody in the office clicks. Slowness, absence, sloppiness and bad faith all
-- produce a record identical to non-payment, and the renter has no way to say
-- otherwise.
--
-- `office_recording_lag_days` does not fix this. It delays the accusation; it is
-- owner-set and may be zero; and once the window passes the renter is late
-- forever. It reduces false alarms. It cannot prevent a false default.
--
-- WHY THIS MATTERS MORE THAN A REMINDER: a landlord's ledger is the exhibit in
-- an eviction. Software that prints "unpaid" because nobody clicked is
-- manufacturing evidence of a default that may not exist. Today the only
-- downstream effect is a text message. Late fees and default states are the
-- obvious next builds, and after they exist this is expensive to retrofit.
--
-- THE FIX IS NOT TO BELIEVE THE RENTER INSTEAD. A claim is not proof either.
-- The ledger holds BOTH assertions and makes disagreement visible, so a human
-- resolves it on purpose instead of the software resolving it silently in
-- whichever direction nobody is watching.

create table if not exists public.park_payment_claims (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null
    -- RESTRICT, matching 0072: this is money-adjacent, and a claim is the only
    -- trace of the renter's side. It must not vanish in somebody's cleanup.
    references public.park_charges(id) on delete restrict,

  -- All nullable ON PURPOSE. "I paid you" with no amount, date or check number
  -- is still an assertion, and it is what most of these will actually be. A
  -- form that demands a check number before it will record anything is a form
  -- that records nothing, and the claims it refuses are the ones from the
  -- households least able to produce paperwork.
  claimed_amount numeric(10,2) check (claimed_amount is null or claimed_amount > 0),
  claimed_paid_on date,
  method text check (method is null or method in ('cash','check','card','ach','transfer','other')),
  reference text,
  note text,

  -- WHO SAID SO. The entire point of the table.
  --
  -- 'renter' means the RENTER asserts it, whoever typed it in. A quarter to a
  -- third of a park will never touch a screen, so the office logs their claim
  -- for them — over the counter, on the phone — and `logged_by` records that.
  -- That is still the renter's assertion, not the park's agreement with it.
  asserted_by text not null check (asserted_by in ('renter', 'office')),
  logged_by uuid references public.users(id) on delete set null,

  created_at timestamptz not null default now(),

  -- Resolution is a DECISION SOMEBODY MAKES, with their name on it.
  resolved_at timestamptz,
  resolution text check (resolution in ('matched', 'not_found', 'withdrawn')),
  resolved_by uuid references public.users(id) on delete set null,
  resolution_note text,

  constraint claim_resolution_is_a_decision
    check (resolved_at is null or resolution is not null),
  -- "We looked and there is no such payment" is the one resolution that leaves
  -- the renter owing money on the strength of the park's word. It has to be
  -- explained, and the explanation is what a court would ask for.
  constraint claim_not_found_needs_a_reason
    check (resolution is distinct from 'not_found' or resolution_note is not null)
);

-- The lookup the ledger does on every read: does this charge have an open claim?
create index if not exists park_payment_claims_open_idx
  on public.park_payment_claims (charge_id)
  where resolved_at is null;

alter table public.park_payment_claims enable row level security;

-- House rule (MEMORY: default write grants): RLS alone is not enough.
revoke insert, update, delete, truncate, references, trigger
  on public.park_payment_claims from anon, authenticated;
revoke select on public.park_payment_claims from anon;

-- A renter may read their own claims; the park may read its own.
drop policy if exists park_payment_claims_read on public.park_payment_claims;
create policy park_payment_claims_read on public.park_payment_claims
  for select using (
    exists (
      select 1 from public.park_charges c
      where c.id = park_payment_claims.charge_id
        and (
          public.ll_manages_park(c.park_id)
          or public.ll_is_ops()
          or c.renter_id in (select id from public.park_renters where user_id = auth.uid())
        )
    )
  );

-- When the park records a payment against a charge, any open claim on it is
-- ANSWERED. The renter said they paid; the ledger now agrees. Auto-resolving
-- this is safe in a way that auto-dismissing never would be — it closes the
-- disagreement by conceding it, not by overruling it.
create or replace function public.settle_claims_on_payment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.park_payment_claims
     set resolved_at = now(),
         resolution = 'matched',
         resolution_note = 'A payment was recorded against this bill.'
   where charge_id = new.charge_id
     and resolved_at is null;
  return new;
end $$;

drop trigger if exists trg_settle_claims_on_payment on public.park_payments;
create trigger trg_settle_claims_on_payment
after insert on public.park_payments
for each row execute function public.settle_claims_on_payment();

-- Post-conditions: prove the three that matter by attempting each violation.
do $$
declare p uuid; l uuid; c uuid; k uuid; ok boolean;
begin
  insert into public.parks (id, name) values (gen_random_uuid(), 'mig0074 probe')
    returning id into p;
  insert into public.park_lots (park_id, lot_number) values (p, 'X') returning id into l;
  insert into public.park_charges (park_id, park_lot_id, period_month, due_on, amount)
    values (p, l, '2026-01', '2026-01-01', 455) returning id into c;

  -- 1. A bare "I paid you" is recordable, with no amount, date or reference.
  insert into public.park_payment_claims (charge_id, asserted_by)
    values (c, 'renter') returning id into k;

  -- 2. "We looked and found nothing" cannot be recorded without a reason.
  begin
    update public.park_payment_claims
       set resolved_at = now(), resolution = 'not_found' where id = k;
    ok := false;
  exception when check_violation then ok := true;
  end;
  if not ok then
    raise exception '0074: a claim was dismissed with no explanation';
  end if;

  -- 3. Recording the payment answers the open claim by conceding it.
  insert into public.park_payments (charge_id, amount, method, received_on)
    values (c, 455, 'cash', '2026-01-02');
  if (select resolution from public.park_payment_claims where id = k)
     is distinct from 'matched' then
    raise exception '0074: recording a payment left the claim open';
  end if;

  delete from public.park_payment_claims where charge_id = c;
  delete from public.park_payments where charge_id = c;
  delete from public.parks where id = p;
end $$;
