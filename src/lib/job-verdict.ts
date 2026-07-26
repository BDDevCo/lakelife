import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { openDisputeForJob, resolveFromCorrection } from "@/lib/disputes";
import { sendSms } from "@/lib/sms";

/**
 * THE post-job verdict recorder (extracted 2026-07-26 for the job-detail
 * surface). The 👍/👎 quality loop used to exist ONLY behind an SMS link;
 * customers can now tap it from the job page in their portal too. Both doors
 * must open the same machinery — a second copy of "flip the verdict, then
 * open a Make-It-Right dispute and text the crew" is exactly the kind of
 * drift that ends with money moving one way from one door and another way
 * from the other.
 *
 * AUTH IS THE CALLER'S JOB: the token routes authorize by unguessable token,
 * the portal action authorizes by session ownership. This module records.
 *
 * Exactly-once by construction: the verdict flip is guarded on
 * `verdict is null`, so whoever taps first wins and a second tap (other door,
 * double-click, SMS prefetch retry) is a no-op that still reports success.
 */

export type Verdict = "good" | "issue";

export interface VerdictOutcome {
  ok: boolean;
  /** true when THIS call won the flip; false = someone already answered. */
  recorded: boolean;
  /** true when the 👎 opened (or reused) a Make-It-Right dispute. */
  disputeOpened?: boolean;
  error?: string;
}

const one = <T,>(x: T | T[] | null | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? x[0] ?? null : x;

/**
 * Record a verdict against a job_confirmations row and run every downstream
 * consequence: a 👎 on a normal job opens the cure-first dispute (holding the
 * crew's pay) and hands the crew their three one-tap links; a verdict on a
 * CORRECTION visit closes the originating dispute instead. The customer's
 * note always lands on the property's message board, annotated to this job.
 */
export async function recordJobVerdict(
  confirmationId: string,
  verdict: Verdict,
  note: string,
): Promise<VerdictOutcome> {
  const admin = createServiceClient();
  const cleanNote = (note ?? "").trim().slice(0, 500);

  const { data: conf } = await admin
    .from("job_confirmations")
    .select("id, verdict, job_id, property_id, vendor_id, jobs(date, correction_of, services(name)), properties(nickname, address, owner_id)")
    .eq("id", confirmationId)
    .maybeSingle();
  if (!conf) return { ok: false, recorded: false, error: "That job isn't open for feedback." };
  if (conf.verdict) return { ok: true, recorded: false };

  const { data: won } = await admin
    .from("job_confirmations")
    .update({ verdict, note: cleanNote || null, responded_at: new Date().toISOString() })
    .eq("id", conf.id)
    .is("verdict", null) // one verdict, ever — first tap wins
    .select("id");
  if (!won || won.length === 0) return { ok: true, recorded: false };

  const job = one(conf.jobs) as { date?: string; correction_of?: string | null; services?: unknown } | null;
  const svc = (one(job?.services) as { name?: string } | null)?.name ?? "the service";
  const prop = one(conf.properties) as { nickname?: string; address?: string; owner_id?: string } | null;
  const where = prop?.nickname || prop?.address || "the property";

  let disputeOpened = false;

  if (verdict === "good") {
    if (job?.correction_of) {
      // The make-it-right visit satisfied them — dispute resolves, pay releases.
      await resolveFromCorrection(conf.job_id as string, true);
    }
    return { ok: true, recorded: true };
  }

  // 👎 ---------------------------------------------------------------------
  if (job?.correction_of) {
    // Still not right AFTER a free return visit — the dispute's own policy
    // engine decides what happens next and owns every message from here.
    await resolveFromCorrection(conf.job_id as string, false);
  } else {
    const r = await openDisputeForJob(conf.job_id as string, cleanNote || null);
    disputeOpened = Boolean(r.ok);
    if (r.ok && r.crewLinks && conf.vendor_id) {
      const { data: v } = await admin
        .from("vendors").select("user_id").eq("id", conf.vendor_id as string).maybeSingle();
      const { data: cu } = v?.user_id
        ? await admin.from("users").select("phone").eq("id", v.user_id as string).maybeSingle()
        : { data: null };
      if (cu?.phone) {
        void sendSms(
          cu.phone as string,
          `LakeLife: the customer flagged the ${svc} at ${where}${cleanNote ? ` — "${cleanNote.slice(0, 120)}"` : ""}. Your pay for it is ON HOLD until this is settled. Make it right (free return visit): ${r.crewLinks.fix} · It was done right (send them your photos): ${r.crewLinks.verify} · Talk it through: ${r.crewLinks.talk}`,
        );
      }
    }
  }

  // The complaint lands on the board either way, annotated to THIS job so the
  // job page can show the thread in context and ops can see what it's about.
  if (conf.property_id) {
    await admin.from("messages").insert({
      property_id: conf.property_id,
      job_id: conf.job_id,
      from_user: prop?.owner_id ?? null,
      body: `⚠️ Issue flagged on ${svc}${job?.date ? ` (${job.date})` : ""}: ${cleanNote || "no details left — crew has been notified"}`,
    });
  }

  return { ok: true, recorded: true, disputeOpened };
}

/** Resolve an unguessable confirm token to its row id (SMS-link door). */
export async function confirmationIdForToken(token: string): Promise<string | null> {
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("job_confirmations").select("id").eq("confirm_token", token).maybeSingle();
  return (data?.id as string) ?? null;
}
