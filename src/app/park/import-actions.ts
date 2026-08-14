"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { toDaterange, parseDaterange, type Term } from "@/lib/parks";
import { parseRentRoll, contentHash, type ParseResult } from "@/lib/roll-parse";
import { SITE_DEFAULTS } from "./park-helpers";
import {
  planImport,
  statedTotalFrom,
  emptyLotLabelsFrom,
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
    return { ok: false, error: "Pick the month you take over." };
  }

  const admin = createServiceClient();
  const hash = contentHash(rawText);

  // RE-PASTE, blocked before the screen loads. Without this a second paste of
  // the same list makes 158 tenant files out of 79 people — a state the
  // database will happily hold, because the one-claim-per-park index is
  // partial (it only applies where user_id is not null).
  if (!opts?.force) {
    const { data: prior } = await admin
      .from("park_import_batches")
      .select("id, created_at, committed_at, undone_at")
      .eq("park_id", parkId)
      .eq("content_hash", hash)
      .is("undone_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
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

  const lots = await loadLotNumbers(admin, parkId);
  const parsed = parseRentRoll(rawText, { knownLots: lots });

  const { data: batch, error: batchErr } = await admin
    .from("park_import_batches")
    .insert({
      park_id: parkId,
      raw_text: rawText,
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
        raw_line: o.text,
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

async function loadLotNumbers(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("park_lots")
    .select("lot_number")
    .eq("park_id", parkId);
  return (data ?? []).map((l) => l.lot_number as string);
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
  counts: Record<string, number>;
  /** What the seller wrote at the bottom of his own sheet. Evidence, not truth. */
  statedTotal: number | null;
}

/**
 * Re-read the stored paste and re-plan it. Deliberately NOT stored: the plan
 * depends on live inventory and live tenancies, both of which change while he
 * is looking at the screen. Re-planning on every load is how the screen and
 * the commit stay in agreement.
 */
export async function loadBatch(batchId: string): Promise<LoadedBatch | null> {
  const admin = createServiceClient();
  const { data: batch } = await admin
    .from("park_import_batches")
    .select("id, park_id, raw_text, cutover_date, lines_total, lines_read, committed_at, undone_at, counts")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return null;

  const parkId = batch.park_id as string;
  if (!(await assertMyPark(parkId))) return null;

  const [{ data: park }, { data: lotRows }, { data: rowRecords }] = await Promise.all([
    admin.from("parks").select("name, park_type, season_open_month, season_open_day, season_close_month, season_close_day")
      .eq("id", parkId).maybeSingle(),
    admin.from("park_lots").select("id, lot_number").eq("park_id", parkId),
    admin.from("park_import_rows").select("line_no, raw_line, verdict, flags, resolved, commit_error")
      .eq("batch_id", batchId).order("line_no"),
  ]);

  const lots = (lotRows ?? []).map((l) => ({ id: l.id as string, lotNumber: l.lot_number as string }));
  const lotIds = lots.map((l) => l.id);

  // Tenancies that already hold dates, so a collision is caught before a write.
  const { data: stayRows } = lotIds.length
    ? await admin
        .from("lot_reservations")
        .select("park_lot_id, during, status")
        .in("park_lot_id", lotIds)
        .in("status", ["approved", "active"])
    : { data: [] as { park_lot_id: string; during: string }[] };

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
    emptyLotLabels: emptyLotLabelsFrom(
      [...parsed.vacantDeclared, ...parsed.silentLots],
      lots.map((l) => ({ lotNumber: l.lotNumber })),
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
    counts: (batch.counts as Record<string, number>) ?? {},
    statedTotal: statedTotalFrom(parsed.totals.map((t) => t.text)),
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
  const { data: batch } = await admin
    .from("park_import_batches")
    .select("park_id, committed_at")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { ok: false, error: "That import is gone." };
  if (!(await assertMyPark(batch.park_id as string))) return { ok: false, error: DENIED };
  if (batch.committed_at) return { ok: false, error: "That import is already in." };

  const { data: existing } = await admin
    .from("park_import_rows")
    .select("resolved")
    .eq("batch_id", batchId)
    .eq("line_no", lineNo)
    .maybeSingle();

  const merged = { ...((existing?.resolved as Record<string, unknown>) ?? {}), ...resolved };
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
  const loaded = await loadBatch(batchId);
  if (!loaded) return { ok: false, error: DENIED };
  if (loaded.committedAt) return { ok: false, error: "You already imported this one." };

  const admin = createServiceClient();
  const { data: park } = await admin
    .from("parks")
    .select("park_type, rent_due_day")
    .eq("id", loaded.parkId)
    .maybeSingle();

  const defaultSiteType = siteTypeForPark((park?.park_type as string) ?? null);
  const defaults = SITE_DEFAULTS[defaultSiteType] ?? { hasWater: true, hasSewer: true };
  const parkDueDay = (park?.rent_due_day as number) ?? 1;

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

  for (const label of loaded.plan.lotsToCreate) {
    const { data: created, error } = await admin
      .from("park_lots")
      .insert({
        park_id: loaded.parkId,
        lot_number: label,
        site_type: defaultSiteType,
        has_water: defaults.hasWater,
        has_sewer: defaults.hasSewer,
        active: true,
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
      const { data: found } = await admin
        .from("park_lots")
        .select("id")
        .eq("park_id", loaded.parkId)
        .eq("lot_number", label)
        .maybeSingle();
      if (found) { lotIdByLabel.set(label, found.id as string); continue; }
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

    const counts = { tenants: 0, lots: lotsCreated, rates: ratesWritten, failed: failures.length, monthly: loaded.plan.monthlyTotal };
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
        source: "seller_roll",
        // user_id stays null — unclaimed, which is the whole point of the table.
        // mobile_e164 stays null — a pasted number has no consent behind it.
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
        amount_source: "seller_roll",
        amount_source_at: new Date().toISOString(),
        due_day: parkDueDay,
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
    const { data: haveRates } = rateLotIds.length
      ? await admin.from("lot_rates").select("park_lot_id").in("park_lot_id", rateLotIds).eq("term", "monthly")
      : { data: [] as { park_lot_id: string }[] };
    const alreadyRated = new Set((haveRates ?? []).map((r) => r.park_lot_id as string));

    for (const r of loaded.plan.rates) {
      const lotId = lotIdByLabel.get(r.lotLabel);
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

  const counts = {
    tenants: tenantsAdded,
    lots: lotsCreated,
    rates: ratesWritten,
    failed: failures.length,
    monthly: loaded.plan.monthlyTotal,
  };
  await admin
    .from("park_import_batches")
    .update({ committed_at: new Date().toISOString(), counts })
    .eq("id", batchId);

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
  const { data: batch } = await admin
    .from("park_import_batches")
    .select("park_id, committed_at, undone_at")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { ok: false, error: "That import is gone." };
  if (!(await assertMyPark(batch.park_id as string))) return { ok: false, error: DENIED };
  if (!batch.committed_at) return { ok: false, error: "That import was never put in." };
  if (batch.undone_at) return { ok: false, error: "That import was already undone." };

  const { data: rows } = await admin
    .from("park_import_rows")
    .select("created_reservation_id, created_renter_id, created_lot_id")
    .eq("batch_id", batchId);

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
  if (lotIds.length) {
    const { count } = await admin
      .from("park_charges")
      .select("id", { count: "exact", head: true })
      .in("park_lot_id", lotIds);
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
  if (renterIds.length) {
    const { count: held } = await admin
      .from("park_payments")
      .select("id", { count: "exact", head: true })
      .in("renter_id", renterIds)
      .is("charge_id", null)
      .is("reversed_at", null);
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
    const { count } = await admin
      .from("lot_reservations")
      .select("id", { count: "exact", head: true })
      .eq("park_lot_id", lotId);
    if (!count) await admin.from("park_lots").delete().eq("id", lotId);
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
  const { data: batch } = await admin
    .from("park_import_batches").select("park_id").eq("id", batchId).maybeSingle();
  if (!batch) return { ok: false, error: "That import is gone." };
  if (!(await assertMyPark(batch.park_id as string))) return { ok: false, error: DENIED };

  const { count } = await admin
    .from("lot_reservations")
    .select("id", { count: "exact", head: true })
    .eq("renter_id", renterId);
  if (count) return { ok: false, error: "They're on a lot now — end the tenancy instead." };

  await admin.from("park_renters").delete().eq("id", renterId).eq("park_id", batch.park_id as string);
  revalidatePath("/park");
  return { ok: true, signal: "That file is removed." };
}
