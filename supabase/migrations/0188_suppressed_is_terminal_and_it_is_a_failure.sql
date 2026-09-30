-- ============================================================================
-- 0188 — SUPPRESSED IS TERMINAL, AND IT IS A FAILURE.
--
-- 0187 shipped with the reader and the record disagreeing about one word.
-- `src/lib/email-delivery.ts` counts 'suppressed' among the failures, because
-- Resend refusing to send at all — the address is on the suppression list —
-- is a message that did not arrive. `email_status_rank()` did not rank it, so
-- the forward-only trigger read it as a word it had never heard and let a
-- later event walk it back.
--
-- That is the shape this codebase already has a name for: two halves
-- self-consistent and wrong about the same fact. One of them had to move, and
-- the reader is right — a suppressed message is as finished as a bounced one.
--
-- Found while working out which Resend events to subscribe the webhook to.
-- `email.suppressed` is one of them, so this would have arrived in production
-- and been quietly overwritable.
-- ============================================================================

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
    when 'suppressed'       then 7
    else null
  end;
$$;

-- The terminal list inside the trigger is a SEPARATE literal from the ranking
-- above, so it has to learn the same word — otherwise a suppressed row stays
-- overwritable by anything else ranked 7.
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
    new.status_at := old.status_at;
    return new;
  end if;
  if lower(coalesce(old.status, '')) in
       ('delivered', 'bounced', 'complained', 'failed', 'canceled', 'cancelled', 'suppressed') then
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

-- --------------------------------------------------- post-conditions -------
-- Inside a sub-transaction that raises, so the rows never exist.

do $$
declare
  mid text := 're_0188_proof_' || gen_random_uuid()::text;
  got text;
begin
  begin
    insert into public.email_receipts
      (message_id, to_email, kind, subject_sha256, body_length, body_sha256,
       accepted_status, status)
    values (mid, 'proof@lakelife.test', 'proof', repeat('c', 64), 1,
            repeat('a', 64), 'accepted', 'accepted');

    update public.email_receipts set status = 'suppressed' where message_id = mid;
    select status into got from public.email_receipts where message_id = mid;
    if got <> 'suppressed' then
      raise exception '0188: a suppressed verdict did not land (got %)', got;
    end if;

    -- The whole point: a later delivered must NOT overwrite it.
    update public.email_receipts set status = 'delivered' where message_id = mid;
    select status into got from public.email_receipts where message_id = mid;
    if got <> 'suppressed' then
      raise exception '0188: delivered walked a suppressed message back to %', got;
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
  raise notice '0188: suppressed now ranks terminal, and the reader and the record agree.';
end $$;
