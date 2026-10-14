-- ===========================================================================
-- 0195  A MANAGER MAY STILL DELETE THEIR OWN LOGIN
-- ===========================================================================
--
-- PROVEN ON PRODUCTION BEFORE THE FIX, inside a block that rolled back:
--
--   A set_null = REFUSED (P0001: park_member_invites: that invitation has
--                         already been taken up — remove the person from th…)
--
-- `accepted_user_id` is ON DELETE SET NULL, so deleting that login issues
-- exactly that UPDATE. 0193's own guard refused it. So the moment anybody
-- accepted an invitation, THEIR ACCOUNT COULD NEVER BE DELETED: the cascade
-- aborted, and what reached the person was a raw constraint error in a toast
-- with nothing in it they could act on.
--
-- 0193 was written to stop an invitation being rewritten, which is right. It
-- did not distinguish a rewrite from the one legitimate change there is — the
-- acceptor's account going away, which does not alter what happened, only who
-- is left to point at.
--
-- SO THE RECORD KEEPS WHAT IT KNOWS AND FORGETS WHAT IT LOST. `accepted_at`
-- stands: the invitation WAS taken up, on that day, and that is the history of
-- how somebody got authority over a park. `accepted_user_id` may go to null
-- and only to null, and only while `accepted_at` is untouched. Every other
-- rewrite 0193 refused, it still refuses.
--
-- The same shape applies to `revoked_by`.
-- ===========================================================================

-- AN ACCEPTOR WITHOUT AN ACCEPTANCE IS STILL NONSENSE. What becomes legal is
-- only the other direction: an acceptance whose acceptor has since deleted
-- their login.
alter table public.park_member_invites
  drop constraint if exists park_member_invites_acceptance_is_whole;
alter table public.park_member_invites
  add constraint park_member_invites_acceptance_is_whole
  check (accepted_user_id is null or accepted_at is not null);

alter table public.park_member_invites
  drop constraint if exists park_member_invites_revocation_is_whole;
alter table public.park_member_invites
  add constraint park_member_invites_revocation_is_whole
  check (revoked_by is null or revoked_at is not null);

create or replace function public.guard_park_member_invite()
returns trigger language plpgsql as $$
declare
  forgetting_acceptor boolean := false;
  forgetting_revoker  boolean := false;
begin
  if tg_op = 'UPDATE' then
    -- THE ONE LEGITIMATE CHANGE: the account that acted has been deleted and
    -- the FK is setting its id to null. Narrow on purpose — it is only this
    -- when the timestamp is untouched and the id goes to null rather than to
    -- somebody else.
    forgetting_acceptor :=
      old.accepted_user_id is not null
      and new.accepted_user_id is null
      and new.accepted_at is not distinct from old.accepted_at;
    forgetting_revoker :=
      old.revoked_by is not null
      and new.revoked_by is null
      and new.revoked_at is not distinct from old.revoked_at;

    if new.park_id is distinct from old.park_id
       or new.email is distinct from old.email
       or new.role is distinct from old.role
       or new.invited_at is distinct from old.invited_at then
      raise exception 'park_member_invites: an invitation is a record of what was sent — withdraw it and send a new one instead of rewriting it';
    end if;

    -- `invited_by` is ON DELETE RESTRICT, so it cannot be nulled out from
    -- under us; a change here is somebody rewriting who asked.
    if new.invited_by is distinct from old.invited_by then
      raise exception 'park_member_invites: an invitation is a record of who sent it';
    end if;

    if old.accepted_at is not null
       and not forgetting_acceptor
       and (new.accepted_at is distinct from old.accepted_at
            or new.accepted_user_id is distinct from old.accepted_user_id) then
      raise exception 'park_member_invites: that invitation has already been taken up — remove the person from the park instead';
    end if;

    if old.revoked_at is not null
       and not forgetting_revoker
       and (new.revoked_at is distinct from old.revoked_at
            or new.revoked_by is distinct from old.revoked_by) then
      raise exception 'park_member_invites: that invitation was already withdrawn — send a new one instead';
    end if;

    if old.revoked_at is not null and new.accepted_at is not null then
      raise exception 'park_member_invites: that invitation was withdrawn before it was used';
    end if;
  end if;

  -- AN ACCEPTANCE MUST BE BY THE PERSON IT WAS SENT TO.
  --
  -- Skipped when the acceptor is being forgotten: there is no account left to
  -- match, and the acceptance itself is not being made, only stripped of a
  -- name. Checking it here would re-break exactly what this migration fixes.
  if new.accepted_at is not null
     and new.accepted_user_id is not null
     and not forgetting_acceptor then
    if not exists (
      select 1 from public.users u
       where u.id = new.accepted_user_id
         and lower(u.email) = new.email
    ) then
      raise exception 'park_member_invites: an invitation can only be taken up by the address it was sent to';
    end if;
  end if;

  return new;
end $$;

comment on function public.guard_park_member_invite() is
  'An invitation is a record of what was sent. Nothing about it may be rewritten, and neither ending may be undone — except that a deleted account''s id may be nulled out of accepted_user_id or revoked_by, which forgets who acted without changing that they did.';
