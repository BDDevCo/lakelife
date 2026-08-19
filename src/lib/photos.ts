import "server-only";
import { mustRead, ReadFailed } from "@/lib/must-read";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * THE job-photo reader (job detail, 2026-07-26). Photos live in a PRIVATE
 * bucket and job_photos.url holds a bare storage PATH, so the only way anyone
 * sees an image is a short-lived signed URL minted server-side. Before this
 * existed the ONLY signer was vendor-gated — meaning a homeowner could never
 * see the photos of their own job, while the completion SMS told them the
 * photos were waiting in their portal.
 *
 * AUTH IS THE CALLER'S JOB. This module signs; it does not authorize. Every
 * caller must first prove the viewer may see this job:
 *   - owner  → the loadOwnJob ownership check (properties.owner_id === user)
 *   - crew   → assertVendorJob (jobs.vendor_id === my vendor)
 *   - ops    → assertOps
 * Never export this through a client boundary, and never hand a raw path to
 * the browser: a signed URL is a bearer token — it must not ride in an SMS,
 * an email, or any cached page (job-detail pages are force-dynamic for
 * exactly this reason).
 */

/** One hour. Matches the vendor + COI signers so TTL is uniform app-wide. */
export const PHOTO_URL_TTL_SECONDS = 3600;

export interface JobPhoto {
  url: string; // signed, expires in PHOTO_URL_TTL_SECONDS
  takenAt: string | null;
}

/** Signed URLs + capture times for one job's photos, oldest first. */
export async function signedJobPhotos(jobId: string): Promise<JobPhoto[]> {
  const admin = createServiceClient();
  // AN EMPTY PHOTO LIST IS AN ACCUSATION HERE. The ops job file renders "No
  // photos on this job yet. A job can't reach complete — and the crew can't be
  // paid" off the length of what this returns, so a swallowed read says the
  // crew didn't document their work and shouldn't be paid for it. That is the
  // photo gate — the one rule CLAUDE.md calls non-negotiable — reporting a
  // dropped connection as a crew failing it.
  const rows = mustRead("this job's photos", await admin
    .from("job_photos")
    .select("url, taken_at")
    .eq("job_id", jobId)
    .order("taken_at", { ascending: true }));
  const paths = (rows ?? []).map((r) => r.url as string).filter(Boolean);
  if (paths.length === 0) return [];

  // Storage, not Postgres, but the same rule: rows exist and we could not sign
  // them is not "there are no photos".
  const { data: signed, error: signErr } = await admin.storage
    .from("job-photos")
    .createSignedUrls(paths, PHOTO_URL_TTL_SECONDS);
  if (signErr) {
    console.error("[read failed] signing this job's photos:", signErr);
    throw new ReadFailed("this job's photos", signErr.message);
  }
  // createSignedUrls preserves input order; a path that failed to sign comes
  // back with a null signedUrl rather than shifting the rest.
  return (signed ?? [])
    .map((s, i) => ({ url: s?.signedUrl ?? "", takenAt: ((rows ?? [])[i]?.taken_at as string) ?? null }))
    .filter((p) => p.url);
}

/** Photos for SEVERAL jobs at once (package visits: the legs share a group). */
export async function signedJobPhotosFor(jobIds: string[]): Promise<Map<string, JobPhoto[]>> {
  const out = new Map<string, JobPhoto[]>();
  const ids = [...new Set(jobIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const admin = createServiceClient();
  // SAME ACCUSATION, ONE SCREEN OVER. The package legs render off this map, so
  // a swallowed read here said the OTHER visits in the package came back with
  // no photos — the same "the crew didn't document their work" claim, made
  // about several jobs at once. Both callers are page loaders behind the error
  // boundary, so this throws exactly like signedJobPhotos above.
  const rows = mustRead("the photos on this package's visits", await admin
    .from("job_photos")
    .select("job_id, url, taken_at")
    .in("job_id", ids)
    .order("taken_at", { ascending: true }));
  const flat = (rows ?? []).filter((r) => r.url);
  if (flat.length === 0) return out;

  const { data: signed, error: signErr } = await admin.storage
    .from("job-photos")
    .createSignedUrls(flat.map((r) => r.url as string), PHOTO_URL_TTL_SECONDS);
  if (signErr) {
    console.error("[read failed] signing this package's photos:", signErr);
    throw new ReadFailed("the photos on this package's visits", signErr.message);
  }
  flat.forEach((r, i) => {
    const url = (signed ?? [])[i]?.signedUrl;
    if (!url) return;
    const key = r.job_id as string;
    out.set(key, [...(out.get(key) ?? []), { url, takenAt: (r.taken_at as string) ?? null }]);
  });
  return out;
}
