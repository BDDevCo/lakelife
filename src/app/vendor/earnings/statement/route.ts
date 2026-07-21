import { todayLakeDate } from "@/lib/booking";
import { getMyEarningsFor } from "../../earnings-data";
import {
  periodRanges,
  formatCurrency,
  formatDateHuman,
  statusLabel,
  type EarningRow,
} from "../../earnings-helpers";

export const dynamic = "force-dynamic";

/**
 * Print-optimized HTML earnings statement for the SIGNED-IN crew only.
 * getMyEarningsFor asserts the caller owns a vendors row and scopes the read to
 * their own vendor_id — a non-vendor gets 401. The crew opens this in a new tab
 * and uses the browser's Print → Save as PDF (zero dependencies).
 *
 * CLAUDE.md rule 1: every figure is the crew's own take-home. No customer price
 * or margin is read or rendered.
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

  const html = renderStatement(statement.company, statement.from, statement.to, statement.rows, statement.periodTotal, statement.generatedAt);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
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

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStatement(
  company: string | null,
  from: string,
  to: string,
  rows: EarningRow[],
  periodTotal: number,
  generatedAt: string,
): string {
  const crew = esc(company ?? "Your crew");
  const period = `${formatDateHuman(from)} – ${formatDateHuman(to)}`;
  const generated = formatDateHuman(generatedAt);

  const body =
    rows.length === 0
      ? `<tr><td colspan="4" class="empty">No completed jobs in this period.</td></tr>`
      : rows
          .map(
            (r) => `<tr>
      <td>${esc(r.jobDate)}</td>
      <td>${esc(r.service ?? "Service")}</td>
      <td>${esc(r.address ?? "—")}</td>
      <td class="num">${esc(formatCurrency(r.amount))}</td>
      <td class="status">${esc(statusLabel(r.status))}</td>
    </tr>`,
          )
          .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LakeLife — Crew Earnings Statement</title>
<style>
  :root { --ink:#0a2430; --teal:#137a8c; --teal-dark:#0e5e6d; --line:#dce9ec; --sub:#5d7681; --ok:#2e8b57; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; padding: 32px 28px 48px; }
  .letterhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 3px solid var(--teal); padding-bottom: 14px; margin-bottom: 20px; }
  .brand { font-size: 22px; font-weight: 800; color: var(--teal-dark); letter-spacing: -0.02em; }
  .brand em { font-style: normal; color: var(--ink); }
  .doc-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sub); margin-top: 2px; }
  .meta { text-align: right; font-size: 13px; color: var(--sub); line-height: 1.5; }
  .meta strong { color: var(--ink); }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .crew { font-size: 15px; font-weight: 700; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sub); border-bottom: 2px solid var(--line); padding: 8px 10px; }
  tbody td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.status { color: var(--sub); white-space: nowrap; }
  td.empty { text-align: center; color: var(--sub); padding: 22px; }
  tfoot td { padding: 12px 10px; font-weight: 800; border-top: 2px solid var(--ink); }
  tfoot td.num { font-size: 16px; color: var(--teal-dark); }
  .note { margin-top: 20px; font-size: 11.5px; color: var(--sub); line-height: 1.55; }
  .print-btn { margin: 18px 0 0; }
  .print-btn button { font: inherit; font-weight: 700; background: var(--teal); color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
  @media print {
    .print-btn { display: none; }
    .sheet { max-width: none; padding: 0; }
    body { font-size: 12px; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="letterhead">
      <div>
        <div class="brand">Lake<em>Life</em></div>
        <div class="doc-title">Crew Earnings Statement</div>
      </div>
      <div class="meta">
        <div>Period<br /><strong>${esc(period)}</strong></div>
        <div style="margin-top:6px">Generated<br /><strong>${esc(generated)}</strong></div>
      </div>
    </div>

    <h1>Earnings summary</h1>
    <div class="crew">${crew}</div>

    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Service</th>
          <th>Property</th>
          <th class="num">Take-home</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
${body}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3">Total for period</td>
          <td class="num">${esc(formatCurrency(periodTotal))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>

    <p class="note">
      Amounts are your crew&apos;s take-home pay. Payouts release every Friday once a job&apos;s photos
      are verified. This statement is provided for your records and your accountant — it is not a tax
      document. Questions? Contact LakeLife dispatch.
    </p>

    <div class="print-btn">
      <button type="button" onclick="window.print()">Print / Save as PDF</button>
    </div>
  </div>
</body>
</html>`;
}
