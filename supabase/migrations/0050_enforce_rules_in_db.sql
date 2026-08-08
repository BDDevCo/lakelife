-- ============================================================
--  LakeLife — PUT THE RULES IN THE DATABASE (two-season audit, 2026-07).
--
--  CLAUDE.md says rules 1, 2 and 7 are enforced "at the API/RLS level,
--  not just the UI". They were not: they lived in TypeScript only. The
--  audit probed the live schema inside a rolled-back transaction and
--  EVERY one of these inserted with nothing objecting:
--
--    * a job status='complete' with ZERO job_photos on a service whose
--      min_photos = 4                                        (RULE 2)
--    * a water job dated three weeks past its lake's pull_deadline
--                                                            (RULE 7)
--    * jobs.margin set to a number unrelated to price − cost
--    * vendor_cost GREATER than customer_price on a job being assigned
--    * a job assigned to a SUSPENDED crew
--    * a $999,999 payout row with no job_id
--    * a refund far exceeding what was ever captured on the invoice
--    * a $50,000 crew_referral accrual against a $250 lifetime cap dial
--    * job_photos added to a job whose payout has already been BANKED
--
--  Modelled on the three guards this codebase already got right: the
--  one-captured-payment-per-invoice partial index (0024), the
--  one-open-dispute-per-job partial index (0045), and the user_credits
--  overdraft trigger (0029) — advisory lock, check, raise.
--
--  DESIGN RULE FOR EVERY GUARD BELOW: it fires only on the row's
--  TRANSITION, never as a blanket re-validation. A job that is already
--  complete, already assigned, already priced keeps updating freely —
--  so no legacy row is retroactively illegal and no cascade
--  (properties→jobs→job_photos delete, job_groups→jobs.group_id
--  SET NULL) can trip a guard by touching columns it doesn't care about.
--
--  Run once. Safe to re-run — every object is drop-then-create.
-- ============================================================


-- ===========================================================
--  RULE 2 — no photos, no completion. Server-enforced.
-- ===========================================================
-- completeJob (src/app/vendor/actions.ts) counts photos then flips the
-- status; this trigger is the same rule one layer down, including the
-- PACKAGE case, where the gate is the SUM of every leg's minimum (a
-- haul-winterize-wrap-store visit needs its at-dock, on-trailer, wrapped
-- and racked shots, not just the anchor's two).
--
-- Scoped to the TRANSITION into complete/paid. No app path ever INSERTs a
-- job already complete (every insert is 'requested' or, for a $0
-- correction visit, 'scheduled'), so covering INSERT costs nothing and
-- closes the direct-write hole the audit walked through. Rows that were
-- already complete before this migration are never re-checked.
create or replace function public.guard_job_photo_gate()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  required int := 0;
  leg_sum  int;
  have     int;
begin
  if new.status not in ('complete', 'paid') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new; -- already complete; this update is about something else
  end if;

  -- Package visit: the legs own the gate whenever legs exist.
  if new.group_id is not null then
    select sum(coalesce(s.min_photos, 0)) into leg_sum
      from public.job_items ji
      join public.services s on s.id = ji.service_id
     where ji.job_id = new.id;
  end if;

  if leg_sum is not null then
    required := leg_sum;
  else
    select coalesce(s.min_photos, 0) into required
      from public.services s where s.id = new.service_id;
    required := coalesce(required, 0);
  end if;

  if required <= 0 then
    return new;
  end if;

  select count(*) into have from public.job_photos where job_id = new.id;
  if have < required then
    raise exception
      'rule 2: job % cannot reach % — % of % photos uploaded',
      new.id, new.status, have, required;
  end if;
  return new;
end $$;

drop trigger if exists jobs_photo_gate on public.jobs;
create trigger jobs_photo_gate
  before insert or update on public.jobs
  for each row execute function public.guard_job_photo_gate();


