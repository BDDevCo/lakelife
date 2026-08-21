"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { assertMyPark } from "./data";
import { toDaterange, parseDaterange, type Term } from "@/lib/parks";
import { parseRentRoll, contentHash, redactSensitive, type ParseResult } from "@/lib/roll-parse";
import { SITE_DEFAULTS } from "./park-helpers";
import {
  planImport,
  importBlockerText,
  statedTotalFrom,
  emptyLotsFrom,
  type ImportPlan,
  type RowOverride,
  type SeasonWindow,
} from "./import-helpers";
import type { ParkResult } from "./actions";

/**
 * THE IMPORT WRITE PATH.
 *
 * One property shapes every line of this file: THE COMMIT IS NOT ONE
 * TRANSACTION. On closing day a man has 79 lots and a seller's rent roll, and
 * 78 good rows plus one collision must never roll back to 79 zero rows and a
 * man reaching for his notebook. So: per-row writes, errors collected on the
 * row that caused them, and the loop keeps going.
 *
 * Nothing here texts, emails or charges anybody. An import is a filing
 * exercise, and the day you buy a park is the worst possible day to send 79
 * strangers an automated message.
 */

const DENIED = "You don't manage that park.";

/** How a pasted lot becomes a real one. 0057's taxonomy, NOT the older
 *  mh_pad/rv_full vocabulary the design doc was written against. */
function siteTypeForPark(parkType: string | null): string {
  if (parkType === "mh") return "mh_single";
  if (parkType === "rv") return "rv_site";
  // A mixed park is genuinely ambiguous, and a mobile-home pad is the harder
  // one to fix later (it needs sewer). Default to the RV site, which is what
  // "add a lot" already defaults to everywhere else.
  return "rv_site";
}

// ---------------------------------------------------------------- reading ---

export interface ReadResult extends ParkResult {
  batchId?: string;
  /** Set when this exact list was already read. He may still say "again". */
  duplicateOf?: { id: string; when: string; committed: boolean };
}

/**
 * Screen 1 → 2. Store the paste VERBATIM, parse it, store every line.
 *
 * The paste is stored before parsing, deliberately. It is the evidence for
 * every number the parse produces, and the "attach the page" rail the screen
 * puts beside the questions.
 */
export async function readPaste(
  parkId: string,
  rawText: string,
  cutoverISO: string,
  opts?: { force?: boolean },
): Promise<ReadResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!rawText.trim()) return { ok: false, error: "Paste the list first." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverISO)) {
    return { ok: false, error: "Pick the day you take over." };
  }

  const admin = createServiceClient();
  const hash = contentHash(rawText);

  // RE-PASTE, blocked before the screen loads. Without this a second paste of
  // the same list makes 158 tenant files out of 79 people — a state the
  // database will happily hold, because the one-claim-per-park index is
  // partial (it only applies where user_id is not null).
  if (!opts?.force) {
    // FAILS OPEN, AND THE PARAGRAPH ABOVE SAYS WHAT THAT COSTS: a dropped read
    // is indistinguishable from "no prior paste", so the re-paste guard simply
    // does not run and the same 79 people are filed twice.
    const priorRes = await admin
      .from("park_import_batches")
      .select("id, created_at, committed_at, undone_at")
      .eq("park_id", parkId)
      .eq("content_hash", hash)
      .is("undone_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (priorRes.error) {
      return { ok: false, error: readFailedMessage("your earlier imports", priorRes.error) };
    }
    const prior = priorRes.data;
    if (prior) {
      return {
        ok: false,
        error: "You've read this exact list before.",
        duplicateOf: {
          id: prior.id as string,
          when: (prior.created_at as string).slice(0, 10),
          committed: prior.committed_at != null,
        },
      };
    }
  }

  // The known lot numbers change how the sheet PARSES — which lines are a
  // tenancy and which are a heading — so reading none of them silently
  // produces a different reading of the same paste.
  const lots = await loadLotNumbers(admin, parkId);
  if (lots === null) {
    return { ok: false, error: readFailedMessage("your lot numbers", "see the read above") };
  }
  const parsed = parseRentRoll(rawText, { knownLots: lots });

  const { data: batch, error: batchErr } = await admin
    .from("park_import_batches")
    .insert({
      park_id: parkId,
      // The blob is stored so an import can be shown and undone. It is stored
      // REDACTED: refusing the SSN column left the number sitting here in full,
      // which made the refusal cosmetic.
      raw_text: redactSensitive(rawText),
      content_hash: hash,
      cutover_date: cutoverISO,
      lines_total: parsed.accounting.totalLines,
      lines_read: parsed.stats.readable,
    })
    .select("id")
    .single();
  if (batchErr || !batch) return { ok: false, error: "Couldn't save that list — try again." };

  const rows = rowsForStorage(batch.id as string, parsed);
  if (rows.length > 0) {
    const { error: rowsErr } = await admin.from("park_import_rows").insert(rows);
    if (rowsErr) {
      // A batch with no rows is a dead end. Remove it rather than leave him
      // looking at an empty screen with no way back.
      await admin.from("park_import_batches").delete().eq("id", batch.id as string);
      return { ok: false, error: "Couldn't save that list — try again." };
    }
  }

  return { ok: true, batchId: batch.id as string };
}

