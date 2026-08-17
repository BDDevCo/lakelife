"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";
import {
  enableParkServices, focusParkProperty, setParkServiceRate,
  type ParkServiceRow,
} from "@/app/park/service-actions";

/**
 * THE PARK'S OWN SERVICE DESK.
 *
 * Three states, and only one of them is a menu:
 *   1. not on yet        → one button, and what it will do
 *   2. on, but blocked   → the list of things to fix, in order
 *   3. on and ready      → the priced menu, with the arithmetic shown
 *
 * THE ARITHMETIC IS PRINTED BEFORE ANY BOOKING BUTTON. These prices are worked
 * out from his live lot count, and a number he cannot see the derivation of is
 * a number he will not trust — or worse, will trust wrongly.
 */
export function ParkServices({
  parkId, parkName, propertyId, liveLots, blockers, canEnable, menu,
}: {
  parkId: string;
  parkName: string;
  propertyId: string | null;
  liveLots: number;
  blockers: string[];
  canEnable: boolean;
  menu: ParkServiceRow[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();

  const on = propertyId != null;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 16, margin: 0 }}>Services for the park itself</h3>
      <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
        Work on the common ground — the roads, the verges, the trash corral.
        This is the park buying work as a customer, on your card and in your
        name. It has nothing to do with the rent roll, in either direction.
      </p>

      {!on && (
        <div style={{ marginTop: 12 }}>
          {blockers.length > 0 ? (
            <Blockers rows={blockers} />
          ) : (
            <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.55 }}>
              {/* The space after an interpolation is not reliable in JSX here
                  — it rendered "The Havena LakeLife" on screen. Explicit. */}
              Turning this on makes {parkName}{" "}a LakeLife customer with one
              address — the park&apos;s own. Nothing is booked and nothing is
              charged until you pick a service and a day.
            </p>
          )}
          <button
            className="ll-btn gold"
            style={{ minHeight: 44 }}
            disabled={busy || !canEnable || blockers.length > 0}
            onClick={() =>
              start(async () => {
                const res = await enableParkServices(parkId);
                toast(res.ok ? (res.signal ?? "On.") : (res.error ?? "Couldn't do that."));
                if (res.ok) router.refresh();
              })
            }
          >
            {busy ? "Setting up…" : "Turn on park services"}
          </button>
        </div>
      )}

      {on && blockers.length > 0 && <Blockers rows={blockers} />}

      {on && (
        <div style={{ marginTop: 14 }}>
          {/* THE DERIVATION, not just the price. */}
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>
            {liveLots} live {liveLots === 1 ? "lot" : "lots"} — every price below is worked out from that
          </div>

          {menu.length === 0 ? (
            <p className="mut" style={{ fontSize: 13, margin: "8px 0 0", lineHeight: 1.55 }}>
              No grounds services are switched on yet. Tell us what you want for
              the common areas and we&apos;ll price it against your lot count.
            </p>
          ) : (
            <div style={{ marginTop: 8 }}>
              {menu.map((s) => (
                <RateRow key={s.id} parkId={parkId} row={s} liveLots={liveLots} />
              ))}
            </div>
          )}

          {menu.some((s) => s.price == null) && (
            <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.5 }}>
              The ones without a price need your rate before they can be booked
              — every park pays a different number for these, and we will not
              guess yours from somebody else&apos;s.
            </p>
          )}

          <button
            className="ll-btn"
            style={{ marginTop: 10, minHeight: 44 }}
            disabled={busy || menu.every((s) => s.price == null) || blockers.length > 0}
            onClick={() =>
              start(async () => {
                // Points the booking screen at the PARK. Without this the
                // switcher falls back to his oldest property, which for an
                // owner who also has a lake house is the wrong place entirely.
                const res = await focusParkProperty(parkId);
                if (!res.ok) { toast(res.error ?? "Couldn't do that."); return; }
                router.push("/book");
              })
            }
          >
            Book park work →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * ONE SERVICE, AND WHAT THIS PARK PAYS FOR IT.
 *
 * Two dials, because that is what the table holds and hiding one behind a
 * "simple" single field would make the other unreachable: a flat amount every
 * visit, plus an amount per live lot. The Haven's mow is $16 + $4 x 21 = $100,
 * which is the seller's actual contract. A park in another county types its own
 * two numbers and never sees ours.
 *
 * The total is computed AS HE TYPES, against his real lot count, so he is never
 * asked to trust arithmetic he cannot see.
 */
