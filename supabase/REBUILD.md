# Rebuilding the LakeLife database from scratch

This is the disaster-recovery procedure, and also how you stand up a staging
copy or hand a working database to a technical buyer. Verified 2026-07-26 by
replaying every migration onto an empty Supabase branch.

## The one command

```bash
supabase db push
```

Every `supabase/migrations/*.sql` file applies in order and the result is a
database the app can boot on: schema, RLS, functions, triggers, all 34
pricing/policy dials, three lakes, and the full service menu.

`0047_seeds_and_backfills.sql` ends with a check that raises if the menu or the
lakes came out empty, so a broken rebuild fails loudly instead of quietly
booting with nothing to sell.

## What was wrong before (and what to watch for)

The audit found that a from-scratch replay produced **zero SQL errors and a
broken database**. Worth understanding, because the failure mode is silent:

- The lake and service seeds lived in `supabase/seed/*.sql`, outside the
  migration set, so they ran only when a human remembered to paste them.
- Three migrations backfill data that the seeds create — `0008` (per-service
  `daily_capacity`), `0031` (`lakes.slug`, which every public SEO page needs),
  and `0042` (`services.est_minutes`, which the fleet router budgets against).
  On a rebuild all three matched zero rows and left defaults or NULLs behind.

`0047` folds the seeds in and re-issues those three backfills after them.

## The production history needs one repair

Migrations `0001`–`0017` were applied by hand in the SQL Editor before the CLI
was wired up, so **Supabase does not know they ran**. Everything works today,
but any tool that replays history — a branch, a clone, a restore — starts at
`0018`, which immediately calls a function created back in `0002`, and dies.
That is exactly how the audit's first branch build failed.

Register them once, against production:

```bash
supabase migration repair --status applied 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017
```

This only writes to Supabase's migration bookkeeping table. It does not touch
your data or re-run anything.

## Two things that still live outside SQL

`0048` creates the storage buckets, so those are covered now. These two are not:

1. **The intraday cron schedule.** `0023` installs `pg_cron`/`pg_net` but does
   not schedule the job, because the statement embeds `CRON_SECRET` and this
   repo is public. After a rebuild there is no 30-minute heartbeat — no
   waitlist retries, no intraday re-homing. Re-create it in the SQL editor:

   ```sql
   select cron.schedule('lakelife-intraday', '*/30 * * * *', $$
     select net.http_post(
       url := 'https://www.lakelife.ai/api/cron/intraday',
       headers := '{"Authorization":"Bearer <CRON_SECRET>"}'::jsonb,
       timeout_milliseconds := 25000);
   $$);
   ```

2. **The first ops account.** `guard_role_change` blocks role changes from
   anyone who is not already ops or service-role, so the first ops user has to
   be promoted with the service key, out of band.

## Notes

- Every migration is now re-runnable. `0002_rls.sql` was the last exception —
  27 unguarded `create policy` statements that failed on a second pass — and it
  now drops each policy first, matching every later migration.
- `supabase/seed/*.sql` are kept as the human-readable source of the menu, but
  they are no longer load-bearing: `0047` carries the same content. Edit both,
  or edit `0047` and treat the seed files as documentation.
- There is no `setup-all.sql` any more. It advertised "complete database setup"
  while containing only `0001`, `0002` and the lakes seed, so anyone following
  it got a two-migration database. Use `supabase db push`.
