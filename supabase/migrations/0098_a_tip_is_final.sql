-- 0098 — A TIP IS FINAL.
--
-- Brendon, asked directly: "tips shouldnt be refunded." Settled.
--
-- This migration exists because 0096 told people to do something that does not
-- exist. Its trigger refuses an edit with:
--
--   'a tip is not editable once given (% -> %). Refund it if it was wrong —
--    an edit would leave the payout behind.'
--
-- There is no tip refund. `refunds.invoice_id` is NOT NULL and a tip has no
-- invoice by design (0097), so the advice pointed at a path the schema forbids.
-- That is this codebase's own worst habit in miniature — a remedy named in
-- words, with nothing behind it — and it is worse in an error message than
-- anywhere else, because an error message is read by somebody already stuck.
--
-- WHY FINAL IS THE RIGHT POLICY, not just the easy one:
--
--   IT IS ALREADY IN THE CREW'S HANDS. 0091 releases the payout the moment the
--   customer's charge captures, and the month-end batch pays it out. Reversing
--   it means taking money back off the person it was given to, for a decision
--   somebody else made afterwards.
--
--   A TIP YOU CAN CLAW BACK IS NOT A TIP. It is a deposit against future
--   satisfaction, and the crew would learn to treat it as provisional — which
--   is precisely the corrosive dynamic 0091 was written to avoid.
--
--   THE WORK HAS ITS OWN REMEDY. If the job was bad, the refundable thing is
--   what we CHARGED for the job. That path exists, is bounded by the work's
--   own capture, and never touches the tip. Somebody unhappy about the service
--   is made whole there.
--
-- The obligation this creates is on US, not the customer: the finality must be
-- said BEFORE they give, on the screen where they give it, and the amounts
-- must stay small enough that a mistake is a small mistake. Both are done in
-- the same commit as this migration.

create or replace function public.guard_tip_is_immutable()
returns trigger language plpgsql as $function$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if old.tip_amount is null then return new; end if;          -- the first answer
  if new.tip_amount is not distinct from old.tip_amount then return new; end if;

  raise exception
    'jobs: a tip is final once given (% -> %). It is already released to the crew and there is no tip refund — if the WORK was wrong, refund the job''s own charge instead.',
    old.tip_amount, new.tip_amount;
end $function$;

comment on column public.jobs.tip_amount is
  'What the homeowner chose to add for the crew, after the work was done. '
  'NULL = never asked or never answered; 0 = asked and declined, which is a '
  'perfectly good answer and must never be rendered as a failing. FINAL once '
  'set (0096 + 0098): it is released to the crew immediately and there is no '
  'tip refund by policy. A bad job is made right by refunding the job.';

comment on column public.payments.tip_job_id is
  'Set ONLY on a tip charge, and then invoice_id is null. A tip is not '
  'LakeLife revenue — it is pass-through to the crew — so it never gets an '
  'invoice. Keeps sum(invoices) honest without a filter anybody has to '
  'remember. NON-REFUNDABLE by policy (0098): `refunds` is invoice-keyed and '
  'deliberately cannot reach this row.';

-- ------------------------------------------------------ post-conditions ----
-- Same rolled-back-subtransaction pattern as 0096: real rows, no residue.
do $$
declare jid uuid; ok boolean; msg text;
begin
  select id into jid from public.jobs where tip_amount is null limit 1;
  if jid is null then return; end if;

  begin
    update public.jobs set tip_amount = 25, tipped_at = now() where id = jid;

    ok := false;
    begin
      update public.jobs set tip_amount = 40 where id = jid;
    exception when others then ok := true; msg := sqlerrm;
    end;
    if not ok then raise exception '0098 FAIL: a tip was edited after it was given'; end if;

    -- THE POINT OF THIS MIGRATION: the message must not send anybody looking
    -- for a refund path that does not exist.
    if position('Refund it if it was wrong' in msg) > 0 then
      raise exception '0098 FAIL: the trigger still advises a tip refund';
    end if;
    if position('no tip refund' in msg) = 0 then
      raise exception '0098 FAIL: the trigger does not state the policy: %', msg;
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