/**
 * EVERY line of the paste becomes a row, including the ones we could not read.
 * That is what makes "we read 24 of 31" checkable instead of merely stated —
 * the other seven have line numbers he can go and look at.
 */
function rowsForStorage(batchId: string, parsed: ParseResult) {
  const out: {
    batch_id: string; line_no: number; raw_line: string;
    parsed: unknown; verdict: string; flags: string[];
  }[] = [];

  for (const r of parsed.rows) {
    out.push({
      batch_id: batchId,
      line_no: r.lines[0],
      raw_line: r.source.join("\n"),
      parsed: {
        lot: r.lot, name: r.name, rent: r.rent, term: r.term,
        notes: r.notes, lines: r.lines,
      },
      verdict: r.verdict,
      flags: r.askReasons,
    });
  }

  const others: [typeof parsed.vacantDeclared, string][] = [
    [parsed.vacantDeclared, "vacant"],
    [parsed.silentLots, "vacant"],
    [parsed.facilities, "not_a_lot"],
    [parsed.totals, "not_a_lot"],
    [parsed.skipped, "skip"],
    [parsed.unparsed, "unparsed"],
  ];
  for (const [list, verdict] of others) {
    for (const o of list) {
      out.push({
        batch_id: batchId,
        line_no: o.lines[0],
        raw_line: redactSensitive(o.text),
        parsed: { why: o.why ?? null, lines: o.lines },
        verdict,
        flags: o.why ? [o.why] : [],
      });
    }
  }

  // (batch_id, line_no) is unique. A wrapped row owns its continuation lines,
  // so keep the FIRST claim on any line and drop later duplicates rather than
  // letting the whole insert fail.
  const seen = new Set<number>();
  return out
    .sort((a, b) => a.line_no - b.line_no)
    .filter((r) => (seen.has(r.line_no) ? false : (seen.add(r.line_no), true)));
}

/** NULL means the read failed — not that the park has no lots yet, which on
 *  closing morning is a perfectly ordinary thing for it to be. */
async function loadLotNumbers(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
): Promise<string[] | null> {
  const res = await admin
    .from("park_lots")
    .select("lot_number")
    .eq("park_id", parkId);
  if (res.error) {
    console.error("[read failed] your lot numbers:", res.error);
    return null;
  }
  return (res.data ?? []).map((l) => l.lot_number as string);
}

// ---------------------------------------------------------------- the plan --

export interface LoadedBatch {
  id: string;
  parkId: string;
  parkName: string;
  cutover: string;
  rawText: string;
  linesTotal: number;
  linesRead: number;
  committedAt: string | null;
  undoneAt: string | null;
  plan: ImportPlan;
  /** Lines that are not tenancies, for the never-hidden footer. */
  others: { lineNo: number; text: string; verdict: string; why: string | null }[];
  blockQuestions: { code: string; question: string }[];
  /**
   * jsonb, so it holds the failure LIST as well as the tallies. It was typed
   * `Record<string, number>`, which is why "3 rows didn't take" could only
   * ever be a number.
   */
  counts: Record<string, unknown>;
  /** What the seller wrote at the bottom of his own sheet. Evidence, not truth. */
  statedTotal: number | null;
  /**
   * Columns we refused on purpose — socials, dates of birth, bank details.
   * Named on screen because quietly discarding something somebody pasted is
   * its own kind of lie, and because the owner should know we will not hold it
   * before he goes looking for it later.
   */
  refusedColumns: string[];
}

/**
 * Re-read the stored paste and re-plan it. Deliberately NOT stored: the plan
 * depends on live inventory and live tenancies, both of which change while he
 * is looking at the screen. Re-planning on every load is how the screen and
 * the commit stay in agreement.
 */
