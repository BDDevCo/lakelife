-- ============================================================
--  LakeLife — keep public.users.email_verified in sync with the
--  real Supabase auth record.
--
--  Fixes a gap in 0002: the signup trigger only captured email
--  confirmation at the instant of INSERT. When Supabase confirms
--  the email a moment later (auto-confirm) or when the user clicks
--  the confirmation link (a later UPDATE), the flag never updated.
--  This adds an UPDATE trigger and backfills existing rows.
-- ============================================================

create or replace function public.sync_email_verified()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.users
     set email_verified = (new.email_confirmed_at is not null),
         email          = coalesce(new.email, public.users.email)
   where id = new.id;
  return new;
end $$;

drop trigger if exists on_auth_email_confirmed on auth.users;
create trigger on_auth_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.sync_email_verified();

-- Backfill: bring every existing profile in line with its auth record.
update public.users u
   set email_verified = (a.email_confirmed_at is not null)
  from auth.users a
 where a.id = u.id
   and u.email_verified is distinct from (a.email_confirmed_at is not null);
