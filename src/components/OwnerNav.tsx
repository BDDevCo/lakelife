"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * THE HOMEOWNER'S SIX, AS A COLUMN.
 *
 * Same six destinations, same order, same URLs as the tab strip they
 * replace — the October design review moves them beside the page on a
 * desktop and to a bar along the bottom on a phone, and that is all this
 * change is. The glyph is `aria-hidden` decoration; the word is always
 * there, because a row of icons with no words is a guess on a bar where
 * "Approvals" and "Billing" are different answers to the same question.
 */
const TABS = [
  { href: "/book", label: "Book services", mark: "☰" },
  { href: "/requests", label: "My requests", mark: "◷" },
  { href: "/approvals", label: "Approvals", mark: "✓" },
  { href: "/messages", label: "Messages", mark: "✉" },
  { href: "/billing", label: "Billing", mark: "$" },
  { href: "/profile", label: "Property profile", mark: "⌂" },
];

export function OwnerNav() {
  const pathname = usePathname();
  return (
    <nav className="ll-sidenav" aria-label="My LakeLife">
      {TABS.map((t) => {
        // `/profile` is exact because `/profile/setup` is the guided wizard,
        // a screen of its own rather than a tab of this one.
        const active = pathname === t.href || (t.href !== "/profile" && pathname.startsWith(t.href));
        return (
          <Link
            key={t.href}
            href={t.href}
            className={active ? "on" : undefined}
            aria-current={active ? "page" : undefined}
          >
            <span className="ll-sidenav-mark" aria-hidden="true">{t.mark}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
