"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendOpsMessage, draftReplyForThread } from "@/app/ops/messages-actions";
import { toast } from "@/components/Toast";
import type { OpsThread } from "@/app/ops/messages-data";

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function MessageBoard({ threads }: { threads: OpsThread[] }) {
  const [openId, setOpenId] = useState<string | null>(threads[0]?.propertyId ?? null);

  if (threads.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
        <p className="mut" style={{ fontSize: 14 }}>
          No homeowner messages yet. When an owner writes in, their thread shows up here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {threads.map((t) => (
        <Thread key={t.propertyId} thread={t} open={openId === t.propertyId} onToggle={() => setOpenId(openId === t.propertyId ? null : t.propertyId)} />
      ))}
    </div>
  );
}

function Thread({ thread, open, onToggle }: { thread: OpsThread; open: boolean; onToggle: () => void }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftMock, setDraftMock] = useState(false);
  const last = thread.messages[thread.messages.length - 1];

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    const res = await sendOpsMessage(thread.propertyId, text);
    setSending(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't send — try again.");
      return;
    }
    setBody("");
    setDraftMock(false);
    router.refresh();
  }

  // Drafting only fills the textarea below — ops still reviews/edits and
  // clicks the existing Send button. The AI never sends a message itself.
  async function draft() {
    if (drafting) return;
    setDrafting(true);
    const res = await draftReplyForThread(thread.propertyId);
    setDrafting(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't draft a reply — try again.");
      return;
    }
    setBody(res.text ?? "");
    setDraftMock(!!res.mock);
  }

  return (
    <div className="ll-card" style={{ overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer",
          padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {thread.ownerName ?? "Homeowner"}
            {thread.lake && <span className="mut" style={{ fontWeight: 500 }}> · {thread.lake}</span>}
          </div>
          <div className="mut" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {thread.address ?? "—"}
          </div>
          {!open && last && (
            <div className="mut" style={{ fontSize: 12.5, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {last.from === "ops" ? "You: " : ""}{last.body}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
          <span className={`ll-pill ${last?.from === "owner" ? "warn" : "slate"}`}>
            {last?.from === "owner" ? "Owner wrote" : "Replied"}
          </span>
          <span className="mut" style={{ fontSize: 11.5 }}>{whenLabel(thread.lastAt)}</span>
        </div>
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--line)", padding: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 360, overflowY: "auto" }}>
            {thread.messages.map((m) => {
              const ops = m.from === "ops";
              return (
                <div key={m.id} style={{ display: "flex", justifyContent: ops ? "flex-end" : "flex-start" }}>
                  <div style={{ maxWidth: "80%" }}>
                    <div
                      style={{
                        padding: "9px 12px", borderRadius: 12, fontSize: 14, lineHeight: 1.45,
                        whiteSpace: "pre-wrap", wordBreak: "break-word",
                        background: ops ? "#eef6f7" : "var(--sun-soft)",
                        border: `1px solid ${ops ? "var(--line)" : "#f0e3c6"}`,
                      }}
                    >
                      {m.body}
                    </div>
                    <div className="mut" style={{ fontSize: 11.5, marginTop: 3, textAlign: ops ? "right" : "left" }}>
                      {ops ? "LakeLife dispatch" : thread.ownerName ?? "Owner"} · {whenLabel(m.created_at)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 14 }}>
            <button
              className="ll-btn ghost sm"
              onClick={() => void draft()}
              disabled={drafting || sending}
            >
              {drafting ? "Drafting…" : "✨ Draft reply"}
            </button>
            {draftMock && (
              <span className="ll-pill slate" style={{ fontSize: 11 }}>
                draft: offline template — add ANTHROPIC_API_KEY for Claude
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <input
              style={{
                flex: 1, padding: "11px 13px", border: "1.5px solid var(--line)",
                borderRadius: 10, fontFamily: "inherit", fontSize: 14,
              }}
              placeholder="Reply to this homeowner…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={sending}
              aria-label="Reply to homeowner"
            />
            <button className="ll-btn gold" onClick={() => void send()} disabled={sending || !body.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
