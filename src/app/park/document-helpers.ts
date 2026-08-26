/**
 * WHAT THE PARK FILED, AND WHO WAS GIVEN IT.
 *
 * COURIER, NOT WITNESS. A lease is between the park and the household.
 * LakeLife administers the billing under it and is not a party to it, so it
 * holds no signature for it and never asks for one. What it can honestly do is
 * keep the file, and keep a record of who was handed it.
 *
 * Every sentence in this module obeys one rule: SENT and OPENED, never AGREED.
 * The difference is not pedantry. "19 of 21 agreed" is a claim about consent
 * that nothing here could support, and the moment a screen says it, somebody
 * relies on it.
 *
 * OPENED IS ONLY KNOWABLE FOR A LINK WE SERVED. Handed across the office
 * counter, the park knows it was delivered and cannot know it was read.
 * `deliveryState` returns `handed` for that rather than pretending, and the
 * database refuses an `opened_at` on any channel but email.
 */

export type DocumentKind =
  | "park_lease"
  | "park_rules"
  | "amenity_rules"
  | "notice"
  | "other";

export const DOCUMENT_KINDS: DocumentKind[] = [
  "park_lease", "park_rules", "amenity_rules", "notice", "other",
];

/**
 * KINDS THAT HAVE VERSIONS, and therefore supersede.
 *
 * A park has ONE current lease and ONE current rulebook, so filing a new one
 * retires the old. It does not have one current NOTICE: a rent-increase notice
 * in November and a water-shutoff notice in March are two documents, not two
 * versions of a document.
 *
 * Superseding on `kind` alone marked the November notice "Replaced by a newer
 * version" the moment the March one was filed, greyed it out, and removed its
 * delivery control — so the record of what nineteen households were told in
 * November read as obsolete, and nobody could be given it afterwards.
 */
export const VERSIONED_KINDS: DocumentKind[] = ["park_lease", "park_rules", "amenity_rules"];

/** What the owner calls each kind, in his words rather than the column's. */
export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  park_lease: "Lease",
  park_rules: "Park rules",
  amenity_rules: "Amenity rules",
  notice: "Notice",
  other: "Other document",
};

export type DeliveryChannel = "email" | "hand" | "post";

export const CHANNEL_LABEL: Record<DeliveryChannel, string> = {
  email: "Emailed",
  hand: "Handed over",
  post: "Posted",
};

export interface DeliveryRow {
  parkRenterId: string;
  displayName: string;
  channel: DeliveryChannel | null;
  sentAt: string | null;
  openedAt: string | null;
}

/**
 * NOT_SENT is a real state and the most important one on the screen — it is the
 * household nobody has given the document to.
 *
 * HANDED is deliberately not "sent": the park handed it over and cannot know
 * what happened next. Calling it sent would invite a reader to wonder why it
 * was never opened.
 */
export type DeliveryState = "not_sent" | "handed" | "sent" | "opened";

export function deliveryState(d: Pick<DeliveryRow, "channel" | "sentAt" | "openedAt">): DeliveryState {
  if (d.channel == null || d.sentAt == null) return "not_sent";
  if (d.openedAt != null) return "opened";
  // A channel we cannot hear back on. The record stops at delivery because
  // that is where the knowledge stops.
  if (d.channel !== "email") return "handed";
  return "sent";
}

export const DELIVERY_STATE_LABEL: Record<DeliveryState, string> = {
  not_sent: "Not sent yet",
  handed: "Handed over",
  sent: "Emailed — not opened yet",
  opened: "Opened",
};

/**
 * The line at the top of a document's card.
 *
 * COUNTS, NEVER PERCENTAGES. At twenty-one households "67% opened" is a
 * statistic about fourteen people, and the honest form is the fourteen.
 *
 * NAMES THE ONES NOBODY HAS GIVEN IT TO, while there are few enough to name —
 * that is the only actionable half of this sentence. "2 not sent" sends him to
 * another screen; "lot 6 and lot 14 haven't had it" is the answer.
 */
