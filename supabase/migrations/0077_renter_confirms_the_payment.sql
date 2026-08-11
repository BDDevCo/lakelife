-- 0077 — THE RENTER'S OWN CONFIRMATION.
--
-- There is no bank in the middle of these lakes. Cash sits in a drawer until
-- somebody drives to town, and often never gets deposited, so nothing external
-- will ever validate this ledger. Only the two people who were there can.
--
-- The trap: "the owner ticked a box saying the renter agreed" is STILL ONE
-- PARTY. `renter_confirmed_via` records which act it was, and the check forces
-- an answer -- a confirmation with no account of HOW it was given is somebody's
-- word about somebody else's word.
alter table public.park_payments
  add column if not exists confirm_token text unique,
  add column if not exists renter_confirmed_at timestamptz,
  add column if not exists renter_confirmed_via text
    check (renter_confirmed_via is null
           or renter_confirmed_via in ('link', 'counterfoil', 'in_person'));

create index if not exists park_payments_unconfirmed_idx
  on public.park_payments (received_on desc)
  where renter_confirmed_at is null;

alter table public.park_payments
  drop constraint if exists park_payments_confirmed_has_a_how;
alter table public.park_payments
  add constraint park_payments_confirmed_has_a_how
  check (renter_confirmed_at is null or renter_confirmed_via is not null);
