"use client";

/**
 * Referral capture (roadmap §8). If someone lands with ?ref=CODE, remember it
 * in a 30-day cookie — the attribution is claimed server-side at the portal
 * front door AFTER they sign up (never trusted from the URL at claim time,
 * only matched against a real user's code). Renders nothing.
 */

import { useEffect } from "react";

export function RefCatcher() {
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref && /^[0-9a-f]{8}$/i.test(ref)) {
      document.cookie = `ll_ref=${ref}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
    }
  }, []);
  return null;
}