-- ===========================================================
--  RULE 7 — water work lives inside the lake's season window.
-- ===========================================================
-- Mirrors dayStatus() (src/lib/booking.ts) exactly: a bound is enforced
-- only when the lake HAS that date, which is the same behaviour the
-- booking calendar and the ops season gate already have. This trigger
-- deliberately does not invent a bound the app doesn't have — audit
-- finding 8 (a blank ice-out skipping the lower gate) is a lake-data
-- problem and belongs in the lake-conditions lane, not here.
--
-- Two exemptions, both real:
--   * correction_of — a Make-It-Right return visit is a promise already
--     made to a customer. If the original pier pull is disputed on the
--     pull deadline, the free fix lands after it. Blocking that would
--     break right-to-cure (ToS §11.5) to protect a date.
--   * a property with no lake has no window to be outside of.
--
-- KNOWN INTERACTION, accepted: the same-day rush fallback (rollRushJobs,
-- src/lib/automation.ts) moves an unclaimed rush job to TOMORROW. On the
-- one day a year that tomorrow is past a lake's deadline, that roll now
-- fails and the job stays put for the expiry sweep instead of being
-- scheduled under the ice. That is rule 7 doing its job, not a break.
create or replace function public.guard_water_season_window()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  is_water boolean;
  ice_out  date;
  pull_by  date;
begin
  if new.date is null or new.correction_of is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.date is not distinct from new.date then
    return new; -- not a reschedule; leave the row alone
  end if;

  select s.is_water_work into is_water
    from public.services s where s.id = new.service_id;
  if is_water is not true then
    return new;
  end if;

  select l.ice_out_actual, l.pull_deadline into ice_out, pull_by
    from public.properties p
    join public.lakes l on l.id = p.lake_id
   where p.id = new.property_id;

  -- ROLL THE STALE SEASON, exactly as effectiveSeason() does in
  -- src/lib/booking.ts. This is load-bearing: audit bug 1's fix teaches
  -- dayStatus to roll a prior-year window onto the current year "so a lake
  -- never goes dark waiting on a human", and NOTHING writes the rolled dates
  -- back to `lakes` — only ops and lake-birth ever write that row. A trigger
  -- that compared the RAW stored dates would refuse every water booking the
  -- calendar had just sold, silently, from the first January after the stored
  -- season ages out. (Caught by branch verification before this ever shipped.)
  --
  -- Anchor on ice-out when present, else the deadline, matching the helper.
  -- Postgres `+ interval 'N years'` clamps Feb 29 to Feb 28 in a common year,
  -- which is the same clamp addYearsISO applies.
  begin
    if coalesce(ice_out, pull_by) is not null then
      declare
        delta int := greatest(
          0,
          extract(year from current_date)::int
            - extract(year from coalesce(ice_out, pull_by))::int
        );
      begin
        if delta > 0 then
          if ice_out is not null then ice_out := ice_out + make_interval(years => delta); end if;
          if pull_by is not null then pull_by := pull_by + make_interval(years => delta); end if;
        end if;
      end;
    end if;
  end;

  if pull_by is not null and new.date > pull_by then
    raise exception
      'rule 7: % is past this lake''s pull deadline (%) — water work has to happen before the freeze window',
      new.date, pull_by;
  end if;
  if ice_out is not null and new.date < ice_out then
    raise exception
      'rule 7: % is before this lake''s ice-out (%) — there is still ice on the water',
      new.date, ice_out;
  end if;
  return new;
end $$;

drop trigger if exists jobs_water_season on public.jobs;
create trigger jobs_water_season
  before insert or update on public.jobs
  for each row execute function public.guard_water_season_window();


