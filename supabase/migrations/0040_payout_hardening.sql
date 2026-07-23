-- ============================================================
--  LakeLife — payout rails hardening (review fixes).
--  1) 'building' state: a batch is INVISIBLE to the exporter until its
--     totals are written in the same update that flips it to 'queued' —
--     kills the window where an export could pay $0 for claimed money.
--  2) Column-level grants on payout_accounts: ops browser sessions can
--     read bank_name/last4, but the ENCRYPTED BLOBS are service-role
--     only — "never leaves the server" now enforced by the grant, not
--     just intent.
--  Run once. Safe to re-run.
-- ============================================================

alter table public.payout_batches
  drop constraint if exists payout_batches_status_check;
alter table public.payout_batches
  add constraint payout_batches_status_check
  check (status in ('building', 'queued', 'exported', 'paid', 'failed'));

revoke select on public.payout_accounts from authenticated;
grant select (user_id, bank_name, account_last4, updated_at) on public.payout_accounts to authenticated;
