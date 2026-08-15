-- 0125 — THE PARK IS NOT A SCRATCH PARK
--
-- The Haven is a real mobile-home park in LaGrange County, Indiana. Brendon is
-- buying it; it closes 15 Dec 2026. It has 21 lots, 19 of them paying, and its
-- public page has been live at:
--
--     /parks/scratch-haven
--
-- It was created during development, when it WAS a scratch row, and it quietly
-- became the real thing without anybody renaming it. Two reasons that matters
-- more than it looks:
--
-- ONE: the slug is the public URL, and ops/parks-actions.ts claims a slug at
-- creation precisely because it "cannot be renamed later without breaking a
-- printed flyer". The window where renaming is free is exactly now — before the
-- park changes hands and before anything is printed. It gets more expensive
-- every week and never gets cheaper.
--
-- TWO: a real park wearing fixture clothing is the mirror image of the incident
-- that produced 0124. There, a fixture looked real and reached the public site.
-- Here, the real thing looks like a fixture — so any future cleanup keyed on
-- "looks like scratch data" deletes a park with 19 paying tenants in it.
--
-- ------------------------------------------------------------ what changes --
--
-- The slug, and only the slug. Specifically NOT the id.
--
-- `facade00-0000-4000-8000-000000000001` also reads as fixture-shaped, and it
-- is tempting to renumber it for the same reason. Don't. It is a primary key
-- with 21 park_lots, the cost schedules, the amenity and its bookings, the
-- payments and the tenancies all hanging off it, and rewriting it buys a
-- cosmetic improvement at the price of a live re-parenting of real money. The
-- id is never shown to anyone. The fence that matters for parks is
-- `parks.active`, which is a column, not a naming convention — so nothing in
-- this codebase decides what is real by looking at that prefix.
--
-- THE MONEY IS SAFE ACROSS THIS RENAME, which is the one thing worth checking
-- before running it: park_service_rates keys on park_id, not on slug, so The
-- Haven's mowing rate ($16 + $4/lot — the seller's $100/week over 21 lots) is
-- attached to the id and does not notice. Post-condition 4 proves it rather
-- than asserting it.

update public.parks
   set slug = 'the-haven'
 where slug = 'scratch-haven';

-- ------------------------------------------------------- post-conditions --
do $$
declare
  pid uuid;
  n integer;
  rate_base numeric;
begin
  select id into pid from public.parks where slug = 'the-haven';

  -- Nothing to prove on a database that never had this park (a fresh rebuild,
  -- a branch). The rename is data repair for one row that exists in one place.
  if pid is null then return; end if;

  begin
    -- 1. THE OLD PUBLIC URL IS GONE. Not aliased, not redirected — gone. The
    --    park is unlaunched and unadvertised, so there is nothing to keep
    --    working, and a live /parks/scratch-haven would defeat the point.
    select count(*) into n from public.parks where slug = 'scratch-haven';
    if n <> 0 then raise exception '0125: scratch-haven still resolves'; end if;

    -- 2. AND IT IS THE PARK WE MEANT. Renaming the wrong row is the failure
    --    mode with no error message.
    select count(*) into n from public.parks where slug = 'the-haven' and name = 'The Haven';
    if n <> 1 then raise exception '0125: the-haven does not name The Haven'; end if;

    -- 3. THE LOTS CAME WITH IT. A slug is not a foreign key, so this should be
    --    impossible — which is exactly the kind of assumption worth spending
    --    one line on before trusting it with 19 paying tenants.
    select count(*) into n from public.park_lots where park_id = pid;
    if n <> 21 then raise exception '0125: expected 21 lots, found %', n; end if;

    -- 4. AND SO DID THE MONEY. park_service_rates keys on park_id; if it had
    --    keyed on slug, this rename would silently have unpriced his mowing
    --    and every future mow would have refused to book.
    select r.base into rate_base
      from public.park_service_rates r
      join public.services s on s.id = r.service_id
     where r.park_id = pid and s.name = 'Park grounds mowing & trim';
    if rate_base is null then raise exception '0125: the mowing rate lost its park'; end if;

    -- 5. THE SLUG IS STILL UNIQUE ACROSS PARKS. Two parks sharing a public URL
    --    is one park being invisible.
    select count(*) into n from (
      select slug from public.parks group by slug having count(*) > 1
    ) dupes;
    if n <> 0 then raise exception '0125: duplicate park slugs'; end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
