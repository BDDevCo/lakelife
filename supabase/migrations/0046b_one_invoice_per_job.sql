-- RECOVERED, NOT REWRITTEN (20260726205020 — "one invoice per job").
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

-- settleJob, cancelRequest and the dispute engine all read the invoice for a
-- job with .maybeSingle(), which THROWS on a second row rather than degrading.
-- The one-invoice-per-job rule was assumed everywhere and enforced nowhere;
-- verified zero duplicates in production before locking it.
create unique index if not exists invoices_one_per_job
  on public.invoices(job_id) where job_id is not null;
