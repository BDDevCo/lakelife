/**
 * ONE COLOUR LANGUAGE FOR A JOB'S STATUS.
 *
 * "Requested" was an orange `warn` pill on every list and every job page, and
 * a gold pill on both calendars. The two calendars each carried a private
 * colour table — one commented "Mirrors OpsCalendar's map exactly — one
 * product, one color language", the other "The one shared color map" — and
 * the two of them agreed with each other and disagreed with the rest of the
 * product. The lists, meanwhile, held THREE copies of the pill map.
 *
 * The prototype (lakelife.html:1052) maps Pending → `pill warn` and Scheduled
 * → `pill teal`; there is no gold status anywhere in it. So `warn` is the
 * answer, and this is the only place it is written.
 *
 * `STATUS_PILL` is the class; `STATUS_COLORS` is the same palette flattened
 * for a calendar cell, derived from the pill classes in globals.css so the
 * calendar cannot drift from the pill again.
 */

export type JobStatus = "requested" | "scheduled" | "in_progress" | "complete" | "paid" | "cancelled";

/** The `.ll-pill` variant for each status. */
export const STATUS_PILL: Record<JobStatus, "warn" | "teal" | "ok" | "slate"> = {
  requested: "warn",
  scheduled: "teal",
  in_progress: "teal",
  complete: "ok",
  paid: "slate",
  cancelled: "slate",
};

export const STATUS_LABEL: Record<JobStatus, string> = {
  requested: "Requested",
  scheduled: "Scheduled",
  in_progress: "In progress",
  complete: "Complete",
  paid: "Paid",
  cancelled: "Cancelled",
};

/**
 * The pill palette, as values, for surfaces that draw a dot or a tinted cell
 * rather than a pill. These MUST equal the `.ll-pill.<variant>` rules in
 * globals.css — a test pins that — so the calendar's "Requested" square and
 * the list's "Requested" pill are the same colour.
 */
const PILL_PALETTE: Record<"warn" | "teal" | "ok" | "slate", { bg: string; fg: string; dot: string }> = {
  warn:  { bg: "#f8ecdd", fg: "var(--warn)",      dot: "var(--warn)" },
  teal:  { bg: "#e0f0f3", fg: "var(--teal-dark)", dot: "var(--teal)" },
  ok:    { bg: "#e4f2ea", fg: "var(--ok)",        dot: "var(--ok)" },
  slate: { bg: "#e9eff1", fg: "var(--sub)",       dot: "var(--sub)" },
};

export const STATUS_COLORS: Record<JobStatus, { dot: string; bg: string; fg: string; label: string }> =
  Object.fromEntries(
    (Object.keys(STATUS_PILL) as JobStatus[]).map((s) => [
      s,
      { ...PILL_PALETTE[STATUS_PILL[s]], label: STATUS_LABEL[s] },
    ]),
  ) as Record<JobStatus, { dot: string; bg: string; fg: string; label: string }>;

/** The pill variant for a status string from the database — `slate` for anything unknown. */
export function statusPill(status: string | null | undefined): "warn" | "teal" | "ok" | "slate" {
  return (STATUS_PILL as Record<string, "warn" | "teal" | "ok" | "slate">)[status ?? ""] ?? "slate";
}
