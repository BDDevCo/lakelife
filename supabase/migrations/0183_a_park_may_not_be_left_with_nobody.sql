-- ============================================================================
-- 0183 — A PARK MAY NOT BE LEFT WITH NOBODY, AND A CREW'S MONEY MAY NOT
--        CASCADE AWAY.
--
-- THE BUG, verified on production against pg_constraint on 30 Sep 2026:
--
--   park_members.user_id -> users   ON DELETE CASCADE
--
-- deleteAccount() removes the auth user. The cascade takes the park_members
-- row and STOPS THERE: the park, its lots, its renters, its leases, its rent
-- ledger and its payments all survive, and not one of them is reachable,
-- because getMyPark() resolves a park only through park_members and no screen
-- in the product — ops included — can re-attach an owner to a park that
-- already exists. 0052 already says the sentence, in the unwind path of
-- createPark: "A park with no members is unreachable by every screen in the
-- module."  This makes that a rule instead of a comment.
--
-- Today production holds exactly ONE park and ONE park_members row.
--
-- THE RENTER HALF IS NOT THIS BUG. park_renters.user_id is ON DELETE SET NULL
-- (0055) and stays that way: a resident deleting their login un-claims the
-- park's file on them and the lease, ledger and deposit stand. Nothing here
-- touches it.
--
-- WHAT THE TRIGGER MUST NOT BREAK: tearing a park down. parks -> park_members
-- is ON DELETE CASCADE, and RI cascade runs as an AFTER DELETE on the parent,
-- so by the time the cascading delete reaches park_members the parks row is
-- already gone. An absent park is therefore EXACTLY the teardown case, and it
-- is let through — which keeps createPark's unwind (ops/parks-actions.ts:147)
-- working.
-- ============================================================================

create or replace function public.guard_last_park_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The park itself is going away. This delete IS the teardown; let it run.
  if not exists (select 1 from public.parks p where p.id = old.park_id) then
    return old;
  end if;

  if not exists (
    select 1
    from public.park_members m
    where m.park_id = old.park_id
      and (m.user_id, m.park_id) is distinct from (old.user_id, old.park_id)
  ) then
    raise exception
      'park % would be left with no member, so nobody could open its lots, leases or rent; attach another login to the park first',
      old.park_id
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists park_members_keep_one on public.park_members;
create trigger park_members_keep_one
  before delete on public.park_members
  for each row execute function public.guard_last_park_member();


-- ============================================================================
-- payouts.vendor_id: CASCADE -> NO ACTION.
--
-- vendors.user_id CASCADEs from users, so deleting a crew's login deletes the
-- vendors row, and payouts CASCADEd with it. jobs.vendor_id is already NO
-- ACTION, which accidentally covers a crew that has jobs — but a 'tip' or
-- 'adjustment' payout carries job_id NULL, so a crew with money rows and no
-- job rows lost its ledger silently. Money records are kept for seven years;
-- /privacy says so.
--
-- SAFE: the only deliberate delete of a vendors row in the codebase is the
-- unwind in book/contractor-actions.ts:174, on a vendor created seconds
-- earlier that has no payouts. automation.ts:5408 deletes a payout by id,
-- which this does not affect.
-- ============================================================================

alter table public.payouts drop constraint payouts_vendor_id_fkey;
alter table public.payouts
  add constraint payouts_vendor_id_fkey
  foreign key (vendor_id) references public.vendors(id);