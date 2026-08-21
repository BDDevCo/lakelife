import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";

/**
 * THE ACCEPTANCE LEDGER — appending to it, and asking what it says.
 *
 * Every agreement anybody gives is one row, written once, never updated. The
 * table (0139) holds the shape; this holds the two questions worth asking of
 * it: "has this person agreed to the current version of X?" and "what has this
 * person agreed to?".
 *
 * WHY THIS IS NOT A "use server" FILE. Every export of one of those is a server
 * action callable from any browser that knows its id, and `recordAcceptance`
 * takes a bare subject id with no membership check of its own. Same lesson as
 * `rent-changes.ts`: the engine lives where a browser cannot reach it, and the
 * caller is the one that proves who it is talking about.
 *
 * WHAT IS DELIBERATELY ABSENT: any way to edit or remove a row. A withdrawal is
 * `withdrawAcceptance()`, which APPENDS. `stopTexts()` nulls `sms_consent_text` today, so
 * withdrawing SMS consent destroys the record of what was consented to — that
 * is the shape this refuses to repeat. "She agreed, then moved out" has to stay
 * answerable, and it only stays answerable if nothing is ever taken away.
 */

/** The document kinds the ledger accepts. Mirrors 0139's check constraint. */
export const ACCEPTANCE_KINDS = [
  "tos",
  "privacy",
  "park_rules",
  "park_lease",
  "amenity_rules",
] as const;
export type AcceptanceKind = (typeof ACCEPTANCE_KINDS)[number];

/**
 * WHO agreed. Exactly one, and the database enforces that too.
 *
 * A renter is addressable by their park FILE because the file exists before any
 * login does — 0055 forbids making `users.id` the only pointer to a person, and
 * at The Haven nineteen households will have a file and no account for weeks.
 * An acceptance they give from a link must land somewhere.
 */
export type Subject =
  | { userId: string; parkRenterId?: never }
  | { parkRenterId: string; userId?: never };

export interface AcceptanceRow {
  id: string;
  kind: AcceptanceKind;
  version: string | null;
  /** Null only on rows migrated from the pre-ledger columns. */
  text: string | null;
  act: "accepted" | "withdrawn";
  occurredAt: string;
  /** False when the words were never captured — say so rather than imply them. */
  wordsWereKept: boolean;
}

/** Stable fingerprint of the words, so "did this change?" is one comparison. */
export function textFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function subjectColumns(subject: Subject): Record<string, string> {
  return "userId" in subject && subject.userId
    ? { user_id: subject.userId }
    : { park_renter_id: (subject as { parkRenterId: string }).parkRenterId };
}

/** The email to stamp beside the id, so the row survives the account. */
async function emailFor(subject: Subject): Promise<string | null> {
  if (!("userId" in subject) || !subject.userId) return null;
  const admin = createServiceClient();
  const row = mustRead(
    "your account",
    await admin.from("users").select("email").eq("id", subject.userId).maybeSingle(),
  );
  return (row?.email as string) ?? null;
}

/**
 * APPEND ONE ACT.
 *
 * `text` is required and is the whole point: a version string records THAT
 * somebody agreed and cannot answer WHAT they agreed to. Pass the exact words
 * that were on the screen — for LakeLife's own terms that is `termsPlainText()`,
 * the same source the page renders from, so the two cannot disagree.
 */
