/**
 * THE NIGHTLY DIGEST composer (Autonomy Ladder) — PURE, no I/O, fully
 * unit-testable, same pattern as comms-render and the refund math. The ONE
 * email that carries everything the machine did or noticed tonight — humans
 * read only what's non-empty, and a quiet night says so and nothing else.
 * sendNightlyDigest (lib/automation.ts) gathers the live facts and mails it.
 */

export interface DigestSections {
  learning: { changes: Array<{ service: string; from: number; to: number; samples: number }> };
  autoPricing: { changes: Array<{ label: string; service: string }> };
  disputeSweep: { fired: number; escalated: number; quietCloses?: number; reconciled?: number };
  escalatedDisputes: Array<{ service: string; note: string }>;
  lakesBorn: Array<{ name: string; source: string }>;
  routes: { hoursBust?: number };
  aiAutoReplies: number;
  aiReplyTexts: string[];
  gapSla: { alerted: number };
  /**
   * MONEY THAT MOVED TONIGHT (two-season audit, bug 10a). The nightly ran the
   * payout batches, the referral maturation, the cancellation-fee retries and
   * the refund reconcile, then returned them in an HTTP response nobody reads
   * — so month-end, the night the largest sum of the month leaves the account,
   * read as "Quiet night — nothing needed a human." These are OPTIONAL so a
   * caller that hasn't been wired up yet still compiles and still gets the
   * rest of its digest; a zero is silence, the same as every other section.
   */
  referralPayouts?: { beneficiaries: number; total: number };
  crewPayouts?: { batches: number; total: number };
  referralCredits?: { granted: number; total?: number };
  cancellationFees?: { collected: number; total?: number };
  /**
   * VISITS WHERE NOBODY GOT ANY WORK DONE and the customer never picked
   * another day (0089). These are PROPOSALS sitting on an ops screen waiting
   * for a person — the one branch of the recovery path that does not resolve
   * itself. A proposal nobody is told about is a proposal nobody actions, and
   * the customer meanwhile hears nothing at all.
   */
  visitFees?: { proposed: number; skipped: number };
  refundsReconciled?: { orphansCleared: number; flipsCompleted: number };
  /**
   * STEPS THAT THREW TONIGHT. The nightly wraps each of its ~27 steps in a
   * guard so one failure cannot take the rest of the night down — but it
   * collected the failures and then dropped them, so a night where the charge
   * run died produced the same email as a clean one. This renders FIRST,
   * before anything that went right.
   */
  failures?: Array<{ step: string; error: string }>;
  /**
   * Homes on the books with no lake against them.
   *
   * A null lake is not cosmetic: dispatch's geo gate is skipped so a crew who
   * doesn't serve that water is eligible, the calendar's capacity is unscoped,
   * ice-out and the pull deadline enforce nothing, and the seasonal freeze
   * warning — which filters on lake_id — never reaches them. Crew imports
   * minted these silently. Ops is the only thing that can fix one.
   */
  homesWithNoLake?: number;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain-English HTML body. Every section is skippable — only what actually
 *  happened tonight shows up. Pure: no I/O, easy to unit test. */
export function composeNightlyDigest(sections: DigestSections): string {
  const parts: string[] = [];
  const plural = (n: number) => (n === 1 ? "" : "s");

  // WHAT BROKE, ABOVE WHAT WORKED. A digest that leads with good news while a
  // step is dying is worse than no digest — it actively reassures.
  if (sections.failures && sections.failures.length > 0) {
    const n = sections.failures.length;
    const items = sections.failures
      .map((f) => `<li><strong>${escHtml(f.step)}</strong> — ${escHtml(f.error)}</li>`)
      .join("");
    parts.push(
      `<h3>⚠️ ${n} step${plural(n)} failed tonight</h3>` +
      `<p>The rest of the night still ran. These did not, and nothing retried them:</p>` +
      `<ul>${items}</ul>`,
    );
  }

  if (sections.learning.changes.length > 0) {
    const n = sections.learning.changes.length;
    const items = sections.learning.changes
      .map((c) => `<li>${escHtml(c.service)}: ${c.from} → ${c.to} min (${c.samples} job${plural(c.samples)})</li>`)
      .join("");
    parts.push(`<h3>Duration dial</h3><p>The router's time estimate moved on its own for ${n} service${plural(n)}:</p><ul>${items}</ul>`);
  }

  if (sections.autoPricing.changes.length > 0) {
    const n = sections.autoPricing.changes.length;
    const items = sections.autoPricing.changes.map((c) => `<li>${escHtml(c.service)} — ${escHtml(c.label)}</li>`).join("");
    parts.push(`<h3>Prices auto-applied</h3><p>${n} menu raise${plural(n)} went live on their own tonight:</p><ul>${items}</ul>`);
  }

  const quietCloses = sections.disputeSweep.quietCloses ?? 0;
  const reconciled = sections.disputeSweep.reconciled ?? 0;
  if (sections.disputeSweep.fired > 0 || sections.disputeSweep.escalated > 0 || quietCloses > 0 || reconciled > 0 || sections.escalatedDisputes.length > 0) {
    const bits: string[] = [];
    if (sections.disputeSweep.fired > 0) bits.push(`${sections.disputeSweep.fired} auto-refunded`);
    if (sections.disputeSweep.escalated > 0) bits.push(`${sections.disputeSweep.escalated} escalated`);
    // Quiet closes RELEASE held money in the crew's favor — automated money
    // movement the digest exists to surface (review finding).
    if (quietCloses > 0) bits.push(`${quietCloses} closed in the crew's favor (customer went quiet)`);
    if (reconciled > 0) bits.push(`${reconciled} lost 👎${plural(reconciled)} recovered into fresh disputes`);
    const sweepLine = bits.length > 0 ? `<p>Deadline sweep: ${bits.join(", ")}.</p>` : "";
    const list =
      sections.escalatedDisputes.length > 0
        ? `<p><b>${sections.escalatedDisputes.length} dispute${plural(sections.escalatedDisputes.length)} waiting on you:</b></p><ul>${sections.escalatedDisputes
            .map((d) => `<li>${escHtml(d.service)}${d.note ? ` — "${escHtml(d.note)}"` : ""}</li>`)
            .join("")}</ul>`
        : "";
    parts.push(`<h3>Make-It-Right</h3>${sweepLine}${list}`);
  }

  if (sections.lakesBorn.length > 0) {
    const n = sections.lakesBorn.length;
    const items = sections.lakesBorn.map((l) => `<li>${escHtml(l.name)} — from a ${escHtml(l.source)}</li>`).join("");
    parts.push(`<h3>New lakes</h3><p>${n} lake${plural(n)} born in the last 24 hours:</p><ul>${items}</ul>`);
  }

  const hoursBust = sections.routes.hoursBust ?? 0;
  if (hoursBust > 0) {
    parts.push(
      `<h3>Routes</h3><p>${hoursBust} truck day${plural(hoursBust)} tomorrow run past a crew's hours — they've been texted; nothing to do unless it keeps happening.</p>`,
    );
  }

  // AUDIT BUG 10b: the gate was `aiAutoReplies > 0` alone — but the count is
  // a head-count query (`aiCount ?? 0`) while the texts come from a different
  // query, so a null count zeroed the gate while the texts survived and the
  // safety net vanished. Texts OR a positive count opens the section, and the
  // headline falls back to the number of texts actually in hand.
  if (sections.aiAutoReplies > 0 || sections.aiReplyTexts.length > 0) {
    const n = sections.aiAutoReplies > 0 ? sections.aiAutoReplies : sections.aiReplyTexts.length;
    // The TEXTS, not just the count — an auto-sent reply that promised
    // something it shouldn't have needs to be seen the next morning, not
    // discovered by the customer holding LakeLife to it (review finding).
    const samples = sections.aiReplyTexts.length > 0
      ? `<ul>${sections.aiReplyTexts.map((t) => `<li>"${escHtml(t)}"</li>`).join("")}</ul>`
      : "";
    parts.push(`<h3>AI auto-replies</h3><p>${n} customer message${plural(n)} got an AI auto-reply in the last 24 hours.</p>${samples}`);
  }

  // MONEY MOVED (audit bug 10a) — one section, every rail that moved cash
  // tonight. Ops should never learn that month-end ran from a bank statement.
  {
    const money: string[] = [];
    const usd = (n: number) => `$${n.toFixed(2)}`;
    const rp = sections.referralPayouts;
    if (rp && (rp.beneficiaries > 0 || rp.total > 0)) {
      money.push(`<li>Referral payout batch: <b>${usd(rp.total)}</b> approved for ${rp.beneficiaries} beneficiar${rp.beneficiaries === 1 ? "y" : "ies"}.</li>`);
    }
    const cp = sections.crewPayouts;
    if (cp && (cp.batches > 0 || cp.total > 0)) {
      money.push(`<li>Crew month-end payouts: <b>${usd(cp.total)}</b> queued across ${cp.batches} batch${cp.batches === 1 ? "" : "es"}.</li>`);
    }
    const rc = sections.referralCredits;
    if (rc && (rc.granted > 0 || (rc.total ?? 0) > 0)) {
      const amt = rc.total != null ? ` — <b>${usd(rc.total)}</b>` : "";
      money.push(`<li>Referral earnings matured into spendable credits: ${rc.granted}${amt}.</li>`);
    }
    const cf = sections.cancellationFees;
    if (cf && (cf.collected > 0 || (cf.total ?? 0) > 0)) {
      const amt = cf.total != null ? ` — <b>${usd(cf.total)}</b>` : "";
      money.push(`<li>Late-cancellation fee${plural(cf.collected)} collected on retry: ${cf.collected}${amt}.</li>`);
    }
    // NOT money that moved — money WAITING ON A DECISION. Rendered here
    // because it is the only branch of the recovery path that stalls without
    // a person, and phrased as an ask rather than a total so nobody reads it
    // as revenue already banked.
    const vf = sections.visitFees;
    if (vf && vf.proposed > 0) {
      money.push(
        `<li><b>${vf.proposed} missed visit${plural(vf.proposed)}</b> passed the ` +
        `reschedule window with no reply — a fee is proposed and needs your yes ` +
        `or a waive. Nothing has been charged.</li>`,
      );
    }
    const rr = sections.refundsReconciled;
    if (rr && (rr.orphansCleared > 0 || rr.flipsCompleted > 0)) {
      const bits: string[] = [];
      if (rr.flipsCompleted > 0) bits.push(`${rr.flipsCompleted} refund${plural(rr.flipsCompleted)} finished settling (invoice flipped, referrals voided)`);
      if (rr.orphansCleared > 0) bits.push(`${rr.orphansCleared} stranded claim${plural(rr.orphansCleared)} cleared (no cash ever moved)`);
      money.push(`<li>Refunds reconciled: ${bits.join("; ")}.</li>`);
    }
    if (money.length > 0) {
      parts.push(`<h3>Money moved tonight</h3><ul>${money.join("")}</ul>`);
    }
  }

  if (sections.gapSla.alerted > 0) {
    parts.push(`<h3>Gap SLA</h3><p>${sections.gapSla.alerted} job${plural(sections.gapSla.alerted)} sat unclaimed past the SLA tonight and triggered an ops alert.</p>`);
  }

  if (sections.homesWithNoLake && sections.homesWithNoLake > 0) {
    const n = sections.homesWithNoLake;
    parts.push(
      `<h3>${n} ${n === 1 ? "home has" : "homes have"} no lake set</h3>` +
      `<p>They're invisible to the freeze warning, the crew geo gate doesn't ` +
      `apply to them, and ice-out and the pull deadline enforce nothing on ` +
      `their water work. Set the lake on each one in ops.</p>`,
    );
  }

  if (parts.length === 0) return `<p>Quiet night — nothing needed a human. 🌊</p>`;
  return parts.join("\n");
}

