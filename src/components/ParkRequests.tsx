"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  takeRequest, resolveRequest, mintStickers,
  type ParkRequestRow, type StickerRow,
} from "@/app/park/request-actions";

/**
 * WHAT THE PARK REPORTED — the queue behind the pedestal stickers.
 *
 * Before this, 10-25 of these a month arrived on the owner's personal mobile
 * and lived in his head. The blueprint calls it "the cleanest service-capture
 * path in the whole product… it arrives unprompted, from the tenant, at the
 * moment of need" — and it was the one item of the season-one cut with nothing
 * built at all.
 *
 * AGE IS THE ONLY URGENCY SIGNAL HERE, deliberately. The renter picked a
 * category, not a priority: asking somebody standing at a leaking riser to
 * rate its severity is asking the wrong person the wrong question, and every
 * report would come back "urgent". How long it has sat is a fact nobody has to
 * judge.
 */
export function ParkRequests({
  parkId,
  rows,
}: {
  parkId: string;
  rows: ParkRequestRow[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [stickers, setStickers] = useState<StickerRow[] | null>(null);

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Reported from the park</h3>
        <button
          className="ll-btn ghost sm"
          style={{ marginLeft: "auto", minHeight: 38 }}
          disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await mintStickers(parkId);
              toast(res.ok ? (res.signal ?? "Ready.") : (res.error ?? "Couldn't do that."));
              if (res.ok) setStickers(res.rows ?? []);
            })
          }
        >
          {busy ? "Working…" : "Print the stickers"}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="mut" style={{ fontSize: 13, margin: "8px 0 0", lineHeight: 1.55 }}>
          Nothing reported. The sticker on each lot pedestal opens a form with
          no login — put them up and things start arriving here instead of on
          your phone.
        </p>
      ) : (
        <div style={{ marginTop: 10 }}>
          {rows.map((r) => (
            <RequestLine key={r.id} row={r} parkId={parkId} busy={busy} start={start} router={router} />
          ))}
        </div>
      )}

      {stickers && <StickerSheet rows={stickers} />}
    </div>
  );
}

function RequestLine({
  row, parkId, busy, start, router,
}: {
  row: ParkRequestRow;
  parkId: string;
  busy: boolean;
  start: (fn: () => void) => void;
  router: { refresh: () => void };
}) {
  const [closing, setClosing] = useState(false);
  const [what, setWhat] = useState("");

  return (
    <div style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>
          {/* A null lot is a COMMON-AREA report — the road, the mailboxes.
              Saying "Lot —" would read as missing data. */}
          {row.lotNumber ? `Lot ${row.lotNumber}` : "Common area"}
        </strong>
        <span className="mut" style={{ fontSize: 12.5 }}>{row.category}</span>
        {row.status === "in_hand" && <span className="ll-pill slate">In hand</span>}
        <span className="mut" style={{ fontSize: 12.5, marginLeft: "auto" }}>
          {row.ageDays === 0 ? "today" : `${row.ageDays} ${row.ageDays === 1 ? "day" : "days"} ago`}
        </span>
      </div>

      <p style={{ fontSize: 13.5, margin: "4px 0 0", lineHeight: 1.5 }}>{row.note}</p>

      {(row.reporterName || row.reporterPhone) && (
        <p className="mut" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
          {row.reporterName ?? "Someone"}
          {row.reporterPhone ? ` · ${row.reporterPhone}` : " · no number left"}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        {row.status === "new" && (
          <button className="ll-btn ghost sm" disabled={busy}
            onClick={() => start(async () => {
              const res = await takeRequest(parkId, row.id);
              toast(res.ok ? (res.signal ?? "Yours.") : (res.error ?? "Couldn't do that."));
              if (res.ok) router.refresh();
            })}>
            I&apos;ve got it
          </button>
        )}
        <button className="ll-btn ghost sm" disabled={busy} onClick={() => setClosing((c) => !c)}>
          {closing ? "Cancel" : "Mark it done"}
        </button>
      </div>

      {closing && (
        <div className="ll-field" style={{ marginTop: 8 }}>
          {/* The note is required by the database too. In six months it is the
              only answer to a household asking why nothing changed. */}
          <label>What did you do?</label>
          <input value={what} onChange={(e) => setWhat(e.target.value)}
            placeholder="e.g. replaced the riser" autoFocus />
          <button className="ll-btn" style={{ marginTop: 8, minHeight: 40 }}
            disabled={busy || !what.trim()}
            onClick={() => start(async () => {
              const res = await resolveRequest(parkId, row.id, what);
              toast(res.ok ? (res.signal ?? "Closed.") : (res.error ?? "Couldn't close that."));
              if (res.ok) { setClosing(false); setWhat(""); router.refresh(); }
            })}>
            Close it
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The sticker sheet. Deliberately plain text URLs rather than rendered QR
 * images: generating QR codes needs a library and a decision about where the
 * image lives, and the owner can paste these into whatever label tool he
 * already uses. The URL is the thing that matters and it is stable forever.
 */
function StickerSheet({ rows }: { rows: StickerRow[] }) {
  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>
        One link per lot — {rows.length} of them
      </div>
      <p className="mut" style={{ fontSize: 12.5, margin: "0 0 10px", lineHeight: 1.5 }}>
        Turn each into a QR code and put it on that lot&apos;s pedestal. They
        never change, so a sticker you screw on today keeps working — which is
        also why nothing here can rotate one by accident.
      </p>
      <div style={{
        fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.7,
        background: "var(--sand, #f6f3ec)", borderRadius: 8, padding: "10px 12px",
        maxHeight: 260, overflowY: "auto",
      }}>
        {rows.map((s) => (
          <div key={s.lotId}>Lot {s.lotNumber} — {s.url}</div>
        ))}
      </div>
    </div>
  );
}
