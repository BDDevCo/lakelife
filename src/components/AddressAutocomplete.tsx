"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Address field backed by Google's NEW Places Autocomplete element
 * (PlaceAutocompleteElement, part of "Places API (New)"). The owner types a
 * few letters and taps their real address; we capture the formatted address
 * plus lat/lng (which the routing engine needs later).
 *
 * If the Google key is missing or Places (New) isn't enabled, it falls back to
 * a plain typed field so setup is never blocked.
 */

type MapsWindow = { google?: { maps?: { importLibrary?: unknown } } };

/** Resolves only once google.maps.importLibrary is actually callable. */
function whenImportLibraryReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const check = () => {
      const gm = (window as unknown as MapsWindow).google?.maps;
      if (gm && typeof gm.importLibrary === "function") return resolve();
      if (++tries > 200) return reject(new Error("Google Maps init timed out"));
      setTimeout(check, 50);
    };
    check();
  });
}

let mapsPromise: Promise<void> | null = null;
function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject();
  const gm = (window as unknown as MapsWindow).google?.maps;
  if (gm && typeof gm.importLibrary === "function") return Promise.resolve();
  if (mapsPromise) return mapsPromise;

  mapsPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-lakelife-maps]');
    const onReady = () => whenImportLibraryReady().then(resolve).catch(reject);
    if (existing) {
      onReady();
      return;
    }
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async&v=weekly`;
    s.async = true;
    s.dataset.lakelifeMaps = "1";
    // onload fires before the API finishes wiring importLibrary, so poll after.
    s.onload = onReady;
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

// Cache the "is Places (New) enabled?" answer so we probe at most once/session.
let placesEnabledCache: boolean | null = null;
async function placesNewEnabled(places: {
  AutocompleteSuggestion: { fetchAutocompleteSuggestions: (r: object) => Promise<unknown> };
  AutocompleteSessionToken: new () => object;
}): Promise<boolean> {
  if (placesEnabledCache !== null) return placesEnabledCache;
  try {
    const token = new places.AutocompleteSessionToken();
    await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: "1 main st",
      sessionToken: token,
      includedRegionCodes: ["us"],
    });
    placesEnabledCache = true;
  } catch {
    placesEnabledCache = false;
  }
  return placesEnabledCache;
}

/* Minimal typings for the new Places element we use. */
interface PlacePrediction {
  toPlace: () => {
    fetchFields: (o: { fields: string[] }) => Promise<void>;
    formattedAddress?: string;
    location?: { lat: () => number; lng: () => number };
  };
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (sel: AddressSelection) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"plain" | "google">("plain");

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !hostRef.current) return;
    let cancelled = false;

    loadGoogleMaps(key)
      .then(async () => {
        const g = (window as unknown as {
          google: { maps: { importLibrary: (n: string) => Promise<Record<string, unknown>> } };
        }).google;
        const places = (await g.maps.importLibrary("places")) as {
          PlaceAutocompleteElement: new (o?: object) => HTMLElement & {
            includedRegionCodes?: string[];
            style: CSSStyleDeclaration;
          };
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: (r: object) => Promise<unknown>;
          };
          AutocompleteSessionToken: new () => object;
        };
        if (cancelled || !hostRef.current) return;

        // Only upgrade to the Google box if "Places API (New)" is actually
        // enabled — otherwise the box would take input but return nothing.
        if (!(await placesNewEnabled(places))) {
          setMode("plain");
          return;
        }

        if (hostRef.current.childElementCount > 0) {
          setMode("google");
          return; // already mounted (StrictMode / re-run)
        }
        const el = new places.PlaceAutocompleteElement();
        try {
          el.includedRegionCodes = ["us"];
        } catch {}
        el.style.width = "100%";
        el.style.colorScheme = "light"; // match the light card (avoid Google's dark default)
        hostRef.current.appendChild(el);

        el.addEventListener("gmp-select", async (evt: Event) => {
          const { placePrediction } = evt as unknown as { placePrediction: PlacePrediction };
          const place = placePrediction.toPlace();
          await place.fetchFields({ fields: ["formattedAddress", "location"] });
          const address = place.formattedAddress ?? "";
          const loc = place.location;
          if (address) onChange(address);
          onSelect({ address, lat: loc ? loc.lat() : null, lng: loc ? loc.lng() : null });
        });

        setMode("google");
      })
      .catch((e) => {
        console.error("[LakeLife] Places autocomplete failed:", e);
        setMode("plain");
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ll-field">
      <label>Property address</label>

      {/* Google's element mounts here once Places (New) is available. */}
      <div ref={hostRef} style={{ display: mode === "google" ? "block" : "none" }} />

      {/* Plain fallback until/if Google isn't available. */}
      {mode === "plain" && (
        <input
          value={value}
          placeholder="Start typing your address…"
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      )}

      <div className="mut" style={{ fontSize: 11.5, marginTop: 4 }}>
        {mode === "google"
          ? "Start typing and tap your address from the list."
          : value
            ? `On file: ${value}`
            : "Type your full property address."}
      </div>
    </div>
  );
}
