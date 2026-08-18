# The 502s: what they were, and what they weren't

**Diagnosed 17–18 Aug 2026. Not the database, not capacity, not the plan, and
not production.**

---

## What was seen

Three Cloudflare `502 Bad Gateway` responses inside a few minutes, on ordinary
reads (`park_renters`, `lot_reservations`) during a page render. They mattered
because the code above them could not tell a failed read from an empty table,
so each one rendered as *"No lot on your account"* to a paying resident.

That half is fixed. This is about the 502 itself.

## The evidence

| Checked | Found |
|---|---|
| Supabase edge logs, 886 requests that day | **Zero 5xx.** All 200/201/204 plus a few 4xx. |
| The specific request that came back 502 | Origin served it **200 in 136 ms**. |
| Postgres logs | No restart, no OOM, no connection exhaustion. Only 9 `ERROR`s — all my own deliberate test mutations and MCP typos. |
| Plan and status | **Pro**, `ACTIVE_HEALTHY`, throughout. |
| Vercel runtime errors, 7 days | **None.** |

## The finding

Split the day's traffic by where it came from:

| Path | Requests | Failures |
|---|---|---|
| Cox Communications → Cloudflare PHX / LAX / SJC — the dev machine | 578 | 3 |
| Amazon (Vercel) → Cloudflare IAD — production | 297 | 0 |

**Every failure came from one network path, and it is not the one users take.**

Production runs Vercel `iad1` → Supabase `us-east-1`, both in Northern
Virginia, effectively next door. The dev machine reaches the same origin over
home cable across the country, and Cloudflare was bouncing it between three
different edge colos.

And the decisive detail: on the request that failed, **the origin had already
answered 200**. The 502 was injected after that — a relay failure between
Cloudflare and the client, on a long haul. The database never knew anything
went wrong, which is exactly why nothing appeared in its logs.

### Why this does not follow users into production

Every one of these reads is **server-side**. A resident's phone talks to
Vercel; Vercel talks to Supabase. A resident on bad cellular gets a slow page
from Vercel — they do not inherit this path at all. The only machine taking the
long route is the one doing development.

## What was done anyway

`src/lib/supabase/retrying-fetch.ts` — one retry, then a second, on the shapes
that mean *no real answer was received*: a thrown network error, or 502/503/504.

**Reads only, and that is the whole safety argument.** A `GET` that fails in
transit changed nothing, so asking again is free. A `POST`/`PATCH`/`DELETE`
that fails in transit **may have landed** — only the response went missing — so
retrying one could double-charge a card, double-pay a crew, or raise a bill
twice. Those are precisely the bugs the rest of this work removed; a
helpful-looking retry would put them back. `.rpc()` is a POST and is not
retried either, because a function can write.

A 4xx is a real answer and passes through. So does a 500 — the origin ran and
failed, and asking again just fails again, slower.

Log lines carry the **path only**, never the query string, because a Supabase
query string carries filters and filters carry data.

## What to watch

The retry logs `[supabase] <path> got 502, retrying` and `recovered on attempt
N`. If `recovered` lines start appearing **in Vercel's logs** — as opposed to
locally — the picture has changed and it is worth reopening. Nothing so far
suggests it will.

## One genuinely separate thing found on the way

`postgres_logs` shows `column "ran_at" does not exist` and
`relation "public.job_reminders" does not exist`. Both came from ad-hoc console
queries, not from application code — but they mean those names were wrong in
somebody's head, so any runbook or saved query using them is broken.
