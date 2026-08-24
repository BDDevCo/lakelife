import { termsGateForRouteHandler } from "@/lib/terms-gate-route";
import { todayLakeDate } from "@/lib/booking";
import { getMyEarningsFor } from "../../earnings-data";
import { periodRanges, csvRow, statusLabel, earningsRowLabel } from "../../earnings-helpers";

export const dynamic = "force-dynamic";

/**
 * CSV export of the SIGNED-IN crew's take-home for a period (default YTD).
 * getMyEarningsFor asserts the caller owns a vendors row and scopes the read to
 * their own vendor_id — a non-vendor gets 401. Downloads as an attachment for
 * import into bookkeeping software.
 *
 * CLAUDE.md rule 1: only the crew's own take-home is emitted. No customer price
 * or margin is read or written.
 */
/**
 * A LAYOUT DOES NOT WRAP A ROUTE HANDLER.
 *
 * The terms gate lives in src/app/vendor/layout.tsx, and every page under it is covered. This
 * is not a page — Next.js layouts wrap pages, there is no middleware, and the
 * codebase already records the sibling fact that a route handler has no error
 * boundary either. So while the whole crew area was showing the agree card,
 * this URL kept returning the document, and it is a plain GET link the app
 * itself puts in the address bar: it is in history and in bookmarks.
 *
 * Identity was never the hole — getMyEarningsFor scopes to the caller's own vendor_id and 401s a stranger. What walked past was the AGREEMENT.
 */
export async function GET(req: Request) {
  const { from, to } = resolveRange(req);
  const statement = await getMyEarningsFor(from, to);
  if (!statement) {
    return new Response("Not authorized — crews only.", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const gate = await termsGateForRouteHandler("/vendor");
  if (gate) return gate;

  // A CREW COLUMN, because this file is what the company's bookkeeper opens
  // to split a lump payout. LakeLife pushes to ONE bank account, so without a
  // name beside each tip the office cannot tell who to hand it to.
  const lines: string[] = [csvRow(["Date", "Service", "Property", "Crew", "Amount", "Status"])];
  for (const r of statement.rows) {
    lines.push(
      csvRow([
        r.jobDate,
        earningsRowLabel(r),
        r.address ?? "",
        r.crew ?? "",
        r.amount.toFixed(2), // plain number for bookkeeping import (no $) — negative for adjustments
        statusLabel(r.status),
      ]),
    );
  }
  lines.push(csvRow(["", "", "", "Total", statement.periodTotal.toFixed(2), ""]));

  // Leading BOM so Excel opens UTF-8 addresses cleanly; CRLF per RFC 4180.
  const csv = "﻿" + lines.join("\r\n") + "\r\n";
  const filename = `lakelife-earnings-${statement.from}-${statement.to}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Read ?from&to; default to YTD. Ignores malformed values (falls back safely). */
function resolveRange(req: Request): { from: string; to: string } {
  const url = new URL(req.url);
  const today = todayLakeDate();
  const ytd = periodRanges(today).ytd;
  const qFrom = url.searchParams.get("from");
  const qTo = url.searchParams.get("to");
  return {
    from: qFrom && ISO.test(qFrom) ? qFrom : ytd.from,
    to: qTo && ISO.test(qTo) ? qTo : ytd.to,
  };
}
