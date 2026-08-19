"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertVendorJob, getCrewCalendarYear, type CrewCalRow } from "./job-detail-data";
import { crewChooseFix, crewChooseVerify, crewChooseTalk } from "@/lib/disputes";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";

/**
 * CREW JOB-DETAIL actions (2026-07-26).
 *
 * MAKE-IT-RIGHT, IN-PORTAL. Until now the crew's three cure choices existed
 * ONLY behind the SMS links at /d/<crew_token>/{fix,verify,talk} — miss the
 * text, miss the window, and the policy fires against you. These actions put
 * the same three choices on the job page.
 *
 * THE SECURITY SHAPE THAT MATTERS: the dispute's crew_token is a bearer
 * credential. It is looked up HERE, on the server, only after assertVendorJob
 * has proved the caller is this job's crew, and it is handed straight to the
 * lib function. It is never returned, never rendered, never sent to a client
 * component. The browser identifies the work by job id; the token stays home.
 *
 * No exported types in this file — a "use server" module may only export async
 * actions (exporting a type here breaks Turbopack's server-actions loader at
 * runtime). Types live in job-detail-data.ts.
 */

/** Statuses src/lib/disputes.ts still treats as open. First tap across the three wins. */
const OPEN_DISPUTE = ["crew_review", "fixing", "verifying", "talk", "escalated"];

/**
 * The open dispute's crew token for a job the caller has ALREADY been proven
 * to own. Not exported: nothing outside this module can reach a token.
 */
async function openDisputeToken(jobId: string): Promise<string | null> {
  const admin = createServiceClient();
  // THROWS on a failed read, same reason assertVendorJob does. `null` from here
  // means "there is nothing open to settle", and that is what the caller says
  // out loud — to a crew whose pay is being HELD by the very dispute this read
  // failed to find, on the screen they were sent to in order to clear it. The
  // caller converts the throw into its own result.
  const data = mustRead(
    "this job's open dispute",
    await admin
      .from("disputes")
      .select("crew_token, status")
      .eq("job_id", jobId)
      .in("status", OPEN_DISPUTE)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return (data?.crew_token as string | null) ?? null;
}

/**
 * Crew picks one of the three cures on their own job page.
 *  - "fix"    → books the $0, photo-gated return visit for dateISO
 *  - "verify" → stands by the work; the customer decides against the photos
 *  - "talk"   → opens the message thread with the customer
 * The lib functions re-check the dispute's state, so a stale button loses the
 * race honestly rather than double-booking anything.
 */
export async function crewCureJob(
  jobId: string,
  choice: "fix" | "verify" | "talk",
  dateISO?: string,
): Promise<{ ok: boolean; error?: string }> {
  // assertVendorJob THROWS when the read itself fails, so that a dropped
  // connection can never be reported as "that job isn't on your route". A
  // rejection escaping a "use server" action reaches the crew as a blank
  // failure with no sentence, so it is converted to this action's own
  // { ok, error } here. Nothing has been written at this point.
  let job: Awaited<ReturnType<typeof assertVendorJob>> = null;
  try {
    job = await assertVendorJob(jobId);
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your job", e) };
    throw e;
  }
  if (!job) return { ok: false, error: "That job isn't on your route." };

  // Same conversion as above: a rejection escaping a "use server" action is a
  // blank failure on the crew's phone. Nothing has been written at this point —
  // all three cures are driven by the lib functions below.
  let token: string | null = null;
  try {
    token = await openDisputeToken(jobId);
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("this job's dispute", e) };
    throw e;
  }
  if (!token) return { ok: false, error: "There's nothing open to settle on this job." };

  if (choice === "fix") return crewChooseFix(token, String(dateISO ?? "").trim());
  if (choice === "verify") return crewChooseVerify(token);
  if (choice === "talk") return crewChooseTalk(token);
  return { ok: false, error: "Pick one of the three options." };
}

/**
 * One more year of the crew's own calendar, fetched when month navigation
 * crosses into a year the page didn't ship with. Mirrors the ops calendar's
 * loadOpsCalendarYear. Gating lives in getCrewCalendarYear, which resolves the
 * vendor from the SESSION — no vendor id is ever accepted from the browser.
 */
export async function loadCrewCalendarYear(year: number): Promise<CrewCalRow[]> {
  // DELIBERATELY NOT CAUGHT. This returns a bare array, so the only shape a
  // catch could convert a failed read into is `[]` — the blank grid must-read
  // exists to prevent. VendorCalendar.ensureYear already wraps this call in
  // try/catch and says "Couldn't load that year — try again."
  return getCrewCalendarYear(Number(year));
}
