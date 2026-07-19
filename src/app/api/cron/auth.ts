import "server-only";

/**
 * Cron endpoints run with no signed-in user, so they authorize with a shared
 * secret instead. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
 * automatically when CRON_SECRET is set in the project env. We accept that, or
 * an `x-cron-secret` header, using a length-safe constant-time comparison.
 * If CRON_SECRET is unset we DENY (fail closed) rather than run open.
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — never run an unprotected cron
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const header = req.headers.get("x-cron-secret");
  const provided = bearer || header || "";
  return timingSafeEqual(provided, secret);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