export async function recordAcceptance(input: {
  subject: Subject;
  kind: AcceptanceKind;
  version: string | null;
  text: string;
  parkId?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const words = (input.text ?? "").trim();
  // The database refuses this too. Refusing it here as well means the caller
  // gets a sentence rather than a constraint violation.
  if (!words) {
    return { ok: false, error: "Nothing was recorded — the words being agreed to were empty." };
  }

  const admin = createServiceClient();
  const { error } = await admin.from("acceptances").insert({
    ...subjectColumns(input.subject),
    actor_email: await emailFor(input.subject),
    document_kind: input.kind,
    document_version: input.version,
    document_text: words,
    text_sha256: textFingerprint(words),
    park_id: input.parkId ?? null,
    act: "accepted",
    method: "clickwrap",
    provenance: "live",
  });
  if (error) return { ok: false, error: "Couldn't record that agreement — try again." };
  return { ok: true };
}

/**
 * APPEND A WITHDRAWAL. The acceptance it follows stays exactly where it is.
 *
 * The words are carried again rather than looked up: what somebody is walking
 * away from is part of the act, and re-reading them later would show whatever
 * the document says by then.
 */
export async function withdrawAcceptance(input: {
  subject: Subject;
  kind: AcceptanceKind;
  version: string | null;
  text: string;
  parkId?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const words = (input.text ?? "").trim();
  if (!words) {
    return { ok: false, error: "Nothing was recorded — the words being withdrawn were empty." };
  }
  const admin = createServiceClient();
  const { error } = await admin.from("acceptances").insert({
    ...subjectColumns(input.subject),
    actor_email: await emailFor(input.subject),
    document_kind: input.kind,
    document_version: input.version,
    document_text: words,
    text_sha256: textFingerprint(words),
    park_id: input.parkId ?? null,
    act: "withdrawn",
    method: "clickwrap",
    provenance: "live",
  });
  if (error) return { ok: false, error: "Couldn't record that — try again." };
  return { ok: true };
}

/**
 * THE DECISION, WITH NO DATABASE IN IT.
 *
 * Separated so the semantics can be proved on examples rather than inferred
 * from a query — the same split the park planner uses, for the same reason: a
 * rule that only exists inside an I/O function is a rule nobody can test.
 *
 * THE LATEST ACT WINS, and that single sentence is what makes withdrawal work
 * without any row ever being edited. Accept v2, then withdraw v2, and the
 * newest row says withdrawn — the acceptance is still there, still readable,
 * and no longer in force.
 *
 * A version that does not match is NOT accepted: bumping TOS_VERSION is how
 * everyone gets re-prompted, which is the whole point of the constant.
 */
/**
 * THE NEWEST ACT IN A HISTORY.
 *
 * Pulled out so "the latest act wins" — the ledger's headline rule — can be
 * executed by a test on a real sequence, instead of living only inside a
 * database ORDER BY that nothing exercises. `hasAccepted` reads the rows
 * already ordered and passes them through here anyway: the database and this
 * function must agree, and if the ORDER BY were ever dropped this still picks
 * the right row.
 *
 * Sorted by the string form of the timestamp, which is ISO-8601 from Postgres
 * and therefore sorts as time. Ties keep their incoming order, which is the
 * database's — a genuine tie means two acts in the same microsecond, and there
 * is no truer answer available than the one the index already gives.
 */
export function latestAct<T extends { occurredAt: string }>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
}

export function acceptedFromLatest(
  latest: { act: "accepted" | "withdrawn"; version: string | null } | null,
  currentVersion: string | null,
): boolean {
  if (!latest) return false;
  if (latest.act !== "accepted") return false;
  return latest.version === currentVersion;
}

/**
 * IS THIS PERSON CURRENTLY AGREED TO THIS VERSION?
 *
 * The LATEST act wins, which is what makes a withdrawal work without any row
 * being edited: accept v2, withdraw v2, and the newest row says withdrawn.
 *
 * THROWS on a failed read rather than answering false. Answering false would
 * re-prompt somebody who has already agreed — survivable — but the same helper
 * is the natural place to gate on later, and a gate that opens or closes on a
 * dropped connection is the defect class this codebase keeps digging out.
 */
export async function hasAccepted(
  subject: Subject,
  kind: AcceptanceKind,
  version: string | null,
): Promise<boolean> {
  const admin = createServiceClient();
  const cols = subjectColumns(subject);
  const [column, value] = Object.entries(cols)[0];

  const rows = mustRead(
    "what you've agreed to",
    await admin
      .from("acceptances")
      .select("act, document_version, occurred_at")
      .eq(column, value)
      .eq("document_kind", kind)
      .order("occurred_at", { ascending: false }),
  );

  // Ordered by the database AND re-picked here. A person has a handful of acts
  // per document, so there is nothing to save by trusting one of the two.
  const latest = latestAct(
    (rows ?? []).map((r) => ({
      act: r.act as "accepted" | "withdrawn",
      version: (r.document_version as string) ?? null,
      occurredAt: r.occurred_at as string,
    })),
  );
  return acceptedFromLatest(latest, version);
}

/**
 * EVERYTHING THIS PERSON HAS AGREED TO, newest first — for the screen that
 * shows them.
 *
 * `wordsWereKept` is separate from a null `text` on purpose: "we did not store
 * the wording" and "there is no wording" are different answers, and a screen
 * that only checks for null would render the first as the second.
 */
export async function acceptancesFor(subject: Subject): Promise<AcceptanceRow[]> {
  const admin = createServiceClient();
  const cols = subjectColumns(subject);
  const [column, value] = Object.entries(cols)[0];

  const rows = mustRead(
    "what you've agreed to",
    await admin
      .from("acceptances")
      .select("id, document_kind, document_version, document_text, act, occurred_at, provenance")
      .eq(column, value)
      .order("occurred_at", { ascending: false }),
  );

  return (rows ?? []).map((r) => ({
    id: r.id as string,
    kind: r.document_kind as AcceptanceKind,
    version: (r.document_version as string) ?? null,
    text: (r.document_text as string) ?? null,
    act: r.act as "accepted" | "withdrawn",
    occurredAt: r.occurred_at as string,
    wordsWereKept: (r.provenance as string) === "live",
  }));
}
