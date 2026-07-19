"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/book", label: "Book services" },
  { href: "/requests", label: "My requests" },
  { href: "/billing", label: "Billing" },
  { href: "/profile", label: "Property profile" },
];

export function OwnerNav() {
  const pathname = usePathname();
  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 0 }}>
      <div
        style={{
          display: "flex", gap: 4, borderBottom: "2px solid var(--line)",
          flexWrap: "wrap", marginBottom: 6,
        }}
      >
        {TABS.map((t) => {
          const active = pathname === t.href || (t.href !== "/profile" && pathname.startsWith(t.href));
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
