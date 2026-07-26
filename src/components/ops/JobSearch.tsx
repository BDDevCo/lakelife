"use client";

/**
 * OPS SEARCH box — the answer to "at scale I can't find one dock job by
 * clicking through months of calendar" (owner, 2026-07-26).
 *
 * Debounced (250ms) client input → searchJobsAction → up to 25 hits, each a
 * link into that job's full ops file. The needle is sanitized server-side
 * (sanitizeSearchTerm) before it reaches the database; nothing here needs to
 * escape anything. Stale responses are dropped by sequence number so a fast
 * typist never sees an older query's rows land on top of a newer one's.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { searchJobsAction } from "@/app/ops/job-detail-actions";
// TYPE-ONLY: search-data.ts is `server-only`, so nothing but its types may
// cross this boundary (the same rule OpsShell follows with ops/data.ts).
import type { JobSearchHit } from "@/app/ops/search-data";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const STATUS_TONE: Record<string, string> = {
  requested: "warn",
  scheduled: "teal",
  in_progress: "teal",
  complete: "ok",
  paid: "slate",
  cancelled: "slate",
};

const STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  scheduled: "Scheduled",
  in_progress: "In progress",
  complete: "Complete",
  paid: "Paid",
  cancelled: "Cancelled",
};

function prettyDate(d: string | null): string {
  if (!d) return "no date";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function JobSearch() {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<JobSearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Clearing/arming happens in the EVENT handler, not the effect — the effect
  // may only own the debounce timer and the async result, or React (and the
  // lint rule) rightly complains about cascading renders.
  function onType(next: string) {
    setTerm(next);
    if (next.trim().length < 2) {
      seq.current += 1; // invalidate anything already in flight
      setRows([]);
      setTruncated(false);
      setSearched(false);
      setBusy(false);
      setError(null);
    } else {
      setBusy(true);
    }
  }

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < 2) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await searchJobsAction(trimmed);
        if (mine !== seq.current) return; // a newer keystroke won
        setRows(res.rows);
        setTruncated(res.truncated);
        setError(res.ok ? null : (res.error ?? "Search failed."));
      } catch {
        if (mine !== seq.current) return;
        setError("Search failed — try again.");
      } finally {
        if (mine === seq.current) {
          setBusy(false);
          setSearched(true);
        }
      }
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="ll-pill teal">Find a job</span>
        {busy && <span className="mut" style={{ fontSize: 12 }}>Searching…</span>}
      </div>
      <input
        value={term}
        onChange={(e) => onType(e.target.value)}
        placeholder="Customer, address, nickname, service or crew…"
        aria-label="Search jobs"
        style={{
          width: "100%", marginTop: 10, padding: "11px 13px", border: "1.5px solid var(--line)",
          borderRadius: 10, fontSize: 16, fontFamily: "inherit", color: "var(--text)", background: "#fff",
        }}
      />
      <p className="mut" style={{ fontSize: 11.5, marginTop: 6 }}>
        Two characters or more. Searches every job on the book, not just this month.
      </p>

      {error && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{error}</p>}

      {!error && searched && rows.length === 0 && (
        <p className="mut" style={{ fontSize: 13, marginTop: 10 }}>
          Nothing matches that. Try a last name, a street, or the crew&apos;s company.
        </p>
      )}

      {rows.length > 0 && (
        <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
          {rows.map((r) => {
            const where = r.nickname || r.address || "Property on file";
            const meta = [prettyDate(r.date), r.lakeName, r.customerName, r.crewCompany ? `crew: ${r.crewCompany}` : "unassigned"]
              .filter(Boolean)
              .join(" · ");
            return (
              <Link
                key={r.id}
                href={`/ops/jobs/${r.id}`}
                style={{
                  display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                  padding: "9px 11px", borderRadius: 10, background: "var(--sand-light, #f7f4ec)",
                  textDecoration: "none", color: "inherit",
                }}
              >
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>
                    {r.serviceName ?? "Service"} · {where}
                  </div>
                  <div className="mut" style={{ fontSize: 12.5 }}>{meta}</div>
                </div>
                <span className={`ll-pill ${STATUS_TONE[r.status] ?? "slate"}`}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, minWidth: 60, textAlign: "right" }}>
                  {r.customerPrice == null ? "—" : money.format(r.customerPrice)}
                </span>
              </Link>
            );
          })}
          {truncated && (
            <p className="mut" style={{ fontSize: 12 }}>
              More jobs matched than fit here — these are the most recent. Narrow the search to see older ones.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
