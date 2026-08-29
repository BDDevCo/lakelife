import { slotLabel } from "@/lib/shot-list";

/**
 * THE CONDITION REPORT, ON A PHONE, WITH NO SESSION.
 *
 * §E.2 of the storage design asked for "typed intake/outtake photo checklists
 * at every custody handoff + customer e-acknowledgment". 0146 built the
 * checklist and the crew screen shoots it. This is the acknowledgment half —
 * and without it the customer was being asked to approve work they could not
 * see: the 👍 link read "One tap and your crew gets the credit for Boat
 * storage & winterize" above a button and nothing else.
 *
 * An acknowledgment of an unseen thing is not evidence of anything. If the
 * gouge argument ever happens, "they tapped 👍" is worth what the photos in
 * front of them at that moment were worth.
 *
 * A STRING BUILDER, NOT A COMPONENT. These pages are plain HTML responses
 * from route handlers — there is no React on the other end of an SMS tap.
 * Kept out of the route files, and out of `server-only`, so the escaping can
 * be tested directly.
 *
 * SIGNED URLS ARE BEARER TOKENS. The caller mints them at request time (one
 * hour of life) and has already proved the viewer holds the confirm token for
 * this job. This function must never be handed a raw storage path, and its
 * output must never ride in an email or an SMS — only in a response to a tap.
 */

export interface StripPhoto {
  /** Signed, short-lived. Minted by the caller, never a storage path. */
  url: string;
  /** The named shot (0146), or null for an extra photo. */
  slot?: string | null;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** How many thumbnails fit on a phone before the card becomes a scroll. */
export const STRIP_MAX = 8;

/**
 * A grid of the job's photos with their shot labels, or "" when there are
 * none — an empty string so the caller can concatenate without a branch.
 *
 * NO "no photos yet" LINE HERE. On a page whose button says the work went
 * well, an empty-state sentence would be an accusation against the crew
 * rendered by a failed read as readily as by a real absence, and the caller
 * cannot always tell those apart (see the loaders' own notes on that).
 */
export function photoStripHtml(photos: StripPhoto[] | null | undefined): string {
  // Trimmed, not just truthy: `createSignedUrls` hands back a null url for a
  // path whose FILE is gone, and a blank one renders a broken-image icon on a
  // page that is asking somebody to approve the work it depicts.
  const list = (photos ?? []).filter((p) => p && typeof p.url === "string" && p.url.trim());
  if (list.length === 0) return "";
  const shown = list.slice(0, STRIP_MAX);
  const more = list.length - shown.length;

  const cells = shown.map((p) => {
    const label = p.slot ? slotLabel(p.slot) : "";
    // The URL is escaped for the attribute exactly like any other
    // interpolation: a signed URL carries a query string full of & and =.
    const cap = label
      ? `<span style="position:absolute;left:0;right:0;bottom:0;background:linear-gradient(to top,rgba(10,36,48,.86),rgba(10,36,48,0));color:#fff;font-size:10px;font-weight:800;padding:9px 5px 3px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</span>`
      : "";
    const img = `<img src="${esc(p.url)}" alt="${esc(label || "Job photo")}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">`;
    return `<span style="position:relative;display:block;border-radius:10px;overflow:hidden;border:1px solid #d7e0e3;background:#eef3f4;aspect-ratio:4/3">${img}${cap}</span>`;
  }).join("");

  const note = more > 0
    ? `<p style="font-size:12px;color:#5D7681;margin:8px 0 0">+ ${more} more in your portal.</p>`
    : "";

  return `<div style="margin-top:16px"><p style="font-size:12.5px;color:#5D7681;margin:0 0 8px;text-align:left">What your crew photographed:</p><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px">${cells}</div>${note}</div>`;
}