export async function loadBatch(batchId: string): Promise<LoadedBatch | null> {
  const admin = createServiceClient();
  // THROWS on a failed read rather than returning null, because null here
  // means "that import is gone" to the screen and DENIED to `commitImport` —
  // and because the plan this builds is what the commit then writes. The
  // action below catches it; the page has the root boundary.
  const batch = mustRead("that import", await admin
    .from("park_import_batches")
    .select("id, park_id, raw_text, cutover_date, lines_total, lines_read, committed_at, undone_at, counts")
    .eq("id", batchId)
    .maybeSingle());
  if (!batch) return null;

  const parkId = batch.park_id as string;
  if (!(await assertMyPark(parkId))) return null;

  const [parkRes, lotsRes, rowsRes] = await Promise.all([
    admin.from("parks").select("name, park_type, season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", parkId).maybeSingle(),
    admin.from("park_lots").select("id, lot_number").eq("park_id", parkId),
    admin.from("park_import_rows").select("line_no, raw_line, verdict, flags, resolved, commit_error")
      .eq("batch_id", batchId).order("line_no"),
  ]);
  const park = mustRead("your park", parkRes);
  // Without the lots, every line looks like a lot that has to be created;
  // without the row records, every answer he typed on this screen is lost and
  // the rows go back to being blocked.
  const lotRows = mustRead("your lots", lotsRes);
  const rowRecords = mustRead("your answers on this import", rowsRes);

  const lots = (lotRows ?? []).map((l) => ({ id: l.id as string, lotNumber: l.lot_number as string }));
  const lotIds = lots.map((l) => l.id);

  // Tenancies that already hold dates, so a collision is caught before a write.
  // A failed read is an empty list, which is "no collisions" — the check the
  // commit relies on to not put two households on one pad.
  const stayRows = mustRead("who is already on those lots", lotIds.length
    ? await admin
        .from("lot_reservations")
        .select("park_lot_id, during, status")
        .in("park_lot_id", lotIds)
        .in("status", ["approved", "active"])
    : { data: [] as { park_lot_id: string; during: string; status: string }[], error: null });

  const liveStays = (stayRows ?? [])
    .map((s) => ({ lotId: s.park_lot_id as string, range: parseDaterange(s.during as string) }))
    .filter((s): s is { lotId: string; range: { start: string; end: string } } => s.range != null);

  const parsed = parseRentRoll(batch.raw_text as string, { knownLots: lots.map((l) => l.lotNumber) });

  // WHAT HE ANSWERED. Without this the questions on screen are decorative —
  // he types a name, taps Save, and the row stays blocked forever.
  const overrides: Record<number, RowOverride> = {};
  const approvedNewLots: string[] = [];
  for (const rec of rowRecords ?? []) {
    const raw = (rec.resolved as Record<string, unknown> | null) ?? {};
    if (Object.keys(raw).length === 0) continue;
    const o: RowOverride = {};
    if (typeof raw.name === "string" && raw.name.trim()) o.name = raw.name.trim();
    if (raw.rent !== undefined) {
      const n = Number(String(raw.rent).replace(/[^0-9.-]/g, ""));
      // An unparseable answer is not a rent. Leave it absent rather than
      // storing NaN, which renders as a blank that silently means zero.
      o.rent = Number.isFinite(n) ? n : null;
    }
    if (raw.skip === true) o.skip = true;
    if (raw.current === true) o.current = true;
    if (typeof raw.createLot === "string" && raw.createLot) {
      o.createLot = raw.createLot;
      approvedNewLots.push(raw.createLot);
    }
    overrides[rec.line_no as number] = o;
  }

  const plan = planImport({
    rows: parsed.rows,
    lots,
    liveStays,
    cutoverISO: batch.cutover_date as string,
    season: seasonFor(park, batch.cutover_date as string),
    approvedNewLots,
    overrides,
    namelessRoll: !parsed.shape.hasNameColumn,
    // THE EMPTY PADS ARE LOTS. Declared vacant, or implied by a gap in the
    // numbering — both were recorded as import notes and created nothing, so
    // The Haven came in as 19 lots instead of 21. A cost is divided by every
    // RENTABLE lot and the park carries the empties; a lot that does not exist
    // cannot be carried, and the rule silently did nothing.
    emptyLots: emptyLotsFrom(
      [...parsed.vacantDeclared, ...parsed.silentLots],
      lots.map((l) => ({ lotNumber: l.lotNumber })),
      // The lots the sheet actually billed, so a silent pad numbered beyond
      // them is read as inventory that does not exist yet rather than an empty
      // one the park should be carrying.
      parsed.rows.map((r) => r.lot?.value ?? "").filter(Boolean),
    ),
  });

  const others = (rowRecords ?? [])
    .filter((r) => !["import", "ask"].includes(r.verdict as string))
    .map((r) => ({
      lineNo: r.line_no as number,
      text: r.raw_line as string,
      verdict: r.verdict as string,
      why: ((r.flags as string[]) ?? [])[0] ?? null,
    }));

  return {
    id: batch.id as string,
    parkId,
    parkName: (park?.name as string) ?? "your park",
    cutover: batch.cutover_date as string,
    rawText: batch.raw_text as string,
    linesTotal: (batch.lines_total as number) ?? parsed.accounting.totalLines,
    linesRead: (batch.lines_read as number) ?? parsed.stats.readable,
    committedAt: (batch.committed_at as string) ?? null,
    undoneAt: (batch.undone_at as string) ?? null,
    plan,
    others,
    blockQuestions: parsed.blockQuestions,
    counts: (batch.counts as Record<string, unknown>) ?? {},
    statedTotal: statedTotalFrom(parsed.totals.map((t) => t.text)),
    refusedColumns: parsed.columns.refused,
  };
}

/** A park's season, resolved into the year the cutover falls in. */
function seasonFor(
  park: {
    season_open_month?: number | null; season_open_day?: number | null;
    season_close_month?: number | null; season_close_day?: number | null;
  } | null,
  cutoverISO: string,
): SeasonWindow | null {
  if (!park?.season_open_month || !park?.season_close_month) return null;
  const year = Number(cutoverISO.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, "0");
  const start = `${year}-${pad(park.season_open_month)}-${pad(park.season_open_day ?? 1)}`;
  let end = `${year}-${pad(park.season_close_month)}-${pad(park.season_close_day ?? 1)}`;
  // A season that closes before it opens runs over the new year.
  if (end <= start) end = `${year + 1}-${pad(park.season_close_month)}-${pad(park.season_close_day ?? 1)}`;
  return { start, end };
}

// ------------------------------------------------------------ the answers ---

/**
 * Record an answer to one of the questions on screen. Stored as `resolved`
 * beside the original `parsed`, never over it — what we proposed and what he
 * confirmed are different facts, and the difference is the provenance.
 */
