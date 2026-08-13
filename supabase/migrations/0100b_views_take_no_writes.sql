-- The three views are NOT auto-updatable (each carries a join, so Postgres
-- refuses a write through them whatever the grant says — checked:
-- information_schema.views.is_updatable = NO for all three). So this changes
-- no behaviour. It is here so the standing audit query —
--   grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')
-- returns EXACTLY the seven tables that legitimately need client writes, with
-- nothing to explain away. An audit with known noise in it is an audit people
-- stop reading.
revoke insert, update, delete on public.owner_jobs, public.vendor_jobs, public.park_site_visits
  from anon, authenticated;

do $$
declare bad text;
begin
  select string_agg(table_name, ', ' order by table_name) into bad
    from (select distinct table_name from information_schema.role_table_grants
           where table_schema='public' and grantee='authenticated'
             and privilege_type in ('INSERT','UPDATE','DELETE')) x
   where table_name not in ('properties','property_profile','boats','toys',
                            'payment_methods','notification_prefs','vendor_availability');
  if bad is not null then
    raise exception '0100b: unexpected client-writable tables — %', bad;
  end if;
end $$;
