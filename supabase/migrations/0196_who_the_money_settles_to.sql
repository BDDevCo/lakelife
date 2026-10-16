-- ===========================================================================
-- 0196  WHO THE MONEY SETTLES TO
-- ===========================================================================
--
-- THE GAP, verified against production on 15 Oct 2026:
--
--   processor account registry : DOES NOT EXIST
--   parks.*merchant*           : no such column
--   vendors.*merchant*         : no such column
--   The Haven                  : accepts_online_rent = TRUE, card_fee_pct = 3.00
--
-- So the park is switched on to take rent online and **nothing anywhere
-- records who receives it.**
--
-- `payRent` gates on `parks.accepts_online_rent` alone. `takePayment` gates on
-- `LAKELIFE_PAYMENTS_LIVE`, which is ONE DEPLOYMENT-WIDE BOOLEAN meaning
-- "LakeLife has a processor". Neither asks the question Architecture A makes
-- the whole design: can THIS park's owner receive money, into THEIR OWN
-- account?
--
-- The day that flag is set, a resident's rent would be charged with no
-- recipient on file — which means it settles to the only merchant that does
-- exist, LakeLife's. That is the pooled model we deliberately rejected,
-- arriving by omission rather than by decision, on somebody else's rent.
--
-- This is [[a-switch-is-a-wish-a-processor-is-a-rail]] one level up: a global
-- switch standing in for a per-park capability.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD
-- ---------------------------------------------------------------------------
-- NO ACCOUNT NUMBERS. NO ROUTING NUMBERS. That is the whole dividend of
-- Architecture A: the park owner's bank details live with the processor, who
-- is the party regulated to hold them, and we keep four digits so a screen can
-- say "ending 4471" and nothing more. A registry that accumulated bank
-- credentials would hand us back the custody problem we designed out.
--
-- CAPABILITIES ARE THE PROCESSOR'S ANSWER, NOT OUR WISH. Every one defaults
-- FALSE. A park cannot take ACH because somebody ticked a box here; it can
-- take ACH when the processor says the merchant is approved for it.
-- ===========================================================================

create table if not exists public.processor_accounts (
  id            uuid primary key default gen_random_uuid(),

  -- Which processor. Named rather than assumed: the research that chose one
  -- may be revisited, and a registry that hard-codes a vendor is a migration
  -- away from being wrong.
  provider      text not null check (length(provider) between 2 and 40),
  -- Their id for this merchant. NULL until we have actually submitted.
  provider_merchant_id text,

  -- EXACTLY ONE RECIPIENT. A park owner receiving rent, or a crew receiving
  -- payouts. Never both, never neither — a row that names nobody is a
  -- settlement destination nobody can read.
  park_id       uuid references public.parks(id) on delete cascade,
  vendor_id     uuid references public.vendors(id) on delete cascade,

  status        text not null default 'draft'
                check (status in ('draft', 'submitted', 'active', 'rejected', 'disabled')),

  -- What the PROCESSOR says this merchant may do. Not a wish list.
  can_accept_ach    boolean not null default false,
  can_accept_card   boolean not null default false,
  can_receive_payout boolean not null default false,

  -- Four digits, for a sentence on a screen. Never more. See the header.
  settlement_last4 text check (settlement_last4 ~ '^[0-9]{4}$'),

  -- One-way timestamps, for the reason 0191 spelled out: a status column
  -- invites a writer to move a row backwards, and none of these acts can be
  -- undone. A rejected merchant is re-submitted as a new attempt.
  submitted_at  timestamptz,
  activated_at  timestamptz,
  disabled_at   timestamptz,
  disabled_reason text,

  -- Whatever they sent, verbatim, the way processor_events keeps raw payloads.
  -- Nothing reads this to make a decision; it exists so a human can see what
  -- the processor actually said when a status makes no sense.
  provider_state jsonb,

  created_at    timestamptz not null default now(),

  constraint processor_accounts_one_recipient
    check ((park_id is null) <> (vendor_id is null)),

  -- A merchant id is the processor's, so it cannot exist before we submitted.
  constraint processor_accounts_id_follows_submission
    check (provider_merchant_id is null or submitted_at is not null),

  -- An active account must be able to DO something, or "active" is a word
  -- that tells a doorway nothing.
  constraint processor_accounts_active_can_do_something
    check (status <> 'active'
           or can_accept_ach or can_accept_card or can_receive_payout),

  -- Half a disablement is a row nobody can account for.
  constraint processor_accounts_disablement_is_whole
    check ((disabled_at is null) = (status <> 'disabled'))
);