export async function resolveRow(
  batchId: string,
  lineNo: number,
  resolved: Record<string, unknown>,
): Promise<ParkResult> {
  const admin = createServiceClient();
  const batchRes = await admin
    .from("park_import_batches")
    .select("park_id, committed_at")
    .eq("id", batchId)
    .maybeSingle();
  if (batchRes.error) {
    return { ok: false, error: readFailedMessage("that import", batchRes.error) };
  }
  const batch = batchRes.data;
  if (!batch) return { ok: false, error: "That import is gone." };
  if (!(await assertMyPark(batch.park_id as string))) return { ok: false, error: DENIED };
  if (batch.committed_at) return { ok: false, error: "That import is already in." };

  // This read is what makes the write a MERGE. Failing it reads as "he has
  // answered nothing about this line", and the update below then overwrites
  // the answers he already gave with only the one he just typed.
  const existingRes = await admin
    .from("park_import_rows")
    .select("resolved")
    .eq("batch_id", batchId)
    .eq("line_no", lineNo)
    .maybeSingle();
  if (existingRes.error) {
    return { ok: false, error: readFailedMessage("your earlier answers", existingRes.error) };
  }

  const merged = { ...((existingRes.data?.resolved as Record<string, unknown>) ?? {}), ...resolved };
  const { error } = await admin
    .from("park_import_rows")
    .update({ resolved: merged })
    .eq("batch_id", batchId)
    .eq("line_no", lineNo);
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  revalidatePath(`/park/import/${batchId}`);
  return { ok: true };
}

// ---------------------------------------------------------------- commit ----

export interface CommitOutcome extends ParkResult {
  tenantsAdded?: number;
  lotsCreated?: number;
  monthlyTotal?: number;
  /** Per row, in his words. Never a 500, never a rollback of what worked. */
  failures?: { lot: string | null; name: string | null; message: string }[];
  /** A file with no lot. Kept ON PURPOSE — see the orphan rule below. */
  orphans?: { renterId: string; name: string }[];
}

