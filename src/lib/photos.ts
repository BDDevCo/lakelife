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
  /**
   * `job_photos.id` — the photo's stable identity, and the React key the
   * gallery lists on. It used to key on the signed URL, which is regenerated
   * with a fresh token on every render: reconciliation was defeated on every
   * load, and two rows pointing at one storage object collided outright
   * ("children may be duplicated and/or omitted" — on the gallery a dispute
   * turns on).
   */
  id: string;
  url: string; // signed, expires in PHOTO_URL_TTL_SECONDS
  takenAt: string | null;
  /**
   * Which named shot this is (0146) — "engine", "racked_position". Null for
   * an extra photo beyond the list and for every row written before 0146.
   * Carried on the SHARED reader on purpose: a condition report that only the
   * crew can read is not a report. The homeowner looking at their own boat
   * and ops arbitrating a gouge both need to know which photo is the engine.
   */
  slot: string | null;
  /** The uploading device's own file time (0146). Never called capture time. */
  deviceTime: string | null;
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
    .select("id, url, taken_at, slot, device_time")
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
  const out = (signed ?? [])
    .map((s, i) => ({
      id: ((rows ?? [])[i]?.id as string) ?? "",
      url: s?.signedUrl ?? "",
      takenAt: ((rows ?? [])[i]?.taken_at as string) ?? null,
      slot: ((rows ?? [])[i]?.slot as string | null) ?? null,
      deviceTime: ((rows ?? [])[i]?.device_time as string | null) ?? null,
    }))
    .filter((p) => p.url);

  // ROWS BUT NO PICTURES IS A DIFFERENT FACT FROM NO ROWS, and until now it
  // was silent. `createSignedUrls` returns a null url per path rather than an
  // error when the FILE is gone, so a half-finished upload left a job that
  // cleared the photo gate, got paid, and shows the customer an empty gallery
  // — the screen saying the crew documented nothing about work they were paid
  // for. Not throwable: a missing file is permanent, and taking the page down
  // forever is worse than showing the rest of it. So it is logged, loudly,
  // because somebody has to go and look.
  if (paths.length > 0 && out.length === 0) {
    console.error(
      `[photos] job ${jobId}: ${paths.length} photo row(s) on file and none could be signed — ` +
        `the customer sees an empty gallery on a job that passed the photo gate.`,
    );
  }
  return out;
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
    .select("id, job_id, url, taken_at, slot, device_time")
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
    out.set(key, [...(out.get(key) ?? []), {
      id: (r.id as string) ?? "",
      url,
      takenAt: (r.taken_at as string) ?? null,
      slot: (r.slot as string | null) ?? null,
      deviceTime: (r.device_time as string | null) ?? null,
    }]);
  });
  return out;
}

/**
 * THE TOKEN-PAGE VARIANT: signed photos, or none, and NEVER a throw.
 *
 * `signedJobPhotos` throws ReadFailed on purpose — its callers are page
 * loaders sitting behind an error boundary, and an empty gallery there is an
 * accusation ("the crew documented nothing"). The 👍/👎 SMS doors have no
 * error boundary and no session: a storage hiccup there would turn a working
 * feedback link into a bare 500 on somebody's phone, and the tap that was
 * meant to release a crew's credit would be lost.
 *
 * So on those pages the failure is absorbed and logged. The strip simply does
 * not render, which is exactly the page as it stood before — and the verdict,
 * which is the thing the customer actually came to record, still lands.
 */
export async function signedJobPhotosOrNone(jobId: string | null | undefined): Promise<JobPhoto[]> {
  if (!jobId) return [];
  try {
    return await signedJobPhotos(jobId);
  } catch (e) {
    console.error("[read failed] the photos on this feedback link:", e);
    return [];
  }
}
