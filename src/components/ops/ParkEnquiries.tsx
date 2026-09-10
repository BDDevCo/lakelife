"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { markEnquiryHandled } from "@/app/ops/enquiry-actions";
import type { ParkEnquiry } from "@/app/ops/parks-data";

/**
 * PARK OWNERS WHO HAVE ASKED ABOUT US.
 *
 * The reader half of /for-parks. 0164 refused to file these in
 * `marketing_contacts` precisely because that table has a writer and no reader
 * on any ops screen — a lead nobody opens is worse than no form at all,
 * because the person who filled it in believes they have been heard.
 *
 * Everything here is somebody's real name, email and phone, typed by a
 * stranger. It renders as text and never as a link that could carry it
 * somewhere else.
 */
const when = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    timeZone: "America/Indiana/Indianapolis",
  });

export function ParkEnquiries({ enquiries }: { enquiries: ParkEnquiry[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ fontSize: 17, margin: "0 0 2px" }}>Park owners who asked about us</h3>
          <p className="mut" style={{ fontSize: 13, margin: 0 }}>
            From the form on /for-parks. Answered ones drop off this list.
          </p>
        </div>
        {enquiries.length > 0 && (
          <span className="ll-pill gold">{enquiries.length} waiting</span>
        )}
      </div>

      {enquiries.length === 0 ? (
        /* "Nobody has asked" is a fact, not a failure — and it must not read
           as an error. The loader throws rather than returning [] on a dropped
           read, so this sentence is only ever true. */
        <p className="mut" style={{ fontSize: 13.5, padding: "10px 2px 2px" }}>
          Nobody has asked yet. The form is live at /for-parks.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {enquiries.map((e) => (
            <div key={e.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{e.name}</span>
                {e.parkName && <span className="mut" style={{ fontSize: 13.5 }}>— {e.parkName}</span>}
                <span className="mut" style={{ fontSize: 12.5, marginLeft: "auto" }}>{when(e.createdAt)}</span>
              </div>

              <div className="mut" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.6, wordBreak: "break-word" }}>
                {e.email}
                {e.phone ? ` · ${e.phone}` : ""}
                {e.town ? ` · ${e.town}` : ""}
                {/* THE NUMBER WORTH READING FIRST. A 4-lot park and a 400-lot
                    park are different businesses, and it is the one optional
                    field most worth having asked for. */}
                {e.lots != null ? ` · ${e.lots} ${e.lots === 1 ? "lot" : "lots"}` : ""}
              </div>

              {e.note && (
                <p style={{ fontSize: 13.5, margin: "8px 0 0", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                  {e.note}
                </p>
              )}

              <button
                className="ll-btn ghost"
                style={{ fontSize: 12.5, padding: "5px 10px", marginTop: 10 }}
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    const res = await markEnquiryHandled(e.id);
                    toast(res.ok ? "Cleared." : (res.error ?? "Couldn't do that."));
                    if (res.ok) router.refresh();
                  })
                }
              >
                {busy ? "Saving…" : "I've replied"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