export async function commitImport(batchId: string): Promise<CommitOutcome> {
  // `loadBatch` throws on a failed read now. This is the button, so it catches
  // and answers in the shape the screen is awaiting — and it must answer
  // BEFORE any row is written, which is why the catch is out here.
  let loaded: LoadedBatch | null;
  try {
    loaded = await loadBatch(batchId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("that import", e) };
  }
  if (!loaded) return { ok: false, error: DENIED };
  if (loaded.committedAt) return { ok: false, error: "You already imported this one." };

  const admin = createServiceClient();
  // The park type picks the site defaults for any lot this has to create. The
  // due day is deliberately NOT read: it is not copied onto the tenancies any
  // more, because billing reads it from the park at bill time (dueDayFor).
  const parkRes = await admin
    .from("parks")
    .select("park_type")
    .eq("id", loaded.parkId)
    .maybeSingle();
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park", parkRes.error, { money: true }) };
  }
  const park = parkRes.data;

  const defaultSiteType = siteTypeForPark((park?.park_type as string) ?? null);
  const defaults = SITE_DEFAULTS[defaultSiteType] ?? { hasWater: true, hasSewer: true };

  const failures: CommitOutcome["failures"] = [];
  const orphans: CommitOutcome["orphans"] = [];
  let tenantsAdded = 0;
  let lotsCreated = 0;
  // Labels this import actually brought into existence — as opposed to ones it
  // merely found. Only these may be removed again by undo.
  const lotsWeCreated = new Set<string>();

  // ---- phase 1: LOTS. Distinct labels only, so two rows on one new lot do
  // not create it twice.
  // Seed from EVERY planned row, not just the importable ones — in the
  // nameless-roll mode `ready` is empty by design, and seeding from it would
  // leave every existing lot unresolved and write no rates at all.
  const lotIdByLabel = new Map<string, string>();
  for (const row of loaded.plan.rows) {
    if (row.matchedLotId && row.lotLabel) lotIdByLabel.set(row.lotLabel, row.matchedLotId);
  }

  // A pad the roll named but never billed, and whether it exists yet. Beyond
  // the highest billed lot means inventory he has not built — created so he
  // can see it, but NOT rentable, so it stays out of every cost denominator.
  const futureLots = new Set(
    (loaded.plan.emptyLots ?? []).filter((e) => !e.rentable).map((e) => e.label),
  );

  for (const label of loaded.plan.lotsToCreate) {
    const planned = futureLots.has(label);
    const { data: created, error } = await admin
      .from("park_lots")
      .insert({
        park_id: loaded.parkId,
        lot_number: label,
        site_type: defaultSiteType,
        has_water: defaults.hasWater,
        has_sewer: defaults.hasSewer,
        active: !planned,
        lifecycle: planned ? "planned" : "live",
      })
      .select("id")
      .single();

    if (created) {
      lotIdByLabel.set(label, created.id as string);
      lotsWeCreated.add(label);
      lotsCreated += 1;
      continue;
    }
    // 23505 — he created it in another tab thirty seconds ago. Use theirs.
    if (error?.code === "23505") {
      const foundRes = await admin
        .from("park_lots")
        .select("id")
        .eq("park_id", loaded.parkId)
        .eq("lot_number", label)
        .maybeSingle();
      // Per-row, so a failed read here falls through to the failure line below
      // rather than stopping the other 78. It must not be silent, though.
      if (foundRes.error) console.error(`[read failed] lot ${label}:`, foundRes.error);
      if (foundRes.data) { lotIdByLabel.set(label, foundRes.data.id as string); continue; }
    }
    failures.push({ lot: label, name: null, message: `Couldn't create lot ${label}.` });
  }

  // ---- THE NAMELESS ROLL stops here. Lots and rates, and nobody recorded as
  // living anywhere, because the sheet did not say who does. Writing a tenancy
  // would mean inventing a person, which is the one thing this importer will
  // not do.
  if (loaded.plan.namelessRoll) {
    let ratesWritten = 0;
    for (const r of loaded.plan.rates) {
      const lotId = lotIdByLabel.get(r.lotLabel);
      if (!lotId) continue;
      if (r.amount == null) continue;

      const { error } = await admin
        .from("lot_rates")
        .upsert(
          { park_lot_id: lotId, term: "monthly", amount: r.amount },
          { onConflict: "park_lot_id,term" },
        );
      if (error) {
        failures.push({ lot: r.lotLabel, name: null, message: `Couldn't save the rent for lot ${r.lotLabel}.` });
        continue;
      }
      ratesWritten += 1;
      await admin
        .from("park_import_rows")
        .update({
          matched_lot_id: lotId,
          created_lot_id: lotsWeCreated.has(r.lotLabel) ? lotId : null,
          commit_error: null,
        })
        .eq("batch_id", batchId)
        .eq("line_no", r.lineNo);
    }

    // THE LIST, NOT JUST THE TALLY. "3 rows didn't take" sent him to hunt
    // three households across a 79-row roll where a lost one and an empty lot
    // look identical.
    const counts = { tenants: 0, lots: lotsCreated, rates: ratesWritten, failed: failures.length, monthly: loaded.plan.monthlyTotal, failures };
    await admin
      .from("park_import_batches")
      .update({ committed_at: new Date().toISOString(), counts })
      .eq("id", batchId);

    revalidatePath("/park");
    revalidatePath(`/park/import/${batchId}`);
    return {
      ok: true,
      tenantsAdded: 0,
      lotsCreated,
      monthlyTotal: loaded.plan.monthlyTotal,
      failures,
      orphans: [],
      signal: `${lotsCreated} ${lotsCreated === 1 ? "lot" : "lots"} set up. Nobody was filed as living on them — your list didn't say who.`,
    };
  }

  // ---- phases 2 and 3: a renter file, then a tenancy, per row.
  for (const row of loaded.plan.ready) {
    const lotId = row.lotLabel ? lotIdByLabel.get(row.lotLabel) : null;

    // Belt and braces. planImport already refuses both of these, and a row
    // that reached here without them would be a bug — but a silent drop is
    // exactly what the prototype did, so it gets a sentence either way.
    if (!lotId || !row.name) {
      failures.push({
        lot: row.lotLabel,
        name: row.name,
        message: !lotId
          ? `We couldn't put anyone on lot ${row.lotLabel ?? "?"} — the lot isn't there.`
          : `Line ${row.lineNo} had no name, so nobody was filed for it.`,
      });
      continue;
    }

    const { data: renter, error: renterErr } = await admin
      .from("park_renters")
      .insert({
        park_id: loaded.parkId,
        display_name: row.name,          // VERBATIM. Never reordered.
        source: "prior_roll",
        // user_id stays null — unclaimed, which is the whole point of the table.
        //
        // THE TWO CONTACT COLUMNS, AND WHY THEY ARE DIFFERENT.
        //
        // `email` is stored so the office never retypes it, and so the one
        // invite the owner chooses to send has somewhere to go. Storing it is
        // not consent to use it: `contact_pref` below stays paper, so nothing
        // automated will ever mail this address.
        //
        // `phone_on_file_with_park` is where a pasted number goes — NEVER
        // `mobile_e164`. That column means "a number this person gave US and
        // verified"; this one means "a number written on somebody else's
        // sheet". The reminder engine reads the first and is built to be
        // unable to read the second, so the office can see the number while
        // the software cannot dial it.
        email: row.email,
        phone_on_file_with_park: row.phone,
        // PAPER, ALWAYS, until they say otherwise. Having an address is not
        // being asked. This is the same rule buildTenant learned the hard way
        // when `mobile ? "sms" : "paper"` enrolled a park in text messages.
        contact_pref: "paper",
        notes: row.notes.length ? row.notes.join("\n") : null,
      })
      .select("id")
      .single();

    if (renterErr || !renter) {
      failures.push({ lot: row.lotLabel, name: row.name, message: `Couldn't file ${row.name}.` });
      continue;
    }

    const { data: res, error: resErr } = await admin
      .from("lot_reservations")
      .insert({
        park_lot_id: lotId,
        renter_id: renter.id,
        during: toDaterange(row.range!),
        term: row.term as Term,
        quoted_amount: row.amount,
        status: "active",
        origin: "grandfathered",
        // No decision happened, and the database refuses to let one be
        // recorded here — decided_by and decided_at stay null.
        amount_source: "prior_roll",
        amount_source_at: new Date().toISOString(),
        // NULL MEANS FOLLOW THE PARK. This used to copy `rent_due_day` onto
        // every imported row, which looks harmless and is not: a copy is not a
        // default. The moment he changed the park dial, all nineteen
        // households would have kept the old day while the screen showed the
        // new one. Only a day he sets for ONE household belongs on that
        // household — see dueDayFor.
        import_batch_id: batchId,
      })
      .select("id")
      .single();

    if (resErr || !res) {
      // THE ORPHAN RULE. The renter file STAYS. The application path deletes an
      // orphaned rig when its reservation fails, and that is right — a rig is
      // inventory. A NAME HE TYPED IS NOT. It surfaces on the receipt with two
      // buttons, and undo can still remove it.
      orphans.push({ renterId: renter.id as string, name: row.name });
      failures.push({
        lot: row.lotLabel,
        name: row.name,
        message:
          resErr?.code === "23P01"
            ? `Somebody's already on lot ${row.lotLabel}. Nothing was changed there.`
            : `${row.name} is on file, but they aren't on a lot yet.`,
      });
      await admin
        .from("park_import_rows")
        .update({ created_renter_id: renter.id, commit_error: resErr?.code ?? "insert_failed" })
        .eq("batch_id", batchId)
        .eq("line_no", row.lineNo);
      continue;
    }

    tenantsAdded += 1;
    await admin
      .from("park_import_rows")
      .update({
        created_renter_id: renter.id,
        created_reservation_id: res.id,
        matched_lot_id: lotId,
        // Only when THIS import made the lot. Without it, undo's lot cleanup
        // is dead code and a lot he never had survives the undo.
        created_lot_id: row.lotLabel && lotsWeCreated.has(row.lotLabel) ? lotId : null,
        commit_error: null,
      })
      .eq("batch_id", batchId)
      .eq("line_no", row.lineNo);
  }

  // ---- the rate cards, off the same sheet ---------------------------------
  //
  // The named path used to write none at all, so a roll that stated a rent on
  // every line still left "Rate cards 0 of 21" on the checklist and "Ask the
  // park about rates" on every lot of the public page.
  //
  // NEVER OVERWRITES. If the owner has already set a rate on a lot, his number
  // wins — the seller's sheet is where this started, not where it ends.
  let ratesWritten = 0;
  if (loaded.plan.rates.length > 0) {
    const rateLotIds = loaded.plan.rates
      .map((r) => lotIdByLabel.get(r.lotLabel))
      .filter(Boolean) as string[];
    const haveRatesRes = rateLotIds.length
      ? await admin.from("lot_rates").select("park_lot_id").in("park_lot_id", rateLotIds).eq("term", "monthly")
      : { data: [] as { park_lot_id: string }[], error: null };
    // FAILS OPEN INTO THE ONE THING THIS BLOCK PROMISES NOT TO DO. An empty
    // set means "nobody has a rate yet", so the upsert below would put the
    // seller's number over the owner's own on every lot. We cannot tell which
    // are his, so none are written and the receipt says so by name.
    const rateReadFailed = !!haveRatesRes.error;
    if (rateReadFailed) {
      console.error("[read failed] the rates already on those lots:", haveRatesRes.error);
    }
    const alreadyRated = new Set((haveRatesRes.data ?? []).map((r) => r.park_lot_id as string));

    for (const r of loaded.plan.rates) {
      const lotId = lotIdByLabel.get(r.lotLabel);
      if (rateReadFailed) {
        failures.push({
          lot: r.lotLabel, name: null,
          message: `We couldn't check whether lot ${r.lotLabel} already had a rent set, so we left it alone. Set it on Lots & rates.`,
        });
        continue;
      }
      if (!lotId || r.amount == null || alreadyRated.has(lotId)) continue;
      const { error } = await admin
        .from("lot_rates")
        .upsert({ park_lot_id: lotId, term: "monthly", amount: r.amount },
                { onConflict: "park_lot_id,term" });
      if (error) {
        failures.push({ lot: r.lotLabel, name: null, message: `Couldn't save the rent for lot ${r.lotLabel}.` });
        continue;
      }
      ratesWritten += 1;
    }
  }

  // THE ROWS THAT NEVER REACHED THE LOOP AT ALL.
  //
  // `loadBatch` re-plans against LIVE tenancies every time it runs, which is
  // right — somebody may have filled a lot in another tab since he read the
  // sheet. But the commit iterates `plan.ready`, so a row that picked up a
  // blocker between the read and the commit is not written AND not counted:
  // it silently leaves `ready` and nothing downstream ever mentions it.
  //
  // Reproduced: three rows pasted, lot 2 taken by somebody else in between,
  // and the receipt said "2 tenants are in ✓" with `failed: 0`. Earl was gone
  // — no tenancy, no renter file, no line anywhere. An unfiled household and
  // an empty lot look identical on every screen from that moment on, and he
  // is never billed again.
  //
  // A row he explicitly stood down is not this: `skipped` is an answer. These
  // are rows the sheet named, he did not stand down, and nothing was written
  // for — each with the blocker's own sentence.
  const written = new Set(loaded.plan.ready.map((r) => r.lineNo));
  const named = new Set((failures ?? []).map((f) => `${f.lot}|${f.name}`));
  for (const row of loaded.plan.rows) {
    if (row.skipped || written.has(row.lineNo) || row.blockers.length === 0) continue;
    if (named.has(`${row.lotLabel}|${row.name}`)) continue;
    failures.push({
      lot: row.lotLabel,
      name: row.name,
      message: importBlockerText(row.blockers[0], row.lotLabel ?? undefined),
    });
  }

  const counts = {
    tenants: tenantsAdded,
    lots: lotsCreated,
    rates: ratesWritten,
    failed: failures.length,
    monthly: loaded.plan.monthlyTotal,
    // Kept so the receipt can NAME them, and still name them after a reload.
    failures,
  };
  await admin
    .from("park_import_batches")
    .update({ committed_at: new Date().toISOString(), counts })
    .eq("id", batchId);

  // THE ANSWER TO "WHICH MONTH DO YOU TAKE OVER?" HAD NOWHERE TO LAND.
  //
  // The importer asks that question, writes it to `park_import_batches
  // .cutover_date`, and dates every tenancy from it — but `parks.cutover_date`
  // is a DIFFERENT column on a different table, and the only thing that ever
  // wrote it was the Park setup form. So an owner who onboarded the documented
  // way — paste a roll, answer the takeover question — ended up with
  // parks.cutover_date NULL.
  //
  // NULL means "no handover, no restriction" (0131), by design and correctly
  // for the parks that join with no takeover at all. But here he ANSWERED. The
  // consequence: `park_charge_not_before_go_live` waves everything through and
  // `preCutoverRefusal` returns nothing, so a run for a month that belongs to
  // the SELLER bills the residents and lands the money on the wrong side of
  // the closing. That is the rule the whole go-live gate exists to enforce,
  // switched off for exactly the parks that used the onboarding flow.
  //
  // Only when it is null. If he set a date on Park setup that is his answer,
  // and an import must not quietly move his ledger's start.
  if (loaded.cutover) {
    const cutRes = await admin
      .from("parks").select("cutover_date").eq("id", loaded.parkId).maybeSingle();
    // The tenancies are already written, so this cannot refuse — but a failed
    // read leaves parks.cutover_date NULL and the go-live gate switched off,
    // which is the whole bug this paragraph describes. Say so on the log.
    if (cutRes.error) {
      console.error("[read failed] your park's takeover date:", cutRes.error);
    }
    const park = cutRes.data;
    if (park && park.cutover_date == null) {
      await admin
        .from("parks")
        .update({ cutover_date: loaded.cutover })
        .eq("id", loaded.parkId);
    }
  }

  revalidatePath("/park");
  revalidatePath(`/park/import/${batchId}`);

  return {
    ok: true,
    tenantsAdded,
    lotsCreated,
    monthlyTotal: loaded.plan.monthlyTotal,
    failures,
    orphans,
    signal:
      `${tenantsAdded} ${tenantsAdded === 1 ? "tenant is" : "tenants are"} in.` +
      (ratesWritten > 0
        ? ` ${ratesWritten} ${ratesWritten === 1 ? "lot has" : "lots have"} a rent card off your sheet — check them on Lots & rates.`
        : ""),
  };
}

