"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getMyVendorId } from "./data";
import { sendSms } from "@/lib/sms";
import { settleJob } from "@/lib/automation";
import { todayLakeDate } from "@/lib/booking";

// Only these profile fields may be changed by a crew flag, with safe values.
const COUNT_FIELDS = new Set(["pier_sections", "boat_lifts", "pwc_lifts", "jet_skis", "toy_lifts"]);
const LAWN_BANDS = new Set(["small", "medium", "large"]);
function sanitizeProposed(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (COUNT_FIELDS.has(k)) {
      const n = Math.floor(Number(v));
      if (Number.isFinite(n) && n >= 0 && n <= 99) out[k] = n;
    } else if (k === "lawn_band" && typeof v === "string" && LAWN_BANDS.has(v)) {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  photoCount?: number;
}

/** Confirm the job is assigned to the signed-in vendor. Returns the job row or null. */
async function assertVendorJob(jobId: string) {
  const vendorId = await getMyVendorId();
  if (!vendorId) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("jobs")
    // Deliberately NO customer_price / vendor_cost: this is the crew code path,
    // and rule 1 forbids a vendor from ever seeing menu price or margin. Keeping
    // those columns out of reach by construction (settleJob re-loads them ops-side).
    .select("id, status, vendor_id, service_id, date, property_id, services(name, min_photos)")
    .eq("id", jobId)
    .maybeSingle();
  if (!data || data.vendor_id !== vendorId) return null;
  return data;
}

/**
 * Upload one job photo. The crew's device sends the image in a FormData; the
 * file goes to a PRIVATE storage bucket and only a row (job_id + path) is kept.
 */
export async function uploadJobPhoto(jobId: string, form: FormData): Promise<ActionResult> {
  const job = await assertVendorJob(jobId);
  if (!job) return { ok: false, error: "That job isn't on your route." };

  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No photo received." };
  const okTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  if (!okTypes.includes(file.type)) return { ok: false, error: "Use a JPG, PNG, WEBP or HEIC photo." };
  if (file.size > 12 * 1024 * 1024) return { ok: false, error: "Photo is too large (max 12MB)." };

  const admin = createServiceClient();
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${jobId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await admin.storage.from("job-photos").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (upErr) return { ok: false, error: upErr.message };

  const { error: rowErr } = await admin.from("job_photos").insert({ job_id: jobId, url: path });
  if (rowErr) return { ok: false, error: rowErr.message };

  // Stamp the crew's clock-in on the first photo (scoring: actual job duration).
  // Best-effort, only if not already set.
  await admin.from("jobs").update({ started_at: new Date().toISOString() }).eq("id", jobId).is("started_at", null);

  const { count } = await admin
    .from("job_photos")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  return { ok: true, photoCount: count ?? 0 };
}

/**
 * Mark a job complete — HARD photo gate (CLAUDE.md rule 2): cannot complete,
 * and payout cannot release, without at least the service's min_photos.
 * On success: status -> complete, an invoice is raised, the vendor payout is
 * released (photo-verified), and the owner gets the "done + photos" text.
 */
export async function completeJob(jobId: string): Promise<ActionResult> {
  const job = await assertVendorJob(jobId);
  if (!job) return { ok: false, error: "That job isn't on your route." };
  if (job.status === "complete" || job.status === "paid") {
    return { ok: false, error: "That job is already complete." };
  }
  // A job can only be closed on or after the day it's scheduled — no closing
  // (and no payout) on work that isn't due yet.
  if (job.date && String(job.date) > todayLakeDate()) {
    return { ok: false, error: "This job isn't scheduled until later — you can complete it on the day." };
  }

  const svc = (Array.isArray(job.services) ? job.services[0] : job.services) as
    | { name?: string; min_photos?: number }
    | null;
  if (!job.service_id || !svc) return { ok: false, error: "This job has no service set — call Ops." };
  const minPhotos = svc.min_photos ?? 0;

  const admin = createServiceClient();
  const { count } = await admin
    .from("job_photos")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  const photoCount = count ?? 0;
  if (photoCount < minPhotos) {
    return {
      ok: false,
      photoCount,
      error: `Photos required — no photos, no payout. ${photoCount}/${minPhotos} uploaded.`,
    };
  }

  // Idempotent complete: only a job that is still open transitions, and the
  // WHERE clause guarantees exactly one caller wins — so a double-tap or retry
  // can't raise two invoices or release two payouts.
  const { data: changed, error } = await admin
    .from("jobs")
    .update({ status: "complete", completed_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["scheduled", "in_progress", "requested"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!changed || changed.length === 0) {
    return { ok: false, error: "That job is already complete." };
  }

  // Settle the job: payout + invoice + auto-charge + receipt. Extracted into an
  // IDEMPOTENT helper (checks-then-writes) so a partial failure here is
  // recoverable — the nightly reconcile sweep re-runs it for any job left
  // completed-but-unbilled. rule 4: only the vault token is ever charged.
  await settleJob(jobId);

  // "Service complete — with photos" text to the owner (best effort).
  const { data: prop } = await admin
    .from("properties")
    .select("address, users(phone)")
    .eq("id", job.property_id)
    .maybeSingle();
  const ownerPhone = ((Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as { phone?: string } | null)?.phone;
  if (ownerPhone) {
    void sendSms(
      ownerPhone,
      `LakeLife: ${svc?.name ?? "Your service"} is done at ${prop?.address ?? "your place"} — ${photoCount} photos are in your property log. 🌊`,
    );
  }

  return { ok: true, photoCount };
}

/** Vendor flags a profile discrepancy — goes to the owner for approval (rule 6). */
export async function submitFlag(
  jobId: string,
  type: string,
  note: string,
  proposedChange: Record<string, unknown> | null,
): Promise<ActionResult> {
  const job = await assertVendorJob(jobId);
  if (!job) return { ok: false, error: "That job isn't on your route." };

  const admin = createServiceClient();
  const { error } = await admin.from("flags").insert({
    job_id: jobId,
    vendor_id: job.vendor_id,
    type,
    note: note.trim().slice(0, 500) || "Flagged on site by crew.",
    proposed_change: sanitizeProposed(proposedChange),
    status: "pending",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Signed URLs for a job's photos (used to show thumbnails to the crew/owner). */
export async function getJobPhotoUrls(jobId: string): Promise<string[]> {
  const job = await assertVendorJob(jobId);
  if (!job) return [];
  const admin = createServiceClient();
  const { data: rows } = await admin.from("job_photos").select("url").eq("job_id", jobId);
  const paths = (rows ?? []).map((r) => r.url as string);
  if (paths.length === 0) return [];
  const { data: signed } = await admin.storage.from("job-photos").createSignedUrls(paths, 3600);
  return (signed ?? []).map((s) => s.signedUrl).filter(Boolean) as string[];
}
