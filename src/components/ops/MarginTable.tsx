import type { MarginRow } from "@/app/ops/data";

/**
 * Ops-only Revenue & margin view. Margin is intentionally shown here — Ops
 * sees vendor cost and the platform fee; customers and vendors never do
 * (rule 1). One row per service line, plus a highlighted total row.
 */

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const cellStyle: React.CSSProperties = {
  padding: "11px 14px",
  borderBottom: "1px solid var(--line)",
  fontSize: 14,
};

const numStyle: React.CSSProperties = {
  ...cellStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const headStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1.5px solid var(--line)",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: "0.03em",
  color: "var(--sub)",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

export function MarginTable({ rows, total }: { rows: MarginRow[]; total: MarginRow }) {
  return (
    <>
      <div className="ll-card">
        {rows.length === 0 ? (
          <div className="ll-card-pad">
            <p className="mut" style={{ fontSize: 14 }}>
              No priced jobs yet — assign and schedule jobs to see margin build here.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 620 }}>
              <thead>
                <tr>
                  <th style={{ ...headStyle, textAlign: "left" }}>Service line</th>
                  <th style={{ ...headStyle, textAlign: "right" }}>Jobs</th>
                  <th style={{ ...headStyle, textAlign: "right" }}>Customer price</th>
                  <th style={{ ...headStyle, textAlign: "right" }}>Vendor cost</th>
                  <th style={{ ...headStyle, textAlign: "right" }}>LakeLife margin</th>
                  <th style={{ ...headStyle, textAlign: "right" }}>Margin %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.service_name}>
                    <td style={{ ...cellStyle, fontWeight: 700 }}>{r.service_name}</td>
                    <td style={numStyle}>{r.jobs}</td>
                    <td style={numStyle}>{usd.format(r.customer_total)}</td>
                    <td style={numStyle}>{usd.format(r.vendor_total)}</td>
                    <td style={{ ...numStyle, color: "var(--teal-dark)", fontWeight: 800 }}>
                      {usd.format(r.margin_total)}
                    </td>
                    <td style={numStyle}>{r.margin_pct}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "var(--sun-soft)" }}>
                  <td style={{ ...cellStyle, fontWeight: 800, borderBottom: "none" }}>
                    {total.service_name}
                  </td>
                  <td style={{ ...numStyle, fontWeight: 800, borderBottom: "none" }}>{total.jobs}</td>
                  <td style={{ ...numStyle, fontWeight: 800, borderBottom: "none" }}>
                    {usd.format(total.customer_total)}
                  </td>
                  <td style={{ ...numStyle, fontWeight: 800, borderBottom: "none" }}>
                    {usd.format(total.vendor_total)}
                  </td>
                  <td style={{ ...numStyle, color: "var(--teal-dark)", fontWeight: 800, borderBottom: "none" }}>
                    {usd.format(total.margin_total)}
                  </td>
                  <td style={{ ...numStyle, fontWeight: 800, borderBottom: "none" }}>{total.margin_pct}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      {/* "THE 30% PLATFORM FEE" WAS NOT A NUMBER ANYBODY SET.
          It sat ten pixels above a total that read 33.9%, on a page whose
          header pill claimed 30% too, while the only enforced dial in
          production was `margin_floor` at 0.20 — a circuit breaker, not a
          target — and 0174 replaced the whole idea with two published
          percentages at 12% each. Three answers, one viewport, none of them
          from a column.

          The confidentiality half was always true and needed no percentage.
          The figure in the sentence now is the one this table just computed,
          named as what it is: what these jobs LEFT us, not a rate we charge.
          It is read from the Total row above it, so it cannot drift from the
          table it describes. Omitted entirely when there are no jobs — "0%" is
          a claim about an empty set. */}
      <p className="mut" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
        Customers only ever see the single all-in price. Crew cost and LakeLife&apos;s share live
        here and nowhere else.
        {rows.length > 0 && (
          <>
            {" "}
            Across the {total.jobs} {total.jobs === 1 ? "job" : "jobs"} above, {total.margin_pct}% was
            left to LakeLife — what this work actually earned, not a rate we charge.
          </>
        )}
      </p>
    </>
  );
}
