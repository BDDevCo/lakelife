-- ===========================================================================
-- 0193  A PARK CAN BE HANDED TO A SECOND PERSON
-- ===========================================================================
--
-- THE DEFECT, verified against production on 13 Oct 2026.
--
--   park_members : 1 row.  role='owner'.  managers: 0.
--   users.role   : an ENUM of exactly (owner, vendor, ops).
--
-- `park_members.role` has allowed 'manager' since 0052, and the word is READ
-- in four places that already gate real behaviour — publishing the park
-- (actions.ts setParkLive), buying services on the park's behalf
-- (service-helpers canBuyServices), and the two viewerIsOwner reads. It is
-- WRITTEN by exactly one statement in the entire product: `createPark`, which
-- hard-codes role: "owner".
--
-- So the manager role is a working, enforced, tested permission tier with no
-- door to it. There is no screen anywhere that can make a second person on a
-- park. He cannot hand The Haven to anybody, which is the thing he asked for.
--
-- WHY A TABLE AND NOT JUST AN INSERT. `park_members.user_id` is NOT NULL with
-- an FK to public.users, so a membership cannot exist before the person has an
-- account — and the person he wants to hand the park to does not have one yet.
-- The crew door solved the same problem with `vendors.invite_email` and a
-- claim on first sign-in; a park membership has nowhere to put that, because
-- its primary key IS (park_id, user_id).
--
-- An invitation is also a durable fact in its own right. It has to be
-- listable (who did I invite), revocable before it is taken up, and auditable
-- after — none of which fits in a column on a row that does not exist yet.
--
-- WHAT THIS DOOR MAY NEVER DO: mint an owner. The CHECK below allows
-- 'manager' and nothing else. An owner can publish the park to the public
-- internet and commit it to buying services, and "the invite link that
-- creates a second one of those" is not a thing to build by accident on the
-- way to a handoff. An owner is still created by ops, with a park, as it was.
-- ===========================================================================

create table if not exists public.park_member_invites (
  id          uuid primary key default gen_random_uuid(),
  park_id     uuid not null references public.parks(id) on delete cascade,
  -- Stored LOWER-CASED by the writer. The crew doors learned this the
  -- expensive way: a pre-check with a case-sensitive `.eq` against a
  -- case-insensitive unique index produced a constraint-name error and a retry
  -- that could never succeed. A CHECK makes the rule the table's, not the
  -- caller's.
  email       text not null check (email = lower(email) and position('@' in email) > 1),
  -- ONLY EVER A MANAGER. See the header. Written as a CHECK rather than left
  -- to the default so that a caller passing 'owner' is refused out loud
  -- instead of being quietly corrected.
  role        text not null default 'manager' check (role = 'manager'),
  invited_by  uuid not null references public.users(id) on delete restrict,
  invited_at  timestamptz not null default now(),
  -- A NOTE FROM THE PERSON INVITING. Shown in the email, so it is theirs.
  note        text,

  -- ONE-WAY TIMESTAMPS, both of them, for the reason 0191 spelled out: a
  -- status column invites a writer to move a row backwards, and neither of
  -- these acts can be undone. Re-inviting somebody is a new row.
  accepted_at      timestamptz,
  accepted_user_id uuid references public.users(id) on delete set null,
  revoked_at       timestamptz,
  revoked_by       uuid references public.users(id) on delete set null,

  -- An acceptance names who accepted; a revocation names who revoked. Half of
  -- either is a row nobody can account for.
  constraint park_member_invites_acceptance_is_whole
    check ((accepted_at is null) = (accepted_user_id is null)),
  constraint park_member_invites_revocation_is_whole
    check ((revoked_at is null) = (revoked_by is null)),
  -- AND NEVER BOTH. An invite that was taken up cannot later be "withdrawn" —
  -- what you withdraw then is the membership, which is its own act on its own
  -- table and leaves this record standing as the history of how they got in.
  constraint park_member_invites_one_ending
    check (accepted_at is null or revoked_at is null)
);

-- ONE OPEN INVITE PER PERSON PER PARK.
--
-- Partial, so the same person may be re-invited after a revocation and may be
-- invited again if their membership is later removed. A full unique index
-- would make "invited, revoked, invited again" impossible, which is the
-- ordinary course of a handoff that falls through.
--
-- A NOTE FOR WHOEVER ADDS THE NEXT KIND OF ROW HERE: this index is a
-- guarantee the accept and revoke paths lean on, and sharing the table with a
-- new `role` or a new kind of invitation silently spends it. 0192 learned that
-- on park_reminders — widen the index per act, in the same migration.
create unique index if not exists park_member_invites_one_open_idx
  on public.park_member_invites(park_id, email)
  where accepted_at is null and revoked_at is null;

create index if not exists park_member_invites_park_idx
  on public.park_member_invites(park_id, invited_at desc);
create index if not exists park_member_invites_email_open_idx
  on public.park_member_invites(email)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- AN ENDING IS AN ENDING
