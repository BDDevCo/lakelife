"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { removeProperty, deleteAccount } from "@/app/profile/account-actions";
import { toast } from "@/components/Toast";

type Dialog = null | "property" | "account";

export function AccountControls({
  hasProperty,
  propertyLabel,
  propertyId,
}: {
  hasProperty: boolean;
  propertyLabel?: string;
  propertyId?: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  async function doRemoveProperty() {
    setBusy(true);
    const res = await removeProperty(propertyId);
    setBusy(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't remove your property.");
      return;
    }
    setDialog(null);
    toast("Your property and house data have been removed.");
    router.push("/profile");
    router.refresh();
  }

  async function doDeleteAccount() {
    setBusy(true);
    const res = await deleteAccount();
    if (!res.ok) {
      setBusy(false);
      toast(res.error ?? "Couldn't delete your account.");
      return;
    }
    // Session is now invalid — sign out locally and leave.
    try {
      await createClient().auth.signOut();
    } catch {}
    toast("Your account has been deleted. Take care 🌊");
    router.push("/");
    router.refresh();
  }

  return (
    <div className="ll-card ll-card-pad" style={{ borderColor: "#e7d0cb" }}>
      <h3 style={{ fontSize: 16, marginBottom: 4 }}>Account</h3>
      <p className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
        Manage your data. These actions can&apos;t be undone.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {hasProperty && (
          <button className="ll-btn ghost" onClick={() => setDialog("property")}>
            Remove this property
          </button>
        )}
        <button
          className="ll-btn ghost"
          style={{ color: "var(--danger)", borderColor: "#e7bcb4" }}
          onClick={() => { setConfirmText(""); setDialog("account"); }}
        >
          Delete my account
        </button>
      </div>

      {/* Remove property confirm */}
      {dialog === "property" && (
        <ConfirmOverlay onClose={() => setDialog(null)}>
          <span className="ll-pill warn">Remove property</span>
          <h3 style={{ fontSize: 20, margin: "10px 0 6px" }}>
            Remove {propertyLabel ?? "this property"}?
          </h3>
          <p className="mut" style={{ fontSize: 14, marginBottom: 8 }}>
            This deletes this property&apos;s profile, pier/lift/boat details, photos and any
            scheduled work. <b>Your login — and any other properties — stay</b>, so you can
            set it up again anytime.
          </p>
          <p className="mut" style={{ fontSize: 12.5, marginBottom: 18 }}>
            We keep just your name, email, phone and lake for seasonal reminders, until you opt out.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button className="ll-btn ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button className="ll-btn" style={{ background: "var(--warn)" }} onClick={doRemoveProperty} disabled={busy}>
              {busy ? "Removing…" : "Remove property"}
            </button>
          </div>
        </ConfirmOverlay>
      )}

      {/* Delete account confirm (type-to-confirm) */}
      {dialog === "account" && (
        <ConfirmOverlay onClose={() => setDialog(null)}>
          <span className="ll-pill red">Delete account</span>
          <h3 style={{ fontSize: 20, margin: "10px 0 6px" }}>Delete your account?</h3>
          <p className="mut" style={{ fontSize: 14, marginBottom: 8 }}>
            This permanently removes your login, your properties, and your service
            history. This can&apos;t be undone.
          </p>
          <p className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>
            The only thing we keep is your name, email, phone and lake — for seasonal
            reminders, until you opt out.
          </p>
          <div className="ll-field">
            <label>Type DELETE to confirm</label>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" />
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button className="ll-btn ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button
              className="ll-btn"
              style={{ background: "var(--danger)" }}
              onClick={doDeleteAccount}
              disabled={busy || confirmText.trim().toUpperCase() !== "DELETE"}
            >
              {busy ? "Deleting…" : "Delete account"}
            </button>
          </div>
        </ConfirmOverlay>
      )}
    </div>
  );
}

function ConfirmOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="ll-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="ll-modal" style={{ maxWidth: 440 }}>
        <div className="ll-modal-body">{children}</div>
      </div>
    </div>
  );
}
