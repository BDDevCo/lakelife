-- ============================================================================
-- 0051 — package_components.role: a STABLE key for the storage legality rails
--
-- Audit bug 7 (two-season audit, docs/two-season-audit-2026-07.md): package
-- legality was keyed on a service's DISPLAY NAME —
--   const FALL_RETURN = "Boat return & splash"
-- Renaming that row in Ops, an ordinary edit on a table rule 8 explicitly tells
-- the owner to tune, INVERTED the rails in both directions: a legal booking
-- became unsatisfiable, and an illegal one was accepted — winter storage AND a
-- trip home billed for the same hull, with custody opened on a boat that had
-- been delivered back to its owner.
--
-- lib/packages.ts now identifies the return leg from a stable role tag (or an
-- explicit service id from the caller) and FAILS CLOSED when it cannot tell.
-- Failing closed is right — the wrong answer bills a customer twice — but it
-- means the tag has to exist, and it did not. Without this migration every
-- we_haul booking is refused with "its return trip isn't identified."
--
-- Safe to apply now: all three service_packages rows are active = false (the
-- storage launch switch is off pending the owner's rates), so nothing live
-- changes. This must land BEFORE that switch flips.
-- ============================================================================

alter table public.package_components
  add column if not exists role text;

comment on column public.package_components.role is
  'Stable machine key for a component''s job in the package (e.g. return_leg). '
  'Legality rules key on THIS, never on services.name — renaming a service in '
  'Ops must never change what a package means. Audit bug 7, 2026-07.';

-- Tag the SPRING return trip on the we_haul package (the boat comes home in
-- the spring; the same service also appears in the fall leg, which is why the
-- phase filter below is load-bearing). Matched by service name
-- HERE, once, at migration time — which is exactly the coupling being removed
-- from the running code: a one-off data fix can look the row up by name, but
-- the engine may not.
update public.package_components c
   set role = 'return_leg'
  from public.service_packages p, public.services s
 where c.package_id = p.id
   and c.service_id = s.id
   and p.code = 'we_haul'
   and c.phase = 'spring'
   and s.name = 'Boat return & splash'
   and c.role is distinct from 'return_leg';

-- Fail loudly if the tag did not land: a silent miss here reappears as every
-- we_haul booking being refused on the day storage goes live, which is the
-- worst possible time to discover it. Only assert when the package actually
-- exists, so a fresh rebuild that has not seeded packages yet still applies.
do $$
declare n_pkg int; n_tagged int;
begin
  select count(*) into n_pkg from public.service_packages where code = 'we_haul';
  if n_pkg = 0 then
    raise notice '0051: no we_haul package on this database yet — nothing to tag.';
    return;
  end if;
  select count(*) into n_tagged
    from public.package_components c
    join public.service_packages p on p.id = c.package_id
   where p.code = 'we_haul' and c.role = 'return_leg';
  if n_tagged <> 1 then
    raise exception '0051: we_haul must have exactly ONE return_leg component, found % — packages.ts fails closed without it and every we_haul booking would be refused', n_tagged;
  end if;
end $$;
