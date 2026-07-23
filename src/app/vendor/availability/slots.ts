/**
 * The crew day's four slots — a neutral module (no "use client") because
 * BOTH the server page and the client grid read it. A value exported from
 * a client module is a client-reference proxy on the server side (Next 16
 * RSC boundary), so it can't live in AvailabilityGrid.tsx.
 */
export const SLOT_TIMES = ["8a", "10a", "1p", "3p"] as const;
