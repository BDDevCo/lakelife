-- 0164 — A PARK OWNER ASKING ABOUT US
--
-- lakelife.ai has one front door and it is written for a lake house: "House,
-- lawn, dock, lift, boat and toys." The word "park" does not appear on it.
-- A mobile-home park OWNER who hears about this has nowhere to land, and a
-- park RESIDENT who types the address instead of using her slip lands on a
-- page selling dock installation.
--
-- The owner half needs somewhere for the enquiry to go. Parks are created by
-- hand — there is no INSERT on `parks` or `park_members` anywhere in the app,
-- by design — so this is a conversation, not a signup.
--
-- ------------------------------------------- why not marketing_contacts ----
--
-- That table exists and looked like the obvious home. It has ONE writer
-- (profile/account-actions.ts) and NO reader on any ops screen — checked
-- before writing this. Filing enquiries there would put them somewhere nobody
-- looks, which is this codebase's most-repeated defect wearing a new hat. Its
-- shape is wrong too: `lake` and `reason` do not hold "42 lots in Wolcottville".
--
-- So: its own table, AND an ops card that reads it, in the same commit. A
-- lead that lands in a table nobody opens is worse than no form at all,
-- because the person who filled it in believes they have been heard.
--
-- `handled_at` is what keeps the card honest — an enquiry list that only ever
-- grows is one somebody stops reading by February.

create table if not exists public.park_enquiries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),

  -- WHO. Name and one way to reach them is the whole requirement; everything
  -- else is optional, because a form that demands a lot count from somebody
  -- just kicking the tyres is a form they abandon.
  name        text not null check (length(btrim(name)) between 1 and 120),
  email       text not null check (length(btrim(email)) between 3 and 200 and position('@' in email) > 1),
  phone       text check (phone is null or length(btrim(phone)) <= 40),

  -- WHAT THEY HAVE. All optional and all worth having: the lot count is the
  -- single most useful number for judging whether a park is worth a call.
  park_name   text check (park_name is null or length(btrim(park_name)) <= 160),
  town        text check (town is null or length(btrim(town)) <= 160),
  lots        integer check (lots is null or (lots >= 0 and lots <= 10000)),
  note        text check (note is null or length(note) <= 2000),

  -- WHETHER ANYBODY HAS ANSWERED. Nullable = still waiting.
  handled_at  timestamptz,
  handled_by  uuid references public.users(id)
);

comment on table public.park_enquiries is
  'A park owner asking about LakeLife from /for-parks. Not a signup — parks are '
  'created by hand — so this is the start of a conversation. Read by the ops '
  'console; handled_at is what stops the list growing forever.';
comment on column public.park_enquiries.handled_at is
  'NULL means nobody has replied yet. The ops card counts these.';

create index if not exists park_enquiries_waiting_idx
  on public.park_enquiries (created_at desc)
  where handled_at is null;

-- WHO MAY TOUCH IT. The form writes through a server action on the service
-- client, so no client role needs INSERT — and anon holding INSERT on a table
-- fed by a public form is exactly how it fills with rubbish. RLS is on and no
-- policy is created: ops reads it service-role, nobody else reads it at all.
-- These rows carry a stranger's name, email and phone.
alter table public.park_enquiries enable row level security;
revoke all on public.park_enquiries from anon, authenticated;

do $$
declare n int; ok boolean;
begin
  if (select count(*) from information_schema.role_table_grants
       where table_schema='public' and table_name='park_enquiries'
         and grantee in ('anon','authenticated')) <> 0 then
    raise exception '0164: a client role can reach a table of strangers'' contact details';
  end if;
  if not (select relrowsecurity from pg_class
           where relname='park_enquiries' and relnamespace='public'::regnamespace) then
    raise exception '0164: row level security is off';
  end if;

  -- An enquiry with no way to answer it is not an enquiry.
  ok := false;
  begin
    insert into public.park_enquiries (name, email) values ('No Address', 'not-an-email');
  exception when others then ok := true;
  end;
  if not ok then
    raise exception '0164: an unreachable enquiry was accepted';
  end if;

  -- And a real one is, with only the two required fields.
  insert into public.park_enquiries (name, email) values ('0164 Proof', 'proof@example.com');
  select count(*) into n from public.park_enquiries where handled_at is null;
  if n < 1 then
    raise exception '0164: a new enquiry did not read as waiting';
  end if;

  raise exception 'ROLLBACK_0164_PROOF';
exception when others then
  if sqlerrm <> 'ROLLBACK_0164_PROOF' then raise; end if;
end $$;
