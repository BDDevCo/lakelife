-- ============================================================================
-- 0158 — WHO PULLED THE BANK FILE, AND WHERE A RETURNED PAYOUT LANDS
--
-- Two gaps around the single most sensitive artifact this product produces.
--
-- ============ ONE: THE EXPORT LEFT NO RECORD OF ITSELF ============
--
-- POST /api/ops/payout-export decrypts every payee's routing and account
-- number into a CSV and hands it over. Nothing anywhere recorded who
-- downloaded it, when, or which batches were in it. There is exactly one ops
-- account today, so "who" has felt like a settled question — it stops being
-- one the moment there are two, and it is also the question asked after a
-- laptop is lost or an account is taken over, which is when nobody can wait
-- for it to be reconstructed from a memory.
--
-- `payout_export_events` holds WHO and WHAT, and deliberately not the file.
-- No routing numbers, no account numbers, no payee names: a durable copy of
-- the file's contents would double the thing being protected. The batch ids
-- are enough to reconstruct which crews were in a given pull, from rows that
-- already exist.
--
-- APPEND-ONLY, by a trigger and not only by a grant, for the reason 0139 and
-- 0128 give: a grant can drift, a trigger holds. An audit row that the audited
-- party can edit is not an audit row.
--
-- ============ TWO: AN ACH RETURN HAD NOWHERE TO LAND ============
--
-- A payout leaves as a line in a bank file. Three to five business days later
-- the bank can hand it back — closed account, wrong routing number, a digit
-- transposed. `status` has permitted 'failed' since 0039 and nothing has ever
-- written it, because there were no columns to say WHEN it came back or WHY,
-- and a batch marked failed with neither is a mystery six months later.
--
-- The half that costs real money is not the status. It is that the crew's
-- `payouts` rows stay stamped with `batch_id`, and every re-batch query in the
-- product filters on `batch_id is null` — so a crew whose bank details were
-- wrong by one digit was owed money this product could no longer pay them
-- through any path. src/app/ops/payout-actions.ts:markBatchesReturned writes
-- these two columns and frees those rows in the same action.
--
-- NOT DECIDED HERE, and deliberately: whether a crew is charged for a returned
-- payout, and what they are told. Those are the owner's calls. This gives the
-- fact somewhere to live.
-- ============================================================================

-- ---------------------------------------------------------- who pulled it ---

create table if not exists public.payout_export_events (
  id           uuid primary key default gen_random_uuid(),
  exported_by  uuid not null references public.users(id),
  exported_at  timestamptz not null default now(),
  -- The batches in the file that was handed over. Never what was in their
  -- rows: this table says a pull happened, not what it disclosed.
  batch_ids    uuid[] not null,
  row_count    int not null check (row_count >= 0),
  -- True for ?redownload=1 — a deliberate re-pull of already-exported
  -- batches, which is the shape of an accidental double payment.
  redownload   boolean not null default false
);

comment on table public.payout_export_events is
  'One row per ACH bank file actually handed to an ops user. Append-only. '
  'Holds WHO and WHICH BATCHES and nothing from inside the file — no routing '
  'numbers, no account numbers, no payee names.';

comment on column public.payout_export_events.batch_ids is
  'The payout_batches in the delivered file. A batch withheld because its '
  'queued -> exported flip did not land is NOT here, because it was not in '
  'the file.';

create index if not exists payout_export_events_when_idx
  on public.payout_export_events (exported_at desc);

-- An audit row the audited party can edit is not an audit row.
create or replace function public.payout_export_events_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'payout_export_events is append-only (attempted %)', tg_op;
end $$;

drop trigger if exists payout_export_events_no_edit on public.payout_export_events;
create trigger payout_export_events_no_edit
  before update or delete on public.payout_export_events
  for each row execute function public.payout_export_events_append_only();

-- RLS ISN'T ENOUGH — every table needs the client writes revoked explicitly.
-- Ops may read the log; nobody holding a browser session may write it. The
-- only writer is the service role inside the route handler.
alter table public.payout_export_events enable row level security;

drop policy if exists payout_export_events_ops_read on public.payout_export_events;
create policy payout_export_events_ops_read on public.payout_export_events
  for select using (public.ll_is_ops());

revoke all on public.payout_export_events from anon;
revoke insert, update, delete, truncate on public.payout_export_events from authenticated;
grant select on public.payout_export_events to authenticated;

-- ------------------------------------------------- where a return lands -----

alter table public.payout_batches add column if not exists returned_at timestamptz;
alter table public.payout_batches add column if not exists returned_reason text;

comment on column public.payout_batches.returned_at is
  'When the bank handed this payout back. Set with status = ''failed'' by '
  'markBatchesReturned, which also clears batch_id on the payouts so they '
  'can go out again to a corrected account.';

comment on column public.payout_batches.returned_reason is
  'What the bank said — the return code, or the words ops was given. Required '
  'by the action: a failed batch nobody can explain tells the crew nothing '
  'about what to fix.';

-- ------------------------------------------------------ what must hold ------
--
-- SHIP-TIME assertions. They run once, in the transaction that applies this
-- file, and cannot police the next migration.

do $$
declare v_ok boolean := false; v_ops uuid;
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'payout_batches'
         and column_name in ('returned_at', 'returned_reason')) <> 2 then
    raise exception '0158: a returned payout still has nowhere to land';
  end if;

  -- 'failed' must be a status the CHECK permits, or the action above writes a
  -- value the database refuses and every return fails silently at the button.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.payout_batches'::regclass
       and conname = 'payout_batches_status_check'
       and pg_get_constraintdef(oid) like '%''failed''%'
  ) then
    raise exception '0158: payout_batches.status does not permit failed';
  end if;

  if (select count(*) from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'payout_export_events'
         and grantee = 'anon') <> 0 then
    raise exception '0158: anon still holds grants on payout_export_events';
  end if;

  if (select count(*) from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'payout_export_events'
         and grantee = 'authenticated'
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) <> 0 then
    raise exception '0158: a browser session can still write the export log';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.payout_export_events'::regclass
       and tgname = 'payout_export_events_no_edit'
  ) then
    raise exception '0158: the export log is editable';
  end if;

  -- THE TRIGGER ACTUALLY REFUSES, proven against a real row rather than
  -- assumed from its existence. Everything inside this block is raised out of,
  -- so the table ends this migration empty — which it must, because
  -- append-only means a proof row could not be removed afterwards even by us.
  select id into v_ops from public.users where role = 'ops' limit 1;
  if v_ops is null then
    -- exported_by is NOT NULL and references users; with no ops account there
    -- is no honest row to try. Said out loud rather than passed silently.
    raise notice '0158: no ops account to prove the append-only trigger against; skipped';
    v_ok := true;
  else
    begin
      insert into public.payout_export_events (exported_by, batch_ids, row_count)
      values (v_ops, array[]::uuid[], 0);

      begin
        update public.payout_export_events set row_count = 99;
        -- reached only if the trigger did NOT fire
      exception when others then
        v_ok := true;  -- assignments survive the rollback; database changes do not
      end;

      raise exception 'll_rollback_proof';
    exception when others then
      if sqlerrm <> 'll_rollback_proof' then raise; end if;
    end;
  end if;

  if not v_ok then
    raise exception '0158: an export audit row was editable after all';
  end if;
end $$;
