-- 0138 — THE RULES SHE ACTUALLY READ
--
-- `amenity_bookings.acknowledged_at` records that a guest ticked the park's own
-- rules before taking the pontoon. The rules themselves were never stored. They
-- live on `park_amenities.rules`, a column the park owner edits whenever he
-- likes — so the day he tightens the life-jacket line, every acknowledgement
-- ever made silently re-points at wording nobody was shown.
--
-- The same row already gets this right about money. 0119 snapshots
-- `quoted_amount` onto the booking "so editing the rate in August cannot rewrite
-- what July's guest agreed to". The words got no such protection, and the words
-- are the part somebody would actually argue about.
--
-- WHY IT MATTERS MORE THAN A USUAL SNAPSHOT. These are not LakeLife's rules.
-- LakeLife is a third-party administrator and is not a party to them; it takes
-- no position on what a park's terms say. Holding a timestamp that asserts
-- "she agreed to the rules", while being unable to produce the rules, is a
-- record that READS as evidence and is not one — about somebody else's terms.
-- That is precisely the liability the product refuses elsewhere, and 0133
-- already settled the pattern for it:
--
--   "A timestamp records THAT somebody agreed. It cannot answer what they
--    agreed to. So the exact words are snapshotted beside the timestamp, at the
--    moment of the tap, in the same write."
--
-- THE PAIR IS ALL-OR-NOTHING, and the database holds that rather than the
-- caller. Two ways it used to be able to lie:
--
--   * acknowledged, no words   — the defect above.
--   * acknowledged, no rules to acknowledge — the guest page renders the rules
--     only `if (o.rules)`, so an amenity with none showed her a bare button and
--     still stamped "she ticked the rules". Nothing was there to tick.
--
-- So: a booking has both, or neither. An owner booking a day ON BEHALF of a
-- resident (`booked_by` set) has neither, correctly — she tapped nothing.

alter table public.amenity_bookings
  add column if not exists rules_text text;

comment on column public.amenity_bookings.rules_text is
  'The park''s amenity rules EXACTLY as rendered to the guest above the button, '
  'snapshotted at the moment she tapped it. park_amenities.rules is live and '
  'editable; this is not. NULL together with acknowledged_at when the amenity '
  'had no rules, or when somebody booked the day on her behalf. LakeLife is not '
  'a party to these rules and takes no position on them — it records only that '
  'these words were the ones on screen.';

comment on column public.amenity_bookings.acknowledged_at is
  'When the guest tapped the button with the park''s rules above it. Meaningless '
  'without rules_text beside it, and the check constraint below makes the two '
  'inseparable.';

-- Nothing to backfill: zero bookings exist. Were there any, the honest fix is
-- NULLING acknowledged_at on them rather than inventing the wording they saw.
alter table public.amenity_bookings
  drop constraint if exists amenity_bookings_ack_has_words;

alter table public.amenity_bookings
  add constraint amenity_bookings_ack_has_words
  check ((acknowledged_at is null) = (rules_text is null));

-- ------------------------------------------------------ post-conditions ----
do $$
declare
  n int;
begin
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'amenity_bookings'
     and column_name = 'rules_text';
  if n <> 1 then
    raise exception '0138: amenity_bookings.rules_text is missing';
  end if;

  select count(*) into n
    from pg_constraint
   where conname = 'amenity_bookings_ack_has_words'
     and conrelid = 'public.amenity_bookings'::regclass;
  if n <> 1 then
    raise exception '0138: the acknowledged-without-words check is missing';
  end if;

  -- AND PROVE IT IS THE RIGHT CHECK, by reading its definition.
  --
  -- The obvious post-condition — insert an acknowledged row with no words and
  -- expect a refusal — is worthless here: `amenity_booking_fits` raises "That
  -- amenity is gone" on the fake unit id long before the constraint is
  -- consulted, so the probe would pass on a database where this constraint had
  -- never been added. A test satisfied by the wrong mechanism is not a test.
  perform 1
     from pg_constraint
    where conname = 'amenity_bookings_ack_has_words'
      and conrelid = 'public.amenity_bookings'::regclass
      and pg_get_constraintdef(oid) ilike '%acknowledged_at IS NULL%'
      and pg_get_constraintdef(oid) ilike '%rules_text IS NULL%';
  if not found then
    raise exception '0138: the check exists but does not tie the two columns: %',
      (select pg_get_constraintdef(oid) from pg_constraint
        where conname = 'amenity_bookings_ack_has_words'
          and conrelid = 'public.amenity_bookings'::regclass);
  end if;
end $$;
