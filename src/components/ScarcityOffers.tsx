"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptScarcityOffer } from "@/app/requests/offer-actions";
import { toast } from "@/components/Toast";
import { formatPrice } from "@/lib/pricing";
import type { ScarcityOfferView } from "@/app/requests/offer-data";

/**
 * Customer-facing scarcity offers (Phase C, ladder rung 3): a stuck request
 * can be unstuck by a small price boost. The customer sees ONLY the uplift
 * and the new all-in total — never any crew rate, margin, or percentage.
 */
export function ScarcityOffers({ offers }: { offers: ScarcityOfferView[] }) {
  return (
    <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
      {offers.map((o) => (
        <OfferCard key={o.jobId} offer={o} />
      ))}
    </div>
  );
}

function prettyDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function OfferCard({ offer }: { offer: ScarcityOfferView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function accept() {
    startTransition(async () => {
      const res = await acceptScarcityOffer(offer.jobId);
      if (res.ok) {
        toast("Locked in — a crew is on it. 🌊");
      } else {
        toast(res.error ?? "Couldn't lock that in just now.");
      }
      router.refresh();
    });
  }

  return (
    <div className="ll-card ll-card-pad" style={{ borderColor: "var(--gold, #d9a441)" }}>
      <span className="ll-pill warn">Crews are tight</span>
      <div style={{ fontWeight: 800, fontSize: 16, margin: "10px 0 4px" }}>
        {offer.serviceName} — {prettyDate(offer.date)}
      </div>
      <p style={{ fontSize: 14, margin: "0 0 12px" }}>
        Crews are stretched thin that day. Add {formatPrice(offer.uplift)} — new total{" "}
        {formatPrice(offer.newPrice)} — and we&apos;ll lock a crew in now.
      </p>
      <button className="ll-btn gold" onClick={accept} disabled={pending} style={{ minHeight: 44 }}>
        {pending ? "Locking it in…" : `Add ${formatPrice(offer.uplift)} & lock it in`}
      </button>
      <p className="mut" style={{ fontSize: 13, margin: "10px 0 0" }}>
        No charge now — you&apos;re only billed when the job is done. Skip it and we&apos;ll keep working on finding a crew.
      </p>
    </div>
  );
}
