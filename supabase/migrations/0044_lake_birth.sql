-- ============================================================
--  LakeLife — demand-born lakes (owner directive 2026-07-23: lakes come
--  from crews and customers; ops keeps the option, never the bottleneck).
--  source: who birthed the row. season_confirmed: machine-born lakes get
--  DEFAULT season dates (copied from existing lakes — fail-safe, since a
--  null ice-out would disable the water-work gate entirely) until ops
--  confirms real dates. Run once. Safe to re-run.
-- ============================================================
alter table public.lakes add column if not exists source text not null default 'ops'
  check (source in ('ops', 'customer', 'crew'));
alter table public.lakes add column if not exists season_confirmed boolean not null default true;
