-- 0202  A PAYOUT TAKES ONE RAIL, AND ONLY ONE
--
-- "lets get the mercury ach payouts to crews working" — 29 Oct 2026.
--
-- Today a batch is paid by a CSV somebody downloads from /ops and hands a
-- bank. Mercury's API originates the same credit without the file. Both rails
-- will exist for a while: the file is what works today and the API is what
-- replaces it, and there is no honest moment to delete the file before the
-- API has paid somebody.
--
-- WHICH MAKES DOUBLE PAYMENT THE RISK THIS MIGRATION IS ABOUT. A batch that
-- was exported to the bank AND sent to Mercury pays a crew twice, out of
-- LakeLife's own account, with nothing in the ledger saying so. `status` is a
-- single value so a row cannot be both at once — but nothing stopped it
-- MOVING from one to the other, because `payout_batches` has no trigger at
-- all. Verified on production today: no trigger, and the status check allows
-- any value to follow any other.
--
-- ---------------------------------------------------------------------------
-- THE NEW STATE
-- ---------------------------------------------------------------------------
-- 'submitted' is NOT 'paid'. Mercury's API path we can actually use —
-- `request-send-money`, the one that needs no IP allowlist because Vercel has
-- no static egress IP — QUEUES a payment for approval rather than sending it.
-- So a submitted batch is money that has been asked for and not yet moved,
-- and calling it paid would be this repo's own "a payment is not money until
-- it clears" (0191) on the way out instead of in.
--
-- That approval step is also the standing rule, for free: nothing goes out
-- until he says, enforced by the bank rather than by us.
alter table public.payout_batches
  drop constraint if exists payout_batches_status_check;
alter table public.payout_batches
  add constraint payout_batches_status_check
  check (status in ('building', 'queued', 'exported', 'submitted', 'paid', 'failed'));

alter table public.payout_batches
  add column if not exists mercury_request_id text;

-- Mercury's id for the crew as a payee. Set once, on the account rather than
-- the batch, so a crew's details are handed over once rather than re-sent with
-- every run — and so the one place bank numbers become plaintext stays the
-- place that already was.
alter table public.payout_accounts
  add column if not exists mercury_recipient_id text;

comment on column public.payout_batches.status is
  'building = being assembled, invisible to any rail. queued = ready. exported = its row went into the CSV a human hands the bank. submitted = handed to Mercury''s API and waiting for approval THERE - asked for, not yet moved. paid = the money left. failed = it came back. A batch takes exactly ONE of exported/submitted; moving between them pays the crew twice.';

comment on column public.payout_batches.mercury_request_id is
  'Mercury''s id for the queued payment, from request-send-money. Set once and never changed - it is how an approval or a return is matched back to this batch, and a rewritten id orphans the money.';

create unique index if not exists payout_batches_one_mercury_request_idx
  on public.payout_batches(mercury_request_id)
  where mercury_request_id is not null;

-- ---------------------------------------------------------------------------
-- THE GUARD. There was none.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payout_batch()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- ONE RAIL. The whole point of this migration.
    if old.status = 'exported' and new.status = 'submitted' then
      raise exception 'payout_batches: that batch is already in a bank file — sending it to Mercury as well would pay them twice. Mark the file paid or failed first';
    end if;
    if old.status = 'submitted' and new.status = 'exported' then
      raise exception 'payout_batches: that batch is already with Mercury — putting it in a bank file as well would pay them twice';
    end if;

    -- FORWARD ONLY. Money that has left cannot go back to queued, and a batch
    -- that failed is not re-sent in place: it is reopened by freeing its
    -- payouts, which is what markBatchesReturned already does.
    if old.status = 'paid' and new.status in ('building', 'queued', 'exported', 'submitted') then
      raise exception 'payout_batches: that money has already gone — a batch is not un-paid. Record the return instead';
    end if;
    if old.status = 'failed' and new.status <> 'failed' then
      raise exception 'payout_batches: that batch came back — free its payouts and build a new one rather than reviving it';
    end if;

    -- Mercury's id is theirs, assigned once.
    if old.mercury_request_id is not null
       and new.mercury_request_id is distinct from old.mercury_request_id then
      raise exception 'payout_batches: that Mercury request id identifies money already asked for — a new id orphans it';
    end if;
  end if;

  -- A BATCH WITH MERCURY HAS MERCURY'S ID. Without it an approval or a return
  -- arriving later has nothing to match against, which is money moving with
  -- nothing in our ledger able to notice.
  if new.status = 'submitted' and new.mercury_request_id is null then
    raise exception 'payout_batches: a batch sent to Mercury needs the id Mercury gave it';
  end if;

  return new;
