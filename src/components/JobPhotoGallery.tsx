"use client";

import { useState } from "react";
import { slotLabel } from "@/lib/shot-list";

/**
 * The proof-of-work gallery — shared by all three job-detail views (customer,
 * crew, ops). Presentational only: it receives already-signed URLs from a
 * server loader that has already authorized the viewer. It never fetches, and
 * it never sees a storage path.
 *
 * Signed URLs are bearer tokens with a 1-hour life, which is why the pages
 * that render this are force-dynamic — a cached page would serve dead images.
 */

export interface GalleryPhoto {
  /** Stable identity for the React key — see JobPhoto.id. */
  id?: string;
  url: string;
  /**
   * `job_photos.taken_at` — which is the moment our SERVER wrote the row, not
   * the moment the shutter fired. This gallery captioned it "Taken 3:42 PM"
   * to all three roles, which is a claim about the world we cannot support:
   * a crew shoots at the dock and uploads from the truck an hour later. On a
   * page whose whole job is to settle "was that gouge there in October", the
   * one timestamp on screen must not overstate what it knows. It says
   * "Uploaded" now, because that is the only thing it is.
   */
  takenAt: string | null;
  /** Which named shot this is (0146). Null for an extra, and for pre-0146 rows. */
  slot?: string | null;
  /**
   * The file's own modified time as the uploading device reported it. NOT
   * EXIF and never described as capture time. Its worth is that it can
   * DISAGREE with the upload — which is exactly the fact an argument turns on,
   * so it is shown to the customer too and not kept for ops.
   */
  deviceTime?: string | null;
}

function prettyTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function JobPhotoGallery({
  photos,
  emptyNote = "No photos yet — they land here the moment the crew finishes.",
  caption,
}: {
  photos: GalleryPhoto[];
  emptyNote?: string;
  caption?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);

  if (photos.length === 0) {
    return <p className="mut" style={{ fontSize: 13.5, margin: 0 }}>{emptyNote}</p>;
  }

  return (
    <div>
      {caption && (
        <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px" }}>{caption}</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 8 }}>
        {photos.map((p, i) => (
          <button
            key={p.id || `${p.url}-${i}`}
            type="button"
            onClick={() => setOpen(i)}
            title={[p.slot ? slotLabel(p.slot) : null, p.takenAt ? `uploaded ${prettyTime(p.takenAt)}` : null]
              .filter(Boolean).join(" — ") || "Open photo"}
            style={{
              padding: 0, border: "1.5px solid #d7e0e3", borderRadius: 12, overflow: "hidden",
              background: "#eef3f4", cursor: "zoom-in", aspectRatio: "4 / 3", display: "block",
              position: "relative",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.url}
              alt={p.slot ? `Job photo — ${slotLabel(p.slot)}` : "Job photo"}
              loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            {/* THE LABEL IS THE POINT. Seven pictures of a hull answer nothing;
                seven pictures where one says "Engine" answer a question. */}
            {p.slot && (
              <span
                style={{
                  position: "absolute", left: 0, right: 0, bottom: 0,
                  background: "linear-gradient(to top, rgba(10,36,48,.86), rgba(10,36,48,0))",
                  color: "#fff", fontSize: 10.5, fontWeight: 700, letterSpacing: ".02em",
                  padding: "10px 6px 4px", textAlign: "left",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
              >
                {slotLabel(p.slot)}
              </span>
            )}
          </button>
        ))}
      </div>

      {open != null && photos[open] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Job photo"
          onClick={() => setOpen(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(10,36,48,.86)", zIndex: 60,
            display: "grid", placeItems: "center", padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, width: "100%" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photos[open].url}
              alt="Job photo, full size"
              style={{ width: "100%", maxHeight: "78vh", objectFit: "contain", borderRadius: 12, display: "block" }}
            />
            {/* WRAPS RATHER THAN SQUEEZES. Prev/Next/Close need ~255px, so on a
                375px phone the caption was crushed into an 80px column and
                wrapped over five lines across the photo — and the caption is
                the part that says WHICH shot this is. `flex: 1 1 200px` puts
                it on its own line when there is no room and back alongside
                the buttons when there is. */}
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 10 }}>
              <span style={{ color: "#fff", fontSize: 13, flex: "1 1 200px", minWidth: 0 }}>
                {photos[open].slot ? <b>{slotLabel(photos[open].slot!)}</b> : null}
                {photos[open].slot && photos[open].takenAt ? " · " : ""}
                {photos[open].takenAt ? `Uploaded ${prettyTime(photos[open].takenAt)}` : ""}
                {photos.length > 1 ? ` · ${open + 1} of ${photos.length}` : ""}
                {/* Shown, not hidden for ops: the customer is the one being
                    asked to accept the condition of their own boat. A file
                    date days before the upload is ordinary; years before it
                    is a question, and they are entitled to ask it. */}
                {photos[open].deviceTime && (
                  <span style={{ display: "block", opacity: 0.72, fontSize: 11.5, marginTop: 2 }}>
                    File date on the device: {prettyTime(photos[open].deviceTime)}
                  </span>
                )}
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                {photos.length > 1 && (
                  <>
                    <button
                      type="button"
                      className="ll-btn ghost"
                      onClick={() => setOpen((open - 1 + photos.length) % photos.length)}
                      style={{ minHeight: 40, background: "#fff" }}
                    >
                      ‹ Prev
                    </button>
                    <button
                      type="button"
                      className="ll-btn ghost"
                      onClick={() => setOpen((open + 1) % photos.length)}
                      style={{ minHeight: 40, background: "#fff" }}
                    >
                      Next ›
                    </button>
                  </>
                )}
                <button type="button" className="ll-btn" onClick={() => setOpen(null)} style={{ minHeight: 40 }}>
                  Close
                </button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
