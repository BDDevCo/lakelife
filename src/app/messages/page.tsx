import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyThread } from "./data";
import { MessageComposer } from "./MessageComposer";

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function MessagesPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const thread = await getMyThread();

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 680 }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Messages</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
          Talk to LakeLife dispatch about {thread.address ?? "your place"}. Scheduling questions, gate notes,
          anything — we&apos;re on it. 🌊
        </p>

        {!thread.propertyId ? (
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
              Add a property first, then you can message dispatch about it.
            </p>
            <Link className="ll-btn gold" href="/profile">Set up my property →</Link>
          </div>
        ) : (
          <>
            <div className="ll-card ll-card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {thread.messages.length === 0 ? (
                <p className="mut" style={{ fontSize: 14, textAlign: "center", padding: "18px 0" }}>
                  No messages yet. Say hello — dispatch usually replies same day.
                </p>
              ) : (
                thread.messages.map((m) => {
                  const mine = m.from === "owner";
                  return (
                    <div
                      key={m.id}
                      style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}
                    >
                      <div style={{ maxWidth: "80%" }}>
                        <div
                          style={{
                            padding: "10px 13px",
                            borderRadius: 12,
                            fontSize: 14,
                            lineHeight: 1.45,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            background: mine ? "var(--sun-soft)" : "#eef6f7",
                            border: `1px solid ${mine ? "#f0e3c6" : "var(--line)"}`,
                          }}
                        >
                          {m.body}
                        </div>
                        <div
                          className="mut"
                          style={{ fontSize: 11.5, marginTop: 4, textAlign: mine ? "right" : "left" }}
                        >
                          {mine ? "You" : "LakeLife dispatch"} · {whenLabel(m.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <MessageComposer propertyId={thread.propertyId} />
          </>
        )}
      </div>
    </>
  );
}
