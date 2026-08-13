-- 0106 — THE CEILING ON A PUBLIC FORM WAS ONLY ADVICE.
--
-- 0105 gave the QR sticker a per-lot ceiling and said why: "so a stuck submit
-- button or a bored teenager cannot bury the twelve real reports the owner has
-- to work through." The code counts open reports, then inserts. Between the
-- count and the insert there is nothing at all.
--
-- Serially that is fine, and a stuck submit button is roughly serial. A script
-- is not. Fifty POSTs issued together each read eleven open reports, each pass
-- the check, and fifty rows land — the ceiling is not exceeded by one, it is
-- absent. This is the ONLY path in the product a stranger can write down, and
-- its containment was a comment.
--
-- WHY A LOCK AND NOT A CONSTRAINT. There is no uniqueness to key on: twelve
-- open reports for one lot are twelve legitimately different rows. A count has
-- to be taken, and under MVCC two transactions counting at the same instant
-- both see the same number. So the insert is serialised per lot by locking
-- that lot's row first. Reports for other lots never touch it, and the lock is
-- held for a count and an insert.
--
-- WHO IS CAPPED: source='qr' only — the stranger. The office logging a report
-- taken at the window is the person who then has to work through the queue,
-- and capping him would be the software refusing its own owner. A common-area
-- report has no lot to count against and is not capped either; the ceiling
-- exists to stop ONE lot's sticker burying the rest.
--
-- The number is 12 in two places: here, and OPEN_PER_LOT_CAP in
-- src/lib/park-request-server.ts. The one here is the enforcement; the one
-- there exists so a person gets a sentence instead of a database error.

create or replace function public.cap_stranger_requests()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare open_now int;
begin
  if new.source <> 'qr' or new.park_lot_id is null then return new; end if;

  -- SERIALISE PER LOT. Without this the count below is a guess: two concurrent
  -- inserts both read the same number and both proceed, which is precisely the
  -- application-level check this trigger exists to replace.
  perform 1 from public.park_lots where id = new.park_lot_id for update;

  select count(*) into open_now
    from public.park_requests
   where park_lot_id = new.park_lot_id
     and status <> 'done';

  if open_now >= 12 then
    raise exception 'park_requests: lot % already has % open reports', new.park_lot_id, open_now
      using errcode = 'check_violation';
  end if;

  return new;
end $function$;

drop trigger if exists trg_cap_stranger_requests on public.park_requests;
create trigger trg_cap_stranger_requests
  before insert on public.park_requests
  for each row execute function public.cap_stranger_requests();

do $$
declare lid uuid; pid uuid; lot uuid; i int; ok boolean; last_id uuid;
begin
  select id into lid from public.lakes limit 1;
  if lid is null then return; end if;

  begin
    insert into public.parks (name, address, slug, lake_id, park_type, active)
    values ('0106 Proof','1 Rd','0106-proof', lid,'mh', false) returning id into pid;
    insert into public.park_lots (park_id, lot_number, active, lifecycle)
    values (pid,'Lot 1', true,'live') returning id into lot;

    -- 1. TWELVE FIT.
    for i in 1..12 loop
      insert into public.park_requests (park_id, park_lot_id, category, note, source)
      values (pid, lot, 'water', 'proof report ' || i, 'qr') returning id into last_id;
    end loop;

    -- 2. THE THIRTEENTH DOES NOT.
    ok := false;
    begin
      insert into public.park_requests (park_id, park_lot_id, category, note, source)
      values (pid, lot, 'water', 'the one over the line', 'qr');
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception '0106: a 13th stranger report was accepted'; end if;

    -- 3. CLOSING ONE FREES A SLOT — the ceiling counts OPEN reports, not
    --    reports ever filed. A lot whose problems were all fixed must be able
    --    to report a new one.
    update public.park_requests
       set status='done', resolved_at = now(), resolution_note = 'fixed'
     where id = last_id;
    insert into public.park_requests (park_id, park_lot_id, category, note, source)
    values (pid, lot, 'water', 'room again', 'qr');

    -- 4. THE OFFICE IS NOT CAPPED, EVEN ON A FULL LOT. The lot is at twelve
    --    open right now and this still goes in. He is the person who has to
    --    work the queue; the ceiling is not aimed at him.
    --
    --    Writing this test the other way round is what proved the ceiling
    --    counts EVERY open report and not just the stranger's — an office
    --    report added first ate the slot that step 3 then expected to be free.
    --    That is correct: twelve open reports on one lot is a buried queue
    --    whoever typed them. The cap is on the lot, not on the reporter.
    insert into public.park_requests (park_id, park_lot_id, category, note, source)
    values (pid, lot, 'water', 'taken at the window', 'office');

    -- 5. A COMMON-AREA REPORT HAS NO LOT AND IS NOT CAPPED.
    for i in 1..15 loop
      insert into public.park_requests (park_id, park_lot_id, category, note, source)
      values (pid, null, 'road', 'common area ' || i, 'qr');
    end loop;

    -- 6. THE LOCK IS THE MECHANISM. A single transaction cannot exercise two
    --    concurrent inserts, so this asserts the serialisation is PRESENT
    --    rather than that it was exercised — a later tidy-up that drops the
    --    FOR UPDATE fails here instead of silently restoring the race.
    if position('for update' in lower(pg_get_functiondef(
         'public.cap_stranger_requests()'::regprocedure))) = 0 then
      raise exception '0106: the per-lot lock is gone — the cap is a guess again';
    end if;

    raise exception 'ROLLBACK_POSTCONDITION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_POSTCONDITION' then raise; end if;
  end;
end $$;