-- ===========================================================
--  MONEY SHAPE ON A JOB — margin must mean what it says, and a
--  crew is never HANDED work that loses money.
-- ===========================================================
-- (a) margin ≡ customer_price − vendor_cost, to the cent.
--     Tolerance is one cent ON PURPOSE, not laziness: two live paths
--     write an unrounded float difference (approveFlag's reprice,
--     src/app/approvals/actions.ts, and the spring sticky-custody
--     assignment in src/lib/automation.ts), so `price − cost` can land
--     a 1e-13 away from the exact numeric difference. An equality
--     check would take both of those paths down; a cent of slack still
--     catches "a number unrelated to price − cost", which is what the
--     audit inserted.
--
--     The SIGN is deliberately NOT constrained. Negative margin is
--     legitimate in two designed places: a $0 correction visit, and
--     rule 6 — a vendor flag the homeowner APPROVES reprices the job
--     down, and the crew's agreed cost stands. LakeLife eats it.
--     A `margin >= 0` constraint would break rule 6 to enforce a
--     number, which is the wrong trade.
--
-- (b) at ASSIGNMENT ONLY, vendor_cost may not exceed customer_price.
--     Scoped to the moment vendor_id is first set or changed, because
--     that is the moment a business decision is made; a later reprice
--     (a) is a different event and stays legal.
--     Exempt: correction visits (positive cost, $0 price, by design)
--     and group/package jobs, whose prices live at the group level via
--     job_items and whose sticky-custody assignment deliberately takes
--     whatever margin physics leaves — the boat is already in that
--     crew's barn ("physics beats the rate card", automation.ts).
--
-- (c) at ASSIGNMENT ONLY, the crew must be 'active'. Every app path
--     already checks this (dispatch, the claim board, ops scheduling,
--     sticky custody); the audit assigned straight past all three.
--     Scoped to the vendor_id transition so that SUSPENDING a crew
--     never freezes the jobs already on their truck — suspendCrew
--     takes them off the board, it does not unwind their week.
--     Correction visits are exempt: the return visit belongs to the
--     crew that did the original work, and a benched crew still owes
--     that customer a fix.
create or replace function public.guard_job_money_shape()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  money_changed boolean;
  newly_crewed  boolean;
  crew_status   text;
begin
  money_changed := tg_op = 'INSERT'
    or old.margin         is distinct from new.margin
    or old.customer_price is distinct from new.customer_price
    or old.vendor_cost    is distinct from new.vendor_cost;

  if money_changed
     and new.margin is not null
     and new.customer_price is not null
     and new.vendor_cost is not null
     and abs(new.margin - (new.customer_price - new.vendor_cost)) > 0.01 then
    raise exception
      'margin % does not reconcile: customer_price % − vendor_cost % = %',
      new.margin, new.customer_price, new.vendor_cost,
      new.customer_price - new.vendor_cost;
  end if;

  newly_crewed := new.vendor_id is not null
    and (tg_op = 'INSERT' or old.vendor_id is distinct from new.vendor_id);

  if newly_crewed and new.correction_of is null then
    if new.group_id is null
       and new.customer_price is not null
       and new.vendor_cost is not null
       and new.vendor_cost > new.customer_price + 0.005 then
      raise exception
        'a job cannot be assigned at a loss: vendor_cost % exceeds customer_price %',
        new.vendor_cost, new.customer_price;
    end if;

    select v.status::text into crew_status from public.vendors v where v.id = new.vendor_id;
    if crew_status is distinct from 'active' then
      raise exception
        'crew % is % — only an active crew can be assigned work', new.vendor_id, coalesce(crew_status, 'missing');
    end if;
  end if;

  return new;
end $$;

drop trigger if exists jobs_money_shape on public.jobs;
create trigger jobs_money_shape
  before insert or update on public.jobs
  for each row execute function public.guard_job_money_shape();


