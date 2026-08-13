"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { assertMyPark } from "./data";

/**
 * THE OWNER'S SIDE OF THE QR STICKER.
 *
 * The renter's side needs no login and lives in `src/lib/park-request-server.ts`.
 * This is the queue those reports land in, plus minting the tokens the stickers
 * carry.
 */

const DENIED = "You don't manage that park.";

export interface RequestResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

export interface ParkRequestRow {
  id: string;
  lotNumber: string | null;
  category: string;
  note: string;
  reporterName: string | null;
  reporterPhone: string | null;
  status: string;
  createdAt: string;
  ageDays: number;
  resolutionNote: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  water: "Water", sewer: "Sewer", electric: "Electric", road: "Road or parking",
  tree: "Tree or branch", trash: "Trash", lighting: "Lighting", other: "Something else",
};

export async function getParkRequests(
  parkId: string,
  includeDone = false,
): Promise<ParkRequestRow[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  let q = admin
    .from("park_requests")
    .select("id, park_lot_id, category, note, reporter_name, reporter_phone, status, created_at, resolution_note")
    .eq("park_id", parkId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (!includeDone) q = q.neq("status", "done");

  const { data } = await q;
  if (!data?.length) return [];

  const lotIds = [...new Set(data.map((r) => r.park_lot_id as string).filter(Boolean))];
  const lotNo = new Map<string, string>();
  if (lotIds.length) {
    const { data: lots } = await admin
      .from("park_lots").select("id, lot_number").in("id", lotIds);
    for (const l of lots ?? []) lotNo.set(l.id as string, (l.lot_number as string) ?? "?");
  }

  const now = Date.now();
  return data.map((r) => ({
    id: r.id as string,
    // Null is a COMMON-AREA report — the road, the mailboxes — not a missing
    // lot. The screen says so rather than printing a bare dash.
    lotNumber: r.park_lot_id ? (lotNo.get(r.park_lot_id as string) ?? "?") : null,
    category: CATEGORY_LABEL[r.category as string] ?? (r.category as string),
    note: (r.note as string) ?? "",
    reporterName: (r.reporter_name as string) ?? null,
    reporterPhone: (r.reporter_phone as string) ?? null,
    status: (r.status as string) ?? "new",
    createdAt: (r.created_at as string) ?? "",
    ageDays: Math.max(0, Math.floor((now - Date.parse(r.created_at as string)) / 86_400_000)),
    resolutionNote: (r.resolution_note as string) ?? null,
  }));
}

/** Picked it up. Says somebody has it, without claiming it is finished. */
export async function takeRequest(parkId: string, requestId: string): Promise<RequestResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("park_requests")
    .update({ status: "in_hand" })
    .eq("id", requestId).eq("park_id", parkId).eq("status", "new")
    .select("id");
  if (error) return { ok: false, error: "Couldn't update that — try again." };
  if (!data?.length) return { ok: false, error: "Somebody already picked that one up." };
  revalidatePath("/park/today");
  return { ok: true, signal: "Marked as yours." };
}

/**
 * Close it, and SAY WHAT WAS DONE.
 *
 * The note is required by the database as well. In six months "we fixed it" is
 * the only answer to a household asking why nothing changed — and the same
 * rule already governs a waived fee, a reversal and a voided bill.
 */
export async function resolveRequest(
  parkId: string,
  requestId: string,
  note: string,
): Promise<RequestResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const what = (note ?? "").trim();
  if (!what) return { ok: false, error: "Say what you did — it's the only record there'll be." };
  if (what.length > 2000) return { ok: false, error: "That's a bit long — a sentence is plenty." };

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("park_requests")
    .update({ status: "done", resolved_at: new Date().toISOString(), resolution_note: what })
    .eq("id", requestId).eq("park_id", parkId).neq("status", "done")
    .select("id");
  if (error) return { ok: false, error: `Couldn't close that — ${error.message}` };
  if (!data?.length) return { ok: false, error: "That one is already closed." };
  revalidatePath("/park/today");
  return { ok: true, signal: "Closed, with what you did on the record." };
}

/** A report taken over the phone or at the window. Same queue, honest source. */
export async function logRequestForLot(
  parkId: string,
  lotId: string | null,
  category: string,
  note: string,
): Promise<RequestResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const what = (note ?? "").trim();
  if (what.length < 3) return { ok: false, error: "Say what's wrong." };

  const admin = createServiceClient();
  if (lotId) {
    // The lot must be in THIS park — the id comes from a browser.
    const { data: lot } = await admin
      .from("park_lots").select("id").eq("id", lotId).eq("park_id", parkId).maybeSingle();
    if (!lot) return { ok: false, error: "That lot isn't in this park." };
  }

  const { error } = await admin.from("park_requests").insert({
    park_id: parkId,
    park_lot_id: lotId,
    category,
    note: what,
    source: "phone",
  });
  if (error) return { ok: false, error: `Couldn't log that — ${error.message}` };
  revalidatePath("/park/today");
  return { ok: true, signal: "Logged." };
}

export interface StickerRow {
  lotId: string;
  lotNumber: string;
  url: string;
}

/**
 * MINT THE STICKERS.
 *
 * A token is printed and screwed to a post, so it is minted ONCE and never
 * rotated casually — a lot that already has one keeps it. Rotating would
 * silently kill a sticker that is still on the pedestal, and nobody would find
 * out until a report never arrived.
 */
export async function mintStickers(parkId: string): Promise<{
  ok: boolean;
  error?: string;
  signal?: string;
  rows?: StickerRow[];
}> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();

  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number, qr_token, lifecycle")
    .eq("park_id", parkId)
    .eq("lifecycle", "live")
    .order("lot_number");
  if (!lots?.length) return { ok: false, error: "No live lots to make stickers for." };

  let minted = 0;
  for (const l of lots) {
    if (l.qr_token) continue;
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const { error } = await admin
      .from("park_lots")
      .update({ qr_token: token })
      .eq("id", l.id as string)
      .is("qr_token", null);      // never overwrite a sticker already on a post
    if (!error) minted += 1;
  }

  const { data: after } = await admin
    .from("park_lots")
    .select("id, lot_number, qr_token")
    .eq("park_id", parkId)
    .eq("lifecycle", "live")
    .not("qr_token", "is", null)
    .order("lot_number");

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const rows: StickerRow[] = (after ?? []).map((l) => ({
    lotId: l.id as string,
    lotNumber: (l.lot_number as string) ?? "?",
    url: `${base}/fix/${l.qr_token as string}`,
  }));

  revalidatePath("/park/today");
  return {
    ok: true,
    rows,
    signal: minted > 0
      ? `${minted} new ${minted === 1 ? "sticker" : "stickers"} ready to print.`
      : "Every live lot already has one.",
  };
}
