import { createServiceClient } from "@/lib/supabase/server";

/**
 * Personal calendar feed (delight layer §5). The owner's phone calendar
 * subscribes to this URL; calendar apps can't log in, so auth is the
 * unguessable per-account token from users.ics_token (unique-indexed).
 * The feed exposes ONLY that account's own upcoming scheduled services —
 * service name, date/slot, address. Never prices, crews, or gate codes.
 */

export const dynamic = "force-dynamic";

const SLOT_HOUR: Record<string, number> = { "8a": 8, "10a": 10, "1p": 13, "3p": 15 };
/** iCalendar escaping for text fields (RFC 5545 §3.3.11). */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** A route handler has no error boundary — a throw here is a bare 500 and some
 *  calendar clients treat that as badly as a 404. 503 + Retry-After is the one
 *  answer that means "ask again", and keeps the existing events in place. */
const unavailable = () =>
  new Response("temporarily unavailable", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "600", "Cache-Control": "no-store" },
  });

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return new Response("not found", { status: 404 });

  const admin = createServiceClient();

  // A FAILED READ IS NOT A BAD TOKEN. 404 tells the calendar app this feed is
  // gone and several will drop the subscription outright, so the owner would
  // have to re-add it by hand. A failed lookup is 503 — retry, don't unsubscribe.
  const userRes = await admin.from("users").select("id").eq("ics_token", token).maybeSingle();
  if (userRes.error) {
    console.error("[read failed] the account behind this calendar feed:", userRes.error.code ?? "", userRes.error.message);
    return unavailable();
  }
  const user = userRes.data;
  if (!user) return new Response("not found", { status: 404 });

  const jobsRes = await admin
    .from("jobs")
    .select("id, date, slot, status, services(name), properties!inner(owner_id, address, nickname)")
    .eq("properties.owner_id", user.id as string)
    .in("status", ["scheduled", "in_progress"])
    .not("date", "is", null)
    .order("date", { ascending: true })
    .limit(200);
  // AN EMPTY CALENDAR IS AN ASSERTION, AND A DESTRUCTIVE ONE. Falling through
  // on null serves a valid, empty VCALENDAR, and a subscribed phone deletes
  // every LakeLife appointment it was holding — silently, with no page anyone
  // is looking at. Serve nothing rather than "nothing".
  if (jobsRes.error) {
    console.error("[read failed] this account's upcoming services:", jobsRes.error.code ?? "", jobsRes.error.message);
    return unavailable();
  }
  const jobs = jobsRes.data;

  const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LakeLife//Schedule//EN",
    "X-WR-CALNAME:LakeLife",
    "X-WR-TIMEZONE:America/Indiana/Indianapolis",
  ];
  for (const j of jobs ?? []) {
    const svc = (one(j.services) as { name?: string } | null)?.name ?? "LakeLife service";
    const prop = one(j.properties) as { address?: string; nickname?: string } | null;
    const where = prop?.nickname || prop?.address || "";
    const [y, m, d] = (j.date as string).split("-").map(Number);
    const h = SLOT_HOUR[(j.slot as string) ?? ""] ?? 8;
    const pad = (n: number) => String(n).padStart(2, "0");
    const dt = `${y}${pad(m)}${pad(d)}T${pad(h)}0000`; // floating local time (lake wall-clock)
    lines.push(
      "BEGIN:VEVENT",
      `UID:${j.id}@lakelife.ai`,
      `DTSTART:${dt}`,
      `SUMMARY:${esc(`LakeLife — ${svc}`)}`,
      ...(where ? [`LOCATION:${esc(where)}`] : []),
      `DESCRIPTION:${esc("We'll text you when it's done, with photos. 🌊")}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="lakelife.ics"',
      "Cache-Control": "private, max-age=300",
    },
  });
}
