-- ============================================================
--  LakeLife — vendor onboarding: invites + server role flips.
--  Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- 1) An invite exists before the person does: vendors.user_id becomes
--    nullable, invite_email records who may claim it. A signup with that
--    email claims the row (sets user_id, role flips to vendor).
alter table public.vendors alter column user_id drop not null;
alter table public.vendors add column if not exists invite_email text;

-- One open invite per email (case-insensitive), only while unclaimed.
create unique index if not exists vendors_invite_email_open
  on public.vendors (lower(invite_email))
  where user_id is null and invite_email is not null;

-- 2) guard_role_change: the SERVER (service role) may set roles — the invite
--    claim flips owner->vendor after verifying the invite email matches.
--    Browser clients still cannot self-promote (anon/authenticated JWTs).
create or replace function public.guard_role_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and not (public.ll_is_ops() or auth.role() = 'service_role') then
    raise exception 'Only ops can change a user role';
  end if;
  return new;
end $$;

-- 3) Belt & braces: a signed-in client must never write invite_email or
--    claim someone else's row directly. Client updates stay locked to
--    work_days only (0010); re-assert after the column add.
revoke update on public.vendors from authenticated, anon;
grant update (work_days) on public.vendors to authenticated;
