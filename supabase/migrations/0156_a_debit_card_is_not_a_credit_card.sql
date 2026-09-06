-- 0156 — A DEBIT CARD IS NOT A CREDIT CARD.
--
-- Two things that are safe only because no processor is connected, and become
-- live defects the moment LAKELIFE_PAYMENTS_LIVE is set.
--
-- ============ 1. THE SURCHARGE REACHES EVERY CARD ============
--
-- The Haven holds `card_fee_pct = 3.00` and `accepts_online_rent = true`.
-- Surcharging a DEBIT card is forbidden by the card networks at any rate in
-- every state — the owner's own processor brief says so, and the setup screen
-- has been warning him since 0109 that `payment_methods` records a brand but
-- no funding type. The warning was all the software could do; a percentage was
-- added to every card alike.
--
-- `funding` is the missing fact. It defaults to 'unknown', and 'unknown' is
-- surcharged at zero along with 'debit' and 'prepaid' — a wrong surcharge is a
-- rule violation and (0142) a refund we cannot simply reverse, while a missing
-- one is lost margin on one bill. The dial is untouched: 3% still means 3%, on
-- the credit cards it is allowed to mean it on.
--
-- NOBODY WRITES 'credit' YET, and nothing in this migration pretends
-- otherwise. `savePaymentMethod` writes whatever funding type the tokenize
-- result carries, which for the mock is none — so every row reads 'unknown'
-- until a real SDK reports one. A column read by a guard and written by
-- nothing is enforced by nothing; this one has its writer from day one, it
-- just has nothing true to say yet.
--
-- ============ 2. A CLIENT CAN WRITE A CARD NUMBER INTO token ============
--
-- CLAUDE.md rule 4: card data never touches our database. The shape guard that
-- enforces it lives in ONE server action (`savePaymentMethod`), while the live
-- grants say `authenticated` holds INSERT, UPDATE and DELETE on
-- payment_methods under policy `pm_owner` (user_id = auth.uid() OR
-- ll_is_ops()) with no CHECK and no trigger. A signed-in browser can POST
-- straight to PostgREST and store a raw PAN under its own user id, and the
-- action never runs. That is the rule in one doorway of two.
--
-- So: the writes are revoked, and the shape rule moves into the column where
-- it holds against every writer including ours. The SELECT grant and pm_owner
-- stay exactly as they are — the card list is read through the resident's own
-- session and revoking that would empty a working screen with no error.
-- `savePaymentMethod` and `removePaymentMethod` move to the service client in
-- the same commit, still scoped by user_id in the statement.
--
-- WHAT THE CHECK SAYS, AND WHAT IT DELIBERATELY DOES NOT. It encodes rule 4's
-- INTENT — a token is short, non-empty, and contains no run of 13-19 digits,
-- which is what a card number is. It does NOT require a 'tok_' prefix: that is
-- the MOCK's format, and pinning it here would refuse Stripe's `pm_…` and
-- Helcim's own the day the SDK is swapped in — a database that forbids saving
-- any real card.
--
-- Verified read-only against production first: 2 rows, both 16-27 characters,
-- neither containing a digit run, so nothing existing is refused.

-- ------------------------------------------------- 1. the funding type ---

alter table public.payment_methods
  add column if not exists funding text not null default 'unknown';

alter table public.payment_methods
  drop constraint if exists payment_methods_funding_known;
alter table public.payment_methods
  add constraint payment_methods_funding_known
  check (funding in ('credit', 'debit', 'prepaid', 'unknown'));

comment on column public.payment_methods.funding is
  'How the card is funded, as reported by the processor. Only ''credit'' may be surcharged (parks.card_fee_pct); ''debit'', ''prepaid'' and the default ''unknown'' are charged nothing extra. Written by savePaymentMethod from the tokenize result; the mock reports none, so every row reads ''unknown'' until real processor keys exist.';

-- --------------------------------------------- 2. rule 4, in the column ---

alter table public.payment_methods
  drop constraint if exists payment_methods_token_is_not_a_pan;
alter table public.payment_methods
  add constraint payment_methods_token_is_not_a_pan
  check (
    length(token) between 1 and 64
    and token !~ '[0-9]{13,19}'
  );

comment on constraint payment_methods_token_is_not_a_pan on public.payment_methods is
  'CLAUDE.md rule 4 — card data never reaches our database. A vault token is short and carries no card number. No prefix is required on purpose: tok_ is the mock''s format and a real processor issues its own.';

-- ------------------------------------------------ 3. close the doorway ---
--
-- SELECT stays: the resident's card list renders through her own session
-- under pm_owner, and ops reads it the same way. Only the writes go.

revoke insert, update, delete on public.payment_methods from anon, authenticated;
grant select on public.payment_methods to anon, authenticated;
