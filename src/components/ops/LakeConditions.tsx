"use client";

/**
 * Editable per-lake season dates (ops only). Ice-out and the estimated hard
 * freeze are entered by hand; the pull deadline is derived live (hard freeze
 * minus an 8-day safety buffer, rule 7) and shown read-only. Saving reflows
 * the customer booking calendar, which reads these dates.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateLakeConditions, promoteLakeToServed } from "@/app/ops/actions";
import { toast } from "@/components/Toast";
import type { LakeCondition } from "@/app/ops/data";
import { waitingWords } from "@/lib/lake-visibility";

/** Hard freeze (yyyy-mm-dd) minus 8 days, formatted "Mon D". "—" if empty/invalid. */
function pullDeadlineLabel(hardFreeze: string): string {
  if (!hardFreeze) return "—";
  const d = new Date(hardFreeze + "T12:00:00");
  if (Number.isNaN(d.getTime())) return "—";
  d.setDate(d.getDate() - 8);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LakeConditions({ lakes }: { lakes: LakeCondition[] }) {
  // LAKES SOMEBODY ASKED FOR AND NOBODY HERE HAS ANSWERED.
  //
  // The gate that keeps an unpromoted lake off the front page is only half the
  // job: a real customer names water we don't work on, the row is created,
  // their set-up completes — and without this line nobody at LakeLife ever
  // learns a market asked for us. Named at the top of the screen rather than
  // left as a badge on a card somebody has to scroll to, because the whole
  // failure mode is nobody looking.
  const waiting = lakes.filter((l) => l.awaiting_promotion);
  return (
    <>
      {waiting.length > 0 && (
        <div className="ll-notice" style={{ marginBottom: 16 }}>
          <b>
            {waiting.length === 1
              ? "1 lake is waiting on you"
              : `${waiting.length} lakes are waiting on you`}
          </b>{" "}
          — named by a customer or a crew, and not on the public site until you
          say we serve it. Their homes, season dates and bookings all work
          meanwhile.
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {waiting.map((l) => (
              <li key={l.id} style={{ fontSize: 13 }}>
                <b>{l.name}</b> — from a {l.source}, {l.active_properties}{" "}
                {l.active_properties === 1 ? "home" : "homes"}, {waitingWords(l.days_waiting)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {lakes.map((lake) => (
          <LakeCard key={lake.id} lake={lake} />
        ))}
      </div>
      <p className="mut" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
        How this drives scheduling: spring water-work opens the customer calendar only after each
        lake&apos;s confirmed ice-out; fall pier &amp; lift removals block after the pull deadline
        (hard freeze minus an 8-day safety buffer).
      </p>
    </>
  );
}

function LakeCard({ lake }: { lake: LakeCondition }) {
  const router = useRouter();
  const [iceOut, setIceOut] = useState(lake.ice_out_actual ?? "");
  const [hardFreeze, setHardFreeze] = useState(lake.hard_freeze_est ?? "");
  const [busy, setBusy] = useState(false);
  const [promoting, setPromoting] = useState(false);

  async function promote() {
    setPromoting(true);
    try {
      const res = await promoteLakeToServed(lake.id);
      if (res.ok) {
        // The warning arm is "it was already public" — a true sentence that is
        // not a success, so it must not be shown as one.
        if (res.warning) toast.ok(res.warning);
        else toast.ok(`${lake.name} is on the public site now.`);
        router.refresh();
      } else {
        toast.err(res.error ?? "Couldn't publish that lake.");
      }
    } finally {
      setPromoting(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await updateLakeConditions(lake.id, {
        iceOut: iceOut || null,
        hardFreeze: hardFreeze || null,
      });
      if (res.ok) {
        toast.ok("Saved — the booking calendar will reflect these dates.");
        router.refresh();
      } else {
        toast.err(res.error ?? "Couldn't save.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ll-card ll-card-pad">
      {/* A SCRATCH LAKE LOOKED EXACTLY LIKE A REAL ONE HERE.
          0124 fenced fixtures off every public surface and deliberately left
          them in this editor — somebody has to be able to set a scratch lake's
          dates — but with nothing marking them. A card for a fixture sat
          between Big Long and Pretty looking identical, and the six date
          fields that gate the whole spring water calendar are typed by hand,
          once a year, from memory. The real ice-out goes into the wrong card
          and the lake that needed it stays provisional: its pull reminder
          never fires and a pier is left in the ice. `is_fixture` was already
          loaded onto this view model and read by nothing. */}
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {lake.name}
        {lake.is_fixture && <span className="ll-pill slate" style={{ fontSize: 11 }}>Test lake</span>}
      </h3>
      {lake.is_fixture && (
        <div className="mut" style={{ fontSize: 12.5, marginTop: 2 }}>
          Not a real lake — nothing here reaches a customer.
        </div>
      )}

      {/* THE OTHER HALF OF THE GATE, ON THE CARD ITSELF.
          The banner at the top of this screen says a lake is waiting; this is
          where somebody does something about it. Without a control the rule
          would be a hole ops could see and not close — the only way to promote
          a lake would be an UPDATE typed against production. */}
      {lake.awaiting_promotion && (
        <div className="ll-notice" style={{ marginTop: 8 }}>
          <b>Not on the public site.</b>{" "}
          {lake.source === "crew"
            ? "A crew added this lake to their service area."
            : "A customer named this lake when they set up."}{" "}
          It is off the front page, /lakes, the sitemap and the link-preview
          card until you say we serve it — {waitingWords(lake.days_waiting)}.
          The {lake.active_properties === 1 ? "home" : "homes"} already here
          book and get their season dates either way.
          <div style={{ marginTop: 10 }}>
            <button className="ll-btn sm" onClick={promote} disabled={promoting}>
              {promoting ? "Saving…" : "Yes — we serve this lake"}
            </button>
          </div>
        </div>
      )}

      {/* THIS IS THE SCREEN THAT EXISTS TO FIX IT, and it could not say which
          lake needed fixing. `season_confirmed` was not even loaded here. A
          provisional window is a guess the booking calendar and the public
          lake page are now both obliged to admit to — so the sooner a real
          ice-out lands in these two boxes, the sooner they stop hedging. */}
      {!lake.is_fixture && lake.provisional && (
        <div className="ll-notice" style={{ marginTop: 8 }}>
          <b>Still provisional.</b>{" "}
          {lake.season_confirmed
            ? "These dates were rolled from a past season, so customers booking water work here are being told they're an estimate."
            : "Nobody has confirmed this lake's dates — they were copied from a neighbouring lake when it was created."}{" "}
          Type this year&apos;s ice-out and hard freeze below and the hedging stops.
        </div>
      )}
      <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
        {lake.active_properties} active properties
      </div>

      <div className="ll-field" style={{ marginTop: 14 }}>
        <label>Ice-out (actual)</label>
        <input type="date" value={iceOut} onChange={(e) => setIceOut(e.target.value)} />
      </div>

      <div className="ll-field">
        <label>Est. hard freeze</label>
        <input type="date" value={hardFreeze} onChange={(e) => setHardFreeze(e.target.value)} />
      </div>

      <div style={{ marginTop: 6, fontSize: 13 }}>
        <span className="mut">Pull deadline:</span>{" "}
        <b style={{ color: "var(--warn)" }}>{pullDeadlineLabel(hardFreeze)}</b>
      </div>

      <button className="ll-btn sm" style={{ marginTop: 14 }} onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
