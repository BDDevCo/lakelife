-- THE 1 JANUARY WALK
--
-- Nobody had ever walked a household's first day end to end. Every screen was
-- individually defensible and the CHAIN was what was broken — the slip that
-- the claim function refused, the sticker the report card assumed, the mow the
-- booking action never added, the pay button the charge gate declines. No
-- amount of reading one screen at a time finds a handoff failure.
--
-- This walks the first handoff — a printed slip becoming an account — against
-- the LIVE database, as a signed-in household, and prints what happened.
--
-- ============ IT LEAVES NOTHING BEHIND ============
--
-- Everything happens inside one PL/pgSQL block that ends by RAISING, so the
-- whole thing rolls back: the fixture park, the lot, the file, the tenancy,
-- the two accounts and every row the claim wrote. The transcript comes back
-- as the exception message. That is deliberately safer than create-then-
-- delete-by-id — there is no window in which a stray row exists, and no
-- cleanup step that can be forgotten or fail halfway.
--
-- The fixture fence is still respected on top of that: a zz- name AND a zz-
-- slug, on a lake flagged `is_fixture`, because a zz- name alone leaves a
-- thing on the live site.
--
-- ============ RUN IT ============
--
--   Supabase MCP `execute_sql`, or the SQL editor. It is expected to FAIL —
--   the exception IS the output. Anything other than "WALK TRANSCRIPT" is a
--   real error.
--
-- ============ WHAT IT SHOULD SAY ============
--
--   wrong lot number     -> claim_no_open_lot
--   mistyped code        -> claim_code_malformed
--   correct code         -> claimed
--   refusals logged with NO household: 1
--   events logged NAMING a household:  2
--   file now claimed by her: true
--
-- Before 0153 every line read `claim_park_not_open` and all three counts were
-- zero: the park is `active = false` until he is ready to be listed publicly,
-- the slip door alone filtered on that flag, and the refusal log sat below
-- four early returns with a NOT NULL renter_id. Twenty households would have
-- failed on 1 January and no screen anywhere would have recorded it.
--
-- The park below is deliberately created with `active = false`, because that
-- is The Haven's real state and the state the bug needed.

do $$
declare
  v_lake uuid; v_park uuid; v_lot uuid; v_file uuid;
  v_user uuid := gen_random_uuid();      -- the household
  v_office uuid := gen_random_uuid();    -- whoever printed the slip
  v_slug text := 'zz-walk-' || encode(gen_random_bytes(4),'hex');
  v_code text := 'K7M2P9RT';             -- matches CLAIM_CODE_RE: no O/I/L/U/0/1
  r text; t text := '';
  n_null int; n_named int;
begin
  -- A trigger mirrors auth.users into public.users, so do not insert both.
  insert into auth.users (id) values (v_user), (v_office);

  insert into public.lakes (name, is_fixture) values ('zz-walk lake', true) returning id into v_lake;
  insert into public.parks (lake_id, name, slug, active)
    values (v_lake, 'zz-walk park', v_slug, false)
    returning id into v_park;
  insert into public.park_lots (park_id, lot_number) values (v_park, '7') returning id into v_lot;

  -- `park_renters_code_has_issuer` requires a code to name who issued it —
  -- a column with a writer, properly enforced.
  insert into public.park_renters
    (park_id, display_name, claim_code_hash, claim_code_expires_at, claim_code_issued_by)
    values (v_park, 'zz-walk household', crypt(v_code, gen_salt('bf')),
            now() + interval '30 days', v_office)
    returning id into v_file;
  insert into public.lot_reservations (park_lot_id, renter_id, during, term, status)
    values (v_lot, v_file, daterange(current_date - 30, null), 'monthly', 'approved');

  -- SIGN IN as her. claim_park_file reads auth.uid(), which reads this.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user::text)::text, true);

  -- The three things that actually happen on a kitchen table in January.
  r := public.claim_park_file(v_slug, '9', v_code);
  t := t || E'\n  wrong lot number     -> ' || r;

  r := public.claim_park_file(v_slug, '7', 'ABC');
  t := t || E'\n  mistyped code        -> ' || r;

  r := public.claim_park_file(v_slug, '7', v_code);
  t := t || E'\n  correct code         -> ' || r;

  -- AND WHETHER ANYBODY COULD TELL. /ops has one screen that answers "who
  -- cannot get in?" and it counts rows in this table.
  select count(*) into n_null   from public.park_renter_claim_events
   where park_id = v_park and renter_id is null;
  select count(*) into n_named  from public.park_renter_claim_events
   where park_id = v_park and renter_id is not null;

  t := t || E'\n  refusals logged with NO household: ' || n_null
         || E'\n  events logged NAMING a household:  ' || n_named
         || E'\n  file now claimed by her: '
         || (select (user_id = v_user)::text from public.park_renters where id = v_file);

  -- THE ROLLBACK. Not a failure — the only way to leave nothing behind in a
  -- database where park_renter_claim_events is append-only by trigger.
  raise exception E'WALK TRANSCRIPT%', t;
end $$;
