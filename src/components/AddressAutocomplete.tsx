"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Address field backed by Google Places Autocomplete: the owner types a few
 * letters and taps their real address, and we capture the exact lat/lng (which
 * the routing engine needs later). If the Google key is missing or the Places
 * API isn't enabled yet, it quietly falls back to a plain typed field.
 */

// Load the Google Maps JS (with Places) exactly once across the app.
let mapsPromise: Promise<void> | null = null;
function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject();
  const w = window as unknown as { google?: { maps?: { places?: unknown } } };
  if (w.google?.maps?.places) return Promise.resolve();
  if (mapsPromise) return mapsPromise;

  mapsPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(s);
  });
  return mapsPromise;
}

export interface AddressSelection {
  address: string;
  lat: number | null;
  lng: number | null;
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (sel: AddressSelection) => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !inputRef.current) return;

    let ac: { addListener: (e: string, cb: () => void) => void; getPlace: () => unknown } | null = null;
    loadGoogleMaps(key)
      .then(() => {
        const g = (window as unknown as { google: { maps: { places: { Autocomplete: new (el: HTMLInputElement, opts: object) => typeof ac } } } }).google;
        ac = new g.maps.places.Autocomplete(inputRef.current!, {
          types: ["address"],
          componentRestrictions: { country: "us" },
          fields: ["formatted_address", "geometry"],
        });
        ac!.addListener("place_changed", () => {
          const place = ac!.getPlace() as {
            formatted_address?: string;
            geometry?: { location?: { lat: () => number; lng: () => number } };
          };
          const address = place.formatted_address ?? "";
          const loc = place.geometry?.location;
          if (address) onChange(address);
          onSelect({
            address,
            lat: loc ? loc.lat() : null,
            lng: loc ? loc.lng() : null,
          });
        });
        setReady(true);
      })
      .catch(() => setReady(false)); // fall back to plain typing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ll-field">
      <label>Property address</label>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder ?? "Start typing your address…"}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <div className="mut" style={{ fontSize: 11.5, marginTop: 4 }}>
        {ready
          ? "Start typing and tap your address from the list."
          : "Type your full property address."}
      </div>
    </div>
  );
}
