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

## The production history — repaired 2026-07-27, and proven

This is done. Recorded here because the shape of the problem is worth
remembering.

A branch, clone or restore replays the SQL stored in
`supabase_migrations.schema_migrations.statements` — **not** the files in this
repo. Two things were wrong:

1. **Migrations `0001`–`0021` were never recorded.** They were applied by hand
   before the CLI existed, so any replay started at `0022`, immediately called
   a function created back in `0002`, and died. They are now registered *with
   their actual file contents* (a bare version number would have fixed
   nothing — there would have been no SQL to replay).
2. **24 recorded migrations had drifted from their repo files.** The one that
   proved it: `0041_fill_in_rates`'s stored copy was missing its dial inserts,
   so a rebuild came up with 29 of 34 dials and no fill-in pricing at all. All
   24 were rewritten to match this repo byte-for-byte.

Three rows are deliberately left as they are — `0043b`, `0043c` and
`one_invoice_per_job` have no repo file, because their DDL was later folded
into `0043` and `0046`. Their recorded SQL is the only record of what ran, and
they replay harmlessly after the folded files since everything is
`if not exists`-guarded.

**Verified by building a branch from production's history**: status
`FUNCTIONS_DEPLOYED`, 34 dials, 3 lakes with slugs, 20 services / 10 active,
43 tables, both buckets private, both price-safe views resolving.

If you ever apply SQL to production by hand again, apply it as a migration
instead — that drift is invisible until the day you need to recover.

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
