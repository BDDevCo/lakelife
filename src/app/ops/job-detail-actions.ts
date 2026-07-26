"use server";

import { searchOpsJobs, type JobSearchResult } from "./search-data";

/**
 * The CLIENT door onto the ops job lane.
 *
 * Deliberately thin. Everything on the ops job file that MOVES MONEY or state
 * reuses the action that already owns it — refunds go through
 * refund-actions.ts (quoteRefund / issueRefund → the ledger-locked,
 * clawback-conserving executeRefund), escalation resolutions go through
 * dispute-actions.ts (→ opsResolveEscalated), crew assignment goes through
 * actions.ts (assignAndSchedule), and replies go through
 * messages-actions.ts (sendOpsMessage / draftReplyForThread). A second path
 * to any of those would be a second place for the money to be wrong.
 *
 * What's left is search: the debounced box in the ops console is a client
 * component, so it needs a server ACTION rather than a server-only loader.
 * The gate and the query both live in search-data.ts.
 *
 * NOTE (production incident, 2026-07-24): no `export type` from a "use server"
 * module — Turbopack's server-actions loader re-exports every name as a VALUE
 * and 500s the whole chunk at runtime. Types are imported here, never
 * re-exported; the client infers result shapes with
 * `Awaited<ReturnType<typeof searchJobsAction>>` or imports them
 * `import type` straight from search-data.
 */
export async function searchJobsAction(term: string): Promise<JobSearchResult> {
  return searchOpsJobs(term);
}
