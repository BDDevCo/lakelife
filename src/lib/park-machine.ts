import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import { currentPeriod } from "@/app/park/ledger-helpers";
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

  // The claim. A unique violation means tonight is already taken.
  const { error: claimErr } = await admin
    .from("park_machine_runs")
    .insert({ park_id: parkId, run_on: today, runner });
  if (claimErr) return { findings: [], error: null }; // already ran tonight

  try {
    const month = currentPeriod(today);

    const park = await must<Record<string, unknown>[]>(
      "parks",
      admin.from("parks").select("cutover_date").eq("id", parkId).limit(1),
    );
    const cutoverDate = (park[0]?.cutover_date as string) ?? null;
    const cutoverMonth = cutoverDate ? cutoverDate.slice(0, 7) : null;

    const lots = await must<Record<string, unknown>[]>(
      "park_lots",
      admin.from("park_lots").select("id, lot_number, lifecycle").eq("park_id", parkId),
    );
    const live = lots.filter((l) => (l.lifecycle as string) === "live");
    const liveIds = live.map((l) => l.id as string);

    const stays = liveIds.length
      ? await must<Record<string, unknown>[]>(
          "lot_reservations",
          admin.from("lot_reservations")
            .select("id, park_lot_id, during, quoted_amount, status")
            .in("park_lot_id", liveIds)
            .in("status", ["approved", "active"]),
        )
      : [];

    const charges = await must<Record<string, unknown>[]>(
      "park_charges",
      admin.from("park_charges")
        .select("id, park_lot_id, period_month, amount")
        .eq("park_id", parkId).eq("period_month", month),
    );
    const billedLots = new Set(charges.map((c) => c.park_lot_id as string));

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

    const byLot = new Map<string, { current: Record<string, unknown> | null; expired: boolean }>();
    for (const id of liveIds) byLot.set(id, { current: null, expired: false });
    for (const s of stays) {
      const r = parseDaterange(s.during as string);
      if (!r) continue;
      const slot = byLot.get(s.park_lot_id as string);
      if (!slot) continue;
      if (r.start <= today && today < r.end) slot.current = s;
      // Ended on paper, nobody moved out, nothing ended it.
      else if (r.end <= today) slot.expired = true;
    }
    // A lot with a live tenancy is not "expired" just because an older one was.
    for (const slot of byLot.values()) if (slot.current) slot.expired = false;

    const findings = reconcile({
      today,
      month,
      cutoverMonth,
      lots: live.map((l) => {
        const slot = byLot.get(l.id as string)!;
        const amount = slot.current?.quoted_amount;
        return {
          lotNumber: (l.lot_number as string) ?? "?",
          occupiedToday: slot.current != null,
          quotedAmount: amount == null ? null : Number(amount),
          tenancyExpired: slot.expired,
          billedThisMonth: billedLots.has(l.id as string),
          statementZero: charges.some(
            (c) => c.park_lot_id === l.id && Number(c.amount) === 0,
          ),
        };
      }),
      openClaims: claims.map((c) => ({
        lotNumber: lotName.get(lotOfCharge.get(c.charge_id as string) ?? "") ?? "?",
        ageDays: Math.max(
          0,
          Math.round(
            (Date.parse(`${today}T00:00:00Z`) - Date.parse(c.created_at as string)) / 86_400_000,
          ),
        ),
      })),
    });

    await admin
      .from("park_machine_runs")
      .update({ found: findings.length, finished_at: new Date().toISOString() })
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
  if (error) return { ok: false, parks: 0, findings: 0, errors: [error.message] };

  let findings = 0;
  const errors: string[] = [];
  for (const p of parks ?? []) {
    const res = await reconcileOnePark(admin, p.id as string, today);
    findings += res.findings.length;
    if (res.error) errors.push(res.error);
  }

  return { ok: errors.length === 0, parks: (parks ?? []).length, findings, errors };
}

export { reconcileSummary };