-- ONE LIVE ACCOUNT PER RECIPIENT PER PROVIDER.
--
-- Partial, excluding disabled and rejected, so a merchant who was turned down
-- can be re-submitted and a closed account can be replaced. A full unique
-- index would make "rejected, fixed, re-applied" impossible, which is the
-- ordinary course of onboarding.
--
-- A NOTE FOR WHOEVER ADDS THE NEXT KIND OF ROW HERE: this index is the
-- guarantee the capability read leans on — it is what lets a doorway ask for
-- THE account rather than pick one of several. Sharing this table with a new
-- recipient kind or a second live account per recipient silently spends it.
-- 0192 learned that on park_reminders; widen the index in the same migration.
create unique index if not exists processor_accounts_one_live_park_idx
  on public.processor_accounts(provider, park_id)
  where park_id is not null and status not in ('disabled', 'rejected');

create unique index if not exists processor_accounts_one_live_vendor_idx
  on public.processor_accounts(provider, vendor_id)
  where vendor_id is not null and status not in ('disabled', 'rejected');

create index if not exists processor_accounts_park_idx
  on public.processor_accounts(park_id) where park_id is not null;
create index if not exists processor_accounts_vendor_idx
  on public.processor_accounts(vendor_id) where vendor_id is not null;

-- ---------------------------------------------------------------------------
-- A STATUS IS A RECORD OF WHAT THE PROCESSOR SAID
-- ---------------------------------------------------------------------------
-- The CHECKs above refuse an incoherent row. They cannot refuse an UPDATE that
-- walks a live merchant backwards to 'draft', or quietly re-points an active
-- account at a different merchant id — and a settlement destination that can
-- be rewritten in place is the one record that must not be.
create or replace function public.guard_processor_account()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- The recipient never changes. Re-pointing an account from one park to
    -- another is indistinguishable, afterwards, from having onboarded that
    -- park all along — and it would redirect somebody's rent.
    if new.park_id is distinct from old.park_id
       or new.vendor_id is distinct from old.vendor_id
       or new.provider is distinct from old.provider then
      raise exception 'processor_accounts: an account belongs to the recipient it was opened for — disable it and open another';
    end if;

    -- Their id for the merchant is assigned once.
    if old.provider_merchant_id is not null
       and new.provider_merchant_id is distinct from old.provider_merchant_id then
      raise exception 'processor_accounts: that merchant id was assigned by the processor and cannot be changed';
    end if;

    -- FORWARD ONLY. draft -> submitted -> active, and anything may end in
    -- rejected or disabled. Nothing comes back.
    if old.status = 'active' and new.status in ('draft', 'submitted') then
      raise exception 'processor_accounts: that merchant is already live — disable the account rather than reopening it';
    end if;
    if old.status in ('disabled', 'rejected') and new.status not in ('disabled', 'rejected') then
      raise exception 'processor_accounts: that account is closed — open a new one instead of reviving it';
    end if;

    -- The stamps say when something happened. They do not get edited.
    if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
      raise exception 'processor_accounts: submitted_at records when it was sent';
    end if;
    if old.activated_at is not null and new.activated_at is distinct from old.activated_at then
      raise exception 'processor_accounts: activated_at records when it went live';
    end if;
  end if;

  -- A LIVE MERCHANT HAS AN ID AND A DESTINATION. Without both, "active" is a
  -- doorway's green light for a payment with nowhere to land.
  if new.status = 'active' then
    if new.provider_merchant_id is null then
      raise exception 'processor_accounts: an active merchant needs the id the processor gave it';
    end if;
    if new.activated_at is null then
      raise exception 'processor_accounts: an active merchant needs the day it went live';
    end if;
    if new.settlement_last4 is null then
      raise exception 'processor_accounts: an active merchant needs the account its money settles to';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists processor_accounts_are_a_record on public.processor_accounts;
create trigger processor_accounts_are_a_record
  before insert or update on public.processor_accounts
  for each row execute function public.guard_processor_account();

-- ---------------------------------------------------------------------------
-- WHO MAY READ
-- ---------------------------------------------------------------------------
alter table public.processor_accounts enable row level security;

-- The recipient's own people, and ops. A park's settlement account is the
-- park's business; a crew's is the crew's.
drop policy if exists processor_accounts_access on public.processor_accounts;
create policy processor_accounts_access on public.processor_accounts for select
  using (
    public.ll_is_ops()
    or (park_id is not null and public.ll_manages_park(park_id))
    or (vendor_id is not null and vendor_id = public.ll_my_vendor_id())
  );

-- Postgres' default grants would let a signed-in client write this table —
-- which on THIS table means marking their own merchant active and pointing a
-- park's rent at an account of their choosing.
revoke insert, update, delete on public.processor_accounts from anon, authenticated;
grant select on public.processor_accounts to authenticated;
revoke all on function public.guard_processor_account() from public, anon, authenticated;

comment on table public.processor_accounts is
  'Who a payment settles to. One live account per recipient per provider. Holds NO bank account or routing numbers - the processor holds those under Architecture A - only four digits for display. Capabilities default false and are the processor''s answer, never a local wish.';
