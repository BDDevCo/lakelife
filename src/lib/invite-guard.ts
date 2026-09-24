import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { likeLiteral } from "@/lib/sql-like";
import { isServedLake, SERVED_LAKE_COLUMNS, SERVED_LAKE_MATCH } from "@/lib/lake-visibility";

/**
 * NOBODY GETS INVITED TWICE — the one guard every invite door calls.
 *
 * Brendon, 23 September 2026: "we need a cross refrence if a home owner send
 * out and invite and we flag that it could possibly be a duplicate, send a
 * response back that your vedor might be already on our platform..... do you
 * see them (show a list) or somthing like this." And the reason, from the
 * message before it: "he will onboard himself with me walking him through it
 * ... so I want to make sure we dont duplicate him."
 *
 * ============================================================================
 * THREE DOORS, ONE GUARD
 * ============================================================================
 * There are three ways a crew gets invited, and there were three hand-written
 * copies of the same two checks:
 *
 *   ops        app/ops/crews-invite.ts        inviteCrew
 *   homeowner  app/book/contractor-actions.ts inviteMyContractor
 *   park       app/park/crew-actions.ts       parkInviteCrew
 *
 * Three copies that agree today drift tomorrow — this codebase's most
 * expensive habit, and `claim_park_file` (0153) is what it costs: one doorway
 * of three carried a filter the other two did not, and every slip would have
 * failed on 1 January with nothing logged. So the checks live here, once, and
 * `invite-guard.test.ts` scans the three doors' source for the call.
 *
 * ============================================================================
 * THREE CASES, AND ONLY ONE OF THEM IS A REFUSAL
 * ============================================================================
 * CASE 1 — THE SAME EMAIL, ALREADY INVITED. The database has always refused
 *   this: `vendors_invite_email_open` is a UNIQUE index on
 *   `lower(invite_email)` where `user_id is null`. The CODE did not: all three
 *   doors pre-checked with a case-SENSITIVE `.eq("invite_email", addr)` while
 *   the `users` lookup immediately above used a case-INSENSITIVE `ilike`. So
 *   inviting `Josh@x.com` while `josh@x.com` was pending sailed past the
 *   friendly check, hit 23505, and handed the raw Postgres string to a person
 *   mid-invite: "duplicate key value violates unique constraint ...". No hint
 *   that the move is Resend, and a retry that can never work.
 *   The pre-check is now case-insensitive AND 23505 maps to the SAME sentence:
 *   the pre-check is the message, the constraint is the truth, and they say
 *   the same thing.
 *
 * CASE 2 — THE SAME EMAIL, ALREADY A CREW. Not an error at all. They are on
 *   LakeLife, so the customer does not need to invite them — the caller binds
 *   them the way an accepted invite would and says they can be booked. That is
 *   a better outcome than an invitation, and it used to read as a refusal.
 *
 * CASE 3 — A DIFFERENT EMAIL, PROBABLY THE SAME BUSINESS. `josh@joshsdocks.com`
 *   and `jdocks@gmail.com` are not linked by anything, and no constraint ever
 *   will link them. That is `findSimilarCrews` below, and it ASKS — it never
 *   refuses. A fuzzy match is a guess; a guess must not be able to block a real
 *   invitation.
 */

/**
 * The service-role client, typed exactly as every other helper in this repo
 * types it (`automation.ts` passes it the same way). The guard never makes its
 * own client: the door has one, the door has already established who is
 * calling, and a helper that reached for its own would be a second place
 * credentials are read.
 */
export type InviteGuardClient = ReturnType<typeof createServiceClient>;

type Embed<T> = T | T[] | null | undefined;
const first = <T,>(x: Embed<T>): T | null => (x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x);

// ---------------------------------------------------------------------------
// CASES 1 AND 2 — THE EMAIL
// ---------------------------------------------------------------------------

/** How a crew looks to somebody deciding whether to invite them. */
export type CrewAvailability = "taking_work" | "setting_up" | "not_taking_work";

/** What we found when we asked about an email address. */
export type InviteEmailCase =
  /** Nobody here holds it. The invitation may go. */
  | { kind: "free" }
  /** It belongs to a crew already on LakeLife (CASE 2). */
  | { kind: "already_crew"; vendorId: string; company: string | null; availability: CrewAvailability; isFixture: boolean }
  /** It belongs to an account that is not a crew — a homeowner, a park owner. */
  | { kind: "other_account" }
  /** An invitation is already out to it and still unclaimed (CASE 1). */
  | { kind: "open_invite"; vendorId: string | null; company: string | null }
  /** WE DO NOT KNOW. Never "free" — a failed read is not an empty one. */
  | { kind: "read_failed"; what: string };