export function deliverySummary(
  rows: readonly DeliveryRow[],
  /** Households on the roll, which may exceed the rows if nobody has been given it. */
  households: number,
): string {
  if (households === 0) return "Nobody is on a lot yet, so there is nobody to give this to.";

  const states = rows.map(deliveryState);
  const sent = states.filter((s) => s !== "not_sent").length;
  const opened = states.filter((s) => s === "opened").length;
  const emailed = rows.filter(
    (r) => r.channel === "email" && r.sentAt != null,
  ).length;
  const missing = households - sent;

  if (sent === 0) {
    return `Filed, and nobody has been given it yet — all ${households} still to go.`;
  }

  const parts = [`Given to ${sent} of ${households}`];
  // Only ever quoted against the households who could have opened it. Counting
  // a handed-over copy in the denominator would make the park look ignored.
  if (emailed > 0) {
    parts.push(
      opened === emailed
        ? `all ${emailed} emailed ${emailed === 1 ? "copy has" : "copies have"} been opened`
        : `${opened} of the ${emailed} emailed opened`,
    );
  }
  if (missing > 0) {
    const names = rows.filter((r) => deliveryState(r) === "not_sent").map((r) => r.displayName);
    parts.push(
      names.length > 0 && names.length <= 4
        ? `not yet: ${names.join(", ")}`
        : `${missing} still to go`,
    );
  }
  return `${parts.join(" · ")}.`;
}

/**
 * Everything this screen must never say.
 *
 * Kept as data, and asserted against every sentence this module produces, so
 * the rule survives somebody rewording a card in six months. It is the whole
 * legal posture in one array.
 */
export const FORBIDDEN_WORDS = [
  "agreed", "agree", "signed", "sign", "accepted", "accept",
  "consented", "consent", "acknowledged",
];

/** True when a sentence stays inside the courier posture. */
export function saysOnlyCourier(sentence: string): boolean {
  const s = sentence.toLowerCase();
  return !FORBIDDEN_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(s));
}

// -------------------------------------------------------------- filing ----

export const MAX_DOC_BYTES = 10 * 1024 * 1024;

/** What a park may file. A lease is a document, not a spreadsheet. */
export const DOC_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;

export interface FileDocInput {
  kind: string;
  title: string;
  version: string;
  contentType: string;
  byteSize: number;
}

export interface FileDocPlan {
  ok: boolean;
  error?: string;
  row?: { kind: DocumentKind; title: string; version: string };
}

/**
 * Checked before a byte is uploaded, because a rejected file that is already in
 * the bucket is an orphan nothing will ever clean up.
 */
export function planFiling(input: FileDocInput): FileDocPlan {
  const title = input.title.trim();
  const version = input.version.trim();

  if (!(DOCUMENT_KINDS as string[]).includes(input.kind)) {
    return { ok: false, error: "Pick what kind of document this is." };
  }
  if (title.length < 2) {
    return { ok: false, error: "Give it a name residents will recognise." };
  }
  if (title.length > 120) return { ok: false, error: "That name is too long." };
  if (version.length < 1) {
    // Not defaulted to a date: a version is what HE calls it, and inventing
    // "2026-08-25" would put our label on his document.
    return { ok: false, error: "Give it a version — whatever you call this one." };
  }
  if (version.length > 40) return { ok: false, error: "That version label is too long." };

  if (!(DOC_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    return { ok: false, error: "Use a PDF, JPG, PNG, WEBP or HEIC file." };
  }
  if (input.byteSize <= 0) return { ok: false, error: "That file is empty." };
  if (input.byteSize > MAX_DOC_BYTES) {
    return { ok: false, error: "That file is too large (max 10MB)." };
  }

  return { ok: true, row: { kind: input.kind as DocumentKind, title, version } };
}
