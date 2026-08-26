"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { assertMyPark } from "./data";
import { sendEmail } from "@/lib/email";
import {
  planFiling, deliverySummary, DOCUMENT_KIND_LABEL,
  type DeliveryChannel, type DeliveryRow, type DocumentKind,
} from "./document-helpers";
import type { ParkResult } from "./actions";

/**
 * FILING THE PARK'S OWN DOCUMENTS, AND LOGGING WHO WAS GIVEN THEM.
 *
 * COURIER, NOT WITNESS. Nothing in this file collects, stores or asks for a
 * signature. A lease is between the park and the household; LakeLife
 * administers the billing under it and is not a party to it. What it does is
 * keep the file and keep a record of delivery — and the database refuses to
 * grow a column that would record assent (0140).
 */

const DENIED = "You don't manage that park.";
const BUCKET = "park-docs";

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export interface FiledDocument {
  id: string;
  kind: DocumentKind;
  title: string;
  version: string;
  sha256: string;
  byteSize: number;
  filedAt: string;
  supersededAt: string | null;
  /** One row per household on the roll, whether or not they have had it. */
  deliveries: DeliveryRow[];
  summary: string;
}

export interface DocumentsPage {
  documents: FiledDocument[];
  households: number;
}

/**
 * Everything filed, with a delivery row per household.
 *
 * The delivery list is built from the ROLL, not from the deliveries — a
 * household nobody has given the document to has no delivery row, and it is
 * the single most important line on the screen. Listing only what was sent
 * would make an empty log and a complete one look identical.
 */
export async function listDocuments(parkId: string): Promise<DocumentsPage> {
  const empty: DocumentsPage = { documents: [], households: 0 };
  if (!(await assertMyPark(parkId))) return empty;

  const admin = createServiceClient();

  const renters = mustRead("the households on your roll", await admin
    .from("park_renters").select("id, display_name").eq("park_id", parkId));
  const renterName = new Map((renters ?? []).map((r) => [r.id as string, r.display_name as string]));

  const docs = mustRead("your filed documents", await admin
    .from("park_documents")
    .select("id, kind, title, version, sha256, byte_size, filed_at, superseded_at")
    .eq("park_id", parkId)
    .order("filed_at", { ascending: false }));

  const ids = (docs ?? []).map((d) => d.id as string);
  // An empty delivery log is a real answer and a dropped read is not. Swallowed,
  // every document would read as "nobody has been given it" and he would send
  // twenty households a second copy.
  const deliveries = ids.length
    ? mustRead("your delivery log", await admin
        .from("park_document_deliveries")
        .select("document_id, park_renter_id, channel, sent_at, opened_at")
        .in("document_id", ids))
    : ([] as Record<string, unknown>[]);

  const byDoc = new Map<string, Map<string, Record<string, unknown>>>();
  for (const d of deliveries ?? []) {
    const k = d.document_id as string;
    if (!byDoc.has(k)) byDoc.set(k, new Map());
    byDoc.get(k)!.set(d.park_renter_id as string, d);
  }

  const documents: FiledDocument[] = (docs ?? []).map((d) => {
    const sent = byDoc.get(d.id as string) ?? new Map();
    const rows: DeliveryRow[] = [...renterName.entries()].map(([id, name]) => {
      const row = sent.get(id);
      return {
        parkRenterId: id,
        displayName: name,
        channel: (row?.channel as DeliveryChannel) ?? null,
        sentAt: (row?.sent_at as string) ?? null,
        openedAt: (row?.opened_at as string) ?? null,
      };
    });
    return {
      id: d.id as string,
      kind: d.kind as DocumentKind,
      title: d.title as string,
      version: d.version as string,
      sha256: d.sha256 as string,
      byteSize: Number(d.byte_size),
      filedAt: d.filed_at as string,
      supersededAt: (d.superseded_at as string) ?? null,
      deliveries: rows,
      summary: deliverySummary(rows, renterName.size),
    };
  });

  return { documents, households: renterName.size };
}

/**
 * File one document.
 *
 * VALIDATED BEFORE A BYTE IS UPLOADED. A file rejected after the upload is an
 * orphan in the bucket that nothing will ever clean up, and the bucket has no
 * lifecycle rule.
 *
 * THE DIGEST IS TAKEN FROM THE BYTES WE ACTUALLY STORED, not from anything the
 * browser said, because its whole job is to answer "is this the file that was
 * delivered" a year from now.
 */
