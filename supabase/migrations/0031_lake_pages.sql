-- ============================================================
--  LakeLife — per-lake landing pages (§8 SEO) + the public HOA
--  "fireworks fund" ticker. Each lake gets a stable URL slug, and
--  optionally a linked HOA account whose referral earnings display
--  publicly as the lake's donation total ("neighbors who join fund
--  the fireworks"). Ops links the HOA account when a partnership
--  lands — no UI needed, one UPDATE.
--  Run once. Safe to re-run.
-- ============================================================

alter table public.lakes
  add column if not exists slug text unique,
  add column if not exists hoa_user_id uuid references public.users(id) on delete set null,
  add column if not exists hoa_name text;

-- Backfill slugs from names ("Big Long Lake" -> "big-long-lake").
update public.lakes
   set slug = regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')
 where slug is null;
