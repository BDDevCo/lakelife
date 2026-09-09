-- 0161 — RULE 2 CANNOT BE SWITCHED OFF BY A COLUMN DEFAULT
--
-- CLAUDE.md rule 2: a job cannot reach `complete`, and a payout cannot
-- release, without at least the service's minimum photo count. It is enforced
-- by a trigger (0050), and that trigger begins:
--
--     select coalesce(s.min_photos, 0) into required from public.services ...;
--     if required <= 0 then return new; end if;
--
-- `services.min_photos` defaults to 0. So a service row inserted without
-- stating it turns the platform's central photo gate into a NO-OP for that
-- service — the job completes on no evidence at all and the money goes out.
-- Nothing anywhere asserted otherwise: 0146 checks only custody services and
-- 0110 only its own pair.
--
-- This is not hypothetical carelessness. 0160 added two services and had to
-- name min_photos explicitly for exactly this reason; the next person adding
-- one has no such warning in front of them. A rule this project calls
-- non-negotiable should not depend on remembering a column.
--
-- SCOPED TO ACTIVE, on purpose. Several inactive rows legitimately sit at 0
-- (Storage overstay is a per-diem line, not a visit), and forcing a number
-- onto work nobody can book would be inventing a fact to satisfy a check.
-- Verified before writing this: all 16 active services already carry
-- min_photos >= 1, so nothing has to change to satisfy it — which is what
-- makes it a ratchet rather than a migration with a backfill.

alter table public.services
  drop constraint if exists services_active_work_has_a_photo_gate;
alter table public.services
  add constraint services_active_work_has_a_photo_gate
  check (active = false or coalesce(min_photos, 0) > 0);

comment on constraint services_active_work_has_a_photo_gate on public.services is
  'CLAUDE.md rule 2, made structural. The completion trigger treats '
  'min_photos <= 0 as "no gate", so a bookable service left at the column '
  'default would complete with no photos and release payout. An INACTIVE row '
  'may sit at 0 — it cannot be booked.';

do $$
declare n int; ok boolean;
begin
  select count(*) into n from public.services
   where active and coalesce(min_photos, 0) <= 0;
  if n <> 0 then
    raise exception '0161: % active service(s) still have no photo gate', n;
  end if;

  -- THE CONSTRAINT ACTUALLY BITES, proven by trying to switch one on with the
  -- gate at zero — which is precisely the mistake it exists to stop. Rolled
  -- back with the migration's own transaction; nothing here survives.
  ok := false;
  begin
    insert into public.services
      (name, kind, pricing_model, base, unit_rate, frequency_options,
       min_photos, est_minutes, criticality, active)
    values ('0161 proof', 'standalone', 'flat', 10, 0, array['One-time'],
            0, 30, 'routine', true);
  exception when others then
    ok := (sqlerrm like '%photo_gate%');
  end;
  if not ok then
    raise exception '0161: a bookable service with no photo gate was accepted';
  end if;

  -- And an inactive one at zero is still allowed, or the check is too blunt.
  begin
    insert into public.services
      (name, kind, pricing_model, base, unit_rate, frequency_options,
       min_photos, est_minutes, criticality, active)
    values ('0161 proof inactive', 'standalone', 'flat', 10, 0, array['One-time'],
            0, 30, 'routine', false);
  exception when others then
    raise exception '0161: an inactive service at 0 photos was refused — too blunt: %', sqlerrm;
  end;
  delete from public.services where name in ('0161 proof', '0161 proof inactive');

  raise notice '0161: rule 2 can no longer be switched off by forgetting a column.';
end $$;
