"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { acceptAddon, declineAddonPrice, withdrawAddon } from "@/app/addons/actions";
import { toast } from "@/components/Toast";
import { ownerStateSentence, standardScopeLine } from "@/lib/addons";
import { money } from "@/app/park/ledger-helpers";
import { longDate, shortDate } from "@/lib/lake-time";
import type { OwnerAddon } from "@/app/addons/data";

/**
 * ONE EXTRA, THE OWNER'S SIDE.
 *
 * It sits on the SAME screen as a crew's flag — /approvals — rather than on a
 * second approvals screen of its own: there is one place in this product where
 * a homeowner is asked to say yes or no to money, and adding a second one is
 * how people stop reading either.
 *
 * THE THREE STATES THAT ARE NOT THE SAME are `ownerStateSentence`'s job, and
 * every one of them ends by saying the booked visit is unaffected. None of
 * them is drawn as an error, because none of them is one.
 *
 * NOTHING IS PRE-TICKED. There is no default action, no highlighted "yes", and
 * the price is never shown as already added. A pre-ticked box once wrote
 * nineteen leases nobody signed.
 *
 * AND THE HONESTY ABOUT SCOPE IS HERE TOO, not only on the job file. This is
 * the screen with the button that bills, and "make sure it isn't something the
 * booked visit already includes" was printed on the OTHER screen — the one
 * without a Yes on it. An owner who approves from /approvals never saw it. The
 * sentence names the visit page, and this card draws a link to it, because
 * copy that instructs a control the screen lacks is the bug class this product
 * keeps paying for.
 */
export function AddonCard({ addon, showService = true }: { addon: OwnerAddon; showService?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "accept" | "decline" | "withdraw">(null);

  const price = addon.status === "accepted" || addon.status === "crew_left"
    ? addon.customerPrice
    : addon.offeredPrice;
  // A QUOTE THIS OLD IS NOT TAPPABLE. The reason takes the place of the
  // buttons rather than letting somebody tap into a refusal; `acceptAddon`
  // re-checks it at the write, so this is the second doorway and not the only
  // one.
  const tappable = addon.status === "quoted" && addon.offeredPrice != null && addon.staleReason == null;
  const scope = standardScopeLine({ serviceName: addon.serviceName ?? "visit", control: "visit" });
  const state = ownerStateSentence({
    status: addon.status,
    serviceName: addon.serviceName ?? "visit",
    price: price == null ? null : money(price),
    crewReason: addon.crewDeclinedReason,
  });

  const subline = [
    showService ? addon.serviceName : null,
    addon.jobDate ? shortDate(addon.jobDate) : null,
    addon.crewName,
  ].filter(Boolean).join(" · ");

  async function act(kind: "accept" | "decline" | "withdraw") {
    setBusy(kind);
    const res =
      kind === "accept" ? await acceptAddon(addon.id, addon.offeredPrice)
      : kind === "decline" ? await declineAddonPrice(addon.id)
      : await withdrawAddon(addon.id);
    setBusy(null);
    if (!res.ok) {
      toast.err(res.error ?? "Something went wrong. Please try again.");
      return;
    }
    const svc = addon.serviceName ?? "visit";
    if (kind === "accept") {
      toast(
        `Added — ${res.price != null ? money(res.price) : "the extra"} goes on your ${svc}. ` +
        "Your crew has been told.",
      );
    } else if (kind === "decline") {
      toast(`Declined — nothing added, nothing charged. Your ${svc} goes ahead as booked.`);
    } else {
      toast("Taken back — your crew won't be asked to price it.");
    }
    router.refresh();
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>An extra you asked for</h3>
          {subline && <p className="mut" style={{ fontSize: 13, margin: "4px 0 0" }}>{subline}</p>}
        </div>
        <span className={`ll-pill ${state.tone}`}>{state.pill}</span>
      </div>

      {/* THE OWNER'S OWN WORDS, BACK TO THEM. React escapes this; the copy that
          reaches the crew goes through notify, which escapes it with the one
          escaper on the way into a mail body. */}
      <p style={{ fontSize: 15, lineHeight: 1.5, margin: "12px 0 0" }}>“{addon.requestText}”</p>

      {addon.status === "quoted" && addon.offeredPrice != null && (
        <div style={{ margin: "12px 0 0", padding: "10px 12px", borderRadius: 10, background: "var(--sand)", border: "1px solid var(--line)" }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{money(addon.offeredPrice)}</div>
          <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
            Added to this visit, on top of what you already booked.
            {addon.quotedAt ? ` Your crew priced it on ${longDate(addon.quotedAt)}.` : ""}
          </div>
        </div>
      )}

      <p style={{ fontSize: 13.5, lineHeight: 1.55, margin: "12px 0 0" }}>{state.line}</p>

      {addon.staleReason && addon.status === "quoted" && (
        <p className="mut" style={{ fontSize: 13, lineHeight: 1.55, margin: "8px 0 0" }}>{addon.staleReason}</p>
      )}

      {tappable && (
        <>
          {/* WHAT "STANDARD" ALREADY COVERS — and the honest answer, on the
              screen with the Yes on it. */}
          <div className="ll-notice" style={{ margin: "12px 0 0", background: "var(--sand)", borderColor: "var(--line)", color: "var(--text)" }}>
            <p style={{ fontSize: 12.5, fontWeight: 700, margin: 0 }}>{scope.headline}</p>
            <p style={{ fontSize: 12.5, lineHeight: 1.55, margin: "4px 0 0" }}>{scope.detail}</p>
            <Link href={`/requests/${addon.jobId}`} style={{ fontSize: 12.5, fontWeight: 700 }}>
              Open this visit
            </Link>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button className="ll-btn ghost" onClick={() => act("decline")} disabled={busy !== null}>
              {busy === "decline" ? "Declining…" : "No thanks"}
            </button>
            <button className="ll-btn gold" onClick={() => act("accept")} disabled={busy !== null}>
              {busy === "accept" ? "Adding…" : `Yes — add ${money(addon.offeredPrice ?? 0)}`}
            </button>
          </div>
        </>
      )}

      {addon.status === "requested" && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button className="ll-btn ghost" onClick={() => act("withdraw")} disabled={busy !== null}>
            {busy === "withdraw" ? "Taking it back…" : "Never mind, take it back"}
          </button>
        </div>
      )}
    </div>
  );
}
