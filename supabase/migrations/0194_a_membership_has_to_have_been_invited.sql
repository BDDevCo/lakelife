-- ===========================================================================
-- 0194  A MEMBERSHIP HAS TO HAVE BEEN INVITED
-- ===========================================================================
--
-- FOUND BY MUTATING 0193'S OWN TEST, which is the only reason it was found.
--
-- `claimParkInvite` writes the membership FIRST and stamps the invitation
-- second, deliberately: the other order stamps an invitation as taken up by
-- somebody who was never given the park, and leaves no trace of the mistake.
--
-- But that ordering has a cost 0193 did not cover. Delete one `.is("revoked_at",
-- null)` from the claim's SELECT and a WITHDRAWN invitation still works: the
-- membership insert succeeds, the person is on the park, and only the stamp
-- afterwards hits 0193's trigger and fails. The record is protected. The
-- authority is not.
--
-- 0193 guards the INVITATION. This guards the MEMBERSHIP, so the order the
-- application happens to write them in stops mattering:
--
--   a manager row may exist only because an invitation to that account's own
--   email address was open on that park at the moment it was created.
--
-- An owner row is untouched — `createPark` creates one with the park, and that
-- is the only writer of one in the product.
-- ===========================================================================

create or replace function public.guard_manager_was_invited()
returns trigger language plpgsql as $$
declare
  addr text;
begin
  -- OWNERS ARE OUT OF SCOPE. A park's first owner is created with the park,
  -- by ops, before any invitation could exist — and there is no other writer
  -- of an owner row anywhere in the product.
  if new.role <> 'manager' then
    return new;
  end if;

  select lower(u.email) into addr from public.users u where u.id = new.user_id;
  if addr is null or addr = '' then
    raise exception 'park_members: that account has no email address, so no invitation can be matched to it';
  end if;

  -- ACCEPTED BY THEM is allowed as well as still open, because the claim path
  -- writes this row while the invitation is open and stamps it immediately
  -- afterwards — and a retry of that same claim must not be refused for
  -- having worked the first time. An invitation accepted by SOMEBODY ELSE
  -- never satisfies it.
  if not exists (
    select 1
      from public.park_member_invites i
     where i.park_id = new.park_id
       and i.email = addr
       and i.revoked_at is null
       and (i.accepted_at is null or i.accepted_user_id = new.user_id)
  ) then
    raise exception 'park_members: nobody can be given a park without an open invitation to their own email address — invite them from "Who can open this park" first';
  end if;

  return new;
end $$;

drop trigger if exists park_members_manager_was_invited on public.park_members;
create trigger park_members_manager_was_invited
  before insert on public.park_members
  for each row execute function public.guard_manager_was_invited();

revoke all on function public.guard_manager_was_invited() from public, anon, authenticated;

comment on function public.guard_manager_was_invited() is
  'A manager membership may exist only because an invitation to that account''s own email was open on that park when it was created. Owners are created with the park and are out of scope.';
