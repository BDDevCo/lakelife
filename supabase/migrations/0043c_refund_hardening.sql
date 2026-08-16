-- RECOVERED, NOT REWRITTEN (20260724030630 — "refund hardening").
--
-- This migration has been live in production since it was applied and had NO
-- FILE in this repository. It was applied inline, which records the SQL in
-- supabase_migrations.schema_migrations and writes nothing to disk — so a
-- rebuild from `supabase/migrations/` would have produced a database missing
-- it, silently and with no error.
--
-- The SQL below is the EXACT text Postgres recorded as applied, decoded from
-- the ledger. Not retyped and not tidied: a recovered migration that has been
-- "improved" on the way out is a different migration wearing the same name.
--
-- Already applied. Present so the repo and the database agree.

-- Review hardening (2026-07-23): the immutable "what the crew was ever
-- owed" anchor — reductions mutate payouts.amount, so conservation needs
-- the original preserved. Backfill = current amount (no refunds have run).
alter table public.payouts add column if not exists original_amount numeric;
update public.payouts set original_amount = amount where original_amount is null and kind = 'earning';

-- Idempotency: a retried/double-submitted refund carries the same client
-- key and lands exactly once.
alter table public.refunds add column if not exists idempotency_key text;
create unique index if not exists refunds_idempotency_idx
  on public.refunds (idempotency_key) where (idempotency_key is not null);
