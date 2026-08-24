import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { acceptancesFor, type AcceptanceKind } from "@/lib/acceptances";
import { TOS_VERSION } from "@/lib/tos";

/**
 * WHAT HAVE I AGREED TO?
 *
 * Every acceptance has snapshotted the exact words since 0139, and until now
 * nothing read them back. A record kept only for a dispute is a record the
 * person it is about has never seen — and the point of snapshotting the words
 * rather than a version string was that somebody could be shown, later,
 * precisely what was on their screen.
 *
 * ONE PAGE FOR ALL FOUR ROLES. A homeowner, a crew, a park owner and a resident
 * agree to the same document and are asked in four different places; giving
 * each of them their own version of this screen is four chances to word it
 * differently about the same rows.
 *
 * IDENTITY COMES FROM THE SESSION, never from an argument. There is nothing on
 * the wire to forge — the crew-invite lesson, kept.
 */

export interface AgreementLine {
  id: string;
  kind: AcceptanceKind;
  /** "Terms of service" — a person's word for the kind, never the enum. */
  label: string;
  version: string | null;
  occurredAt: string;
  act: "accepted" | "withdrawn";
  /** The words, verbatim. Null when they were never captured. */
  text: string | null;
  /** False = we hold no record of the wording, and must say so. */
  wordsWereKept: boolean;
  /**
   * WHERE THIS ROW STANDS, in one word the reader can act on.
   *
   * Two cards both titled "Terms of service" with a badge on only one of them
   * makes the other look broken rather than superseded. Every row says which
   * it is:
   *
   *   in_force    — this is the version being enforced right now
   *   replaced    — you agreed again later; that newer row is the live one
   *   out_of_date — the terms have moved on and you have not re-agreed, so
   *                 you will be asked next time. Worth saying: it explains a
   *                 gate they are about to meet.
   *   withdrawn   — you took it back. The row stays; that is the point.
   */
  standing: "in_force" | "replaced" | "out_of_date" | "withdrawn";
}

export interface TextConsentLine {
  parkName: string;
  /** The sentence she read, snapshotted at the tap (0133). */
  sentence: string | null;
  consentedAt: string;
  number: string | null;
}

export interface MyAgreements {
  lines: AgreementLine[];
  textConsents: TextConsentLine[];
  /** True when they have never agreed to anything at all. */
  empty: boolean;
}

const LABELS: Record<AcceptanceKind, string> = {
  tos: "Terms of service",
  privacy: "Privacy policy",
  park_rules: "Park rules",
  park_lease: "Lease",
  amenity_rules: "Rules for something you booked",
};

export async function myAgreements(): Promise<MyAgreements | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Throws rather than returning an empty list: "you have never agreed to
  // anything" is a strong statement to make to somebody who has, and this
  // screen exists precisely to be trusted about what is on file.
  const rows = await acceptancesFor({ userId: user.id });

  const lines: AgreementLine[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: LABELS[r.kind] ?? "Agreement",
    version: r.version,
    occurredAt: r.occurredAt,
    act: r.act,
    text: r.text,
    wordsWereKept: r.wordsWereKept,
    standing: "out_of_date",   // replaced immediately below, once the whole
                               // history for each kind is in hand
  }));

  // STANDING NEEDS THE WHOLE LIST, not one row. "Replaced" is a statement about
  // a row that exists further up, so it cannot be decided while mapping.
  // `rows` arrives newest-first (acceptancesFor orders it), so the first
  // accepted row of a kind is the one that counts.
  const seenAccepted = new Set<string>();
  for (const line of lines) {
    if (line.act === "withdrawn") {
      line.standing = "withdrawn";
      continue;
    }
    if (seenAccepted.has(line.kind)) {
      line.standing = "replaced";
      continue;
    }
    seenAccepted.add(line.kind);
    // Only OUR documents carry a version we control and can compare against.
    // A park's rulebook has no version scheme of ours, so the newest
    // acceptance of it is simply the one in force.
    const current = line.kind === "tos" ? TOS_VERSION : line.version;
    line.standing = line.version === current ? "in_force" : "out_of_date";
  }

  // ---- the text consent, which has lived unread since it was built ---------
  //
  // Not in the ledger: SMS consent has its own guarded home on park_renters,
  // where triggers clear it if the number changes without fresh proof (0135,
  // 0136) or the file is released (0134). Moving it here would mean unpicking
  // those. It belongs on this SCREEN either way — it is a thing she agreed to,
  // and 0133 snapshotted the sentence specifically so it could be shown back.
  const admin = createServiceClient();
  const files = mustRead(
    "your park file",
    await admin
      .from("park_renters")
      .select("park_id, mobile_e164, sms_consent_operational_at, sms_consent_text")
      .eq("user_id", user.id)
      .not("sms_consent_operational_at", "is", null),
  );

  const textConsents: TextConsentLine[] = [];
  if (files?.length) {
    const parkIds = [...new Set(files.map((f) => f.park_id as string))];
    const parks = mustRead(
      "your park",
      await admin.from("parks").select("id, name").in("id", parkIds),
    );
    const nameById = new Map((parks ?? []).map((p) => [p.id as string, p.name as string]));
    for (const f of files) {
      textConsents.push({
        parkName: nameById.get(f.park_id as string) ?? "your park",
        sentence: (f.sms_consent_text as string) ?? null,
        consentedAt: f.sms_consent_operational_at as string,
        number: (f.mobile_e164 as string) ?? null,
      });
    }
  }

  return {
    lines,
    textConsents,
    empty: lines.length === 0 && textConsents.length === 0,
  };
}