// ------------------------------------------------------------------ undo ----

/**
 * Undo the whole import, by ID rather than by cleverness. Every row recorded
 * exactly what it created, so this removes precisely that and nothing else —
 * a tenant added by hand afterwards is untouched.
 *
 * Order matters: tenancies, then renter files. The other way round would fail
 * on the foreign key.
 */
export async function undoImport(batchId: string): Promise<ParkResult> {
  const admin = createServiceClient();
  const batchRes = await admin
    .from("park_import_batches")
    .select("park_id, committed_at, undone_at")
    .eq("id", batchId)
    .maybeSingle();
  if (batchRes.error) {
    return { ok: false, error: readFailedMessage("that import", batchRes.error) };
  }
  const batch = batchRes.data;
  if (!batch) return { ok: false, error: "That import is gone." };
  if (!(await assertMyPark(batch.park_id as string))) return { ok: false, error: DENIED };
  if (!batch.committed_at) return { ok: false, error: "That import was never put in." };
  if (batch.undone_at) return { ok: false, error: "That import was already undone." };

  // Everything this function deletes comes off this one read. A failure gives
  // three empty lists, and the undo then deletes nothing, stamps `undone_at`
  // so it can never be retried, and reports "your roll is back how it was".
  const rowsRes = await admin
    .from("park_import_rows")
    .select("created_reservation_id, created_renter_id, created_lot_id")
    .eq("batch_id", batchId);
  if (rowsRes.error) {
    return { ok: false, error: readFailedMessage("what that import created", rowsRes.error, { money: true }) };
  }
  const rows = rowsRes.data;

  const resIds = (rows ?? []).map((r) => r.created_reservation_id as string | null).filter(Boolean) as string[];
  const renterIds = (rows ?? []).map((r) => r.created_renter_id as string | null).filter(Boolean) as string[];
  const lotIds = (rows ?? []).map((r) => r.created_lot_id as string | null).filter(Boolean) as string[];

  // ONCE A BILL HAS BEEN RAISED ON THIS IMPORT'S LOTS, UNDO IS OVER.
  //
  // Undo exists for the first five minutes after a paste that went wrong. It is
  // not a way to reverse a month of trading. Deleting a lot cascades its
  // charges, and 0072 makes the database refuse that outright once cash is
  // recorded against them — this check is here so he gets a sentence he can act
  // on instead of a foreign-key error, and so it refuses on the BILL, before
  // any money has even arrived.
  //
  // AND IT FAILS OPEN. `count` is null on a failed read, `null && ...` is
  // false, so the refusal is skipped and the delete runs — the one path this
  // guard exists to stop, taking the bills and the money with it.
  if (lotIds.length) {
    const chargesRes = await admin
      .from("park_charges")
      .select("id", { count: "exact", head: true })
      .in("park_lot_id", lotIds);
    if (chargesRes.error) {
      return { ok: false, error: readFailedMessage("the bills on those lots", chargesRes.error, { money: true }) };
    }
    const count = chargesRes.count;
    if (count && count > 0) {
      return {
        ok: false,
        error:
          `You've billed rent on these lots (${count} ${count === 1 ? "bill" : "bills"}), ` +
          `so undoing the import would take those bills and any money recorded ` +
          `against them with it. Fix the individual tenancies instead.`,
      };
    }
  }

  // MONEY WITH NO BILL BEHIND IT (0102). The guard above counts charges, which
  // WAS a complete money check while every payment required one. Now a deposit
  // taken at signing, or a cheque handed over before the first bill, hangs off
  // the household with no charge — so it is invisible to that count, and the
  // `park_renters` delete below then fails on `park_payments_is_anchored`
  // (renter_id is ON DELETE SET NULL, which would leave a payment anchored to
  // nothing). The error was never read, so the function carried on: lots
  // deleted, `undone_at` stamped, and the toast said "your roll is back how it
  // was" over a roll where every household file survived.
  //
  // Same shape, same failure: a dropped count is not "no money on account".
  if (renterIds.length) {
    const heldRes = await admin
      .from("park_payments")
      .select("id", { count: "exact", head: true })
      .in("renter_id", renterIds)
      .is("charge_id", null)
      .is("reversed_at", null);
    if (heldRes.error) {
      return { ok: false, error: readFailedMessage("money held on account", heldRes.error, { money: true }) };
    }
    const held = heldRes.count;
    if (held && held > 0) {
      return {
        ok: false,
        error:
          `You've taken money from ${held === 1 ? "a household" : "households"} on this import — ` +
          `${held} ${held === 1 ? "payment is" : "payments are"} on account or held as a deposit. ` +
          `Apply or give that money back first, then undo.`,
      };
    }
  }

  if (resIds.length) await admin.from("lot_reservations").delete().in("id", resIds);
  if (renterIds.length) {
    // AND STOP IF IT REFUSES. A half-undone import is worse than one that
    // refused: the lots go, the batch is stamped undone so it cannot be
    // retried, and the household files stay in every picker.
    const { error: renterErr } = await admin.from("park_renters").delete().in("id", renterIds);
    if (renterErr) {
      return {
        ok: false,
        error: `Couldn't remove those household files (${renterErr.message}) — nothing else was undone, so you can try again.`,
      };
    }
  }

  // Lots created by the import come out ONLY if nobody else has since been put
  // on them. A lot with a tenancy on it is now his inventory, not our mess.
  for (const lotId of lotIds) {
    const usedRes = await admin
      .from("lot_reservations")
      .select("id", { count: "exact", head: true })
      .eq("park_lot_id", lotId);
    // FAILS OPEN INTO A DELETE. `!count` is true for a failed count as well as
    // for an empty one, so a dropped read used to remove a pad somebody had
    // since been put on. Per-lot, so the rest of the undo still finishes.
    if (usedRes.error) {
      console.error(`[read failed] whether lot ${lotId} is in use:`, usedRes.error);
      continue;
    }
    if (!usedRes.count) await admin.from("park_lots").delete().eq("id", lotId);
  }

  await admin
    .from("park_import_batches")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", batchId);

  revalidatePath("/park");
  revalidatePath(`/park/import/${batchId}`);
  return { ok: true, signal: "That import is undone. Your roll is back how it was." };
}

