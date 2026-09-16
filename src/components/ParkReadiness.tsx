import Link from "next/link";
import type { ReadinessRow } from "@/app/park/readiness";

/**
 * THE READINESS LIST — one component, two homes.
 *
 * Today shows it while the park is unpublished or a required row is undone
 * (and instead of the money card before go-live); Park setup shows it always,
 * under its title. Same rows from the same builder, so the two screens cannot
 * disagree about what is left.
 *
 * No "use client": it renders Links and plain data, so it works inside the
 * client ParkToday and the server setup page alike. No h1 — page titles are
 * the page's; in-card headings are 16 at most, and this one is the block it
 * replaces (the pre-cutover checklist's 19px lead).
 *
 * The glyphs: ✓ done, ☐ required and not done, – optional and not done. An
 * optional row is a dial whose own form says blank is fine, so it must never
 * read as a box he has failed to tick.
 */
export function ParkReadiness({ headline, sub, rows }: {
  headline: string;
  sub: string;
  rows: ReadinessRow[];
}) {
  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 10 }}>
      <strong style={{ fontSize: 19 }}>{headline}</strong>
      <p className="mut" style={{ fontSize: 14, marginTop: 6, marginBottom: 12, lineHeight: 1.5 }}>
        {sub}
      </p>
      <div style={{ display: "grid", gap: 6 }}>
        {rows.map((row) => (
          <div key={row.key} style={{ display: "flex", gap: 10, fontSize: 14, alignItems: "baseline" }}>
            <span style={{ width: 18 }}>{row.done ? "✓" : row.optional ? "–" : "☐"}</span>
            <span style={{ flex: 1, lineHeight: 1.5 }}>
              <span className={row.done ? "mut" : undefined}>{row.label}</span>
              {row.next && (
                <>
                  {" — "}
                  {row.href ? <Link href={row.href}>{row.next}</Link> : row.next}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