/** vendor_status -> what a person outside the crew may be told. */
export function availabilityOf(status: unknown): CrewAvailability {
  if (status === "active") return "taking_work";
  if (status === "suspended") return "not_taking_work";
  // 'invited', and anything a later migration adds, is "not live yet". The
  // safe direction: never tell a customer a crew can take work when we are
  // not sure they can.
  return "setting_up";
}

/**
 * IS THIS EMAIL FREE? Asked once, by all three doors.
 *
 * CASE-INSENSITIVE ON BOTH LOOKUPS, because that is what the database enforces.
 * `users.email` is synced from Supabase auth (0003) so this repo cannot promise
 * its case; `vendors.invite_email` is ours and lower-cased on the way in, but
 * `vendors_invite_email_open` indexes `lower(invite_email)` — so the row that
 * will actually collide is the one found case-insensitively, and an `.eq` found
 * only some of them.
 *
 * `likeLiteral` escapes the LIKE metacharacters first. Without it `_` matches
 * any single character, which is how `crew_mow@outlook.com` once matched an
 * invitation minted for `crew.mow@outlook.com` (lib/sql-like.ts). Escaped, the
 * pattern matches the address and nothing else.
 *
 * EVERY FAILED READ IS `read_failed`, NEVER `free`. `{ data: null, error }` is
 * what "no such account" and "no open invite" look like too, and waving an
 * invitation through on a dropped connection is how a second row lands on an
 * address that already has one — which the next attempt then trips over.
 */
export async function checkInviteEmail(admin: InviteGuardClient, email: string): Promise<InviteEmailCase> {
  const addr = (email ?? "").trim().toLowerCase();
  if (!addr) return { kind: "read_failed", what: "that email address" };

  const userRes = await admin.from("users").select("id").ilike("email", likeLiteral(addr)).maybeSingle();
  if (userRes.error) return { kind: "read_failed", what: "whether that email is already with us" };
  const existing = userRes.data as { id?: string } | null;

  if (existing?.id) {
    const vendorRes = await admin
      .from("vendors")
      .select("id, company, status, users!vendors_user_id_fkey(is_fixture)")
      .eq("user_id", existing.id)
      .maybeSingle();
    if (vendorRes.error) return { kind: "read_failed", what: "that crew's account" };
    const v = vendorRes.data as
      | { id?: string; company?: string | null; status?: unknown; users?: Embed<{ is_fixture?: unknown }> }
      | null;
    if (!v?.id) return { kind: "other_account" };
    return {
      kind: "already_crew",
      vendorId: v.id,
      company: (v.company as string | null) ?? null,
      availability: availabilityOf(v.status),
      // STRICTLY `!== false`: a missing embed is treated as a fixture, so the
      // caller declines to bind rather than binding a scratch crew to a real
      // property. Absence fails closed, the way isServedLake does.
      isFixture: first(v.users)?.is_fixture !== false,
    };
  }

  const openRes = await admin
    .from("vendors")
    .select("id, company")
    .ilike("invite_email", likeLiteral(addr))
    .is("user_id", null)
    .maybeSingle();
  if (openRes.error) return { kind: "read_failed", what: "open invites for that email" };
  const open = openRes.data as { id?: string; company?: string | null } | null;
  if (open) return { kind: "open_invite", vendorId: open.id ?? null, company: (open.company as string | null) ?? null };

  return { kind: "free" };
}

/**
 * THE CONSTRAINT SAYING WHAT THE PRE-CHECK SAYS.
 *
 * `vendors_invite_email_open` is the only unique index on `vendors` that an
 * insert here can trip, and it means exactly one thing: an open invitation
 * already exists for this address. Recognising it lets the door answer with
 * the same sentence `open_invite` produces, instead of the Postgres string.
 *
 * Matches on the SQLSTATE and the constraint name together. A 23505 from some
 * index added later is not this, and must not borrow this sentence.
 */
