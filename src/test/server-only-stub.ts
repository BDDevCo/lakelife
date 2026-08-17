/**
 * Stands in for the `server-only` package under vitest.
 *
 * The real package throws on import outside a server component — which is the
 * point of it, and also why a module carrying it cannot be unit tested. This
 * empty module is aliased in `vitest.config.ts` so pure helpers can be
 * exercised directly. Nothing about the Next build changes: the genuine guard
 * still runs there, which is the only place a client bundle could form.
 */
export {};
