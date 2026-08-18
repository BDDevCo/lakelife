/**
 * ONE RETRY FOR A BLIP THAT NEVER REACHED THE DATABASE.
 *
 * ============================================================================
 * WHAT THE LOGS ACTUALLY SAID
 * ============================================================================
 * Three Cloudflare 502s were seen on 17 Aug 2026, and the diagnosis is not the
 * one anybody expected:
 *
 *   - Supabase's edge logged 886 requests that day and NOT ONE 5xx.
 *   - The request that came back 502 was served by the origin in 136ms, status
 *     200. The failure was injected after the origin had already answered.
 *   - Postgres logged no restart, no OOM, no connection exhaustion. Pro plan,
 *     healthy the whole time.
 *   - Every failure came from ONE network path: a home cable connection to
 *     us-east-1, which Cloudflare was routing through three different edge
 *     colos. Production — Vercel iad1 to Supabase us-east-1, effectively the
 *     same building — logged 297 requests and zero errors.
 *
 * So it is not the database, not capacity, not the plan, and not the app. It
 * is an ordinary long-haul transport hiccup, and the reason it mattered at all
 * is that the code above it could not tell a failed read from an empty table.
 * That half is fixed; this is the other half.
 *
 * ============================================================================
 * READS ONLY. THIS IS THE WHOLE SAFETY ARGUMENT.
 * ============================================================================
 * A GET that fails in transit did not change anything, so asking again is free.
 * A POST, PATCH or DELETE that fails in transit MAY HAVE LANDED — the response
 * is what went missing, not necessarily the write — so retrying one could
 * double-charge a card, double-pay a crew, or raise a bill twice. Those are
 * exactly the bugs the rest of this change set removed, and re-introducing them
 * here through a helpful-looking retry would be worse than the 502.
 *
 * PostgREST reads are GET (and HEAD for `{ count, head: true }`). `.rpc()` is
 * POST and is deliberately NOT retried, because a function can write.
 *
 * Retried only on the shapes that mean "this never got a real answer":
 * a thrown network error, or 502/503/504 from an edge. A 4xx is a real answer
 * and is returned untouched; so is a 500, which means the origin ran and failed.
 */

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;          // the first try plus two retries
const BACKOFF_MS = [120, 400];   // short: a page render is waiting on this

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET"; // fetch's own default
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

/** Path only — a Supabase URL carries the query, and the query carries data. */
function safeLabel(input: RequestInfo | URL): string {
  try {
    return new URL(urlOf(input)).pathname;
  } catch {
    return "a supabase request";
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createRetryingFetch(
  underlying: typeof fetch = fetch,
): typeof fetch {
  return async function retryingFetch(input, init) {
    const method = methodOf(input, init);
    const idempotent = method === "GET" || method === "HEAD";

    let lastError: unknown;
    for (let attempt = 1; attempt <= (idempotent ? MAX_ATTEMPTS : 1); attempt++) {
      try {
        const res = await underlying(input, init);
        if (!idempotent || !RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
          if (attempt > 1) {
            console.warn(`[supabase] ${safeLabel(input)} recovered on attempt ${attempt}`);
          }
          return res;
        }
        // A retryable status. The body is unread and about to be discarded —
        // cancel it so the socket can be reused rather than left hanging.
        void res.body?.cancel().catch(() => {});
        console.warn(`[supabase] ${safeLabel(input)} got ${res.status}, retrying`);
      } catch (e) {
        lastError = e;
        if (!idempotent || attempt === MAX_ATTEMPTS) throw e;
        console.warn(`[supabase] ${safeLabel(input)} threw, retrying:`, (e as Error)?.message);
      }
      await wait(BACKOFF_MS[attempt - 1] ?? 400);
    }
    // Only reachable when the last attempt threw and the loop fell through.
    throw lastError instanceof Error ? lastError : new Error("supabase fetch failed");
  } as typeof fetch;
}
