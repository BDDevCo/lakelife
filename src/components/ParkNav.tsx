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
  // Crew validation: is that truck meant to be here? Sits next to the lots
  // because it is about the ground, not about the money.
  { href: "/park/visits", label: "Who's on site" },
  // Work the PARK buys for its own ground. Next to "Who's on site" because
  // that is where the visits it creates show up.
  { href: "/park/services", label: "Park services" },
  // THE IMPORTER USED TO BE A ONE-WAY DOOR. Its only link lived inside the
  // rent roll's zero-lots empty state, so the moment a single lot existed —
  // and generating lots is the first thing an owner is told to do — the paste
  // box became unreachable, and the fallback was the three hours of manual
  // typing it exists to prevent. It is not a first-run wizard; it is a tool.
  // NOT "Paste a roll" any more — the screen takes a file now, and that is
  // the door that matters: the roll arrives from the seller by email.
  { href: "/park/import", label: "Load the roll" },
  { href: "/park/rent", label: "Rent" },
  { href: "/park/costs", label: "Costs" },
  { href: "/park/statements", label: "Statements" },
  { href: "/park/documents", label: "Documents" },
  { href: "/park/amenities", label: "What you rent out" },
  { href: "/park/setup", label: "Park setup" },
];

/**
 * TAKES THE PARK, NOT ITS FIELDS.
 *
 * This used to take `parkName` and `live` — two props, spelled out at fourteen
 * call sites. Adding a fifteenth field would have meant editing all fourteen
 * and trusting the next screen to remember, which is the shape of guard this
 * codebase keeps having to repair. Passing the park means a new field is
 * available on every park screen the moment `getMyPark` returns it.
 */
export function ParkNav({ park }: {
  park: {
    name: string;
    active: boolean;
    noticesHeldAt?: string | null;
    noticesHeldReason?: string | null;
  };
}) {
  const pathname = usePathname();
  const parkName = park.name;
  const live = park.active;
  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 0 }}>
      {/* A HOLD NOBODY CAN SEE IS A PRODUCT THAT LOOKS BROKEN.
          Every send to a household is refused while this is up, including the
          ones he taps himself — so it says so on every park screen, and says
          where to lift it. Silence he did not ask for is indistinguishable
          from silence that is failing. */}
      {park.noticesHeldAt && (
        <div className="ll-card ll-card-pad" role="status"
          style={{ marginBottom: 10, background: "rgba(200,150,40,.10)" }}>
          <strong style={{ fontSize: 14 }}>
            Notices are on hold — nothing is reaching your households.
          </strong>
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.5 }}>
            {park.noticesHeldReason
              ? `${park.noticesHeldReason} `
              : "No email or text will go out to anyone on your roll — including anything you send by hand. "}
            Lift it in <Link href="/park/setup">Park setup</Link> when everyone is ready.
          </p>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>{parkName}</strong>
        {/* A dark park is the normal state during setup, so this reads as a
            status, not an error. */}
        <span className={`ll-pill ${live ? "" : "slate"}`}>{live ? "Live" : "Not published"}</span>
        {/* THE PARK OWNER IS ALSO A CUSTOMER — for the common areas, the
            grounds, and any home he owns on a lot. Nothing in the booking
            engine ever blocked him: /book has no park check at all. The only
            thing in his way was the portal redirect, which sends anyone with a
            park membership straight to /park before they can reach it. That
            redirect must STAY (its comment explains it stops a park owner who
            also mows getting silently flipped to a crew role), so the fix is
            simply a door out of the park screens. */}
        <Link
          href="/park/services"
          className="ll-btn ghost"
          style={{ fontSize: 12.5, padding: "4px 10px", marginLeft: "auto", textDecoration: "none" }}
        >
          Book services for the park
        </Link>
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