function RateRow({
  parkId, row, liveLots,
}: { parkId: string; row: ParkServiceRow; liveLots: number }) {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState(row.base != null ? String(row.base) : "");
  const [per, setPer] = useState(row.unitRate != null ? String(row.unitRate) : "");
  const [busy, start] = useTransition();
  const router = useRouter();

  const b = Number(base) || 0;
  const u = Number(per) || 0;
  // THE SAME ENGINE THE INVOICE USES. Doing the multiplication by hand here
  // previewed $277.50 for a rate that actually charged $278 — LakeLife prices
  // in whole dollars, and a preview that does not know that is a lie the owner
  // only finds out about on a bill.
  const preview = priceService(
    {
      name: row.name,
      pricing_model: row.pricingModel,
      base: b,
      unit_rate: u,
      band_pricing: row.bandPricing,
    } as unknown as ServiceRule,
    { lots: liveLots } as unknown as PricingProfile,
  );

  return (
    <div style={{ padding: "9px 0", borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{row.name}</span>
        <span className="mut" style={{ fontSize: 12.5 }}>
          {row.frequencyOptions.join(" \u00b7 ")}
        </span>
        {/* NO PRICE IS AN HONEST STATE. 0115 zeroed the global rate on every
            park service so a park that has not set one cannot be shown another
            park's number. Asking beats a confident wrong figure. */}
        {row.price == null ? (
          <span className="mut" style={{ fontSize: 12.5, marginLeft: "auto" }}>
            needs your price
          </span>
        ) : (
          <span style={{ fontSize: 14, fontWeight: 800, marginLeft: "auto" }}>
            ${row.price.toFixed(2)}
          </span>
        )}
        <button
          style={{
            fontSize: 12.5, fontWeight: 700, background: "none", border: 0,
            padding: 0, cursor: "pointer", color: "var(--teal)",
          }}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close" : row.price == null ? "Set price" : "Edit"}
        </button>
      </div>

      {row.note && !open && (
        <div className="mut" style={{ fontSize: 12, marginTop: 3 }}>{row.note}</div>
      )}

      {open && (
        <div style={{
          marginTop: 8, background: "var(--sand)",
          borderRadius: 10, padding: "10px 12px",
        }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div className="ll-field" style={{ marginBottom: 0, width: 130 }}>
              <label htmlFor={`base-${row.id}`}>Flat, per visit</label>
              <input
                id={`base-${row.id}`} inputMode="decimal" value={base}
                onChange={(e) => setBase(e.target.value)} placeholder="0.00"
              />
            </div>
            <div className="ll-field" style={{ marginBottom: 0, width: 130 }}>
              <label htmlFor={`per-${row.id}`}>Plus, per live lot</label>
              <input
                id={`per-${row.id}`} inputMode="decimal" value={per}
                onChange={(e) => setPer(e.target.value)} placeholder="0.00"
              />
            </div>
          </div>

          <div style={{ fontSize: 13, fontWeight: 800, marginTop: 8 }}>
            {/* The arithmetic, out loud, at his real lot count. */}
            ${b.toFixed(2)} + ${u.toFixed(2)} &times; {liveLots}{" "}
            {liveLots === 1 ? "lot" : "lots"} = ${preview.toFixed(2)} a visit
            {Math.abs(b + u * liveLots - preview) > 0.005 && (
              <span className="mut" style={{ fontWeight: 600 }}>
                {" "}(rounded to the dollar)
              </span>
            )}
          </div>
          <p className="mut" style={{ fontSize: 12, margin: "4px 0 8px", lineHeight: 1.5 }}>
            Put the whole amount in &ldquo;flat&rdquo; if what you pay doesn&apos;t
            change when lots fill or empty. Use the per-lot box when it does &mdash;
            then adding a lot reprices this on its own.
          </p>

          <button
            className="ll-btn gold" style={{ minHeight: 44 }}
            disabled={busy || preview <= 0}
            onClick={() =>
              start(async () => {
                const res = await setParkServiceRate(parkId, row.id, b, u);
                toast(res.ok ? (res.signal ?? "Saved.") : (res.error ?? "Couldn't save that."));
                if (res.ok) { setOpen(false); router.refresh(); }
              })
            }
          >
            {busy ? "Saving\u2026" : "Save this park's price"}
          </button>
        </div>
      )}
    </div>
  );
}

/** What to fix, in the order it has to be fixed. */
function Blockers({ rows }: { rows: string[] }) {
  return (
    <div style={{
      marginTop: 10, background: "var(--sand)",
      borderRadius: 10, padding: "10px 12px",
    }}>
      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>
        Before this can be switched on:
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {rows.map((r) => (
          <li key={r} className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 3 }}>
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}
