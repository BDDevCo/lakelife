"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendOwnerMessage } from "./actions";
import { toast } from "@/components/Toast";

/** The owner's send box. Fires the server action, then router.refresh() so the
 *  new bubble comes back from the server render — no websockets, no polling. */
export function MessageComposer({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    const res = await sendOwnerMessage(propertyId, text);
    setSending(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't send that — try again.");
      return;
    }
    setBody("");
    router.refresh();
  }

  return (
    <div className="ll-card ll-card-pad" style={{ display: "flex", gap: 10, marginTop: 14 }}>
      <input
        style={{
          flex: 1,
          padding: "11px 13px",
          border: "1.5px solid var(--line)",
          borderRadius: 10,
          fontFamily: "inherit",
          fontSize: 14,
        }}
        placeholder="Message LakeLife dispatch…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={sending}
        aria-label="Message LakeLife dispatch"
      />
      <button className="ll-btn gold" onClick={() => void send()} disabled={sending || !body.trim()}>
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
