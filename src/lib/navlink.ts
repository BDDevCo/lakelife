/**
 * Device-aware turn-by-turn links. iPhones open Apple Maps; everything else
 * opens Google Maps. Client-only (reads navigator).
 */
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function mapAppName(): string {
  return isIOS() ? "Apple Maps" : "Google Maps";
}

/** Single-stop navigation to a lat/lng (labelled). */
export function navUrl(lat: number, lng: number, label: string): string {
  if (isIOS()) {
    return `https://maps.apple.com/?daddr=${lat},${lng}&q=${encodeURIComponent(label)}&dirflg=d`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

/** Full multi-stop route (Google — waypoints work cross-device). */
export function fullRouteUrl(points: Array<{ lat: number; lng: number }>): string | null {
  const valid = points.filter((p) => p.lat != null && p.lng != null);
  if (valid.length === 0) return null;
  const pts = valid.map((p) => `${p.lat},${p.lng}`);
  const dest = pts[pts.length - 1];
  const way = pts.slice(0, -1).join("|");
  const wp = way ? `&waypoints=${encodeURIComponent(way)}` : "";
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}${wp}&travelmode=driving`;
}
