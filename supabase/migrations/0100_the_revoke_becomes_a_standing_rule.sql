-- 0100 — THE REVOKE BECOMES A STANDING RULE.
--
-- 0060 ran `revoke ... on all tables in schema public` and closed the hole for
-- every table that existed THAT DAY. It was a sweep, not a rule. Every table
-- created since — 0082's `seasonal_notice_log`, 0083's `platform_dials`,
-- 0099's own two — came back with Supabase's default grants, so the gap
-- reopened quietly eleven times.
--
-- This migration does three things: re-runs the sweep, takes the writes off
-- `authenticated` where nothing legitimately writes as a user, and then makes
-- it STANDING with ALTER DEFAULT PRIVILEGES so the next table created is
-- locked down before anybody remembers to think about it.
--
-- ================== WHY `authenticated` HAD WRITES AT ALL ===================
--
-- 0060 deliberately left them: "This leaves SELECT/INSERT/UPDATE/DELETE
-- exactly as they are for `authenticated`." RLS was doing the work, and it
-- still is — a customer hitting `payouts` is refused by `payouts_ops_write`.
-- So nothing here is exploitable today.
--
-- But it is belt with no braces, and this project's own memory says so: RLS
-- alone means ONE bad policy edit is the whole distance between a customer and
-- our payout ledger. A grant is the second lock, and the reason to fit it is
-- exactly that the first one is currently holding.
--
-- ============ WHICH TABLES KEEP THEIR GRANTS, AND WHY IT MATTERS ============
--
-- Eight tables ARE written by the session (RLS) client, so revoking would
-- break a live screen with a permission error:
--
--   properties, property_profile, boats, toys   -> the property wizard
--   payment_methods                             -> saving a card
--   notification_prefs                          -> the prefs toggles
--   vendor_availability                         -> a crew blocking a slot
--
-- `vendors` WAS on that list and is not any more, because writing this
-- migration found the screen already broken. `authenticated` holds INSERT,
-- DELETE and SELECT on `vendors` — never UPDATE — while the RLS policy
-- `vendor_updates_self` happily permits an update. Postgres needs BOTH, so
-- every tap of a work-day chip has been returning "permission denied for table
-- vendors" since it shipped. The action now writes as the service role, scoped
-- by a session-derived vendor id, and `vendors` joins the revoke list below.
--
-- Finding those took three passes. The first regex missed `properties`
-- entirely because `const { error } = await supabase` and `.from("properties")`
-- sit on different LINES — and revoking there would have broken the core
-- onboarding flow of the product. The post-condition below asserts these eight
-- KEEP their grants, so a future tidy-up that goes one table too far fails
-- loudly here instead of silently in somebody's browser.

-- ------------------------------------------------- 1. re-run 0060's sweep ---
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from anon;

revoke truncate, references, trigger
  on all tables in schema public from authenticated;

-- ------------------------------- 2. the second lock, where it is free to fit --
-- Every one of these is written ONLY by the service role, verified by reading
-- each call site rather than by trusting a grep.
revoke insert, update, delete on
  public.invoices,
  public.jobs,
  public.lakes,
  public.marketing_contacts,
  public.payouts,
  public.routes,
  public.services,
  public.users,
  -- See the header: its only client write was the broken work-days toggle,
  -- now moved to the service role.
  public.vendors
from authenticated;

-- `profile_photos` has NO reference anywhere in src — not a read, not a write.
-- Locked down with the rest rather than left as a writable table nothing owns.
revoke insert, update, delete on public.profile_photos from authenticated;

-- ------------------------------------------- 3. make it standing, not a sweep --
-- The actual fix for "0060 was a one-time sweep". Tables in this schema are
-- created by `postgres` (all 70 of them), so defaults set for that role apply
-- to whatever the next migration adds.
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from authenticated;

-- ------------------------------------------------------ post-conditions ----
do $$
declare bad text;
begin
  -- (a) anon writes NOTHING, anywhere.
  select string_agg(table_name || ':' || privilege_type, ', ')
    into bad
    from information_schema.role_table_grants
   where table_schema='public' and grantee='anon'
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');
  if bad is not null then raise exception '0100: anon can still write — %', bad; end if;

  -- (b) nobody holds truncate/references/trigger.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ')
    into bad
    from information_schema.role_table_grants
   where table_schema='public' and grantee in ('anon','authenticated')
     and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER');
  if bad is not null then raise exception '0100: truncate/references/trigger survive — %', bad; end if;

  -- (c) the ledger tables are second-locked.
  select string_agg(table_name || ':' || privilege_type, ', ')
    into bad
    from information_schema.role_table_grants
   where table_schema='public' and grantee='authenticated'
     and table_name in ('invoices','jobs','payouts','users','services','routes','lakes',
                        'marketing_contacts','profile_photos','vendors')
     and privilege_type in ('INSERT','UPDATE','DELETE');
  if bad is not null then raise exception '0100: a ledger table still takes client writes — %', bad; end if;

  -- (d) THE ONE THAT PROTECTS THE PRODUCT. These eight are written by the
  -- session client; losing their grants breaks the property wizard, saving a
  -- card, the notification toggles, or a crew's work days. If a later
  -- migration revokes them, this fails here rather than in a browser.
  select string_agg(t, ', ') into bad from (
    select t from unnest(array['properties','property_profile','boats','toys',
                               'payment_methods','notification_prefs',
                               'vendor_availability']) as t
    where not exists (
      select 1 from information_schema.role_table_grants g
       where g.table_schema='public' and g.grantee='authenticated'
         and g.table_name = t and g.privilege_type='UPDATE')
  ) missing;
  if bad is not null then
    raise exception '0100: these need client UPDATE and lost it — % (see header)', bad;
  end if;
end $$;

-- The views are handled in 0100b, which is its own file because production's
-- migration ledger records it as its own entry. A block that lives in one file
-- and is recorded under another name is exactly how the four missing
-- migrations happened.
