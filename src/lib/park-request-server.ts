import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount, readFailedMessage } from "@/lib/must-read";
import { isBearerToken, STICKER_MIN } from "@/lib/token-format";

/**
 * THE QR STICKER'S OWN SERVER SIDE — no login, no account, no session.
 *
 * A sticker on a lot pedestal is readable by anyone standing in the park, so
 * everything here is written on the assumption that the caller is a stranger:
 *
 *   IT REVEALS ONLY THE LOT AND THE PARK. Never the household. That is the
 *   same line 0085 drew for the owner's visit log — a person may learn what
 *   they could learn by standing there and not one thing more. A QR that
 *   answered "Dave Smith, Lot 7" would be a tenant directory on a post.
 *
 *   IT READS NOTHING BACK. There is no "here are the other reports on this
 *   lot". The sticker is a way in, not a way to browse what neighbours said.
 *
 *   THE LOOKUP IS SAFE. Rendering the form writes nothing, because link
 *   preview fetchers, messaging apps and school filters all issue GETs — and
 *   a GET that filed a request would fill the owner's queue with ghosts.
 */

export interface StickerView {
  lotId: string;
  lotNumber: string;
  parkId: string;
  parkName: string;
  /** True when this lot already has more open reports than anyone can action. */
  flooded: boolean;
}

/**
 * How many open reports one lot may carry before the form stops accepting.
 *
 * THIS NUMBER IS NOT THE ENFORCEMENT. 0106 holds the real one, in a trigger
 * that locks the lot row before counting. This copy exists only so a person
 * standing at a pedestal gets a sentence instead of a database error — the
 * check below reads the count and then inserts, and between those two things
 * any number of concurrent submissions can slip through.
 *
 * Change one, change the other.
 */
const OPEN_PER_LOT_CAP = 12;

export async function loadSticker(token: string): Promise<StickerView | null> {
  // Was `token.length < 6` — six characters of anything reached `.eq()`.
  // STICKER_MIN by name, not the default: qr_token is minted as randomUUID cut
  // to 20 (park/request-actions.ts), so this is the one caller that genuinely
  // holds a shorter credential, and it says so rather than lowering the floor
  // for everybody else.
  if (!isBearerToken(token, STICKER_MIN)) return null;
  const admin = createServiceClient();

  const lot = mustRead("the lot on the sticker", await admin
    .from("park_lots")
    .select("id, lot_number, park_id, lifecycle")
    .eq("qr_token", token)
    .maybeSingle());
  if (!lot) return null;

  // LIFECYCLE, AND DELIBERATELY NOT `active`.
  //
  // 0065 draws the line: lifecycle is whether the lot EXISTS, `active` is
  // whether it is currently OFFERED — "bookable = active AND lifecycle =
  // live". A lot taken off the market still has somebody living on it, and
  // their water riser still leaks. Refusing their report because the owner is
  // not advertising the lot would be the software enforcing a marketing
  // decision against a resident.
  //
  // A retired lot's sticker takes nothing, and says nothing about WHY —
  // that is park business, not a stranger's.
  if (lot.lifecycle && lot.lifecycle !== "live") return null;

  const park = mustRead("the park", await admin
    .from("parks").select("id, name").eq("id", lot.park_id as string).maybeSingle());
  if (!park) return null;

  // FAILS OPEN IF LEFT ALONE. `(count ?? 0) >= CAP` is false when the count is
  // NULL, and a failed count IS null — so a dropped read switched the courtesy
  // ceiling off entirely. 0106's trigger is still the real ceiling, so nothing
  // could be buried; what was lost is the sentence that stops a person at the
  // pedestal typing a report the database is about to refuse.
  const count = mustCount("how many reports are already open", await admin
    .from("park_requests")
    .select("id", { count: "exact", head: true })
    .eq("park_lot_id", lot.id as string)
    .neq("status", "done"));

  return {
    lotId: lot.id as string,
    lotNumber: (lot.lot_number as string) ?? "?",
    parkId: park.id as string,
    parkName: (park.name as string) ?? "the park",
    flooded: count >= OPEN_PER_LOT_CAP,
  };
}

export const REQUEST_CATEGORIES = [
  { value: "water", label: "Water" },
  { value: "sewer", label: "Sewer" },
  { value: "electric", label: "Electric" },
  { value: "road", label: "Road or parking" },
  { value: "tree", label: "Tree or branch" },
  { value: "trash", label: "Trash" },
  { value: "lighting", label: "Lighting" },
  { value: "other", label: "Something else" },
] as const;

const VALID = new Set(REQUEST_CATEGORIES.map((c) => c.value as string));

/**
 * File it. The only write a stranger can make in this whole product.
 *
 * Nothing here trusts an id from the browser: the lot and the park are both
 * resolved from the TOKEN, which came off a sticker screwed to a post.
 */
export async function fileRequestByToken(input: {
  token: string;
  category: string;
  note: string;
  name?: string;
  phone?: string;
}): Promise<{ ok: boolean; error?: string; signal?: string }> {
  // `loadSticker` throws on a failed read so the GET renders honestly; this
  // form is awaiting { ok, error }, so it becomes a sentence here instead of
  // "this sticker doesn't match a lot", which would send somebody to the office
  // about a perfectly good sticker.
  let view: StickerView | null;
  try {
    view = await loadSticker(input.token);
  } catch (e) {
    return { ok: false, error: readFailedMessage("the lot on the sticker", e) };
  }
  if (!view) return { ok: false, error: "This sticker doesn't match a lot — tell the office." };

  const note = (input.note ?? "").trim();
  if (note.length < 3) return { ok: false, error: "Tell us what's wrong, even in a few words." };
  if (note.length > 2000) return { ok: false, error: "That's very long — the short version is fine." };
  const category = VALID.has(input.category) ? input.category : "other";

  // A PUBLIC FORM WITH NO LOGIN NEEDS A CEILING. Not to stop a determined
  // person — it cannot — but so a stuck submit button or a bored teenager
  // cannot bury the twelve real reports the owner has to work through.
  //
  // This is the COURTESY check, not the ceiling. It reads a count taken a
  // moment ago; the ceiling itself is 0106's trigger, which locks the lot
  // before counting and is the only thing a burst of parallel submissions
  // actually meets.
  const FLOODED =
    "There are already several open reports for this lot. Please ring the office so they don't get missed.";
  if (view.flooded) return { ok: false, error: FLOODED };

  const admin = createServiceClient();
  const { error } = await admin.from("park_requests").insert({
    park_id: view.parkId,
    park_lot_id: view.lotId,
    category,
    note,
    reporter_name: (input.name ?? "").trim().slice(0, 120) || null,
    reporter_phone: (input.phone ?? "").trim().slice(0, 40) || null,
    source: "qr",
  });
  if (error) {
    // The trigger refusing a full lot is not a failure to send — it is the
    // same answer the check above gives, arriving a moment later because
    // somebody else's report landed in between. Telling that person "that
    // didn't send" would invite them to keep trying.
    if (error.message?.includes("park_requests: lot")) {
      return { ok: false, error: FLOODED };
    }
    return { ok: false, error: "That didn't send — please ring the office." };
  }

  return {
    ok: true,
    signal: `Thanks — ${view.parkName} has it, for lot ${view.lotNumber}.`,
  };
}