export async function fileDocument(parkId: string, form: FormData): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No file received." };

  const plan = planFiling({
    kind: String(form.get("kind") ?? ""),
    title: String(form.get("title") ?? ""),
    version: String(form.get("version") ?? ""),
    contentType: file.type,
    byteSize: file.size,
  });
  if (!plan.ok || !plan.row) return { ok: false, error: plan.error };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const admin = createServiceClient();

  // The same file filed twice under the same version is almost certainly a
  // double tap, and the unique index would refuse the row AFTER the upload.
  const existing = mustRead("what you have already filed", await admin
    .from("park_documents")
    .select("id, sha256")
    .eq("park_id", parkId)
    .eq("kind", plan.row.kind)
    .eq("version", plan.row.version));
  if ((existing ?? []).length > 0) {
    return {
      ok: false,
      error: `You already have a ${DOCUMENT_KIND_LABEL[plan.row.kind].toLowerCase()} filed as "${plan.row.version}". Give this one a different version.`,
    };
  }

  const ext = file.type === "application/pdf" ? "pdf" : (file.type.split("/")[1] ?? "bin");
  const path = `${parkId}/${plan.row.kind}-${sha256.slice(0, 16)}.${ext}`;

  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  // A path collision means the identical bytes are already stored, which is
  // fine — the row below is what makes it a filed document.
  if (upErr && !/exists/i.test(upErr.message)) {
    return { ok: false, error: "Couldn't store that file — try again." };
  }

  const { data: row, error } = await admin
    .from("park_documents")
    .insert({
      park_id: parkId,
      kind: plan.row.kind,
      title: plan.row.title,
      version: plan.row.version,
      storage_path: path,
      sha256,
      byte_size: file.size,
      content_type: file.type,
      filed_by: await currentUserId(),
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: "Couldn't file that — try again." };

  // SUPERSEDED, NEVER REPLACED. The older version is what nineteen households
  // were actually given, and deleting it would destroy the only record of what
  // was sent. It stops being the current one and stays readable for ever.
  const prior = mustRead("the version this replaces", await admin
    .from("park_documents")
    .select("id")
    .eq("park_id", parkId)
    .eq("kind", plan.row.kind)
    .is("superseded_at", null)
    .neq("id", row.id));
  for (const p of prior ?? []) {
    await admin
      .from("park_documents")
      .update({ superseded_at: new Date().toISOString(), superseded_by: row.id })
      .eq("id", p.id as string);
  }

  revalidatePath("/park/documents");
  return { ok: true, signal: `${plan.row.title} filed.` };
}

/** A short-lived link for the OWNER to read what he filed. Never public. */
export async function documentUrl(
  parkId: string, documentId: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("park_documents").select("storage_path")
    .eq("id", documentId).eq("park_id", parkId).maybeSingle();
  if (error) return { ok: false, error: readFailedMessage("that document", error) };
  if (!data) return { ok: false, error: "That document isn't yours." };
  const signed = await admin.storage.from(BUCKET).createSignedUrl(data.storage_path as string, 3600);
  if (signed.error || !signed.data) return { ok: false, error: "Couldn't open that file." };
  return { ok: true, url: signed.data.signedUrl };
}

/**
 * Record that a household was given a document.
 *
 * THREE CHANNELS, AND ONLY ONE OF THEM CAN EVER REPORT BACK. Emailing serves a
 * link, and opening it stamps the row. Handing it over at the window or putting
 * it in the post is delivery the park witnessed and nothing more — 0140 refuses
 * an `opened_at` for either, so no screen can later imply it was read.
 */
export async function recordDeliveries(
  parkId: string,
  documentId: string,
  renterIds: string[],
  channel: DeliveryChannel,
): Promise<ParkResult & { failed?: { name: string; why: string }[] }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (renterIds.length === 0) return { ok: false, error: "Pick who was given it." };

  const admin = createServiceClient();

  const doc = mustRead("that document", await admin
    .from("park_documents")
    .select("id, title, storage_path")
    .eq("id", documentId).eq("park_id", parkId));
  if ((doc ?? []).length === 0) return { ok: false, error: "That document isn't yours." };

  // Scoped to THIS park, so a renter id from somewhere else cannot be posted in.
  const renters = mustRead("those households", await admin
    .from("park_renters")
    .select("id, display_name, email")
    .eq("park_id", parkId)
    .in("id", renterIds));

  const failed: { name: string; why: string }[] = [];
  let done = 0;

  for (const r of renters ?? []) {
    const name = (r.display_name as string) ?? "That household";
    const email = (r.email as string) ?? null;

    if (channel === "email" && !email) {
      failed.push({ name, why: "No email on file — hand it over or post it instead." });
      continue;
    }

    const token = channel === "email" ? randomUUID().replace(/-/g, "") : null;
    const { error } = await admin.from("park_document_deliveries").insert({
      document_id: documentId,
      park_renter_id: r.id as string,
      channel,
      token,
    });
    if (error) {
      // 23505: already logged. Delivering twice is not an error worth stopping
      // an afternoon for, and the first delivery is the one that counts.
      failed.push({
        name,
        why: error.code === "23505" ? "Already logged as given it." : "Couldn't log that one.",
      });
      continue;
    }

    if (channel === "email" && token) {
      const base = process.env.NEXT_PUBLIC_SITE_URL ?? "";
      const res = await sendEmail({
        to: email!,
        subject: `${doc![0].title as string} — from your park`,
        html:
          `<p>Your park has sent you a document: <b>${doc![0].title as string}</b>.</p>` +
          `<p><a href="${base}/doc/${token}">Open it here</a></p>` +
          // THE SENTENCE THAT KEEPS THIS HONEST. It is a delivery, not a
          // request for agreement, and the email must not read as one.
          `<p style="color:#5D7681;font-size:13px">This link just opens the document. ` +
          `Your agreement is with the park — LakeLife handles the billing and isn't a party to it.</p>`,
      });
      if (!res.ok) failed.push({ name, why: "Logged, but the email didn't go out." });
    }
    done += 1;
  }

  revalidatePath("/park/documents");
  if (done === 0) return { ok: false, error: "None of those could be logged.", failed };
  return {
    ok: true,
    failed,
    signal: `Logged for ${done} ${done === 1 ? "household" : "households"}.`,
  };
}
