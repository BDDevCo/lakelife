import { todayLakeDate } from "@/lib/booking";
import { getMyEarningsFor } from "../../earnings-data";
import { periodRanges, csvRow, statusLabel } from "../../earnings-helpers";

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
export async function GET(req: Request) {
  const { from, to } = resolveRange(req);
  const statement = await getMyEarningsFor(from, to);
  if (!statement) {
    return new Response("Not authorized — crews only.", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const lines: string[] = [csvRow(["Date", "Service", "Property", "Amount", "Status"])];
  for (const r of statement.rows) {
    lines.push(
      csvRow([
        r.jobDate,
        r.service ?? "Service",
        r.address ?? "",
        r.amount.toFixed(2), // plain number for bookkeeping import (no $)
        statusLabel(r.status),
      ]),
    );
  }
  lines.push(csvRow(["", "", "Total", statement.periodTotal.toFixed(2), ""]));

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
