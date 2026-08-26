"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  fileDocument, recordDeliveries, documentUrl, type DocumentsPage,
} from "@/app/park/document-actions";
import {
  DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, DELIVERY_STATE_LABEL,
  deliveryState, type DeliveryChannel, type DocumentKind,
} from "@/app/park/document-helpers";

/**
 * THE PARK'S OWN PAPERWORK, AND WHO WAS GIVEN IT.
 *
 * COURIER, NOT WITNESS — and this screen is where that decision is either kept
 * or quietly lost. There is no "signed" column, no tick to mark somebody as
 * having agreed, and no place to put one. What a park owner can do here is file
 * his document and record that a household was given it.
 *
 * The vocabulary is SENT and OPENED. Not agreed, not accepted, not signed.
 * `saysOnlyCourier` in the helpers is asserted against every sentence this
 * screen renders, so the rule outlives whoever rewords a card next.
 */

const CHANNELS: { value: DeliveryChannel; label: string; hint: string }[] = [
  { value: "hand", label: "Handed over", hint: "At the office. You saw them take it." },
  { value: "email", label: "Emailed", hint: "Sends a link. Opening it is recorded." },
  { value: "post", label: "Posted", hint: "In the mail. Delivery only." },
];

const bytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function ParkDocuments({ parkId, page }: { parkId: string; page: DocumentsPage }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DocumentKind>("park_lease");
  const [title, setTitle] = useState("");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);

  /** Which document is being delivered, and to whom. */
  const [deliverFor, setDeliverFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [channel, setChannel] = useState<DeliveryChannel>("hand");

  function save() {
    if (!file) return;
    start(async () => {
      const form = new FormData();
      form.set("kind", kind);
      form.set("title", title);
      form.set("version", version);
      form.set("file", file);
      const res = await fileDocument(parkId, form);
      toast(res.ok ? (res.signal ?? "Filed.") : (res.error ?? "Couldn't file that."));
      if (res.ok) {
        setOpen(false); setTitle(""); setVersion(""); setFile(null);
        router.refresh();
      }
    });
  }

  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Documents</h2>
      <p className="mut" style={{ margin: "0 0 6px", lineHeight: 1.5, maxWidth: 640 }}>
        Your lease, your rules, your notices. File the document here and record
        who you gave it to.
      </p>
      {/* THE SENTENCE THAT SETS EVERYONE'S EXPECTATIONS, and it is the whole
          legal posture. Said once, plainly, at the top — not buried in a
          tooltip somebody finds after they have looked for the signature
          feature and concluded it is missing. */}
      <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5, maxWidth: 640, fontSize: 13 }}>
        LakeLife doesn&apos;t hold signatures. Your lease is between you and the
        household — we keep the file and a record of delivery, so you can show
        what was sent and when it was opened. Anything they put their name to,
        they put it to with you.
      </p>

      {page.documents.length === 0 ? (
        <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
          <strong style={{ fontSize: 15 }}>Nothing filed yet.</strong>
          <p className="mut" style={{ fontSize: 13.5, margin: "6px 0 0", lineHeight: 1.5 }}>
            {page.households === 0
              ? "Nobody is on a lot yet either, so there is nobody to give one to."
              : `${page.households} ${page.households === 1 ? "household is" : "households are"} on the roll and waiting.`}
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, marginBottom: 14 }}>
          {page.documents.map((d) => {
            const showing = deliverFor === d.id;
            return (
              <div key={d.id} className="ll-card ll-card-pad"
                style={{ opacity: d.supersededAt ? 0.6 : 1 }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                  <strong style={{ fontSize: 15 }}>{d.title}</strong>
                  <span className="ll-pill slate">{DOCUMENT_KIND_LABEL[d.kind]}</span>
                  <span className="mut" style={{ fontSize: 13 }}>{d.version}</span>
                  {d.supersededAt && (
                    /* NOT DELETED. This is what somebody was actually given, so
                       it stays readable for ever — it simply is not current. */
                    <span className="ll-pill">Replaced by a newer version</span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 12 }} className="mut">
                    {bytes(d.byteSize)}
                  </span>
                </div>

                <p style={{ fontSize: 13.5, margin: "8px 0 0", lineHeight: 1.5 }}>{d.summary}</p>

                {/* The digest, quietly. It is what answers "is this the file we
                    sent" a year from now, and it costs one line to show. */}
                <p className="mut" style={{ fontSize: 11.5, margin: "6px 0 0", fontFamily: "ui-monospace, monospace" }}>
                  {d.sha256.slice(0, 16)}…
                </p>

                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  <button className="ll-btn ghost" disabled={busy}
                    onClick={() => start(async () => {
                      const res = await documentUrl(parkId, d.id);
                      if (res.ok && res.url) window.open(res.url, "_blank", "noopener");
                      else toast(res.error ?? "Couldn't open that.");
                    })}>
                    Open
                  </button>
                  {!d.supersededAt && page.households > 0 && (
                    <button className="ll-btn ghost" disabled={busy}
                      onClick={() => { setDeliverFor(showing ? null : d.id); setPicked(new Set()); }}>
                      {showing ? "Cancel" : "Record who got it"}
                    </button>
                  )}
                </div>

                {showing && (
                  <div style={{ marginTop: 12, borderTop: "1px solid rgba(0,0,0,.08)", paddingTop: 10 }}>
                    <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
                      {d.deliveries.map((r) => {
                        const state = deliveryState(r);
                        const already = state !== "not_sent";
                        return (
                          <label key={r.parkRenterId}
                            style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
                            <input type="checkbox" disabled={already || busy}
                              checked={picked.has(r.parkRenterId)}
                              onChange={() => setPicked((prev) => {
                                const n = new Set(prev);
                                if (n.has(r.parkRenterId)) n.delete(r.parkRenterId);
                                else n.add(r.parkRenterId);
                                return n;
                              })} />
                            <span style={{ flex: 1 }}>{r.displayName}</span>
                            <span className="mut" style={{ fontSize: 12.5 }}>
                              {DELIVERY_STATE_LABEL[state]}
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <select value={channel} disabled={busy}
                        onChange={(e) => setChannel(e.target.value as DeliveryChannel)}>
                        {CHANNELS.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                      <button className="ll-btn" disabled={busy || picked.size === 0}
                        onClick={() => start(async () => {
                          const res = await recordDeliveries(parkId, d.id, [...picked], channel);
                          toast(res.ok ? (res.signal ?? "Logged.") : (res.error ?? "Couldn't log that."));
                          for (const f of res.failed ?? []) toast(`${f.name}: ${f.why}`);
                          if (res.ok) { setDeliverFor(null); setPicked(new Set()); router.refresh(); }
                        })}>
                        {busy ? "Recording…" : `Record ${picked.size}`}
                      </button>
                    </div>
                    <p className="mut" style={{ fontSize: 12, margin: "8px 0 0", lineHeight: 1.5 }}>
                      {CHANNELS.find((c) => c.value === channel)?.hint}
                      {channel !== "email" &&
                        " We can't know whether it was read, so the log stops at delivery."}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!open ? (
        <button className="ll-btn ghost" onClick={() => setOpen(true)}>File a document</button>
      ) : (
        <div className="ll-card ll-card-pad">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What is it</span>
              <select value={kind} style={{ marginTop: 4 }}
                onChange={(e) => setKind(e.target.value as DocumentKind)}>
                {DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>{DOCUMENT_KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What residents see it called</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="2027 lot lease" style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Version — whatever you call this one</span>
              <input value={version} onChange={(e) => setVersion(e.target.value)}
                placeholder="2027" style={{ marginTop: 4 }} />
            </label>
          </div>

          <div style={{ marginTop: 12 }}>
            <input type="file" accept=".pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button className="ll-btn" onClick={save}
              disabled={busy || !file || title.trim().length < 2 || version.trim().length < 1}>
              {busy ? "Filing…" : "File it"}
            </button>
            <button className="ll-btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          <p className="mut" style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.5 }}>
            Filing a newer version of the same kind replaces it going forward.
            The old one stays here — it is what people were actually given.
          </p>
        </div>
      )}
    </section>
  );
}