-- ===========================================================
--  PAYOUTS — every payout is anchored to a job.
-- ===========================================================
-- The audit inserted a $999,999 payout with no job_id: unanchored, so
-- invisible to the one-earning-per-job index (0043), to refund clawback
-- conservation, and to every reconciliation the platform runs. All three
-- writers (settleJob, the cancellation-fee path in requests/actions.ts,
-- and the nightly fee reconciler) always pass a job_id and, for
-- earnings, the immutable original_amount anchor that clawback math
-- depends on.
--
-- INSERT ONLY, and deliberately not a CHECK constraint: payouts.job_id is
-- `on delete set null`, so a table-level NOT NULL would make deleting a
-- job impossible. Existing rows keep whatever they have.
create or replace function public.guard_payout_anchor()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.job_id is null then
    raise exception 'a payout must be anchored to a job — no free-floating money';
  end if;
  if new.kind = 'earning' and new.original_amount is null then
    raise exception 'an earning payout must record original_amount — clawback conservation depends on it';
  end if;
  return new;
end $$;

drop trigger if exists payouts_anchored on public.payouts;
create trigger payouts_anchored
  before insert on public.payouts
  for each row execute function public.guard_payout_anchor();


-- ===========================================================
--  REFUNDS — you cannot send back more than you took.
-- ===========================================================
-- executeRefund (src/lib/refund-core.ts) checks the remaining refundable
-- balance before inserting and self-deletes on a lost race; this makes
-- the ledger genuinely unable to exceed the capture, the same way the
-- credit ledger became unable to overdraft (0029). Same shape: advisory
-- lock per invoice, sum, raise.
--
-- Half-cent tolerance matches the app's own `captured + 0.001` guard.
-- The clawback ceiling is checked PER ROW (against what the crew was ever
-- owed on that job) rather than as a running sum, on purpose: the app
-- inserts the clawback and then shrinks it if concurrent rows jointly
-- over-claw. A summed check would reject a row the app is designed to
-- heal; the per-row cap still kills "a clawback far exceeding the
-- invoice total", which is what the audit inserted.
create or replace function public.guard_refund_ceiling()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  captured  numeric;
  already   numeric;
  ever_owed numeric;
begin
  perform pg_advisory_xact_lock(hashtext('refunds:' || new.invoice_id::text));

  select p.amount into captured
    from public.payments p
   where p.invoice_id = new.invoice_id and p.status = 'captured'
   limit 1;
  if captured is null then
    raise exception 'nothing was captured on invoice % — there is no cash to send back', new.invoice_id;
  end if;

  select coalesce(sum(r.amount), 0) into already
    from public.refunds r where r.invoice_id = new.invoice_id;
  if already + new.amount > captured + 0.005 then
    raise exception
      'refunds on invoice % would total % against % captured',
      new.invoice_id, already + new.amount, captured;
  end if;

  if new.crew_clawback > 0 then
    select coalesce(po.original_amount, po.amount, 0) into ever_owed
      from public.payouts po
     where po.job_id = new.job_id and po.kind = 'earning'
     limit 1;
    ever_owed := coalesce(ever_owed, 0);
    if new.crew_clawback > ever_owed + 0.005 then
      raise exception
        'clawback % exceeds the % this crew was ever owed on job %',
        new.crew_clawback, ever_owed, new.job_id;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists refunds_within_capture on public.refunds;
create trigger refunds_within_capture
  before insert on public.refunds
  for each row execute function public.guard_refund_ceiling();


-- ===========================================================
--  REFERRALS — the crew-referral cap is a DIAL, so read the dial.
-- ===========================================================
-- referral_crew_cap (platform_settings, seeded at 250 in 0028) is the
-- lifetime ceiling on what one bringer earns from one crew they brought.
-- crewShareAccrual() enforces it in TypeScript; the audit inserted
-- $50,000 straight past it. Rule 8 says the number lives in the
-- database, so the guard reads it from the database too — retune the
-- dial and the guard retunes with it. A cap of 0/absent means "no cap
-- configured" and the guard stands down rather than blocking all
-- accrual, which is how crewShareAccrual reads it as well.
--
-- Only crew_referral is capped. The customer_referral and cross_sell
-- arms are percentage-of-spend with a time sunset and have no cap dial;
-- inventing one here would be a policy change, not an enforcement.
create or replace function public.guard_crew_referral_cap()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  cap     numeric;
  already numeric;
