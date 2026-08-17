"use client";

import { useEffect, useState, useTransition } from "react";
import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { issueClaimSlip, declineClaim } from "@/app/parks/claim-actions";
import { releaseClaim } from "@/app/parks/claim-actions";
import { inviteHousehold } from "@/app/parks/invite-actions";

/**
 * THE OFFICE END: printing one slip for one household.
 *
 * THE CODE IS ON SCREEN EXACTLY ONCE. The database stores a bcrypt hash, so
 * nothing here — and nothing we could write later — can show it again. That is
 * the point, and it is also the thing most likely to catch somebody out, so
 * the panel says so in the plainest words available and gives him a print
 * button rather than expecting him to copy it down.
 *
 * NEVER TEXT OR EMAIL IT. There is deliberately no "send to resident" button.
 * A code arriving by the same channel as the scam it resembles is not a
 * credential, and the moment that button exists somebody will use it for the
 * household who is hardest to catch in person — which is exactly the household
 * least able to tell the difference.
 */
export function ClaimSlip({
  renterId,
  displayName,
  lotNumber,
  parkName,
  parkSlug,
  status,
  email,
  invitedAt,
}: {
  renterId: string;
  displayName: string;
  lotNumber: string;
  parkName: string;
  parkSlug: string;
  status: string;
  /** The address on file, if any. Its absence is why paper exists. */
  email: string | null;
  invitedAt: string | null;
}) {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  /**
   * The square, STAMPED WITH THE CODE IT DRAWS.
   *
   * Not a bare data URL: pairing it with its code means a square left over from
   * a previous mint can never be shown beside a new one. That window is small
   * and would be invisible in testing, and somebody would scan a slip that took
   * them to a code the office had already replaced.
   */
  const [qr, setQr] = useState<{ forCode: string; dataUrl: string } | null>(null);
  const [busy, start] = useTransition();
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);

  function issue() {
    start(async () => {
      const res = await issueClaimSlip(renterId);
      if (!res.ok) { toast(res.message); return; }
      setCode(res.code ?? null);
      router.refresh();
    });
  }

  function invite() {
    start(async () => {
      const res = await inviteHousehold(renterId);
      toast(res.message);
      if (res.ok) router.refresh();
    });
  }

  function release() {
    start(async () => {
      const res = await releaseClaim(renterId);
      toast(res.message);
      setConfirmRelease(false);
      if (res.ok) router.refresh();
    });
  }

  function decline() {
    start(async () => {
      const res = await declineClaim(renterId);
      toast(res.message);
      setConfirmDecline(false);
      if (res.ok) router.refresh();
    });
  }

  // THE SQUARE ON THE PAPER.
  //
  // It encodes the claim link WITH the code in it, which is not a weakening:
  // the slip is already the credential — anyone holding it can read the eight
  // characters and type them. The QR just spares an 82-year-old from typing
  // K7QM-3XR9 with a thumb, which is the single most likely place this whole
  // path loses somebody.
  //
  // Signing in is still required, so a photographed slip is worth exactly what
  // a photographed code was worth before.
  const claimHref = code
    ? `/parks/claim?park=${encodeURIComponent(parkSlug)}&c=${encodeURIComponent(code)}`
    : null;

  useEffect(() => {
    if (!code || !claimHref) return;
    let live = true;
    const abs = `${window.location.origin}${claimHref}`;
    QRCode.toDataURL(abs, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((dataUrl) => { if (live) setQr({ forCode: code, dataUrl }); })
      // A slip without a square is still a working slip — the code is printed
      // right above it. Never block the print on the picture.
      .catch(() => {});
    return () => { live = false; };
  }, [code, claimHref]);

  // THE SLIP ITSELF — shown once, then gone.
  if (code) {
    const url = `${typeof window !== "undefined" ? window.location.origin : ""}/parks/claim?park=${parkSlug}`;
    return (
      // `ll-slip` is what the print stylesheet keeps; everything else on the
      // rent roll is hidden. Without it, printing this hands a resident every
      // other household's name and balance.
      <div className="ll-card ll-card-pad ll-slip" style={{ borderColor: "var(--teal-dark)" }}>
        <p className="ll-pill teal ll-noprint" style={{ marginBottom: 10 }}>Print this now</p>
        <p className="ll-noprint" style={{ fontSize: 14, margin: "0 0 14px", lineHeight: 1.55 }}>
          This code is shown <strong>once</strong>. We keep only a scrambled
          copy, so nobody — including us — can look it up again. If it&apos;s
          lost, just print another.
        </p>

        <div style={{
          border: "2px dashed var(--line)", borderRadius: 12, padding: "18px 16px",
          textAlign: "center", background: "#fff", marginBottom: 14,
        }}>
          <div className="mut" style={{ fontSize: 13 }}>{parkName} · Lot {lotNumber}</div>
          <div style={{ fontSize: 15, fontWeight: 700, margin: "2px 0 10px" }}>{displayName}</div>
          <div style={{
            fontSize: 34, fontWeight: 800, letterSpacing: "0.14em",
            fontVariantNumeric: "tabular-nums", color: "var(--teal-dark)",
          }}>{code}</div>

          {qr?.forCode === code && (
            <div style={{ marginTop: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr.dataUrl}
                alt={`Scan to open lot ${lotNumber}`}
                width={148}
                height={148}
                style={{ display: "block", margin: "0 auto" }}
              />
              <div className="mut" style={{ fontSize: 12.5, marginTop: 6 }}>
                Point your phone camera at this square
              </div>
            </div>
          )}

          <div className="mut" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
            {/* An unbroken string — on paper it can run past the dashed box,
                on a phone past the card. */}
            Or go to <strong style={{ overflowWrap: "anywhere" }}>{url.replace(/^https?:\/\//, "")}</strong><br />
            and enter your lot number and this code.
          </div>
          <div className="mut" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
            LakeLife will never ring or text you asking for this code, and never
            asks for card or bank details to set up your lot.
          </div>
        </div>

        <div className="ll-noprint" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="ll-btn" onClick={() => window.print()}>Print</button>
          <button className="ll-btn ghost" onClick={() => setCode(null)}>Done</button>
        </div>
        <p className="mut ll-noprint" style={{ fontSize: 12.5, marginTop: 12 }}>
          Good for 30 days, and it stops working the moment they use it.
        </p>
      </div>
    );
  }

  // SET UP — AND UNDOABLE.
  //
  // The claim screen already tells a resident "if that wasn't you, tell the
  // office and they'll sort it". Until now the office had nothing to sort it
  // WITH: `releaseClaim` existed, wrapped a working database function, and had
  // no caller anywhere. A wrong account on a household file was permanent, and
  // the promise on the resident's screen was a promise about a button that did
  // not exist.
  //
  // Releasing now also spends every key (0134), so the account just detached
  // cannot walk back in through an old email link.
  if (status === "used") {
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="ll-pill ok">Set up</span>
        {!confirmRelease ? (
          <button
            className="mut"
            onClick={() => setConfirmRelease(true)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
          >
            Wrong person?
          </button>
        ) : (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span className="mut" style={{ fontSize: 13 }}>
              Detach that account? They lose access and any link they hold stops working.
            </span>
            <button className="ll-btn sm" disabled={busy} onClick={release} style={{ minHeight: 36 }}>
              {busy ? "Detaching…" : "Yes"}
            </button>
            <button className="ll-btn ghost sm" onClick={() => setConfirmRelease(false)} style={{ minHeight: 36 }}>
              No
            </button>
          </span>
        )}
      </span>
    );
  }

  if (status === "declined") {
    // NOT A LAPSED STATE. A household on paper who pays on time is not a
    // lesser household (0055), so this renders as a settled fact and the
    // screen does not offer a way to nag them.
    return <span className="ll-pill slate">On paper — their choice</span>;
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {/* EMAIL FIRST WHEN WE CAN. One tap for her, no printer for him. The
          slip stays right beside it, because a household with no address is
          not a lesser household — it is the ordinary case at a park that has
          been running on paper for thirty years. */}
      {email && !invitedAt && (
        <button className="ll-btn sm" disabled={busy} onClick={invite} style={{ minHeight: 40 }}>
          {busy ? "Emailing…" : "Email them"}
        </button>
      )}
      {invitedAt && <span className="ll-pill teal">Emailed</span>}

      {status === "open" && <span className="ll-pill">Slip out</span>}
      {status === "expired" && <span className="ll-pill slate">Slip expired</span>}
      {status === "locked" && <span className="ll-pill slate">Locked till tomorrow</span>}

      <button className="ll-btn ghost sm" disabled={busy} onClick={issue} style={{ minHeight: 40 }}>
        {busy ? "Preparing…" : status === "none" ? "Print a slip" : "Print a new slip"}
      </button>

      {!confirmDecline ? (
        <button
          className="mut"
          onClick={() => setConfirmDecline(true)}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
        >
          They said no
        </button>
      ) : (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="mut" style={{ fontSize: 13 }}>Stop asking them?</span>
          <button className="ll-btn sm" disabled={busy} onClick={decline} style={{ minHeight: 36 }}>Yes</button>
          <button className="ll-btn ghost sm" onClick={() => setConfirmDecline(false)} style={{ minHeight: 36 }}>No</button>
        </span>
      )}
    </div>
  );
}