-- ---------------------------------------------------------------------------
-- The CHECKs above refuse a row that is both accepted and revoked. They cannot
-- refuse an UPDATE that un-accepts one, or that re-points an acceptance at a
-- different person — and the whole value of this table as a record of how
-- somebody got authority over a park rests on it not being rewritable.
create or replace function public.guard_park_member_invite()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- The facts of the invitation itself never change. Changing the park or
    -- the email on an open invite is indistinguishable, afterwards, from
    -- having invited that person to that park all along.
    if new.park_id is distinct from old.park_id
       or new.email is distinct from old.email
       or new.role is distinct from old.role
       or new.invited_by is distinct from old.invited_by
       or new.invited_at is distinct from old.invited_at then
      raise exception 'park_member_invites: an invitation is a record of what was sent — withdraw it and send a new one instead of rewriting it';
    end if;

    if old.accepted_at is not null
       and (new.accepted_at is distinct from old.accepted_at
            or new.accepted_user_id is distinct from old.accepted_user_id) then
      raise exception 'park_member_invites: that invitation has already been taken up — remove the person from the park instead';
    end if;

    if old.revoked_at is not null
       and (new.revoked_at is distinct from old.revoked_at
            or new.revoked_by is distinct from old.revoked_by) then
      raise exception 'park_member_invites: that invitation was already withdrawn — send a new one instead';
    end if;

    -- An invitation that was withdrawn cannot afterwards be accepted. Without
    -- this, a stale link in somebody's inbox still works: the one-ending CHECK
    -- is satisfied by clearing revoked_at, and nothing else looks.
    if old.revoked_at is not null and new.accepted_at is not null then
      raise exception 'park_member_invites: that invitation was withdrawn before it was used';
    end if;
  end if;

  -- AN ACCEPTANCE MUST BE BY THE PERSON IT WAS SENT TO.
  --
  -- The server action checks this too, and this is the structural half: an
  -- invitation to one email address must never become authority over somebody
  -- else's rent money because a lookup matched the wrong row. A park
  -- membership is read access to every household's name, lot and payment
  -- history, so the identity check belongs where it cannot be skipped.
  if new.accepted_at is not null then
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

drop trigger if exists park_member_invites_are_a_record on public.park_member_invites;
create trigger park_member_invites_are_a_record
  before insert or update on public.park_member_invites
  for each row execute function public.guard_park_member_invite();

-- ---------------------------------------------------------------------------
-- A PARK ALWAYS HAS AN OWNER
-- ---------------------------------------------------------------------------
-- The remove-a-manager door below only ever deletes a manager, so this cannot
-- fire from the product as written. It is here because the thing it prevents
-- is unrecoverable through the UI: getMyPark resolves a park ONLY through
-- park_members, so a park whose last owner row is gone is invisible to every
-- screen in the module — not broken, not read-only, invisible. 0183's door
-- audit found the same shape on the account-deletion path.
create or replace function public.guard_park_keeps_an_owner()
returns trigger language plpgsql as $$
declare
  owners_left int;
begin
  if old.role <> 'owner' then
    return old;
  end if;
  -- The park going too is fine — that is a cascade, not an orphaning.
  if not exists (select 1 from public.parks p where p.id = old.park_id) then
    return old;
  end if;
  select count(*) into owners_left
    from public.park_members m
   where m.park_id = old.park_id
     and m.role = 'owner'
     and m.user_id <> old.user_id;
  if owners_left = 0 then
    raise exception 'park_members: that is the park''s only owner — a park with no owner cannot be opened by anybody, including you. Make somebody else the owner first';
  end if;
  return old;
end $$;

drop trigger if exists park_members_keeps_an_owner on public.park_members;
create trigger park_members_keeps_an_owner
  before delete on public.park_members
  for each row execute function public.guard_park_keeps_an_owner();

-- ---------------------------------------------------------------------------
-- WHO MAY READ
-- ---------------------------------------------------------------------------
alter table public.park_member_invites enable row level security;

-- The park's own people and ops. An invitation carries an email address that
-- belongs to somebody, so it is not readable by the lake at large — and
-- `ll_manages_park` is the same predicate every other park table is fenced
-- with, so a manager added by this door sees the same list the owner does.
drop policy if exists park_member_invites_access on public.park_member_invites;
create policy park_member_invites_access on public.park_member_invites for select
  using (public.ll_is_ops() or public.ll_manages_park(park_id));

-- Postgres' default grants would let a signed-in client write this table
-- directly — which on THIS table means granting themselves a park. Every
-- write goes through a server action holding the service role.
revoke insert, update, delete on public.park_member_invites from anon, authenticated;
grant select on public.park_member_invites to authenticated;

revoke all on function public.guard_park_member_invite() from public, anon, authenticated;
revoke all on function public.guard_park_keeps_an_owner() from public, anon, authenticated;

comment on table public.park_member_invites is
  'Invitations to help run a park. Manager only — this door may never mint an owner. One open invite per (park, email); accepted_at and revoked_at are one-way and mutually exclusive, and an acceptance must be by the address it was sent to.';
