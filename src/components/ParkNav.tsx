"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  // Today comes first — it is the one he opens with coffee. /park stays the
  // default landing route until he has used both with real rows.
  { href: "/park/today", label: "Today" },
  { href: "/park", label: "Rent roll" },
  { href: "/park/onboard", label: "Who lives here" },
  { href: "/park/lots", label: "Lots & rates" },
  { href: "/park/rent", label: "Rent" },
  { href: "/park/costs", label: "Costs" },
  { href: "/park/statements", label: "Statements" },
  { href: "/park/setup", label: "Park setup" },
];

export function ParkNav({ parkName, live }: { parkName: string; live: boolean }) {
  const pathname = usePathname();
  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>{parkName}</strong>
        {/* A dark park is the normal state during setup, so this reads as a
            status, not an error. */}
        <span className={`ll-pill ${live ? "" : "slate"}`}>{live ? "Live" : "Not published"}</span>
      </div>
      <div
        style={{
          display: "flex", gap: 4, borderBottom: "2px solid var(--line)",
          flexWrap: "wrap", marginBottom: 6,
        }}
      >
        {TABS.map((t) => {
          const active = pathname === t.href || (t.href !== "/park" && pathname.startsWith(t.href));
          return (
            <Link
              key={t.href}
              href={t.href}
              style={{
                padding: "10px 14px", fontWeight: 700, fontSize: 14, whiteSpace: "nowrap",
                textDecoration: "none", color: active ? "var(--teal-dark)" : "var(--sub)",
                borderBottom: `2px solid ${active ? "var(--teal)" : "transparent"}`,
                marginBottom: -2,
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
