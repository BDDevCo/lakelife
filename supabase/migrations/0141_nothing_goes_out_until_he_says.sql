-- ============================================================================
-- 0141 — NOTHING GOES OUT UNTIL HE SAYS.
--
-- The owner's instruction, 25 August 2026:
--
--   "we cannot switch it on till we get everyone loaded in and leases executed.
--    I dont want any notifications going out until we get them all comfortable."
--
-- A sweep of every send path found that nothing enforced it. Loading the roll
-- is silent and every renter-facing send is a button he taps — both good — but
-- the ONE unattended path, `remindExpiringStays` in the nightly cron, scans
-- tenancies with no park filter, no `parks.active` check and no cutover check,
-- and would email and text a one-tap link that extends a tenancy.
--
-- IT CANNOT FIRE TODAY, AND THAT IS AN ACCIDENT. Its gate requires
-- `contact_pref = 'sms'`, and nothing in the codebase ever writes 'sms'. So
-- twenty inboxes are held shut by a column with no writer — this codebase's
-- most-repaired defect class, load-bearing in his favour for once, and one row
-- update away from live.
--
-- `parks.active` does not help: it is an INBOUND visibility flag deciding who
-- may see the park page and who may apply. No send path reads it.
--
-- So: a real switch, read inside the transports themselves.
--
-- HELD BY DEFAULT, AND THAT IS THE POINT. A default is a claim about what is
-- true on day one, and on a park's first day nobody has agreed to hear from us
-- yet. Every park arrives with a roll to load and the same chance to send
-- twenty strangers something before anyone is ready. Lifting it is one tap;
-- discovering you needed it is not. Existing parks are backfilled to held for
-- the same reason — there is exactly one, and its owner asked for this.
-- ============================================================================

alter table public.parks
  add column if not exists notices_held_at    timestamptz default now(),
  add column if not exists notices_held_reason text;

comment on column public.parks.notices_held_at is
  'NULL means notices may go out. Non-null means HELD: no email or SMS reaches '
  'a renter of this park, enforced inside sendEmail/sendSms, not at the call '
  'sites. Held by default — a park''s first day is nobody''s consent.';

-- Every park that already exists starts held. NOT a default-only change: a
-- default does nothing for rows that are already there, and the one park in
-- this database is the one whose owner asked for the hold.
update public.parks
   set notices_held_at = coalesce(notices_held_at, now()),
       notices_held_reason = coalesce(
         notices_held_reason,
         'Held on setup — lift it when the roll is loaded and the leases are executed.')
 where notices_held_at is null or notices_held_reason is null;

-- The lookup the transports make on every send: is this address or number a
-- renter of a park that is holding notices? Indexed on the held side, because
-- the answer is almost always "no park is held" and that should cost nothing.
create index if not exists parks_notices_held_idx
  on public.parks (id) where notices_held_at is not null;

-- ------------------------------------------------------- post-conditions ---
do $$
declare n_unheld int; n_cols int;
begin
  select count(*) into n_cols from information_schema.columns
   where table_schema='public' and table_name='parks'
     and column_name in ('notices_held_at','notices_held_reason');
  if n_cols <> 2 then
    raise exception '0141: the hold columns are missing — every send would be ungated';
  end if;

  -- The whole point. If a park came out of this migration able to send, the
  -- backfill did not do its job.
  select count(*) into n_unheld from public.parks where notices_held_at is null;
  if n_unheld > 0 then
    raise exception
      '0141: % park(s) are still able to send notices — the backfill missed them, '
      'and the roll load is what turns that into twenty emails', n_unheld;
  end if;

  raise notice '0141: notices are held for every park until somebody lifts it by hand.';
end $$;
