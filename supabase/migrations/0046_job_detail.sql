-- ============================================================================
-- 0046 — JOB DETAIL: one clickable job, three role-shaped views
--
-- Owner ask (2026-07-26): every calendar's jobs must be clickable, opening a
-- job's full file — the customer seeing photos/invoice/comments, the crew
-- working the job, ops seeing everything and refunding. Recon found the app
-- had NO per-job route at all, and (worse) the completion SMS promises
-- "photos are in your property log" against a surface that never existed.
--
-- This migration only adds the plumbing the new surfaces need. All three
-- job-detail loaders are service-role + explicit ownership checks (the house
-- pattern), so NO new RLS policy is required to read disputes/confirmations.
-- ============================================================================

-- 1) MESSAGES GAIN AN OPTIONAL JOB ANNOTATION -------------------------------
-- Deliberately an ANNOTATION, not a thread-splitting key. The property board
-- stays ONE thread (so the AI auto-reply rails — 2/property/hour, never two
-- machine turns in a row — and ops' groupThreads keep working unchanged);
-- job-scoped messages simply carry which job they're about, so a job page can
-- focus on its own conversation and the board can label it "re: <service>".
-- Client writes stay revoked (0012) — only sendOwnerMessage/sendOpsMessage
-- populate this, so from_user still can't be spoofed.
alter table public.messages
  add column if not exists job_id uuid references public.jobs(id) on delete set null;

create index if not exists messages_job_idx on public.messages(job_id) where job_id is not null;

-- 2) THE INDEXES THAT NEVER EXISTED -----------------------------------------
-- job_photos(job_id) was a sequential scan on EVERY photo-gate check, every
-- ops board render, and every nightly sweep. A job-detail page fans out
-- several job-scoped reads, which makes this urgent rather than tidy.
create index if not exists job_photos_job_idx on public.job_photos(job_id);
create index if not exists messages_property_idx on public.messages(property_id, created_at);
create index if not exists flags_job_idx on public.flags(job_id);
create index if not exists job_confirmations_job_idx on public.job_confirmations(job_id);
create index if not exists disputes_job_idx on public.disputes(job_id);
-- UNIQUE, not just indexed: settleJob, cancelRequest and the dispute engine
-- all read a job's invoice with .maybeSingle(), which THROWS on a second row
-- rather than degrading. The one-invoice-per-job rule was assumed everywhere
-- and enforced nowhere (verified zero duplicates in prod before locking it).
create unique index if not exists invoices_one_per_job
  on public.invoices(job_id) where job_id is not null;
create index if not exists payouts_job_idx on public.payouts(job_id);

-- 3) OPS SEARCH ACROSS THE BOOK ---------------------------------------------
-- Ops must be able to find one dock job by customer name, address, nickname,
-- service or crew without clicking through months of calendar. Trigram
-- indexes keep ILIKE '%needle%' fast as the book grows into the tens of
-- thousands of jobs (btree can't serve a leading wildcard).
create extension if not exists pg_trgm;

create index if not exists properties_address_trgm on public.properties using gin (address gin_trgm_ops);
create index if not exists properties_nickname_trgm on public.properties using gin (nickname gin_trgm_ops);
create index if not exists users_name_trgm on public.users using gin (name gin_trgm_ops);
create index if not exists vendors_company_trgm on public.vendors using gin (company gin_trgm_ops);
create index if not exists services_name_trgm on public.services using gin (name gin_trgm_ops);
