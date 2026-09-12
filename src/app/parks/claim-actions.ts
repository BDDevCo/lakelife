"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { mintClaimCode, normalizeClaimCode } from "@/lib/claim-code";
import { LOT_WORD, LOT_WORDS } from "@/lib/roll-parse";
import {
  claimSays, claimWorked, issueSays, issueWorked, officeCanReprint,
} from "@/lib/park-claim-copy";


/**
 * Accept either the park's slug ("the-haven") or its name as printed on the
 * slip ("The Haven"). Returns the slug the RPC expects — and the park's id,
 * so the lot can be resolved against the park's own lots — or, if nothing
 * matches, the input slugified and no id, so the RPC's own "park not open"
 * answer stands.
 */
async function resolveParkSlug(typed: string): Promise<{ slug: string; id: string | null }> {
  const asSlug = typed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const admin = createServiceClient();
  const bySlug = await admin.from("parks").select("id, slug").eq("slug", asSlug).maybeSingle();
  if (bySlug.data?.slug) return { slug: bySlug.data.slug as string, id: (bySlug.data.id as string) ?? null };
  const byName = await admin.from("parks").select("id, slug").ilike("name", typed).maybeSingle();
  if (byName.data?.slug) return { slug: byName.data.slug as string, id: (byName.data.id as string) ?? null };
  return { slug: asSlug, id: null };
}

/**
 * A lot label reduced to what identifies it: no "#", no lot word — however
 * many times it is written, because the slip prints "Lot" in front of a
 * label that may already carry it ("Lot LOT22") — no spaces, one case.
 * "Lotus" keeps its Lot: a word only comes off ahead of a digit.
 */
const LOT_WORD_RUN = new RegExp(`^(?:${LOT_WORDS.join("|")})+(?=\\d)`, "i");
const lotKey = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase().replace(LOT_WORD_RUN, "");

/**
 * THE PARK'S OWN SPELLING OF THE LOT SHE MEANS.
 *
 * `claim_park_file` matches `lot_number` exactly, and the park's lots are
 * not all spelt the same way: the importer stores "14", `addLots` stores
 * "LOT22", and a lot made by hand is stored as typed. A door that only
 * stripped the word turned the stored "LOT22" into a "22" the RPC could not
 * find — the lot existed, the slip was right, and she was refused.
 *
 * So: the park's lots are read, and the one whose whole label she typed
 * wins; failing that, the one that reduces to the same key. When nothing
 * matches, or two lots reduce to one key and neither is what she typed, or
 * the read fails — a failed read is not an empty one — the stripped form
 * goes through and the RPC gives its own answer.
 */
async function resolveLotNumber(parkId: string | null, typed: string, stripped: string): Promise<string> {
  if (!parkId) return stripped;
  const admin = createServiceClient();
  const res = await admin.from("park_lots").select("lot_number").eq("park_id", parkId);
  // Logged, as every other failure in this file is: on a park whose lots
  // carry the word, a read that fails here sends the stripped form, the RPC
  // answers no such lot, and she is told nobody lives there — a confident
  // sentence caused by a failed read, with nothing in the logs to say so.
  if (res.error) console.error("[claim] lots read failed", res.error.message);
  if (res.error || !res.data) return stripped;
  const labels = res.data.map((l: { lot_number: unknown }) => String(l.lot_number));
  const whole = labels.find((l) => l.toUpperCase() === typed.toUpperCase());
  if (whole !== undefined) return whole;
  const key = lotKey(typed);
  const byKey = key ? labels.filter((l) => lotKey(l) === key) : [];
  return byKey.length === 1 ? byKey[0] : stripped;
}
/**
 * THE TWO ENDS OF A SLIP OF PAPER.
 *
 * Everything of consequence happens in the database (0128, 0129). These
 * functions carry a string there and a sentence back; they decide nothing.
 * That is on purpose — every rule that matters is in a trigger or a SECURITY
 * DEFINER function, so a future caller written in a hurry cannot skip one.
 *
 * ============================================================================
 * THE USER-SCOPED CLIENT, NOT THE SERVICE ROLE.
 *
 * Every other file under src/app/park* reaches for `createServiceClient()`,
 * which bypasses RLS and carries no session. Claiming must NOT: the whole
 * design rests on the person being `auth.uid()` — a fact the database reads
 * off the session — rather than an id this code passes in. `claim_park_file`
 * accepts no user id and no renter id precisely so there is nothing on the
 * wire to forge, and calling it with the service role would hand it a null
 * identity and refuse every time.
 *
 * That is the crew-invite lesson, kept: claimCrewInvite took the email as an
 * ARGUMENT and anyone signed in could pass somebody else's. The fix there was
 * to derive it from the session. Here the database does that itself.
 */

export interface ClaimResult {
  ok: boolean;
  /** Already a sentence for the screen. Never a raw reason code. */
  message: string;
  /** True when the office can fix this by printing another slip. */
  reprintable?: boolean;
  outcome: string;
}

/**
 * A resident attaches their own account to their own file.
 *
 * Takes what is on the slip and what she already knows — the park, her lot,
 * and the code. Nothing about her identity is a parameter.
 */
