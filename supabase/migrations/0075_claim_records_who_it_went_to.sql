-- 0075 — WHO DID YOU MAKE IT OUT TO?
--
-- At a takeover this is the single most diagnostic question on the claim form.
-- On Dec 15 nineteen households who have paid Michael for years start paying a
-- new owner, and some of them will keep writing checks to the name they have
-- always written. Those checks are not late rent — they are rent that went to
-- the wrong payee — and the answer changes what the park does about it from
-- "chase them" to "go and get it from the seller".
--
-- Free text on purpose: the useful answer is whatever name they actually wrote,
-- including a misspelling or a management company nobody has heard of.
alter table public.park_payment_claims
  add column if not exists paid_to text;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'park_payment_claims'
      and column_name = 'paid_to'
  ) then
    raise exception '0075: paid_to did not land';
  end if;
end $$;