export function isOpenInviteCollision(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown; details?: unknown };
  if (e.code !== "23505") return false;
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof e.details === "string" ? e.details : ""}`;
  return text.includes("vendors_invite_email_open");
}

/** Which door is speaking — the only thing that changes the words. */
export type InviteDoor = "ops" | "homeowner" | "park";

/**
 * THE SENTENCE FOR A CASE, IN ONE PLACE.
 *
 * Copy in three files is three sets of promises to keep true. Every one of
 * these names the move the reader can actually make on the screen they are on:
 * ops has a Resend button on the crew's card, a customer does not and is told
 * who to ask.
 */
export function inviteCaseMessage(found: InviteEmailCase, door: InviteDoor): string {
  switch (found.kind) {
    case "open_invite":
      return door === "ops"
        ? "There's already an open invite for that email — press Resend on their card to send it again."
        : "We've already sent an invite to that email and they haven't signed up yet. Give them a nudge, or ask us to send it again.";
    case "other_account":
      return door === "ops"
        ? "That email already has an account, and it isn't a crew — use a different email for the crew."
        : "That email already has an account — your crew should use a different email to join as a crew.";
    case "already_crew":
      return alreadyCrewMessage(found, door);
    case "read_failed":
      // The wording of `readFailedMessage`, said here so the guard's callers
      // have one sentence for "we could not check" whichever read dropped.
      return "We couldn't check something just now, so nothing has been changed. Try again in a moment.";
    case "free":
      return "";
  }
}

/** CASE 2 said as the good news it is — and never promising a booking a crew
 *  who is still setting up could not take. */
export function alreadyCrewMessage(
  found: { company: string | null; availability: CrewAvailability },
  door: InviteDoor,
): string {
  const who = found.company?.trim() || "They";
  if (door === "ops") return "That email is already a LakeLife crew.";
  const tail =
    found.availability === "taking_work"
      ? door === "park"
        ? "they'll show up as one of your options when you book work for the park."
        : "you can book them today."
      : found.availability === "not_taking_work"
        ? "they're not taking work at the moment, so they won't show up when you book."
        : "they're still setting their account up, so they'll show up when you book once they're live.";
  return `Good news — ${who} are already on LakeLife, so there's no invite to send. ${
    door === "park" ? "" : "They're set as your crew, and "
  }${tail}`;
}

// ---------------------------------------------------------------------------
// CASE 3 — THE CROSS-REFERENCE
// ---------------------------------------------------------------------------

/**
 * ONE NEAR MATCH, AS THE PERSON INVITING MAY SEE THEM.
 *
 * WHAT IS ON THIS WIRE AND WHY. The company name, the lakes they work, and
 * whether they are taking work — enough for somebody to say "yes, that's him",
 * and no more than the crew picker (`book/crew-offers.ts`) already shows the
 * same customer under the crew-priced model. A crew's business name and the
 * water they cover is what they paint on the truck.
 *
 * WHAT IS DELIBERATELY NOT ON IT: the crew's email address — the one that
 * matters, because it is how somebody would go after an invitation that is not
 * theirs — their phone, the owner's personal name, any rate, and anything at
 * all about their other customers.
 */
export interface SimilarCrew {
  vendorId: string;
  company: string;
  /** Served lakes only, by name. Empty when they haven't picked any yet. */
  lakes: string[];
  availability: CrewAvailability;
}

export type SimilarCrewsResult =
  | { ok: true; crews: SimilarCrew[] }
  /** WE COULD NOT ASK. Never an empty list: "no duplicates found" over a read
   *  that failed is the confident sentence that creates the duplicate this
   *  whole file exists to prevent. */
  | { ok: false };

/** How many near matches a person is shown. A list, not a directory. */
export const SIMILAR_CREW_LIMIT = 5;

/** How many rows the narrowing query may pull before scoring. */
const CANDIDATE_LIMIT = 25;

/** Shortest company name worth cross-referencing, after normalising. */
export const MIN_COMPANY_CHARS = 3;

/**
 * Words that identify a trade, a place or a legal form rather than a business.
 * They are still scored — "Miller Pier & Lift" and "Miller Piers" should meet
 * — but on their own they may not pull a row out of the table, so typing
 * "docks" cannot list every dock crew on the lakes.
 */
const GENERIC = new Set([
  "llc", "inc", "co", "corp", "ltd", "llp", "the", "and", "of",
  "dock", "docks", "pier", "piers", "lift", "lifts", "lawn", "lawns",
  "marine", "boat", "boats", "lake", "lakes", "service", "services",
  "landscaping", "landscape", "cleaning", "clean", "maintenance",
  "property", "properties", "home", "homes", "crew", "crews", "group",
]);

/** Lower-case, punctuation out, runs of space collapsed. `Josh's Docks, LLC`
 *  and `josh s docks llc` have to land on the same string before anything can
 *  compare them. */