export async function claimMyFile(input: {
  parkSlug: string;
  lotNumber: string;
  code: string;
}): Promise<ClaimResult> {
  const supabase = await createClient();

  // Shape-check here as well as in SQL. Not distrust of the database — it is
  // the difference between a helpful sentence about the code and a round trip
  // that comes back saying the same thing more slowly.
  const code = normalizeClaimCode(input.code);
  if (!code) {
    return {
      ok: false,
      outcome: "claim_code_malformed",
      message: claimSays("claim_code_malformed"),
    };
  }

  const typedPark = (input.parkSlug ?? "").trim();
  // THE SLIP SAYS "Lot 14". `claim_park_file` matches lot_number exactly, so
  // typing the lot the way the slip prints it was refused as no such
  // household. The word — and a leading "#" — come off here, with the same
  // expression the importer uses, so the two doors agree about the lot WORD;
  // and then the park's own spelling of that lot is looked up, because the
  // stored label is not always the bare number (resolveLotNumber). "Lotus"
  // keeps its Lot: the word only comes off ahead of a digit.
  const typedLot = (input.lotNumber ?? "").trim();
  const strippedLot = typedLot.replace(/^#\s*/, "").replace(LOT_WORD, "").trim();
  if (!typedPark || !strippedLot) {
    return { ok: false, outcome: "claim_no_open_lot", message: claimSays("claim_no_open_lot") };
  }
  // THE SLIP SAYS "THE HAVEN". The field was labelled "Park" and the database
  // wanted the URL slug, so a resident typing what her slip actually says was
  // refused with no explanation. A typed slug still works; a typed NAME is
  // resolved to its slug here, case-insensitively, before the RPC sees it.
  const park = await resolveParkSlug(typedPark);
  const parkSlug = park.slug;
  const lotNumber = await resolveLotNumber(park.id, typedLot, strippedLot);

  const { data, error } = await supabase.rpc("claim_park_file", {
    p_park_slug: parkSlug,
    p_lot_number: lotNumber,
    p_code: code,
  });

  if (error) {
    // A transport or permission failure is not a refusal. Saying "that code
    // isn't right" here would send her back to a slip that is perfectly fine.
    console.error("[claim] rpc failed", error.message);
    return {
      ok: false,
      outcome: "rpc_error",
      message: "We couldn't reach your records just now. Try again in a minute.",
    };
  }

  const outcome = String(data ?? "");
  if (claimWorked(outcome)) {
    revalidatePath("/parks/my");
    revalidatePath("/portal");
  }
  return {
    ok: claimWorked(outcome),
    outcome,
    message: claimSays(outcome),
    reprintable: !claimWorked(outcome) && officeCanReprint(outcome),
  };
}

export interface SlipResult {
  ok: boolean;
  message: string;
  /**
   * THE ONLY TIME THIS STRING EXISTS. It is minted here, hashed by Postgres,
   * and never stored in a form we can read back. If this response is lost, the
   * slip is lost — print another.
   */
  code?: string;
  outcome: string;
}

/**
 * The office mints a slip for one household.
 *
 * The PLAINTEXT is generated here rather than in SQL so it can be shown once
 * and printed; the database stores only a bcrypt hash of it. Nothing in this
 * app can recover the code afterwards, including us.
 *
 * NEVER TEXT OR EMAIL THE RESULT. A code arriving by the same channel as the
 * scam it resembles is not a credential — it is handed over, on paper, by a
 * person she recognises.
 */
export async function issueClaimSlip(renterId: string, days = 30): Promise<SlipResult> {
  const supabase = await createClient();
  const code = mintClaimCode();

  const { data, error } = await supabase.rpc("issue_park_claim_code", {
    p_renter_id: renterId,
    p_code: code,
    p_days: days,
  });

  if (error) {
    console.error("[claim] issue rpc failed", error.message);
    return { ok: false, outcome: "rpc_error", message: "Couldn't create a slip just now." };
  }

  const outcome = String(data ?? "");
  if (!issueWorked(outcome)) {
    return { ok: false, outcome, message: issueSays(outcome) };
  }

  revalidatePath("/park");
  return { ok: true, outcome, message: issueSays(outcome), code };
}

/** The office records that a household said no thanks. Permanent, and fine. */
export async function declineClaim(renterId: string): Promise<ClaimResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decline_park_claim", { p_renter_id: renterId });
  if (error) return { ok: false, outcome: "rpc_error", message: "That didn't save." };
  const outcome = String(data ?? "");
  if (outcome === "declined") {
    revalidatePath("/park");
    return { ok: true, outcome, message: "Noted — we won't ask them again." };
  }
  return { ok: false, outcome, message: issueSays(outcome) };
}

/** Release a claimed file: the resident themselves, the park, or ops. */
export async function releaseClaim(renterId: string): Promise<ClaimResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("release_park_claim", { p_renter_id: renterId });
  if (error) return { ok: false, outcome: "rpc_error", message: "That didn't save." };
  const outcome = String(data ?? "");
  if (outcome === "released") {
    revalidatePath("/park");
    revalidatePath("/parks/my");
    return { ok: true, outcome, message: "Released — a fresh slip will set it up again." };
  }
  return { ok: false, outcome, message: "That couldn't be released." };
}

/**
 * What the owner may see about a household's slip: a fact about the CODE,
 * never a fact about a person. 'none' | 'open' | 'used' | 'expired' |
 * 'locked' | 'declined'.
 *
 * The refusal log itself is ops-only on purpose — a failed attempt must not
 * become a durable record about a resident rendered on their landlord's
 * screen.
 */
export async function claimStatusFor(renterIds: string[]): Promise<Record<string, string>> {
  if (!renterIds.length) return {};
  const supabase = await createClient();
  const out: Record<string, string> = {};
  await Promise.all(
    renterIds.map(async (id) => {
      const { data } = await supabase.rpc("park_claim_code_status", { p_renter_id: id });
      if (data) out[id] = String(data);
    }),
  );
  return out;
}
