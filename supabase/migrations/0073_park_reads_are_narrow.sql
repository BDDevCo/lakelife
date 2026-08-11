-- 0073 — A PARK'S OWN WRITING ABOUT A PERSON OR A LOT IS NOT PUBLIC.
--
-- The rule this whole module is heading toward: a renter's record fans OUT to
-- the renter across every park; nothing a PARK authored fans in or out to
-- anyone else. The axis is who wrote the fact, not how sensitive it looks.
--
-- 0054 narrowed `anon` on park_lots to eleven genuinely public columns. It
-- never narrowed `authenticated`, which still holds all twenty-two — and the
-- read policy on park_lots is `parks.active OR manages OR ops`, so ANY signed-in
-- account could read `notes`, `tier`, `lifecycle`, `features` and the season
-- columns for every published park's lots. Lot notes are where an owner writes
-- "septic backs up in spring" and worse.
--
-- park_renters is different and narrower: its policy already limits rows to
-- `user_id = auth.uid()`, so no cross-park exposure exists. But the grant let a
-- renter read their OWN row's `notes` — the park's private free text about
-- them — plus `claim_code`, `source`, `confirmed_at`, `merged_into` and
-- `phone_on_file_with_park`, a number off a seller's roll that is defined
-- everywhere else as never a send target.
--
-- SAFE TO NARROW: every park read in the app goes through the service-role
-- client, which bypasses grants entirely. The only user-scoped read of a park
-- table anywhere is `parks` (rent_notice_days, rent_due_day) in
-- src/app/park/page.tsx. Verified before writing this.

revoke select on public.park_lots from authenticated;
grant select (
  id, park_id, lot_number, site_type, max_length_ft, amperage,
  has_water, has_sewer, slip_included, active, created_at
) on public.park_lots to authenticated;

revoke select on public.park_renters from authenticated;
grant select (
  id, park_id, user_id, display_name, email,
  mobile_e164, mobile_verified_at,
  sms_consent_operational_at, sms_consent_marketing_at,
  contact_pref, claimed_at, created_at
) on public.park_renters to authenticated;

-- Post-condition: prove the sensitive columns are gone, by asking rather than
-- assuming. A migration that "succeeds" without checking has taught us nothing.
do $$
declare leaked text;
begin
  select string_agg(table_name || '.' || column_name, ', ')
    into leaked
  from information_schema.column_privileges
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type = 'SELECT'
    and (
      (table_name = 'park_lots'
        and column_name in ('notes', 'tier', 'features', 'lifecycle',
                            'expected_live_on', 'rental_mode', 'park_owned_home'))
      or
      (table_name = 'park_renters'
        and column_name in ('notes', 'claim_code', 'source', 'confirmed_at',
                            'merged_into', 'phone_on_file_with_park'))
    );

  if leaked is not null then
    raise exception '0073: still readable by a client role -> %', leaked;
  end if;
end $$;
