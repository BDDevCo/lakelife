-- ============================================================================
-- 0054 — A PARK'S PRIVATE LOT NOTES ARE ACTUALLY PRIVATE.
--
-- THE BUG. 0052 granted `anon` SELECT on public.park_lots so the public
-- /parks/[slug] page could show open sites while signed out. A table-level
-- grant covers EVERY COLUMN, and park_lots.notes is the park owner's private
-- note on that lot. The park_lots_read policy admits any row whose park is
-- active. So: publish a park, and anyone holding the publishable anon key can
-- read your notes on every lot in it.
--
-- Meanwhile the lot editor in src/components/ParkLots.tsx labels that field:
--
--     "Notes (only you see these)"
--
-- which was not true. Verified on production before writing this: anon held
-- SELECT on all twelve columns including notes.
--
-- NO LIVE EXPOSURE — parks.active is false everywhere and always has been, so
-- the policy admitted nothing and no note has ever been readable. This is a
-- latent defect being closed before the switch is ever flipped, not an
-- incident. It matters now because phase 2 wants to put abandonment status and
-- estate contacts on this same table, and those must never be one policy edit
-- from public.
--
-- THE FIX: column-level grants. `anon` gets exactly the columns the public
-- vacancy listing needs and nothing else. Postgres has supported per-column
-- GRANT forever; we simply did not use it.
--
-- Nothing in the app breaks: getPublicPark() reads through the SERVICE client
-- (src/app/parks/public-data.ts) and never selected notes anyway. The anon
-- grant was pure latent surface. It is kept, narrowed, rather than dropped, so
-- a future client-side vacancy widget still works — and so the next person to
-- add a column has to make a decision instead of inheriting one.
-- ============================================================================

revoke select on public.park_lots from anon;

grant select (
  id,
  park_id,
  lot_number,
  site_type,
  max_length_ft,
  amperage,
  has_water,
  has_sewer,
  slip_included,
  active,
  created_at
) on public.park_lots to anon;

comment on column public.park_lots.notes is
  'PRIVATE to the park''s own members and ops. Deliberately excluded from the '
  'anon column grant (migration 0054) — the public vacancy listing must never '
  'be able to read it. Any new column on this table is private BY DEFAULT: '
  'anon holds column-level grants, so a new column is unreadable until someone '
  'explicitly adds it to that list.';

-- ------------------------------------------------------ post-conditions -----
do $$
declare n_notes int; n_cols int;
begin
  select count(*) into n_notes
    from information_schema.column_privileges
   where grantee = 'anon' and table_schema = 'public'
     and table_name = 'park_lots' and column_name = 'notes'
     and privilege_type = 'SELECT';
  if n_notes <> 0 then
    raise exception '0054: anon can STILL read park_lots.notes — the whole point of this migration';
  end if;

  select count(*) into n_cols
    from information_schema.column_privileges
   where grantee = 'anon' and table_schema = 'public'
     and table_name = 'park_lots' and privilege_type = 'SELECT';
  if n_cols <> 11 then
    raise exception '0054: expected anon to read exactly 11 park_lots columns, found %', n_cols;
  end if;

  raise notice '0054: lot notes are private. anon reads % listing columns, not notes.', n_cols;
end $$;
