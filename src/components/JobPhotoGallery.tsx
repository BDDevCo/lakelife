"use client";

import { useState } from "react";

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
  url: string;
  takenAt: string | null;
}

function prettyTime(iso: string | null): string {
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
            key={p.url}
            type="button"
            onClick={() => setOpen(i)}
            title={p.takenAt ? `Taken ${prettyTime(p.takenAt)}` : "Open photo"}
            style={{
              padding: 0, border: "1.5px solid #d7e0e3", borderRadius: 12, overflow: "hidden",
              background: "#eef3f4", cursor: "zoom-in", aspectRatio: "4 / 3", display: "block",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.url}
              alt={p.takenAt ? `Job photo taken ${prettyTime(p.takenAt)}` : "Job photo"}
              loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 10 }}>
              <span style={{ color: "#fff", fontSize: 13 }}>
                {photos[open].takenAt ? `Taken ${prettyTime(photos[open].takenAt)}` : ""}
                {photos.length > 1 ? ` · ${open + 1} of ${photos.length}` : ""}
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