end $$;

drop trigger if exists payout_batches_take_one_rail on public.payout_batches;
create trigger payout_batches_take_one_rail
  before insert or update on public.payout_batches
  for each row execute function public.guard_payout_batch();

revoke all on function public.guard_payout_batch() from public, anon, authenticated;

-- ===========================================================================
-- POST-CONDITIONS — these FAIL the migration rather than report
-- ===========================================================================
do $$
declare
  u_id uuid; rid uuid;
  submitted_ok boolean := false;
  submitted_without_id_refused boolean := false;
  exported_to_mercury_refused boolean := false;
  mercury_to_exported_refused boolean := false;
  unpaid_refused boolean := false;
  id_rewrite_refused boolean := false;
  msg text;
begin
  select user_id into u_id from public.vendors where user_id is not null limit 1;
  if u_id is null then
    raise exception '0202 post-condition: no payee to probe with — the guards are unproven, which is the same as absent';
  end if;

  -- 1. A batch CAN be handed to Mercury, with its id.
  insert into public.payout_batches (user_id, kind, status, mercury_request_id)
  values (u_id, 'monthly', 'submitted', 'req_probe_1') returning id into rid;
  submitted_ok := true;

  -- 2. But NOT without one.
  begin
    insert into public.payout_batches (user_id, kind, status)
    values (u_id, 'monthly', 'submitted');
  exception when others then submitted_without_id_refused := true; msg := sqlerrm;
  end;
  if not submitted_without_id_refused then
    raise exception '0202 FAILED: a batch went to Mercury with no id to match an approval against';
  end if;
  if msg not like '%needs the id Mercury gave it%' then
    raise exception '0202 FAILED: refused with the wrong sentence: %', msg;
  end if;

  -- 3. ONE RAIL: Mercury -> a bank file is refused.
  begin
    update public.payout_batches set status = 'exported' where id = rid;
  exception when others then mercury_to_exported_refused := true; msg := sqlerrm;
  end;
  if not mercury_to_exported_refused or msg not like '%would pay them twice%' then
    raise exception '0202 FAILED: a batch already with Mercury could also go into a bank file — that pays the crew twice';
  end if;

  -- 4. And a bank file -> Mercury is refused.
  insert into public.payout_batches (user_id, kind, status)
  values (u_id, 'monthly', 'exported') returning id into rid;
  begin
    update public.payout_batches set status = 'submitted', mercury_request_id = 'req_probe_2' where id = rid;
  exception when others then exported_to_mercury_refused := true; msg := sqlerrm;
  end;
  if not exported_to_mercury_refused or msg not like '%pay them twice%' then
    raise exception '0202 FAILED: a batch already in a bank file could also go to Mercury';
  end if;

  -- 5. Paid money does not go back.
  update public.payout_batches set status = 'paid', paid_at = now() where id = rid;
  begin
    update public.payout_batches set status = 'queued' where id = rid;
  exception when others then unpaid_refused := true; msg := sqlerrm;
  end;
  if not unpaid_refused or msg not like '%is not un-paid%' then
    raise exception '0202 FAILED: a paid batch was moved back to queued';
  end if;

  -- 6. Mercury's id is assigned once.
  insert into public.payout_batches (user_id, kind, status, mercury_request_id)
  values (u_id, 'monthly', 'submitted', 'req_probe_3') returning id into rid;
  begin
    update public.payout_batches set mercury_request_id = 'req_probe_4' where id = rid;
  exception when others then id_rewrite_refused := true; msg := sqlerrm;
  end;
  if not id_rewrite_refused or msg not like '%orphans it%' then
    raise exception '0202 FAILED: a Mercury request id was rewritten, orphaning money already asked for';
  end if;

  raise exception E'\n0202 PROVEN — rolling back the probe rows\n'
    '  batch may go to Mercury with its id ..... %\n'
    '  ...and NOT without one .................. %\n'
    '  Mercury -> bank file REFUSED ............ %\n'
    '  bank file -> Mercury REFUSED ............ %\n'
    '  paid -> queued REFUSED .................. %\n'
    '  request id rewrite REFUSED .............. %\n',
    submitted_ok, submitted_without_id_refused, mercury_to_exported_refused,
    exported_to_mercury_refused, unpaid_refused, id_rewrite_refused;
exception when others then
  if sqlerrm like '%0202 PROVEN%' then
    raise notice '%', sqlerrm;
  else
    raise;
  end if;
end $$;