export function normalizeCompany(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** The distinctive words in a name — what we are willing to go to the table with. */
export function distinctiveTokens(raw: string | null | undefined): string[] {
  return [...new Set(normalizeCompany(raw).split(" "))].filter((t) => t.length >= 3 && !GENERIC.has(t));
}

/** Padded 3-grams, the same idea pg_trgm's `similarity()` uses — computed here
 *  because PostgREST has no way to express the `%` operator. The GIN index
 *  (`vendors_company_trgm`, 0046) is what the ILIKE narrowing below rides. */
function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * 0 to 1, by Dice coefficient over 3-grams. Two empty names score 0, not 1 —
 * "everything matches nothing" is not a duplicate.
 */
export function companySimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ga = trigrams(x);
  const gb = trigrams(y);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

/** pg_trgm's own default, kept so the number has a source. */
export const SIMILARITY_THRESHOLD = 0.34;

/**
 * Is this pair close enough to ask about? Either the whole names are similar,
 * or one name carries the other's distinctive word — "Josh Docks" and
 * "Joshua's Dock Service" share no long run of characters but are obviously
 * worth asking about.
 */
export function looksLikeSameBusiness(typed: string, stored: string): boolean {
  if (companySimilarity(typed, stored) >= SIMILARITY_THRESHOLD) return true;
  const typedTokens = distinctiveTokens(typed);
  const storedNorm = normalizeCompany(stored);
  const storedTokens = distinctiveTokens(stored);
  const typedNorm = normalizeCompany(typed);
  return (
    typedTokens.some((t) => t.length >= 4 && storedNorm.includes(t)) ||
    storedTokens.some((t) => t.length >= 4 && typedNorm.includes(t))
  );
}

/**
 * "THIS MIGHT ALREADY BE YOUR CREW" — the cross-reference he asked for.
 *
 * IT ASKS, IT NEVER REFUSES. Every caller treats an empty list and a full one
 * the same way: the invitation is still available. A fuzzy match is a guess,
 * and a guess must never be able to block a real invitation.
 *
 * THE FIXTURE FENCE DERIVES FROM THE OWNER. Three production vendors —
 * GreenEdge Lawn Co., Northshore Docks, Iso Test Vendor 2 LLC — are fixtures,
 * and nothing on the vendors row says so: `users.is_fixture` is read through
 * the crew's OWNER, the way every crew pool in automation.ts does it, and the
 * FK has to be named because `vendors` reaches `users` four ways. An UNCLAIMED
 * invite has no owner, so it is fenced on whoever minted it (`invited_by`);
 * ops invites carry no inviter at all and are real.
 *
 * NOT A SECOND RLS STORY. This runs under the service role inside an action
 * that has already established who the caller is. No policy is widened.
 */
export async function findSimilarCrews(
  admin: InviteGuardClient,
  company: string,
  opts?: { excludeVendorIds?: string[] },
): Promise<SimilarCrewsResult> {
  const typed = normalizeCompany(company);
  if (typed.length < MIN_COMPANY_CHARS) return { ok: true, crews: [] };

  // The needles that go to the table: distinctive words only, trimmed to their
  // first four characters so "Joshs" still finds "Josh's". `normalizeCompany`
  // has already stripped every LIKE and PostgREST-grammar character, so what
  // is interpolated below is [a-z0-9] and nothing else.
  const needles = distinctiveTokens(company).map((t) => t.slice(0, 4)).slice(0, 4);
  if (needles.length === 0) return { ok: true, crews: [] };

  const res = await admin
    .from("vendors")
    .select(
      "id, company, status, user_id, invited_by, " +
        "owner:users!vendors_user_id_fkey(is_fixture), inviter:users!vendors_invited_by_fkey(is_fixture)",
    )
    .or(needles.map((n) => `company.ilike.*${n}*`).join(","))
    .limit(CANDIDATE_LIMIT);
  if (res.error) return { ok: false };

  const exclude = new Set(opts?.excludeVendorIds ?? []);
  type Row = {
    id?: string;
    company?: string | null;
    status?: unknown;
    user_id?: string | null;
    invited_by?: string | null;
    owner?: Embed<{ is_fixture?: unknown }>;
    inviter?: Embed<{ is_fixture?: unknown }>;
  };
  const rows = ((res.data ?? []) as Row[]).filter((r) => {
    if (!r.id || exclude.has(r.id)) return false;
    if (!(r.company ?? "").trim()) return false;
    if (isFixtureCrewRow(r)) return false;
    return looksLikeSameBusiness(company, r.company ?? "");
  });

  const ranked = rows
    .map((r) => ({ r, score: companySimilarity(company, r.company ?? "") }))
    .sort((a, b) => b.score - a.score || (a.r.company ?? "").localeCompare(b.r.company ?? ""))
    .slice(0, SIMILAR_CREW_LIMIT);

  // Lake NAMES, for the rows we are actually showing. Fetched separately
  // because `service_lakes` is a uuid[] and PostgREST cannot embed through one.
  const lakesByVendor = new Map<string, string[]>();
  const vendorIds = ranked.map((x) => x.r.id as string);
  if (vendorIds.length) {
    const lakeRes = await admin
      .from("vendors")
      .select(`id, service_lakes`)
      .in("id", vendorIds);
    // SOFT, AND IT HAS TO BE. The lakes are context on a question; losing them
    // costs a line of detail, and refusing the whole cross-reference over it
    // would turn a degraded answer into no answer — and no answer here is what
    // produces the duplicate.
    if (lakeRes.error) {
      console.error("[read failed, degraded] the lakes a near-match crew covers:", lakeRes.error);
    } else {
      const ids = new Set<string>();
      const byVendor = new Map<string, string[]>();
      for (const row of (lakeRes.data ?? []) as { id?: string; service_lakes?: unknown }[]) {
        const list = Array.isArray(row.service_lakes) ? (row.service_lakes as string[]) : [];
        if (row.id) byVendor.set(row.id, list);
        for (const id of list) ids.add(id);
      }
      if (ids.size) {
        // FENCED ON THE QUERY *AND* IN THE LOOP BELOW, deliberately. The
        // in-code `isServedLake` was here first and is the one that encodes
        // the whole rule (is_fixture false AND source ops), but a fence that
        // lives only in a post-filter is invisible to the scanner that polices
        // this class — and a reader who deletes the loop's guard would take the
        // fence with it and nothing would say so. `.match` puts the same rule
        // where the rows are selected, so the fixture never travels at all.
        const nameRes = await admin
          .from("lakes")
          .select(`id, name, ${SERVED_LAKE_COLUMNS}`)
          .match(SERVED_LAKE_MATCH)
          .in("id", [...ids]);
        if (nameRes.error) {
          console.error("[read failed, degraded] lake names for the near-match list:", nameRes.error);
        } else {
          const nameById = new Map<string, string>();
          for (const l of (nameRes.data ?? []) as { id?: string; name?: string; is_fixture?: unknown; source?: unknown }[]) {
            // SERVED LAKES ONLY. A fixture lake's name on a customer's screen
            // is scratch data leaving the fence (0124).
            if (l.id && l.name && isServedLake(l)) nameById.set(l.id, l.name);
          }
          for (const [vid, list] of byVendor) {
            lakesByVendor.set(vid, list.map((id) => nameById.get(id)).filter((n): n is string => !!n).sort());
          }
        }
      }
    }
  }

  return {
    ok: true,
    crews: ranked.map(({ r }) => ({
      vendorId: r.id as string,
      company: (r.company as string).trim(),
      lakes: lakesByVendor.get(r.id as string) ?? [],
      availability: availabilityOf(r.status),
    })),
  };
}

/**
 * FIXTURE OR REAL, decided on the row's OWNER — never on the vendors row,
 * which carries no such column. Fails CLOSED: an embed that did not come back
 * counts as a fixture, so a dropped join hides a real crew from one list
 * rather than putting a scratch crew in front of a customer.
 */
export function isFixtureCrewRow(row: {
  user_id?: string | null;
  invited_by?: string | null;
  owner?: Embed<{ is_fixture?: unknown }>;
  inviter?: Embed<{ is_fixture?: unknown }>;
}): boolean {
  if (row.user_id) return first(row.owner)?.is_fixture !== false;
  if (row.invited_by) return first(row.inviter)?.is_fixture !== false;
  // No owner and nobody named as inviter: an ops-minted invitation
  // (`inviteCrew` writes no `invited_by`). Real.
  return false;
}

/**
 * WHAT A NEAR MATCH READS AS ON THE SCREEN — one line under the company name.
 * Built here so all three doors say the same thing about the same status.
 */
export function similarCrewLine(crew: SimilarCrew): string {
  const where = crew.lakes.length
    ? crew.lakes.join(", ")
    : "Lakes not set yet";
  const state =
    crew.availability === "taking_work"
      ? "Taking work"
      : crew.availability === "not_taking_work"
        ? "Not taking work right now"
        : "Setting up their account";
  return `${where} · ${state}`;
}

/** Said when the cross-reference could not be run. NOT "no duplicates found" —
 *  the invitation still goes, because the exact-email constraint holds either
 *  way, and the reader is told which of the two checks did not happen. */
export const CROSS_REFERENCE_UNAVAILABLE =
  "We couldn't check whether they're already on LakeLife just now, so we've sent the invite anyway. If it turns out they're already here, tell us and we'll join the two up.";
