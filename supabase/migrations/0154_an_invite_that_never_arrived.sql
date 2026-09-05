-- AN INVITE THAT NEVER ARRIVED LOOKS EXACTLY LIKE ONE BEING IGNORED.
--
-- `inviteCrew` inserts an unclaimed vendors row and emails a join link. The
-- invitation IS that email: the row is unreachable until somebody signs in with
-- that exact address. So when the send is refused — a bounce, a fixture
-- recipient, Resend down, a typo'd domain — the crew hears nothing at all.
--
-- The only place that was ever said out loud is a toast, and Toast.tsx clears
-- it after 3800ms. From then on a bounced invite, a spam-foldered invite and an
-- invite somebody simply hasn't got round to all render identically on the
-- Crews board: "Onboarding — Invited — waiting on documents and approval",
-- "hasn't signed up yet". There is no resend button, and pressing Send invite
-- again on the same address is refused as a duplicate open invite.
--
-- So the one recovery available was a database edit, on the screen that exists
-- to onboard crews, in the month he starts onboarding crews.
--
-- TWO COLUMNS, because "we sent it" and "we tried and it bounced" are different
-- facts and the board has to be able to say which:
--
--   invite_sent_at   NULL  = never left our hands. A crew card can say so.
--                    a time = the last send Resend accepted.
--   invite_error     the refusal, verbatim, when the last attempt failed.
--                    Cleared on a successful send.
--
-- NOT a send LOG. One row per crew holding the LAST attempt is what the board
-- needs to answer "did they ever hear from us?", and a history table would be a
-- second thing to keep true for a question nobody is asking.
--
-- Both are nullable with no default, so every existing row — all three fixture
-- vendors — reads as "never sent", which is the honest answer for invites that
-- predate this column. The board says "sent date unknown" rather than inventing
-- one.

alter table public.vendors
  add column if not exists invite_sent_at timestamptz,
  add column if not exists invite_error   text;

comment on column public.vendors.invite_sent_at is
  'When the invitation email was last accepted by the mail provider. NULL means it has never successfully left — including rows that predate this column.';
comment on column public.vendors.invite_error is
  'The refusal from the last failed invitation send, verbatim. Cleared when a send succeeds.';

-- A CLAIMED CREW IS PAST ALL OF THIS. Once user_id is set the invite has done
-- its job, and a stale error hanging around would show a resend prompt on a
-- crew who is already working. Belt and braces: the action clears it too, and
-- this makes it true for every writer.
create or replace function public.clear_invite_state_on_claim()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is not null and old.user_id is null then
    new.invite_error := null;
  end if;
  return new;
end;
$$;

drop trigger if exists vendors_clear_invite_state_on_claim on public.vendors;
create trigger vendors_clear_invite_state_on_claim
  before update on public.vendors
  for each row
  when (new.user_id is not null and old.user_id is null)
  execute function public.clear_invite_state_on_claim();

-- NO GRANT CHANGE, DELIBERATELY, AND THIS WAS CHECKED RATHER THAN ASSUMED.
--
-- The reflex here is `revoke all on public.vendors from anon, authenticated`.
-- Live grants say anon and authenticated hold SELECT and nothing else — writes
-- were revoked long ago — and `vendors_self` scopes that SELECT to
-- `user_id = auth.uid() OR ll_is_ops()`. An UNCLAIMED invite row has a null
-- user_id, so it is invisible to both roles already, and by the time a crew can
-- read their own row they have claimed it and the trigger above has cleared the
-- error. Revoking would strip a SELECT that working screens depend on and empty
-- them with no error — the exact failure mode of a migration that breaks what
-- already worked.
