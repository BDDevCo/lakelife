-- ============================================================
--  LakeLife — Fill-In Rates (docs/margin-gap-design.md).
--  1) jobs.gap_claim: provenance for a claim accepted at a fill-in
--     take-home instead of the crew's card rate (feeds the digest,
--     Margin Health signals, and the gap-share churn indicator).
--  2) vendor_rate_history: every rate-card change keeps its OLD row —
--     the anti-harvest anchor prices gap offers off a crew's trailing
--     90-day LOWEST card, so hiking your card can never raise your
--     fill-in offer. Captured by trigger; ops-only at RLS.
--  Run once. Safe to re-run.
-- ============================================================

alter table public.jobs
  add column if not exists gap_claim boolean not null default false;

create table if not exists public.vendor_rate_history (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors(id) on delete cascade,
  service_id   uuid not null references public.services(id) on delete cascade,
  base         numeric,
  unit_rate    numeric,
  band_pricing jsonb,
  changed_at   timestamptz not null default now()
);
create index if not exists vendor_rate_history_idx
  on public.vendor_rate_history(vendor_id, service_id, changed_at desc);

create or replace function public.capture_vendor_rate_history()
returns trigger language plpgsql security definer as $$
begin
  insert into public.vendor_rate_history (vendor_id, service_id, base, unit_rate, band_pricing)
  values (old.vendor_id, old.service_id, old.base, old.unit_rate, old.band_pricing);
  return new;
end $$;

drop trigger if exists vendor_rate_history_capture on public.vendor_rates;
create trigger vendor_rate_history_capture
  before update on public.vendor_rates
  for each row
  when (old.base is distinct from new.base
     or old.unit_rate is distinct from new.unit_rate
     or old.band_pricing is distinct from new.band_pricing)
  execute function public.capture_vendor_rate_history();

-- Rule-8 dials for the fill-in mechanism (code falls back to these same
-- defaults, but the rows must EXIST so tuning is a DB edit, not a deploy).
insert into public.platform_settings (key, value) values
  ('gap_anchor_pct', '0.95'),
  ('gap_min_offer', '20'),
  ('gap_sla_hours', '72'),
  ('fillin_digest_min', '200'),
  ('fillin_digest_cooldown_days', '30')
on conflict (key) do nothing;

alter table public.vendor_rate_history enable row level security;
drop policy if exists vendor_rate_history_ops on public.vendor_rate_history;
create policy vendor_rate_history_ops on public.vendor_rate_history
  for select using (public.ll_is_ops());
revoke insert, update, delete on public.vendor_rate_history from authenticated, anon;
grant select on public.vendor_rate_history to authenticated;
