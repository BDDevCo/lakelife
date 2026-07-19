"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { approveFlag, declineFlag } from "@/app/approvals/actions";
import { toast } from "@/components/Toast";
import type { OwnerFlag } from "@/app/approvals/data";

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
    toast(
      kind === "approve"
        ? "Approved — your profile is updated and future visits are re-priced."
        : "Declined — nothing changed."
    );
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

      {flag.proposed_change && Object.keys(flag.proposed_change).length > 0 && (
        <p style={{ fontSize: 14, margin: "10px 0 0" }}>
          <span className="mut">Proposed change: </span>
          <b>{summarizeChange(flag.proposed_change)}</b>
        </p>
      )}

      {pending && (
        <>
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
              {busy === "decline" ? "Declining…" : "Decline"}
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
