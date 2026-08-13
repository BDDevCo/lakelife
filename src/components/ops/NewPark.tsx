"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { createPark, findUserByEmail } from "@/app/ops/parks-actions";

/**
 * ADD A PARK — the missing first step of the whole park module.
 *
 * Twelve owner screens, a rent ledger, an importer, a nightly and a public
 * page all start from a `park_members` lookup, and nothing in the product
 * could write that row. This form is what makes The Haven exist.
 *
 * IT ASKS FOR THE LAKE AND THE COORDINATES, and both are required rather than
 * nice-to-have: `parks.lake_id`, `lat` and `lng` were declared in 0052 and
 * written by nothing, so a park could look complete on its own settings screen
 * while being invisible to the crew geo-gate. A park nobody can be dispatched
 * to is a park that quietly never gets serviced.
 */
export function NewPark({ lakes }: { lakes: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [lakeId, setLakeId] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(null);

  if (!open) {
    return (
      <button className="ll-btn ghost sm" style={{ minHeight: 40 }} onClick={() => setOpen(true)}>
        Add a park
      </button>
    );
  }

  const latN = lat.trim() === "" ? null : Number(lat);
  const lngN = lng.trim() === "" ? null : Number(lng);
  const coordsOk =
    latN != null && lngN != null && Number.isFinite(latN) && Number.isFinite(lngN)
    && Math.abs(latN) <= 90 && Math.abs(lngN) <= 180;
  const ready = name.trim() && address.trim() && lakeId && owner && coordsOk;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 10px" }}>Add a park</h3>

      <div className="ll-field">
        <label>Park name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="The Haven" maxLength={120} />
      </div>

      <div className="ll-field" style={{ marginTop: 10 }}>
        <label>Address</label>
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, town, IN" maxLength={200} />
      </div>

      <div className="ll-field" style={{ marginTop: 10 }}>
        <label>Lake</label>
        <select value={lakeId} onChange={(e) => setLakeId(e.target.value)}>
          <option value="">Pick one…</option>
          {lakes.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <div className="ll-field" style={{ flex: 1 }}>
          <label>Latitude</label>
          <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="41.6" />
        </div>
        <div className="ll-field" style={{ flex: 1 }}>
          <label>Longitude</label>
          <input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-85.3" />
        </div>
      </div>
      <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
        Both required — without them the park is invisible to the crew
        geo-gate, which fails quietly rather than loudly. Right-click the park
        entrance in Google Maps and copy the pair.
      </p>

      <div className="ll-field" style={{ marginTop: 12 }}>
        <label>Owner&apos;s email</label>
        <input
          value={ownerEmail}
          onChange={(e) => { setOwnerEmail(e.target.value); setOwner(null); }}
          placeholder="they need an account already"
        />
        <button
          className="ll-btn ghost sm"
          style={{ marginTop: 8, minHeight: 40 }}
          disabled={busy || !ownerEmail.trim()}
          onClick={() =>
            start(async () => {
              const res = await findUserByEmail(ownerEmail);
              if (res.ok && res.id) setOwner({ id: res.id, label: res.label ?? ownerEmail });
              else { setOwner(null); toast(res.error ?? "Couldn't find them."); }
            })
          }
        >
          Find them
        </button>
        {owner && (
          <p style={{ fontSize: 12.5, margin: "8px 0 0", color: "var(--teal-dark)", fontWeight: 700 }}>
            ✓ {owner.label}
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button
          className="ll-btn gold"
          style={{ minHeight: 44 }}
          disabled={busy || !ready}
          onClick={() =>
            start(async () => {
              const res = await createPark({
                name, address, lakeId, lat: latN, lng: lngN, ownerUserId: owner!.id,
              });
              toast(res.ok ? (res.signal ?? "Created.") : (res.error ?? "Couldn't create it."));
              if (res.ok) {
                setOpen(false);
                setName(""); setAddress(""); setLakeId(""); setLat(""); setLng("");
                setOwnerEmail(""); setOwner(null);
                router.refresh();
              }
            })
          }
        >
          {busy ? "Creating…" : "Create the park"}
        </button>
        <button className="ll-btn ghost" style={{ minHeight: 44 }} disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      <p className="mut" style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.5 }}>
        It starts unpublished. The owner adds lots and publishes it themselves
        from <b>/park/setup</b> — nothing goes public from here.
      </p>
    </div>
  );
}
