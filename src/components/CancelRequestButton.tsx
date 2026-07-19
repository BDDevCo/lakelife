"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cancelRequest } from "@/app/requests/actions";
import { toast } from "@/components/Toast";

export function CancelRequestButton({ jobId, serviceName }: { jobId: string; serviceName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (!window.confirm(`Cancel ${serviceName}? Nothing has been charged.`)) return;
    setBusy(true);
    const res = await cancelRequest(jobId);
    setBusy(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't cancel that.");
      return;
    }
    toast("Canceled — nothing will be charged.");
    router.refresh();
  }

  return (
    <button className="ll-btn ghost sm" onClick={cancel} disabled={busy}>
      {busy ? "Canceling…" : "Cancel"}
    </button>
  );
}
