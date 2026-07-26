"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { recordJobVerdict } from "@/lib/job-verdict";
import type { JobVerdictResult, JobMessageResult } from "@/app/requests/job-detail-data";

/**
 * The two things a customer can DO from their job page.
 *
 * Both re-run the ownership gate from scratch (house standard — see
 * loadOwnJob in requests/actions.ts): identity from the session client, data
 * from the service-role client, strict `properties.owner_id === user.id`
 * between them. The page having rendered proves nothing; a job id in a POST
 * body is just a string someone typed.
 *
 * NOTE ON EXPORTS: a "use server" module may only export async functions.
 * `export type` here breaks Turbopack's server-actions loader at runtime
 * (every action in the chunk 500s with "X is not defined"), so the result
 * types live in job-detail-data.ts and are imported as types.
 */

/** Ownership gate. Returns the ids the actions need, or null if not theirs. */
async function ownJob(jobId: string): Promise<{ userId: string; propertyId: string } | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !jobId) return null;

  const admin = createServiceClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id, property_id, properties(owner_id)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return null;
  const prop = (Array.isArray(job.properties) ? job.properties[0] : job.properties) as { owner_id?: string } | null;
  if (prop?.owner_id !== user.id) return null;
  return { userId: user.id, propertyId: job.property_id as string };
}

/**
 * The in-portal 👍/👎 — the same quality check that used to live ONLY behind
 * an SMS link. Everything downstream (the once-ever guarded flip, opening the
 * Make-It-Right dispute on a 👎, holding the crew's pay, texting them their
 * cure links, posting the note to the board annotated with this job) belongs
 * to recordJobVerdict. Two doors, one implementation — a second copy is how
 * money starts moving one way from one door and another way from the other.
 */
export async function submitJobVerdict(
  jobId: string,
  verdict: "good" | "issue",
  note: string,
): Promise<JobVerdictResult> {
  const ctx = await ownJob(jobId);
  if (!ctx) return { ok: false, error: "That job isn't yours." };
  if (verdict !== "good" && verdict !== "issue") return { ok: false, error: "Pick 👍 or 👎." };

  const admin = createServiceClient();
  const { data: conf } = await admin
    .from("job_confirmations")
    .select("id, verdict")
    .eq("job_id", jobId)
    .maybeSingle();
  if (!conf) return { ok: false, error: "This one isn't open for feedback yet — it opens when your crew finishes." };
  if (conf.verdict) return { ok: true, recorded: false };

  const res = await recordJobVerdict(conf.id as string, verdict, note ?? "");
  if (!res.ok) return { ok: false, error: res.error ?? "Couldn't record that just now." };

  revalidatePath(`/requests/${jobId}`);
  revalidatePath("/requests");
  return { ok: true, recorded: res.recorded, disputeOpened: res.disputeOpened };
}

/**
 * The two Make-It-Right levers that used to exist ONLY as SMS links.
 *
 * The dispute row carries two unguessable bearer tokens — the customer's and
 * the CREW's — so rendering either into the page would let one side act as
 * the other. customerResolvedForJob/customerStillForJob resolve the right
 * token server-side from the job and never return it; this action's only job
 * is to prove the caller owns the job first.
 *
 * "Still not right" fires the policy engine, which can move real money
 * (refund + crew clawback), so the ownership gate above is load-bearing.
 */
export async function settleMyDispute(
  jobId: string,
  answer: "resolved" | "still",
): Promise<JobMessageResult> {
  const ctx = await ownJob(jobId);
  if (!ctx) return { ok: false, error: "That job isn't yours." };

  const { customerResolvedForJob, customerStillForJob } = await import("@/lib/disputes");
  const res = answer === "resolved"
    ? await customerResolvedForJob(jobId)
    : await customerStillForJob(jobId);
  if (!res.ok) return { ok: false, error: res.error ?? "Couldn't update that just now." };

  revalidatePath(`/requests/${jobId}`);
  revalidatePath("/requests");
  return { ok: true };
}

/**
 * A comment on this job. It lands on the property's ONE message board (so ops
 * and the owner keep a single thread) annotated with job_id, which is what
 * lets the job page show only its own conversation.
 *
 * Service-role insert is mandatory, not a shortcut: client writes to
 * `messages` are revoked (0012_lock_message_writes) precisely so `from_user`
 * can't be spoofed — we set it to the owner's OWN id, never a value from the
 * browser. Deliberately no maybeAutoReply here: the AI reply rails are tuned
 * to the property board's rhythm, and a job page is not that thread.
 */
export async function postJobMessage(jobId: string, body: string): Promise<JobMessageResult> {
  const ctx = await ownJob(jobId);
  if (!ctx) return { ok: false, error: "That job isn't yours." };

  const text = (body ?? "").trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Type a message first." };

  const admin = createServiceClient();
  const { error } = await admin.from("messages").insert({
    property_id: ctx.propertyId,
    job_id: jobId,
    from_user: ctx.userId,
    body: text,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/requests/${jobId}`);
  revalidatePath("/messages");
  return { ok: true };
}
