-- ============================================================
--  LakeLife — boat engine capture (owner, 2026-07-22): winterization
--  prices by ENGINE (type, HP, count), not just length — but the
--  per-foot rate still matters (storage, wrap, base labor scale by
--  length). Engine fields feed the pricing engine's additive
--  per_engine_hp_tiers param so BOTH dimensions price honestly.
--  Nullable = legacy boats (owner confirms on next wizard run).
--  Run once. Safe to re-run.
-- ============================================================

alter table public.boats
  add column if not exists engine_type text
    check (engine_type is null or engine_type in ('outboard','sterndrive','inboard','jet','none')),
  add column if not exists engine_hp numeric,
  add column if not exists engines integer not null default 1;
