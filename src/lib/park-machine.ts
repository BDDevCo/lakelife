import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate, lakeDaysSince } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import { currentPeriod } from "@/app/park/ledger-helpers";
import { firstBillablePeriod } from "@/lib/billing-start";
import { unbilledMonthsFor } from "@/app/park/unbilled-months";
import { lapsedRowOf, type LapseCandidate } from "@/app/park/park-helpers";
import { reconcile, reconcileSummary, type Finding } from "@/app/park/reconcile-helpers";

/**
 * THE EVENING CHECK.
 *
 * Runs inside the existing nightly — both Vercel cron slots are already spoken
 * for, and a second scheduler would be a second thing that can die quietly.
 *
 * IT WRITES A ROW SAYING IT RAN, BEFORE IT DOES ANY WORK. That row is the claim
 * (a unique index on park+date+runner means a second run tonight finds the seat
 * taken), and it is also the liveness record the SCREEN reads to decide whether
 * the machine is alive. That direction is deliberate: an alert sent by the
 * scheduler cannot fire when the scheduler is what died.
 *
 * IT NEVER WRITES TO THE LEDGER. It reads, and it leaves sentences. The most it
 * can do wrong is put a wrong line on one man's screen.
 */

/** A read that returns {error, data:null} must THROW, not look like no rows. */
async function must<T>(
  label: string,
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${error.message}`);
  return (data ?? []) as T;
}

export interface ParkRunResult {
  ok: boolean;
  parks: number;
  findings: number;
  errors: string[];
  /**
   * THE URGENT FINDINGS, IN WORDS — not just how many.
   *
   * `reconcile` has always produced `live_lot_unbilled`: "N occupied lots have
   * no bill for August 2026. Somebody lives there and nothing is being
   * charged." It is the exact answer to "nothing raises the rent, the owner has
   * to remember every month, forever" — and it went into a COUNT, which went
   * into an HTTP response nobody reads. The machine noticed every night and
   * told nobody.
   *
   * Reporting is all it may do. Raising the bills unattended would assert that
   * money is owed by nineteen households, which is exactly what the park
   * autonomy rule reserves for a human tap: a job runs alone only when its
   * worst outcome is a sentence on a screen. This is that sentence.
   */
  urgent: string[];
}

/**
 * One park's read. Claims its seat, does the work, stamps the outcome.
 *
 * `ok:true, found:0` and `ok:false` are DIFFERENT ROWS on purpose — a job that
 * checked twenty households and found nothing and a job that threw on its first
 * query both report zero, and collapsing them is how a broken check hides for a
 * season.
 */
async function reconcileOnePark(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  today: string,
): Promise<{ findings: Finding[]; error: string | null }> {
  const runner = "reconcile";

  // The claim. A UNIQUE VIOLATION — and only that — means tonight is already
  // taken, which is not a problem and not worth reporting.
  //
  // This used to swallow EVERY error as "already ran". A missing table (which
  // is exactly what a rebuilt environment had, because 0079 was never
  // committed), a permissions change, a dropped connection — all of them
  // reported a clean night, forever, on a screen whose whole job is to tell
  // the owner whether anybody looked. Anything that is not 23505 is now a
  // failure with its own reason, which is what the row's own
  // `machine_run_failure_has_a_reason` constraint was written to insist on.
  const { error: claimErr } = await admin
    .from("park_machine_runs")
    .insert({ park_id: parkId, run_on: today, runner });
  if (claimErr) {
    if (claimErr.code === "23505") return { findings: [], error: null }; // already ran tonight
    return { findings: [], error: `couldn't claim tonight's run: ${claimErr.message}` };
  }

  try {
    const month = currentPeriod(today);

    const park = await must<Record<string, unknown>[]>(
      "parks",
      admin.from("parks").select("cutover_date").eq("id", parkId).limit(1),
    );
    // NOT sliced to a month here any more. The day decides whether the takeover
    // month is a part-month or wholly ours, and only `reconcile` knows what to
    // do with that — see its note on cutoverDate.
    const cutoverDate = (park[0]?.cutover_date as string) ?? null;

    const lots = await must<Record<string, unknown>[]>(
      "park_lots",
      admin.from("park_lots").select("id, lot_number, lifecycle").eq("park_id", parkId),
    );
    const live = lots.filter((l) => (l.lifecycle as string) === "live");
    const liveIds = live.map((l) => l.id as string);

    // THE ENDED ROWS COME TOO, and are split off at once. They reach ONE
    // fact — whether a lot is lapsed (lapsedRowOf: a household closed out
    // of its successor leaves the expired link before it held, run out, and
    // reading the held rows alone called that family "living here with no
    // agreement"). They do NOT reach `heldRows`: the run bills an ended row
    // only when it carries a move-out date (ledger-actions), and whether a
    // moved-out part month with no bill is a hole the nightly should name
    // is a separate question, left exactly where it was on purpose.
    const everyRow = liveIds.length
      ? await must<Record<string, unknown>[]>(
          "lot_reservations",
          admin.from("lot_reservations")
            .select("id, park_lot_id, during, quoted_amount, status, term")
            .in("park_lot_id", liveIds)
            .in("status", ["approved", "active", "ended"]),
        )
      : [];
    const stays = everyRow.filter((s) => s.status === "approved" || s.status === "active");

    // The rows the run would bill, in the shape the unbilled-months read
    // wants. `term` rides along because the run bills months only — a row
    // filed as paid yearly is refused by the run, so a month it has no bill
    // for must not be named as one (unbilled-months.ts says why).
    const heldRows = stays.map((s) => ({
      reservationId: s.id as string,
      lotId: s.park_lot_id as string,
      range: parseDaterange(s.during as string),
      term: (s.term as string | null) ?? null,
    }));

    // NOT ONE MONTH. This read the current month only, so a February hole on
    // a row backfilled in March was invisible every night after 1 March — and
    // it counted a VOIDED bill as a bill, which the run's own "already billed"
    // set does not (ledger-actions). It now reads from the first month
    // LakeLife may bill — or, for a park with no go-live day, from the
    // earliest held row's first month — up to today, live rows only. A floor
    // on `period_month` and nothing per month: the months are judged in
    // `unbilledMonthsFor`, one rule, not here.
    const earliestStart = heldRows
      .map((r) => r.range?.start.slice(0, 7))
      .filter((m): m is string => m != null)
      .sort()[0];
    const floor = firstBillablePeriod(cutoverDate) ?? earliestStart ?? month;
    const charges = await must<Record<string, unknown>[]>(
      "park_charges",
      admin.from("park_charges")
        .select("id, park_lot_id, reservation_id, period_month, amount, status")
        .eq("park_id", parkId)
        .gte("period_month", floor)
        .neq("status", "void"),
    );
    // Reservation → the months with a live charge on it. Keyed per ROW, the
    // way the run keys "already billed" (0081): the prior's February bill
    // never covers the successor's February.
    const billed = new Map<string, Set<string>>();
    for (const c of charges) {
      const rid = c.reservation_id as string | null;
      if (rid == null) continue;
      const months = billed.get(rid) ?? new Set<string>();
      months.add(c.period_month as string);
      billed.set(rid, months);
    }
    const unbilled = unbilledMonthsFor(heldRows, billed, { today, cutoverDate });

    const chargeIds = await must<Record<string, unknown>[]>(
      "park_charges(all)",
      admin.from("park_charges").select("id, park_lot_id").eq("park_id", parkId),
    );
    const lotOfCharge = new Map(chargeIds.map((c) => [c.id as string, c.park_lot_id as string]));

    const claims = chargeIds.length
      ? await must<Record<string, unknown>[]>(
          "park_payment_claims",
          admin.from("park_payment_claims")
            .select("charge_id, created_at")
            .in("charge_id", chargeIds.map((c) => c.id as string))
            .is("resolved_at", null),
        )
      : [];

    const lotName = new Map(lots.map((l) => [l.id as string, l.lot_number as string]));

    const byLot = new Map<string, { current: Record<string, unknown> | null; rows: LapseCandidate[] }>();
    for (const id of liveIds) byLot.set(id, { current: null, rows: [] });
    for (const s of everyRow) {
      const r = parseDaterange(s.during as string);
      const slot = byLot.get(s.park_lot_id as string);
      if (!slot) continue;
      slot.rows.push({ status: s.status as string, range: r, term: (s.term as string) ?? "monthly" });
      if (!r || s.status === "ended") continue;
      if (r.start <= today && today < r.end) slot.current = s;
    }

    const findings = reconcile({
      today,
      month,
      cutoverDate,
      lots: live.map((l) => {
        const slot = byLot.get(l.id as string)!;
        const amount = slot.current?.quoted_amount;
        return {
          lotNumber: (l.lot_number as string) ?? "?",
          occupiedToday: slot.current != null,
          quotedAmount: amount == null ? null : Number(amount),
          // LIVED ON, PAPERWORK RUN OUT — the roll's own rule, not a third
          // spelling of it. This set `expired` for ANY held row behind
          // today, so a checked-out weekend guest was "a household living
          // here with no agreement that has not run out" every night until
          // somebody hand-closed the row, and a lot with a future link read
          // the same. The helper knows short stays, coming links and
          // close-outs; the roll and Today read it too.
          lapsed: lapsedRowOf(slot.rows, today) != null,
          unbilledMonths: unbilled.get(l.id as string) ?? [],
          // Still the current month only: the run drops a zero statement
          // rather than charging $0, so a $0 charge is this month's news.
          statementZero: charges.some(
            (c) => c.park_lot_id === l.id && c.period_month === month && Number(c.amount) === 0,
          ),
        };
      }),
      openClaims: claims.map((c) => ({
        lotNumber: lotName.get(lotOfCharge.get(c.charge_id as string) ?? "") ?? "?",
        ageDays: Math.max(
          0,
          // `today` is a LAKE date; anchoring it at Z put it 4-5 hours before
          // lake midnight, so a claim made after ~7am aged one day short and
          // the 14-day chase fired a day late.
          lakeDaysSince(c.created_at as string, today),
        ),
      })),
    });

    // THE SENTENCES, NOT JUST THE COUNT. `found` alone was written into a
    // column nothing read, so a night that noticed an occupied lot with no
    // bill against it — a household living here and being charged nothing —
    // reported the number 1 to no one and told the owner "checked last night".
    // Written in the same statement as the count, which is what 0080's
    // constraint requires: a count that disagrees with its list lies twice.
    await admin
      .from("park_machine_runs")
      .update({
        found: findings.length,
        findings,
        finished_at: new Date().toISOString(),
      })
      .eq("park_id", parkId).eq("run_on", today).eq("runner", runner);

    return { findings, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // FAIL LOUDLY. The row records that this runner died by name, and the
    // screen turns that into an alarm — a check that threw must never be
    // indistinguishable from a check that found nothing.
    await admin
      .from("park_machine_runs")
      .update({ ok: false, error: message, finished_at: new Date().toISOString() })
      .eq("park_id", parkId).eq("run_on", today).eq("runner", runner);
    return { findings: [], error: `${parkId}: ${message}` };
  }
}

/** Every park the app knows about. Called once, from the nightly. */
export async function runParkNightly(): Promise<ParkRunResult> {
  const admin = createServiceClient();
  const today = todayLakeDate();

  const { data: parks, error } = await admin.from("parks").select("id, name");
  if (error) return { ok: false, parks: 0, findings: 0, errors: [error.message], urgent: [] };

  let findings = 0;
  const errors: string[] = [];
  const urgent: string[] = [];
  for (const p of parks ?? []) {
    const res = await reconcileOnePark(admin, p.id as string, today);
    findings += res.findings.length;
    // Named with the park, because there will be a second one and "3 occupied
    // lots have no bill" is unanswerable without knowing whose.
    for (const f of res.findings) {
      if (f.urgent) urgent.push(`${(p.name as string) ?? "A park"}: ${f.line}`);
    }
    if (res.error) errors.push(res.error);
  }

  return { ok: errors.length === 0, parks: (parks ?? []).length, findings, errors, urgent };
}

export { reconcileSummary };
