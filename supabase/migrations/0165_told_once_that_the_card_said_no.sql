-- 0165 — told once that the card said no
--
-- settleJob runs every night over every invoice still 'due'. When the card is
-- declined, or there is no card at all, noteSettleFailure emails the customer:
-- "Add or update your card and we'll take care of it. Nothing else is needed
-- from you." It had no memory of having said so, so the same person got the
-- same email every night until they added a card — and the sentence "nothing
-- else is needed from you" arrived alongside a nightly reminder that
-- something was.
--
-- The comment beside the retry already knew: "The customer's next signal was
-- their card being retried every night." The notice needed the same discipline
-- the waitlist uses (extend_reminded_at) — a stamp, so the nudge is sent once
-- and then not again for a week.
--
-- The OPS side is untouched. Ops is told through the nightly digest, which
-- carries a standing count rather than a fresh alarm, and a completed job that
-- nobody has paid for is exactly the kind of thing a count should keep saying.

alter table public.invoices
  add column if not exists settle_notice_sent_at timestamptz;

comment on column public.invoices.settle_notice_sent_at is
  'When the customer was last emailed that their card declined / no card is on file. '
  'settleJob skips the customer notice unless this is null or older than 7 days. '
  'Ops is not gated by it — the digest carries the standing count.';
