-- ============================================================================
-- 0060 — THE ANONYMOUS ROLE WRITES NOTHING.
--
-- WHAT THIS FOUND. Auditing grants after 0059's post-condition refused itself,
-- `anon` turned out to hold INSERT, UPDATE, DELETE and TRUNCATE on 17 tables —
-- among them `payments`, `payment_methods`, `payouts`, `invoices` and
-- `properties`. Supabase grants new tables in `public` to `anon` and
-- `authenticated` by default, and the house-style revoke was only ever applied
-- to tables written after somebody remembered.
--
-- IS IT EXPLOITABLE TODAY? No — verified, not assumed. RLS is enabled on every
-- one of those tables and every write policy requires `ll_is_ops()` or
-- `owner_id = auth.uid()`. For `anon`, `auth.uid()` is NULL, so every one of
-- those predicates is NULL or false and the write is refused.
--
-- SO WHY DO THIS. Because a single missing or over-broad policy — one
-- `using (true)` written in a hurry two years from now — is the only thing
-- between that grant and an anonymous DELETE on the payments table. RLS is
-- the lock; the grant is the door. Right now the door is open on 17 rooms and
-- only the locks are stopping anybody. Defence in depth means both.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not touch `authenticated`'s
-- write privileges, and it does not touch anybody's SELECT.
--
--   * FIVE FILES WRITE WITH THE USER-SCOPED CLIENT and rely on RLS to scope
--     the write to the caller: profile/actions.ts (properties, property_profile,
--     boats, toys), profile/notif-actions.ts (notification_prefs),
--     profile/payment-actions.ts (payment_methods),
--     profile/account-actions.ts, and vendor/availability/actions.ts
--     (vendor_availability). Revoking `authenticated` writes would break every
--     one of them. That is a real architectural question — should those go
--     through the service role like everything else? — but it is a code
--     change, not a grant change, and doing it silently inside a security
--     migration is how a "hardening" commit takes the portal down.
--
--   * SELECT is untouched, so no public page changes. The lake landing pages,
--     the park pages and the HOA ticker read exactly what they read before.
--
-- ON THE TWO VIEWS. `owner_jobs` and `vendor_jobs` are owned by postgres with
-- security_invoker off, which normally means an RLS bypass. They are safe, and
-- it was checked rather than assumed: each carries its OWN caller-scoped
-- predicate (`p.owner_id = auth.uid()`, `j.vendor_id = ll_my_vendor_id()`)
-- which reads per-request JWT claims regardless of the invoker setting, so an
-- anonymous caller gets zero rows. Neither is auto-updatable either — both
-- join more than one table — so the write grants on them are inert. Flipping
-- them to security_invoker would additionally require the underlying tables'
-- RLS to admit the caller, which is a behaviour change to the owner and vendor
-- portals and belongs in its own change with its own verification.
-- ============================================================================

-- The whole migration, in two statements. `anon` keeps SELECT wherever it
-- already had it, and loses every way to change anything.
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from anon;

-- Nothing legitimately truncates, references or triggers as an end user. This
-- leaves SELECT/INSERT/UPDATE/DELETE exactly as they are for `authenticated`.
revoke truncate, references, trigger
  on all tables in schema public from authenticated;


-- ------------------------------------------------------ post-conditions -----
-- Verify by EXISTENCE of the absence: enumerate what is left and refuse if it
-- is not what we asked for. 0059 taught that a revoke list which names
-- privileges one at a time quietly leaves the ones nobody thought of.
do $$
declare
  bad_anon  int;
  bad_auth  int;
  offenders text;
begin
  select count(*), coalesce(string_agg(distinct table_name || ':' || privilege_type, ', '), '')
    into bad_anon, offenders
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee = 'anon'
     and privilege_type <> 'SELECT';
  if bad_anon > 0 then
    raise exception '0060: anon still holds % non-SELECT grant(s): %', bad_anon, offenders;
  end if;

  select count(*) into bad_auth
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee = 'authenticated'
     and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER');
  if bad_auth > 0 then
    raise exception '0060: authenticated still holds % truncate/references/trigger grant(s)', bad_auth;
  end if;

  -- And prove we did not go too far: the tables the USER-SCOPED client writes
  -- must still be writable by `authenticated`, or the profile and vendor
  -- portals break the moment somebody saves a property.
  if exists (
    select 1
      from (values ('properties'), ('property_profile'), ('boats'), ('toys'),
                   ('notification_prefs'), ('payment_methods'), ('vendor_availability')) as t(name)
     where not has_table_privilege('authenticated', ('public.' || t.name)::regclass, 'INSERT')
        or not has_table_privilege('authenticated', ('public.' || t.name)::regclass, 'UPDATE')
  ) then
    raise exception '0060: a table the user-scoped client writes lost its INSERT/UPDATE — the portal would break';
  end if;

  -- Public reads must survive untouched, or the lake pages go blank.
  if not has_table_privilege('anon', 'public.lakes'::regclass, 'SELECT')
     or not has_table_privilege('anon', 'public.services'::regclass, 'SELECT')
     or not has_table_privilege('anon', 'public.parks'::regclass, 'SELECT') then
    raise exception '0060: anon lost a SELECT it needs for the public pages';
  end if;

  raise notice '0060: anon can read what it could read, and can no longer write anything.';
end $$;
