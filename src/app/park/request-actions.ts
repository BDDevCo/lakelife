"use server";

import { lakeDaysSince, todayLakeDate } from "@/lib/booking";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage } from "@/lib/must-read";
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

/** How many of the queue we will put on one screen. */
const QUEUE_PAGE = 200;

export interface ParkRequestQueue {
  rows: ParkRequestRow[];
  /**
   * True when the queue is longer than one screenful.
   *
   * IT HAS TO BE SAID OUT LOUD. This used to be a bare `.limit(200)`: the
   * screen listed two hundred reports and looked exactly like a screen listing
   * all of them. 21 lots at a ceiling of 12 open each is 252 before office and
   * common-area reports are counted, so it is reachable — and a queue that
   * quietly drops the overflow is worse than one that admits it, because the
   * owner stops looking for what isn't shown.
   */
  more: boolean;
}

/**
 * The open queue, OLDEST FIRST.
 *
 * This was newest-first, which fought the screen's own argument: age is the
 * only urgency signal here, and newest-first puts the report that has sat for
 * six weeks at the bottom — then, once the list is longer than a page, drops
 * it entirely. The most urgent thing in the queue was the first thing cut.
 */
export async function getParkRequests(parkId: string): Promise<ParkRequestQueue> {
  const empty: ParkRequestQueue = { rows: [], more: false };
  if (!(await assertMyPark(parkId))) return empty;
  const admin = createServiceClient();

  // One more than we will show, so "is there more" is a fact rather than a
  // guess from a full page.
  //
  // AND `empty` IS A SENTENCE, NOT A BLANK. The screen renders "Nothing
  // reported" over an empty queue — told to an owner whose residents have been
  // filing water and sewer reports all week, that is the whole queue hidden
  // behind a calm line saying there is nothing to look at. A failed read
  // throws to the boundary instead; the page has no error channel of its own.
  const data = mustRead("what's been reported from your park", await admin
    .from("park_requests")
    .select("id, park_lot_id, category, note, reporter_name, reporter_phone, status, created_at, resolution_note")
    .eq("park_id", parkId)
    .neq("status", "done")
    .order("created_at", { ascending: true })
    .limit(QUEUE_PAGE + 1));
  if (!data?.length) return empty;

  const more = data.length > QUEUE_PAGE;
  return { rows: await shape(admin, data.slice(0, QUEUE_PAGE)), more };
}

/**
 * Recently closed, with what was done.
 *
 * Its own query, because it used to be `getParkRequests(id, true)` filtered
 * down to the done ones in the page — which meant the closed list was whatever
 * survived a 200-row page shared with the open queue. Once a park has had 200
 * reports, the answer to "what did we do about it" would have been silently
 * empty, and the button counting them would have said so with a straight face.
 */
export async function getClosedRequests(parkId: string, limit = 20): Promise<ParkRequestRow[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();
  // Same rule as the open queue: an empty list here is the screen's answer to
  // "what did we do about it", and a dropped read makes it "nothing".
  const data = mustRead("what's been closed", await admin
    .from("park_requests")
    .select("id, park_lot_id, category, note, reporter_name, reporter_phone, status, created_at, resolution_note")
    .eq("park_id", parkId)
    .eq("status", "done")
    .order("resolved_at", { ascending: false, nullsFirst: false })
    .limit(limit));
  if (!data?.length) return [];
  return shape(admin, data);
}

type Row = Record<string, unknown>;

async function shape(
  admin: ReturnType<typeof createServiceClient>,
  data: Row[],
): Promise<ParkRequestRow[]> {
  const lotIds = [...new Set(data.map((r) => r.park_lot_id as string).filter(Boolean))];
  const lotNo = new Map<string, string>();
  if (lotIds.length) {
    // Called only from the two loaders above, both of which already throw. A
    // failed read here would print "?" against every report on the screen —
    // the same mark a genuinely unknown lot gets, so nothing distinguishes a
    // whole queue whose lot numbers we could not read.
    const lots = mustRead("the lot numbers", await admin
      .from("park_lots").select("id, lot_number").in("id", lotIds));
    for (const l of lots ?? []) lotNo.set(l.id as string, (l.lot_number as string) ?? "?");
  }
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
    // LAKE CALENDAR DAYS, NOT ELAPSED HOURS. Flooring elapsed time called a
    // report filed at 8pm last night "today" all the next morning. This
    // expression exists twice — here and on the other screen that shows the
    // same rows — so both were wrong in the same way.
    ageDays: lakeDaysSince(r.created_at as string, todayLakeDate()),
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
    // "That lot isn't in this park" is a flat assertion about his own
    // inventory, and a failed read has no fact behind it — he would retype the
    // report against a lot that is sitting right there on his screen.
    const lotRes = await admin
      .from("park_lots").select("id").eq("id", lotId).eq("park_id", parkId).maybeSingle();
    if (lotRes.error) {
      return { ok: false, error: readFailedMessage("that lot", lotRes.error) };
    }
    if (!lotRes.data) return { ok: false, error: "That lot isn't in this park." };
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

  // "No live lots to make stickers for" told to a park with twenty-one of them
  // is a sentence he cannot argue with from where he is standing — and it is
  // the only thing between him and the stickers.
  const lotsRes = await admin
    .from("park_lots")
    .select("id, lot_number, qr_token, lifecycle")
    .eq("park_id", parkId)
    .eq("lifecycle", "live")
    .order("lot_number");
  if (lotsRes.error) {
    return { ok: false, error: readFailedMessage("your live lots", lotsRes.error) };
  }
  const lots = lotsRes.data;
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

  const afterRes = await admin
    .from("park_lots")
    .select("id, lot_number, qr_token")
    .eq("park_id", parkId)
    .eq("lifecycle", "live")
    .not("qr_token", "is", null)
    .order("lot_number");
  // A DROPPED READ HERE PRINTS A SHORT SHEET. `rows` would come back empty
  // under a signal that says the stickers are ready — or, worse, partial:
  // he prints what came back, screws them to those posts, and the lots that
  // were missing from the read have no sticker and nobody ever finds out.
  // Minting is idempotent (a token is never overwritten), so refusing costs
  // nothing but a retry.
  if (afterRes.error) {
    console.error("[read failed] the stickers on your lots:", afterRes.error);
    return {
      ok: false,
      error:
        "We couldn't read your stickers back just now, so there's nothing to " +
        "print yet. Any already made are kept — try again in a moment.",
    };
  }
  const after = afterRes.data;

  // A STICKER WITH A RELATIVE URL IS A DEAD STICKER, FOREVER.
  //
  // Without the site URL this produced "/fix/abc123" — which is a working link
  // in a browser that is already on the site, and a meaningless string once it
  // is a QR code screwed to a post. Nobody would find out until a report never
  // arrived. Refuse to hand over anything printable rather than print rubbish.
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      error:
        "The site address isn't configured, so these would print as links that " +
        "go nowhere. Set NEXT_PUBLIC_SITE_URL first — a sticker is permanent " +
        "once it's on a post.",
    };
  }

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
