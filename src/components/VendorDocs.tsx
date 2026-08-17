"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { uploadVendorDoc, getVendorDocUrl } from "@/app/vendor/onboarding-actions";

/**
 * KEEPING YOUR PAPERWORK CURRENT, ONCE YOU'RE ALREADY WORKING.
 *
 * The upload controls lived only inside the onboarding checklist, which
 * renders only while `status !== 'active'`. So the moment a crew was approved,
 * every way to replace a document disappeared — and a COI expires every year.
 *
 * What that did to a real crew: the nightly emails "Update my COI → /vendor";
 * they open /vendor and find their route, with no upload anywhere. On the
 * expiry date dispatch stops routing them, the claim board greys out every
 * card, and no route text arrives. Their status still reads `active`, so the
 * checklist never comes back. Nothing they could do from any screen would fix
 * it — it took someone editing the database.
 *
 * This is the same `uploadVendorDoc` action, on the page they were already
 * told to go to. It is quiet when everything is in date and loud when it is
 * not, because a crew should not have to go looking to find out they are about
 * to stop getting work.
 */

const SOON_DAYS = 45;

function daysUntil(iso: string, todayISO: string): number {
  const [ay, am, ad] = todayISO.split("-").map(Number);
  const [by, bm, bd] = iso.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function pretty(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export function VendorDocs({
  coiUrl, coiExpiry, w9Url, today,
}: {
  coiUrl: string | null;
  coiExpiry: string | null;
  w9Url: string | null;
  today: string;
}) {
  const [open, setOpen] = useState(false);

  const days = coiExpiry ? daysUntil(coiExpiry, today) : null;
  const expired = days != null && days < 0;
  const soon = days != null && days >= 0 && days <= SOON_DAYS;
  const missing = !coiUrl;
  const urgent = expired || missing;

  // Nothing to say: insurance on file, in date, not close to running out.
  const quiet = !urgent && !soon && !!w9Url;
  if (quiet && !open) {
    return (
      <div style={{ marginTop: 20 }}>
        <button className="ll-btn ghost" style={{ fontSize: 13 }} onClick={() => setOpen(true)}>
          My paperwork
        </button>
      </div>
    );
  }

  const headline = missing
    ? "We don't have your insurance on file"
    : expired
      ? "Your insurance certificate has expired"
      : soon
        ? `Your insurance expires ${pretty(coiExpiry!)}`
        : "My paperwork";

  const explain = missing || expired
    ? "Until it's on file and in date we can't send you jobs — you'll stop " +
      "appearing on the claim board and won't get a route. Upload it here and " +
      "it takes effect straight away."
    : soon
      ? "Send the new one over whenever you have it. If it lapses, jobs stop " +
        "coming until it's back in date."
      : "Replace either of these whenever they change.";

  return (
    <div
      className="ll-card ll-card-pad"
      style={{ marginTop: 20, background: urgent ? "rgba(200,60,40,.07)" : undefined }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 16 }}>{urgent ? "⚠️ " : ""}{headline}</strong>
        {quiet && (
          <button className="ll-btn ghost" style={{ fontSize: 13 }} onClick={() => setOpen(false)}>
            Hide
          </button>
        )}
      </div>
      <p className="mut" style={{ fontSize: 13.5, margin: "6px 0 14px", lineHeight: 1.5 }}>
        {explain}
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        <DocUpload
          kind="coi"
          title="Certificate of insurance"
          onFile={coiUrl != null}
          note={coiExpiry ? `On file, good until ${pretty(coiExpiry)}.` : undefined}
        />
        <DocUpload
          kind="w9"
          title="W-9"
          onFile={w9Url != null}
          note={w9Url ? "On file." : "We need this before we can pay you."}
        />
      </div>
    </div>
  );
}

function DocUpload({
  kind, title, onFile, note,
}: {
  kind: "coi" | "w9";
  title: string;
  onFile: boolean;
  note?: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [expiry, setExpiry] = useState("");
  const [busy, start] = useTransition();

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        {onFile && <span className="ll-pill ok">On file</span>}
        {/* `getVendorDocUrl` was written and never called from anywhere, so a
            crew could be told a document was on file with no way to check
            WHICH one — which matters when you're replacing an expiring policy
            and can't remember if you already sent the new one. */}
        {onFile && (
          <button
            className="ll-btn ghost"
            style={{ fontSize: 12, padding: "3px 8px" }}
            onClick={async () => {
              const url = await getVendorDocUrl(kind);
              if (url) window.open(url, "_blank", "noopener");
              else toast("Couldn't open that one — try uploading it again.");
            }}
          >
            See what&apos;s on file
          </button>
        )}
      </div>
      {note && <p className="mut" style={{ fontSize: 12.5, margin: "4px 0 8px" }}>{note}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
      />
      {kind === "coi" && (
        <label className="ll-field" style={{ display: "block", marginTop: 8 }}>
          <span className="mut" style={{ fontSize: 12.5 }}>Expiry date on the certificate</span>
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
      )}

      <button
        className="ll-btn"
        style={{ marginTop: 8 }}
        disabled={busy}
        onClick={() =>
          start(async () => {
            const file = fileRef.current?.files?.[0];
            if (!file) { toast("Pick a file first."); return; }
            if (kind === "coi" && !expiry) { toast("Add the expiry date off the certificate."); return; }
            const form = new FormData();
            form.set("file", file);
            if (kind === "coi") form.set("expiry", expiry);
            const res = await uploadVendorDoc(kind, form);
            if (!res.ok) { toast(res.error ?? "Couldn't upload that."); return; }
            toast(`${title} saved.`);
            if (fileRef.current) fileRef.current.value = "";
            setExpiry("");
            router.refresh();
          })
        }
      >
        {busy ? "Uploading…" : onFile ? "Replace it" : "Upload it"}
      </button>
    </div>
  );
}
