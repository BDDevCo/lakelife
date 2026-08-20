"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { approveFlag, declineFlag } from "@/app/approvals/actions";
import { toast } from "@/components/Toast";
import type { OwnerFlag } from "@/app/approvals/data";
import { declineMeans } from "@/lib/arrival";

/** Friendly, plain-English titles for each flag type. */
const TYPE_LABEL: Record<string, string> = {
  pier: "Pier section count differs from your profile",
  lift: "Extra boat/PWC lift on site",
  lawn: "Lawn is larger than your profile",
  toys: "Water toys not in your profile",
  other: "A note from the crew",
};

/** Human labels for the profile fields a crew might propose changing. */
const FIELD_LABEL: Record<string, string> = {
  pier_sections: "Pier sections",
  lift_count: "Lifts",
  lifts: "Lifts",
  lawn_band: "Lawn size",
  lawn_size: "Lawn size",
  toys: "Water toys",
  water_toys: "Water toys",
};

function labelForField(key: string) {
  return FIELD_LABEL[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** "Pier sections: 12 · Lifts: 2" from the proposed-change object. */
function summarizeChange(change: Record<string, unknown>) {
  return Object.entries(change)
    .map(([k, v]) => `${labelForField(k)}: ${formatValue(v)}`)
    .join(" · ");
}

/** A short, warm date — "Today", "Yesterday", "3 days ago", else "Jul 12". */
function formatWhen(iso: string) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const now = new Date();
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function ApprovalCard({ flag }: { flag: OwnerFlag }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "approve" | "decline">(null);

  // What "no" actually means for THIS flag — computed from what the crew said
  // when they raised it, not assumed.
  const declineNote = declineMeans(
    { crew_can_proceed: flag.crew_can_proceed, crew_cannot_reason: flag.crew_cannot_reason },
    // The booked count lives on the property profile, which this card does not
    // load — so the generic phrase, rather than a number we would be guessing.
    { serviceName: flag.service_name ?? "this visit" },
  );
  const standsDown = declineNote.outcome === "stands_down";

  const title = (flag.type && TYPE_LABEL[flag.type]) || "A note from the crew";
  const subline = [flag.service_name, flag.address, formatWhen(flag.created_at)]
    .filter(Boolean)
    .join(" · ");
  const pending = flag.status === "pending";

  async function decide(kind: "approve" | "decline") {
    setBusy(kind);
    const res = kind === "approve" ? await approveFlag(flag.id) : await declineFlag(flag.id);
    setBusy(null);
    if (!res.ok) {
      toast(res.error ?? "Something went wrong. Please try again.");
      return;
    }
    // WHAT THE YES ACTUALLY DID. The old line said "future visits are
    // re-priced" whether or not any existed — and said nothing about the visit
    // the crew was standing on, which is usually already finished and billed by
    // the time this gets approved. That one keeps its old numbers on both
    // sides, and the owner should hear it from us rather than work it out from
    // an invoice.
    if (kind === "decline") {
      toast(
        standsDown
          ? "Declined — the crew will pack up. Nothing charged; we'll be in touch about another day."
          : "Declined — the crew will do what you booked and we'll note the rest.",
      );
    } else {
      const n = res.repriced ?? 0;
      const parts = [
        n > 0
          ? `Approved — profile updated and ${n} upcoming ${n === 1 ? "visit" : "visits"} re-priced.`
          : "Approved — your profile is updated. Nothing upcoming to re-price yet.",
      ];
      if (res.flaggedJobAlreadyDone) {
        parts.push("That visit is already done, so its bill stays as it was.");
      }
      toast(parts.join(" "));
    }
    router.refresh();
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>{title}</h3>
          {subline && (
            <p className="mut" style={{ fontSize: 13, margin: "4px 0 0" }}>
              {subline}
            </p>
          )}
        </div>
        {!pending && (
          <span className={`ll-pill ${flag.status === "approved" ? "ok" : "slate"}`}>
            {flag.status === "approved" ? "Approved" : "Declined"}
          </span>
        )}
      </div>

      {flag.note && (
        <p style={{ fontSize: 15, lineHeight: 1.5, margin: "12px 0 0" }}>
          “{flag.note}”
        </p>
      )}

      {/* WHAT THE EMAIL SAID, ON THE SCREEN THAT DECIDES.
          The notification quotes the whole thing — "Pier sections 8 → 12, $796
          instead of $604, about an hour and a quarter longer". This card used
          to show "Proposed change: Pier sections: 12". Having read the money,
          they were approving on a page that had forgotten it.
          `correction` is null when we could not price it (or on a decided
          card, where the profile has already moved and the diff would lie), and
          the old count-only line stands in — never nothing. */}
      {flag.correction ? (
        <div style={{ margin: "12px 0 0", padding: "10px 12px", borderRadius: 10, background: "var(--sand)", border: "1px solid var(--line)" }}>
          {flag.correction.changes.map((c) => (
            <div key={c} style={{ fontSize: 14, fontWeight: 700 }}>{c}</div>
          ))}
          <div style={{ fontSize: 14, marginTop: 6 }}>
            {flag.correction.price ?? "The price doesn't change."}
          </div>
          {flag.correction.time && (
            <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
              {flag.correction.time}
            </div>
          )}
        </div>
      ) : (
        flag.proposed_change && Object.keys(flag.proposed_change).length > 0 && (
          <p style={{ fontSize: 14, margin: "10px 0 0" }}>
            <span className="mut">Proposed change: </span>
            <b>{summarizeChange(flag.proposed_change)}</b>
          </p>
        )
      )}

      {pending && (
        <>
          {/* SAYING NO HAS TWO VERY DIFFERENT OUTCOMES, AND ONLY THE CREW KNOWS
              WHICH. Someone tapping "no" while picturing a smaller pier, when
              what they'll actually get is a crew driving away, has not really
              been asked. So the consequence is stated before the button. */}
          {flag.at_arrival && (
            <div
              style={{
                marginTop: 12, padding: "10px 12px", borderRadius: 10,
                background: standsDown ? "var(--sun-soft)" : "var(--sand)",
                border: `1px solid ${standsDown ? "#ecd9ad" : "var(--line)"}`,
                color: standsDown ? "#7a5a1e" : "var(--text)",
                fontSize: 13, lineHeight: 1.55,
              }}
            >
              <b>The crew is at your place now.</b> {declineNote.detail}
            </div>
          )}

          <p className="mut" style={{ fontSize: 13, margin: "12px 0 0" }}>
            Approving updates your profile and re-prices future visits. Declining changes nothing.
            Nothing bills until you approve.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button
              className="ll-btn ghost"
              onClick={() => decide("decline")}
              disabled={busy !== null}
            >
              {busy === "decline" ? "Declining…" : (flag.at_arrival ? declineNote.label : "Decline")}
            </button>
            <button
              className="ll-btn gold"
              onClick={() => decide("approve")}
              disabled={busy !== null}
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
