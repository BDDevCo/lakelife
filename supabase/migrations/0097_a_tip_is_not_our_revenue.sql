-- 0097 — A TIP IS NOT OUR REVENUE.
--
-- Tipping shipped in 0091 and could never take a single dollar. `addTip`
-- raised an invoice for the tip, and `invoices_one_per_job` is a UNIQUE index
-- — every finished job already has one. The insert came back 23505, which
-- supabase-js hands over as `{error, data:null}`, so the code read it as "that
-- didn't work, try again" and told the customer exactly that. Forever. In
-- production, 3 of 3 finished jobs carry an invoice, so the feature was dead
-- on every real job. Zero tips have ever been recorded.
--
-- WHY NOT JUST ADD IT TO THE JOB'S INVOICE. Because that invoice is already
-- PAID and closed, with a captured payment matching it to the cent:
--
--   invoice a016f2ad   $95 paid   <-  payment $95 captured  ch_mock_x0bb5…
--
-- Raising it to $115 for a $20 tip leaves it reading underpaid by $20 on every
-- statement from now on, because the $95 capture is settled and
-- `payments_one_capture_per_invoice` forbids a second captured row to make up
-- the difference. It would also rewrite a receipt the customer already holds.
--
-- SO THE TIP NEVER TOUCHES `invoices` AT ALL, and that is the accounting point
-- rather than a workaround. A tip is not money LakeLife earned — it is money
-- passing through us to the crew, in full, by 0091's guard. Keeping it out
-- means "what did we earn in August" stays `sum(invoices)` with no filter for
-- anyone to forget, which is the failure mode a `kind` column would have
-- invited on every report for the life of the business.
--
-- Every card charge still lands in ONE ledger — `payments` — so reconciliation
-- is still a single table. A payment now belongs to exactly one of two things:
--
--   invoice_id  -> a bill LakeLife raised     (revenue)
--   tip_job_id  -> a thank-you to the crew    (pass-through)
--
-- This is also why nothing else needed changing: every existing read of
-- `payments` filters on `invoice_id`, so no total, reconciler, refund or
-- dispute path can see a tip by accident. That was checked, not assumed.

-- ------------------------------------------------------------ the column ---
-- RESTRICT, not SET NULL. A job that has taken tip money must not be deletable
-- out from under the record of it; the check below would refuse the orphan
-- anyway, and a clear foreign-key error beats a confusing constraint one. The
-- job deletes that exist in code all target rows created seconds earlier
-- (`requested`/`scheduled`, a lost dispute race, an unwound spring birth), and
-- none of those can carry a tip.
alter table public.payments
  add column if not exists tip_job_id uuid references public.jobs(id) on delete restrict;

comment on column public.payments.tip_job_id is
  'Set ONLY on a tip charge, and then invoice_id is null. A tip is not '
  'LakeLife revenue — it is pass-through to the crew — so it never gets an '
  'invoice. Keeps sum(invoices) honest without a filter anybody has to '
  'remember. See 0091 (every cent goes to the crew) and 0096 (immutable).';

create index if not exists payments_tip_job_idx
  on public.payments (tip_job_id) where tip_job_id is not null;

-- --------------------------------------------------------- exactly one of ---
alter table public.payments drop constraint if exists payments_belongs_to_one_thing;
alter table public.payments add constraint payments_belongs_to_one_thing
  check ((invoice_id is not null) <> (tip_job_id is not null));

-- ONE CAPTURED TIP PER JOB, mirroring `payments_one_capture_per_invoice`. A
-- failed attempt may repeat as often as the customer's card declines — that is
-- a record of trying, not of taking — but the money may only land once.
create unique index if not exists payments_one_captured_tip_per_job
  on public.payments (tip_job_id)
  where (tip_job_id is not null and status = 'captured');

-- ------------------------------------------- the person charged may see it --
-- `payments` carried an ops-only policy, so a homeowner could not read it at
-- all. That was fine while every payment mirrored an invoice they could
-- already see; a tip has no invoice, so without this the customer is charged
-- and shown nothing anywhere. Narrow on purpose: their own tips, nothing else.
drop policy if exists payments_owner_reads_own_tip on public.payments;
create policy payments_owner_reads_own_tip on public.payments
  for select using (tip_job_id is not null and public.ll_owns_job(tip_job_id));

-- RLS IS NOT A GRANT. `authenticated` held INSERT/UPDATE/DELETE on this table
-- and `anon` held SELECT; only the ops-only policy stood between a signed-in
-- customer and writing their own payment rows. Adding a read policy above is
-- exactly the moment to take the writes away, because from here on the policy
-- set is no longer "ops and nobody else".
revoke insert, update, delete on public.payments from anon, authenticated;
revoke select on public.payments from anon;

-- ------------------------------------------------------ post-conditions ----
-- Real rows, inside a subtransaction rolled back by a sentinel exception —
-- a post-condition that leaves money behind in production would be worse than
-- the bug it proves fixed (the pattern 0096 arrived at the hard way).
do $$
declare jid uuid; iid uuid; ok boolean;
begin
  select id into jid from public.jobs limit 1;
  select id into iid from public.invoices limit 1;
  if jid is null or iid is null then return; end if;

  begin
    -- 1. THE POINT: a tip charge is accepted with no invoice anywhere.
    insert into public.payments (tip_job_id, amount, status, processor_ref)
    values (jid, 20, 'captured', 'ch_post_0097');

    -- 2. A payment may not belong to both.
    ok := false;
    begin
      insert into public.payments (invoice_id, tip_job_id, amount, status)
      values (iid, jid, 5, 'captured');
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0097: a payment belonging to both an invoice and a tip was accepted'; end if;

    -- 3. …nor to neither.
    ok := false;
    begin
      insert into public.payments (amount, status) values (5, 'captured');
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0097: a payment belonging to nothing was accepted'; end if;

    -- 4. The money lands once.
    ok := false;
    begin
      insert into public.payments (tip_job_id, amount, status)
      values (jid, 20, 'captured');
    exception when unique_violation then ok := true;
    end;
    if not ok then raise exception '0097: a job was charged two captured tips'; end if;

    -- 5. But a declined attempt may repeat — trying is not taking.
    insert into public.payments (tip_job_id, amount, status) values (jid, 20, 'failed');
    insert into public.payments (tip_job_id, amount, status) values (jid, 20, 'failed');

    -- 6. Ordinary invoice payments are untouched by all of this.
    ok := true;
    begin
      insert into public.payments (invoice_id, amount, status)
      values (iid, 1, 'failed');
    exception when others then ok := false;
    end;
    if not ok then raise exception '0097: an ordinary invoice payment stopped working'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