/** Remove a renter file that never made it onto a lot. */
export async function removeOrphan(batchId: string, renterId: string): Promise<ParkResult> {
  const admin = createServiceClient();
  const batchRes = await admin
    .from("park_import_batches").select("park_id").eq("id", batchId).maybeSingle();
  if (batchRes.error) {
    return { ok: false, error: readFailedMessage("that import", batchRes.error) };
  }
  const batch = batchRes.data;
  if (!batch) return { ok: false, error: "That import is gone." };
  if (!(await assertMyPark(batch.park_id as string))) return { ok: false, error: DENIED };

  // FAILS OPEN INTO A DELETE. A failed count is null, `if (count)` is false,
  // and the household file of somebody who IS on a lot gets removed.
  const usedRes = await admin
    .from("lot_reservations")
    .select("id", { count: "exact", head: true })
    .eq("renter_id", renterId);
  if (usedRes.error) {
    return { ok: false, error: readFailedMessage("whether they're on a lot", usedRes.error) };
  }
  if (usedRes.count) return { ok: false, error: "They're on a lot now — end the tenancy instead." };

  await admin.from("park_renters").delete().eq("id", renterId).eq("park_id", batch.park_id as string);
  revalidatePath("/park");
  return { ok: true, signal: "That file is removed." };
}
