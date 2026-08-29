-- 0146 — A PHOTO THAT CAN WIN AN ARGUMENT.
--
-- §E.2 of the storage design named this a launch rail and it was never built:
--
--   "Condition reports, not just photo counts: typed intake/outtake photo
--    checklists at every custody handoff + customer e-acknowledgment. Kills
--    'that gouge wasn't there in October.'"
--
-- He has chosen to run a full custody season. So it is worth being precise
-- about what the record currently holds when somebody says the gouge is new.
--
-- ============ WHAT A PHOTO IS TODAY ============
--
-- `job_photos` has been four columns since 0001 and has never been altered:
-- id, job_id, url, taken_at. That is:
--
--   * no author — nothing records WHO uploaded it. The only attribution
--     anywhere is jobs.vendor_id, which is the company, not the person;
--   * no integrity — no hash, so "this is the same file, unaltered" is not
--     answerable;
--   * no capture time — `taken_at` defaults to now() at INSERT. It is the
--     moment our server wrote the row, not the moment the shutter fired;
--   * no subject — three photos of the same fender satisfy a gate of three.
--
-- Three unattributed images is what currently stands between the platform and
-- a four-figure gelcoat claim.
--
-- ============ WHAT THIS MIGRATION DOES, AND DOES NOT ============
--
-- It makes a photo into evidence, and it does NOT add a new gate.
--
-- DOES: four columns on `job_photos`, and a NAMED SHOT LIST per service so the
-- checklist is data rather than code (CLAUDE.md rule 8) and every future
-- custody service gets its own list without a deploy.
--
-- DOES NOT: introduce slot-completeness enforcement. There is no offline
-- support anywhere in the vendor app — no service worker, no queue, no local
-- state. With a COUNT gate a crew with no signal shoots into the camera roll
-- and uploads from the truck; with a slot gate the device must know which
-- named slots are still empty while offline, and it cannot. No crew has ever
-- completed a job on this platform, so nobody yet knows what a real crew does
-- at a barn door in November. Enforcement is next season's migration, written
-- from what actually happened rather than from what we imagine.
--
-- The slot LABELS the shot and drives the prompt. The existing database gate
-- (0050's `jobs_photo_gate`) still counts, and the counts are raised here to
-- match the named list — so a crew cannot complete a custody job on one photo,
-- which today they can.
--
-- ============ WHY NOT A NEW TABLE ============
--
-- Because 0050 put the photo gate in the DATABASE, and it counts `job_photos`.
-- A separate `storage_condition_reports` table holding its own photos would
-- create a second photo store with a second gate, and the weaker one would
-- still govern `jobs.status`. The slot belongs on the row the trigger reads.
--
-- Nor `acceptances` (0139) for the customer's assent: its `document_kind` is a
-- CHECK over five literals, and every live row must carry `document_text` and
-- `text_sha256`. Photographs are not text, and synthesising a paragraph to fit
-- would be inventing words nobody wrote — which 0139's own header calls "the
-- defect this whole table exists to end."

-- ------------------------------------------------- 1. the photo as evidence --

alter table public.job_photos
  add column if not exists slot        text,
  add column if not exists taken_by    uuid references public.users(id) on delete set null,
  add column if not exists sha256      text,
  add column if not exists device_time timestamptz;

comment on column public.job_photos.slot is
  'Which named shot this is — "port_side", "engine". Nullable: an extra photo '
  'beyond the list is still worth having, and every row written before 0146 '
  'has none. The list lives on services.required_photo_slots.';

comment on column public.job_photos.taken_by is
  'The PERSON who uploaded it. jobs.vendor_id is the company; a custody '
  'dispute asks who was standing at the dock. ON DELETE SET NULL so the '
  'evidence outlives the account.';

comment on column public.job_photos.sha256 is
  'Hash of the bytes at upload, so "this is the same file, unaltered" is '
  'answerable later. Computed server-side from what was actually stored.';

comment on column public.job_photos.device_time is
  'What the uploading DEVICE reported as the file time, kept BESIDE taken_at '
  'and never instead of it. NOT EXIF and must never be described as capture '
  'time: it is the file''s modified time, which a camera sets at the shutter '
  'and a camera roll does not. Its value is that it can DISAGREE with '
  'taken_at — an October device time on a November upload is ordinary; a '
  'three-year-old one is a question.';

-- Same-file detection per job. Not unique — a crew may legitimately shoot the
-- same view twice — but indexed so "is this the photo you showed me" is cheap.
create index if not exists job_photos_sha_idx on public.job_photos(job_id, sha256)
  where sha256 is not null;

-- ------------------------------------------- 2. the shot list, as data ------

alter table public.services
  add column if not exists required_photo_slots text[] not null default '{}';

comment on column public.services.required_photo_slots is
  'The named walk-around for this service, in the order a crew would shoot it. '
  'Drives the prompts on the crew screen and labels each photo. NOT enforced '
  'slot-by-slot yet — see the 0146 header on offline. min_photos is set to '
  'this list''s length so the COUNT gate at least matches the ask.';

update public.services
   set required_photo_slots = array['port_side','starboard_side','bow','stern','hull','engine','interior'],
       min_photos = 7
 where name = 'Boat storage & winterize';

update public.services
   set required_photo_slots = array['port_side','starboard_side','bow','stern','deck'],
       min_photos = 5
 where name = 'Jet ski winterize & store';

update public.services
   set required_photo_slots = array['overall','tag'],
       min_photos = 2
 where name = 'Water toy prep & storage';

update public.services
   set required_photo_slots = array['racked_position','overall'],
       min_photos = 2
 where name = 'Winter storage — indoor';

update public.services
   set required_photo_slots = array['racked_position','cover_or_wrap'],
       min_photos = 2
 where name = 'Winter storage — outdoor';

-- ------------------------------------------------------ post-conditions -----

do $$
declare n int; bad text;
begin
  -- 1. THE COLUMNS EXIST AND ARE OPTIONAL. Every photo written before today
  --    has none of them, and backfilling invented values would be worse than
  --    the gap.
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='job_photos'
         and column_name in ('slot','taken_by','sha256','device_time')) <> 4 then
    raise exception '0146: the evidence columns were not all added';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='job_photos'
                and column_name in ('slot','taken_by','sha256','device_time')
                and is_nullable = 'NO') then
    raise exception '0146: an evidence column is NOT NULL — the 6 existing rows have none of them';
  end if;

  -- 2. EVERY CUSTODY SERVICE HAS A SHOT LIST. This is the point of the
  --    migration: a service that holds somebody's property must say what a
  --    crew is meant to photograph.
  select string_agg(name, ', ') into bad
    from public.services
   where takes_custody and coalesce(array_length(required_photo_slots, 1), 0) = 0;
  if bad is not null then
    raise exception '0146: custody services with no shot list: %', bad;
  end if;

  -- 3. AND THE COUNT GATE MATCHES THE ASK. Before today "Water toy prep &
  --    storage" was ACTIVE, took custody, and let a crew finish on ONE photo.
  select string_agg(name || ' (' || min_photos || ' vs ' ||
                    array_length(required_photo_slots, 1) || ')', ', ')
    into bad
    from public.services
   where takes_custody and min_photos <> array_length(required_photo_slots, 1);
  if bad is not null then
    raise exception '0146: min_photos does not match the shot list: %', bad;
  end if;

  -- 4. NO CUSTODY SERVICE IS STILL ON A TOKEN GATE.
  select count(*) into n from public.services where takes_custody and min_photos < 2;
  if n > 0 then
    raise exception '0146: % custody service(s) still complete on fewer than 2 photos', n;
  end if;

  -- 5. NON-CUSTODY SERVICES ARE UNTOUCHED. A mow does not need a walk-around,
  --    and quietly raising its gate would strand a crew on an unrelated job.
  if exists (select 1 from public.services
              where not takes_custody and array_length(required_photo_slots, 1) > 0) then
    raise exception '0146: a non-custody service was given a shot list';
  end if;
end $$;