begin
  if new.kind <> 'crew_referral' or new.source_vendor is null then
    return new;
  end if;

  select nullif(value #>> '{}', '')::numeric into cap
    from public.platform_settings where key = 'referral_crew_cap';
  if cap is null or cap <= 0 then
    return new; -- no cap configured; same reading crewShareAccrual() uses
  end if;

  perform pg_advisory_xact_lock(
    hashtext('crew_referral:' || new.beneficiary::text || ':' || new.source_vendor::text));

  select coalesce(sum(re.amount), 0) into already
    from public.referral_earnings re
   where re.beneficiary = new.beneficiary
     and re.source_vendor = new.source_vendor
     and re.kind = 'crew_referral'
     and re.status <> 'void';

  if already + new.amount > cap + 0.005 then
    raise exception
      'crew referral cap: % + % exceeds the % lifetime cap for this bringer/crew pair',
      already, new.amount, cap;
  end if;
  return new;
end $$;

drop trigger if exists referral_earnings_crew_cap on public.referral_earnings;
create trigger referral_earnings_crew_cap
  before insert on public.referral_earnings
  for each row execute function public.guard_crew_referral_cap();


-- ===========================================================
--  JOB PHOTOS — the evidence stops moving once the money does.
-- ===========================================================
-- Photos are the proof behind a released payout (rule 2). The audit
-- added photos to an already-settled job: the evidence set behind money
-- that has left the account was still mutable.
--
-- The freeze line is BANKING, not completion, and that is chosen
-- carefully. uploadJobPhoto has no status gate, so a crew tapping
-- "add one more" right after completing is a normal thing that happens;
-- blocking at 'complete' would reject it. Once the earning is in a
-- payout batch (or the batch is paid), the money is gone and the record
-- is closed.
--
-- UPDATE is blocked outright on a complete/paid job — no code path in
-- the app updates a job_photos row, so nothing legitimate is being
-- refused, and rewriting a photo's storage path after the fact is
-- exactly the tamper this exists to stop.
--
-- DELETE IS DELIBERATELY NOT GUARDED. removeProperty and deleteAccount
-- (src/app/profile/account-actions.ts) cascade properties → jobs →
-- job_photos, and a customer erasing their own data must not be blocked
-- by their own completed jobs. Direct deletes are already impossible for
-- clients: 0011 revoked insert/update/delete on job_photos from
-- authenticated and anon, so only the service role can reach the table
-- at all.
create or replace function public.guard_job_photo_immutability()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  banked   boolean;
  job_stat text;
begin
  if tg_op = 'INSERT' then
    select exists (
      select 1 from public.payouts po
       where po.job_id = new.job_id and po.kind = 'earning'
         and (po.batch_id is not null or po.status = 'paid')
    ) into banked;
    if banked then
      raise exception
        'job % is settled — its photo record is closed', new.job_id;
    end if;
    return new;
  end if;

  select j.status::text into job_stat from public.jobs j where j.id = old.job_id;
  if job_stat in ('complete', 'paid') then
    raise exception 'photos on a completed job are evidence — they do not change';
  end if;
  return new;
end $$;

drop trigger if exists job_photos_immutable on public.job_photos;
create trigger job_photos_immutable
  before insert or update on public.job_photos
  for each row execute function public.guard_job_photo_immutability();


-- ---------- these are server-side rails, not client callables ----------
revoke execute on function public.guard_job_photo_gate()          from public, anon, authenticated;
revoke execute on function public.guard_water_season_window()     from public, anon, authenticated;
revoke execute on function public.guard_job_money_shape()         from public, anon, authenticated;
revoke execute on function public.guard_payout_anchor()           from public, anon, authenticated;
revoke execute on function public.guard_refund_ceiling()          from public, anon, authenticated;
revoke execute on function public.guard_crew_referral_cap()       from public, anon, authenticated;
revoke execute on function public.guard_job_photo_immutability()  from public, anon, authenticated;
