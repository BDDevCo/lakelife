"use client";

/**
 * Autopilot — the per-service "set & forget" toggle (§8d). Enrolling locks
 * the customer's all-in price at TODAY's level; each season we text a
 * proposal they one-tap confirm or skip (skip is always free). Never a
 * bundle — every service is its own switch, and the only numbers shown here
 * are the customer's own all-in prices.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAutopilot } from "@/app/book/autopilot-actions";
import { formatPrice } from "@/lib/pricing";
import { toast } from "@/components/Toast";

export interface AutopilotService {
  id: string;
  name: string;
  price: number;
}

export interface AutopilotEnrollment {
  service_id: string;
  active: boolean;
  locked_price: number;
}

export function AutopilotCard({
  propertyId,
  services,
  enrollments,
}: {
  propertyId: string;
  services: AutopilotService[];
  enrollments: AutopilotEnrollment[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (services.length === 0) return null;

  const byService = new Map(enrollments.map((e) => [e.service_id, e]));

  function flip(svc: AutopilotService, on: boolean) {
    setBusyId(svc.id);
    startTransition(async () => {
      const res = await setAutopilot(propertyId, svc.id, on);
      if (!res.ok) {
        toast(res.error ?? "Couldn't update Autopilot — try again.");
      } else if (on) {
        toast(`Autopilot on — price locked at $${res.lockedPrice ?? svc.price}. We'll text you when it's time. 🌊`);
      } else {
        toast("Autopilot off — no more proposals for this one.");
      }
      setBusyId(null);
      router.refresh();
    });
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 18, margin: "0 0 6px" }}>Autopilot ⚡ — set &amp; forget</h3>
      <p className="mut" style={{ fontSize: 14, margin: "0 0 14px", maxWidth: 540 }}>
        We line up each season&rsquo;s visit and text you first — one tap books it, skip
        is free, and your price is locked in today.
      </p>

      <div style={{ display: "grid", gap: 10 }}>
        {services.map((s) => {
          const enr = byService.get(s.id);
          const enrolled = Boolean(enr?.active);
          const rowBusy = pending && busyId === s.id;
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</span>
              {enrolled ? (
                <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="ll-pill ok">
                    On · locked at {formatPrice(Number(enr?.locked_price) || s.price)}
                  </span>
                  <button
                    className="ll-btn ghost"
                    style={{ minHeight: 44 }}
                    disabled={rowBusy}
                    onClick={() => flip(s, false)}
                  >
                    {rowBusy ? "One sec…" : "Turn off"}
                  </button>
                </span>
              ) : (
                <button
                  className="ll-btn gold"
                  style={{ minHeight: 44 }}
                  disabled={rowBusy}
                  onClick={() => flip(s, true)}
                >
                  {rowBusy ? "Locking in…" : "Autopilot this"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
