import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Shared bits for the Autopilot one-tap links (/a/<token>/confirm|skip).
 * The token authorizes exactly ONE proposal's confirm/skip — nothing else.
 * These land from SMS taps with no session, so responses are tiny branded
 * HTML pages, not app routes.
 */

/** HTML-escape anything interpolated into the token pages (nickname/address
 *  are user-controlled — a 40-char nickname can hold a working XSS payload). */
export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function htmlPage(rawTitle: string, rawBody: string, ok = true, formAction?: string, formLabel?: string): Response {
  const title = escapeHtml(rawTitle);
  const body = escapeHtml(rawBody);
  // Mutations happen ONLY on POST (link-preview prefetchers issue GETs — a
  // prefetch must never book or skip anything). The GET page renders this form.
  const form = formAction
    ? `<form method="post" action="${escapeHtml(formAction)}" style="margin-top:18px"><button type="submit" style="width:100%;min-height:48px;border:0;border-radius:12px;background:#d9a441;color:#0a2430;font-size:16px;font-weight:800;cursor:pointer">${escapeHtml(formLabel ?? "Confirm")}</button></form>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — LakeLife</title><style>
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f2f7f8;color:#0a2430;display:grid;place-items:center;min-height:100vh}
  .card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(10,36,48,.08);padding:32px 28px;max-width:420px;margin:16px;text-align:center}
  .badge{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:4px 12px;border-radius:999px;background:${ok ? "#e0f2ef" : "#fdf1dc"};color:${ok ? "#0e7a6a" : "#9a6b15"}}
  h1{font-size:22px;margin:14px 0 8px}p{font-size:15px;color:#48626e;line-height:1.5;margin:0}
  a{color:#0e7a6a;font-weight:700}
  </style></head><body><div class="card"><span class="badge">${ok ? "LakeLife" : "Heads up"}</span><h1>${title}</h1><p>${body}</p>${form}</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export interface TokenEvent {
  id: string;
  status: string;
  proposed_date: string;
  enrollment: {
    id: string;
    active: boolean;
    property_id: string;
    service_id: string;
    locked_price: number;
    serviceName: string;
    ownerId: string | null;
    where: string;
  };
}

const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

/** Resolve a confirm token to its event + enrollment, or null. */
export async function loadTokenEvent(token: string): Promise<TokenEvent | null> {
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  const admin = createServiceClient();
  const { data: ev } = await admin
    .from("autopilot_events")
    .select("id, status, proposed_date, autopilot_enrollments(id, active, property_id, service_id, locked_price, services(name), properties(owner_id, address, nickname))")
    .eq("confirm_token", token)
    .maybeSingle();
  if (!ev) return null;
  const enr = one(ev.autopilot_enrollments) as {
    id?: string; active?: boolean; property_id?: string; service_id?: string; locked_price?: number;
    services?: unknown; properties?: unknown;
  } | null;
  if (!enr?.id) return null;
  const svc = one(enr.services) as { name?: string } | null;
  const prop = one(enr.properties) as { owner_id?: string; address?: string; nickname?: string } | null;
  return {
    id: ev.id as string,
    status: ev.status as string,
    proposed_date: ev.proposed_date as string,
    enrollment: {
      id: enr.id,
      active: !!enr.active,
      property_id: enr.property_id as string,
      service_id: enr.service_id as string,
      locked_price: Number(enr.locked_price ?? 0),
      serviceName: svc?.name ?? "your service",
      ownerId: (prop?.owner_id as string) ?? null,
      where: prop?.nickname || prop?.address || "your place",
    },
  };
}

export function prettyDay(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
