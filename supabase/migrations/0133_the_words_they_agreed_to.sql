-- 0133 — THE WORDS THEY AGREED TO.
--
-- `mobile_verified_at` and `sms_consent_operational_at` have existed since the
-- park module shipped and NOTHING HAS EVER WRITTEN THEM. Two columns the
-- reminder engine reads on every run, permanently null, so the SMS gate has
-- never once opened. Safe by accident, and the accident is about to end: this
-- is the migration that gives them a writer.
--
-- The writer is the resident. Not the office, not an import, not a default —
-- the person whose phone it is, on their own screen, after they are already
-- signed in. That is the same way every other LakeLife account proves a mobile
-- (CLAUDE.md rule 5), and it is the difference between a number we may text
-- and a number somebody wrote on a sheet.
--
-- ---------------------------------------------------------------------------
-- WHY A THIRD COLUMN, AND NOT JUST THE TIMESTAMP.
--
-- A timestamp records THAT somebody agreed. It cannot answer what they agreed
-- to, which is the only question that matters if it is ever disputed — and
-- texting is the channel where being asked that question carries per-message
-- statutory damages.
--
-- Copy changes. The sentence on screen in December will not be the sentence on
-- screen in April, and reconstructing which one a household saw from a git log
-- two years later is not evidence. So the exact words are snapshotted beside
-- the timestamp, at the moment of the tap, in the same write.
--
-- It is deliberately free text and deliberately never parsed. Nothing reads
-- this to make a decision; it exists to be shown to a person who is asking a
-- fair question.

alter table public.park_renters
  add column if not exists sms_consent_text text;

comment on column public.park_renters.sms_consent_text is
  'The exact sentence the resident agreed to when they turned texts on. '
  'Snapshotted at consent time because on-screen copy changes. Never parsed.';

-- ------------------------------------------------------- post-conditions ----

do $$
declare
  n int;
begin
  -- 1. The column exists and is free text.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'park_renters'
     and column_name = 'sms_consent_text' and data_type = 'text';
  if n <> 1 then
    raise exception 'ROLLBACK_POSTCONDITION: sms_consent_text missing or wrong type';
  end if;

  -- 2. The two columns this exists to accompany are still there and still
  --    nullable. A NOT NULL on either would mean every household is presumed
  --    to have consented, which is the exact inversion this whole path avoids.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'park_renters'
     and column_name in ('mobile_verified_at', 'sms_consent_operational_at')
     and is_nullable = 'YES';
  if n <> 2 then
    raise exception 'ROLLBACK_POSTCONDITION: consent columns missing or not nullable';
  end if;

  -- 3. NOBODY IS CONSENTED BY THIS MIGRATION. Adding a column must not turn
  --    into a backfill; every existing household stays exactly as un-consented
  --    as they were a minute ago.
  select count(*) into n from public.park_renters
   where sms_consent_operational_at is not null;
  if n > 0 then
    raise exception
      'ROLLBACK_POSTCONDITION: % household(s) came out of this migration consented', n;
  end if;

  -- 4. Still no client-side write path to the table. The consent write goes
  --    through a server action holding the service role, scoped to the
  --    resident's own file — never from a browser.
  if has_table_privilege('authenticated', 'public.park_renters', 'UPDATE') then
    raise exception 'ROLLBACK_POSTCONDITION: authenticated can UPDATE park_renters';
  end if;
end
$$;
