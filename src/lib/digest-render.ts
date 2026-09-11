import { html, type RawHtml } from "@/lib/html-safe";
/**
 * THE NIGHTLY DIGEST composer (Autonomy Ladder) — PURE, no I/O, fully
 * unit-testable, same pattern as comms-render and the refund math. The ONE
 * email that carries everything the machine did or noticed tonight — humans
 * read only what's non-empty, and a quiet night says so and nothing else.
 * sendNightlyDigest (lib/automation.ts) gathers the live facts and mails it.
 */

/** How an entry got onto the needs-a-look list. See DigestSections.failures. */
export type NeedsLookKind = "failed" | "skipped" | "found";

/**
 * The needs-a-look list, counted by kind — ONE place, so the heading in the
 * email and the subject line on the phone cannot disagree about the night.
 * An entry with no kind counts as `failed` (see DigestSections.failures).
 */
export function countNeedsLook(entries: ReadonlyArray<{ kind?: NeedsLookKind }>): { total: number; failed: number; skipped: number; found: number } {
  let failed = 0, skipped = 0, found = 0;
  for (const e of entries) {
    if (e.kind === "skipped") skipped++;
    else if (e.kind === "found") found++;
    else failed++;
  }
  return { total: entries.length, failed, skipped, found };
}

/**
 * The subject line's tail for a night with a needs-a-look list. Ops reads
 * this on a phone, in a list, at night: the count is always there, and the
 * word FAILED only when a step actually did — "N steps FAILED" over a list
 * of skips and findings was the same lie as the old heading, one line up.
 */
export function needsLookSubject(entries: ReadonlyArray<{ kind?: NeedsLookKind }>): string {
  const c = countNeedsLook(entries);
  const head = `${c.total} thing${c.total === 1 ? "" : "s"} need${c.total === 1 ? "s" : ""} a look`;
  return c.failed > 0 ? `${head}, ${c.failed} step${c.failed === 1 ? "" : "s"} FAILED` : head;
}

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
  /**
   * TRIP FEES PAID TO CREWS for visits that produced no work (0090). `onUs` is
   * the part LakeLife funded rather than a customer — a waived fee, or a
   * stand-down caused by our own stale profile. It is broken out on purpose:
   * that number IS the running cost of bad property data, and if it climbs it
   * is telling you to go and fix profiles, not to lower the trip fee.
   */
  tripFees?: { paid: number; total: number; onUs: number };
  /**
   * TIPS COLLECTED FROM CUSTOMERS since the last digest (0097/0098).
   *
   * The section reported tip money going OUT — `runMonthlyPayoutBatches` has no
   * kind filter, so tips ride inside "Crew month-end payouts" unlabelled — and
   * never reported it coming IN. A "money moved" section that shows one side
   * of a two-sided flow reads as balanced and isn't.
   *
   * It is stated as pass-through, not as takings: none of it is ours.
   */
  tipsCollected?: { count: number; total: number };
  refundsReconciled?: { orphansCleared: number; flipsCompleted: number };
  /**
   * WHAT NEEDS A LOOK TONIGHT. The nightly wraps each of its ~27 steps in a
   * guard so one failure cannot take the rest of the night down — but it
   * collected the failures and then dropped them, so a night where the charge
   * run died produced the same email as a clean one. This renders FIRST,
   * before anything that went right.
   *
   * The list deliberately holds more than throws (nightly-rules "rule 2": to
   * the person reading it at 8am, "the step died" and "the step quietly
   * didn't do it" need the same response), so each entry says which it is:
   *   failed  — the step threw, or a read the digest itself needed failed;
   *             it did not run tonight.
   *   skipped — the step ran and left this one item undone (a job it could
   *             not re-check, a settle that refused, a crew it could not
   *             reach).
   *   found   — nothing broke; a standing fact the machine reports rather
   *             than acts on (the park's "N occupied lots have no bill").
   * An entry with no kind is read as `failed` — the list's original meaning,
   * kept for a caller that predates kinds. The route stamps every one it
   * pushes (route.test.ts holds that), so nothing real arrives unlabelled.
   */
  failures?: Array<{ step: string; error: string; kind?: NeedsLookKind }>;
  /**
   * WORK NOBODY HAS TAKEN, as a standing count. revalidateAssignments
   * re-checks the whole forward book nightly and texts ops the night a
   * service is open that no crew on the platform offers — once per service
   * per week (nudge_log `dead_end:<service>`), because before that memory
   * existed one unfillable booking six weeks out raised the same alarm every
   * night until its date. That alarm was also ops' ONLY signal about unfilled
   * work: dispatch handed the digest nothing. This is the standing fact the
   * alarm used to stand in for, said every morning without a fresh text —
   * the same principle 0165 states for an unpaid invoice.
   *
   * `jobs` are forward jobs with no crew after tonight's re-check;
   * `crewsNotified` is how many crews the up-for-grabs notice actually
   * reached (a door took it — not attempts); `deadEnd` names the services
   * no active, insured, non-fixture crew offers. Zero jobs is silence.
   */
  unfilled?: { jobs: number; crewsNotified: number; deadEnd: string[] };
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

/** Plain-English HTML body. Every section is skippable — only what actually
 *  happened tonight shows up. Pure: no I/O, easy to unit test. */
export function composeNightlyDigest(sections: DigestSections): string {
  const parts: RawHtml[] = [];
  const plural = (n: number) => (n === 1 ? "" : "s");

  // WHAT NEEDS A LOOK, ABOVE WHAT WORKED. A digest that leads with good news
  // while a step is dying is worse than no digest — it actively reassures.
  //
  // The heading used to say "N steps failed tonight — these did not run",
  // which was true of a thrown step and false of everything else the route
  // deliberately merges into this list: a job one step could not re-check, a
  // settle that refused, the park's "N occupied lots have no bill". So the
  // heading says only what is true of all of them, the intro counts each
  // kind by its own name, and every line is labelled.
  if (sections.failures && sections.failures.length > 0) {
    const c = countNeedsLook(sections.failures);
    const kindOf = (f: { kind?: NeedsLookKind }): NeedsLookKind => f.kind ?? "failed";
    const items = sections.failures
      .map((f) => html`<li><strong>${kindOf(f)}</strong> · <strong>${f.step}</strong> — ${f.error}</li>`);
    // Each fragment is a sentence this function writes itself, built as a
    // nested html`` so its counters are escaped and its words stay literal —
    // the same construct (RawHtml[], never string[]) the Make-It-Right sweep
    // line uses below.
    const byKind: RawHtml[] = [];
    if (c.failed > 0) byKind.push(html`${c.failed} step${plural(c.failed)} failed tonight and didn't finish`);
    if (c.skipped > 0) byKind.push(html`${c.skipped} item${plural(c.skipped)} ${c.skipped === 1 ? "was" : "were"} skipped by a step that otherwise ran`);
    if (c.found > 0) byKind.push(html`${c.found} standing finding${plural(c.found)} the machine reports rather than acts on`);
    parts.push(
      html`<h3>⚠️ ${c.total} thing${plural(c.total)} need${c.total === 1 ? "s" : ""} a look</h3><p>The rest of the night still ran. ${byKind.map((b, i) => (i === 0 ? b : html`; ${b}`))}:</p><ul>${items}</ul>`,
    );
  }

  if (sections.learning.changes.length > 0) {
    const n = sections.learning.changes.length;
    const items = sections.learning.changes
      .map((c) => html`<li>${c.service}: ${c.from} → ${c.to} min (${c.samples} job${plural(c.samples)})</li>`);
    parts.push(html`<h3>Duration dial</h3><p>The router's time estimate moved on its own for ${n} service${plural(n)}:</p><ul>${items}</ul>`);
  }

  if (sections.autoPricing.changes.length > 0) {
    const n = sections.autoPricing.changes.length;
    const items = sections.autoPricing.changes.map((c) => html`<li>${c.service} — ${c.label}</li>`);
    parts.push(html`<h3>Prices auto-applied</h3><p>${n} menu raise${plural(n)} went live on their own tonight:</p><ul>${items}</ul>`);
  }

  const quietCloses = sections.disputeSweep.quietCloses ?? 0;
  const reconciled = sections.disputeSweep.reconciled ?? 0;
  if (sections.disputeSweep.fired > 0 || sections.disputeSweep.escalated > 0 || quietCloses > 0 || reconciled > 0 || sections.escalatedDisputes.length > 0) {
    // THE TAG'S OWN PROSE, NOT A VALUE. Each bit is a sentence this function
    // writes itself, so it is built as a nested html`` — its counters are
    // interpolated and escaped like everything else, and its literal words
    // stay literal, exactly as they do in "the router's time estimate" and
    // "a crew's hours" two sections away. Handing the joined sentence over as
    // a plain string instead would escape our own apostrophe into `&#39;`,
    // which no other literal in this file suffers. No raw() either way.
    const bits: RawHtml[] = [];
    if (sections.disputeSweep.fired > 0) bits.push(html`${sections.disputeSweep.fired} auto-refunded`);
    if (sections.disputeSweep.escalated > 0) bits.push(html`${sections.disputeSweep.escalated} escalated`);
    // Quiet closes RELEASE held money in the crew's favor — automated money
    // movement the digest exists to surface (review finding).
    if (quietCloses > 0) bits.push(html`${quietCloses} closed in the crew's favor (customer went quiet)`);
    if (reconciled > 0) bits.push(html`${reconciled} lost 👎${plural(reconciled)} recovered into fresh disputes`);
    // The tag joins an array with nothing, so the ", " between bits is itself
    // a nested template rather than a .join() the tag would then escape.
    const sweepLine = bits.length > 0 ? html`<p>Deadline sweep: ${bits.map((b, i) => (i === 0 ? b : html`, ${b}`))}.</p>` : "";
    const list =
      sections.escalatedDisputes.length > 0
        ? html`<p><b>${sections.escalatedDisputes.length} dispute${plural(sections.escalatedDisputes.length)} waiting on you:</b></p><ul>${sections.escalatedDisputes
            .map((d) => html`<li>${d.service}${d.note ? html` — "${d.note}"` : ""}</li>`)}</ul>`
        : "";
    parts.push(html`<h3>Make-It-Right</h3>${sweepLine}${list}`);
  }

  if (sections.lakesBorn.length > 0) {
    const n = sections.lakesBorn.length;
    const items = sections.lakesBorn.map((l) => html`<li>${l.name} — from a ${l.source}</li>`);
    parts.push(html`<h3>New lakes</h3><p>${n} lake${plural(n)} born in the last 24 hours:</p><ul>${items}</ul>`);
  }

  const hoursBust = sections.routes.hoursBust ?? 0;
  if (hoursBust > 0) {
    parts.push(
      html`<h3>Routes</h3><p>${hoursBust} truck day${plural(hoursBust)} tomorrow run past a crew's hours — they've been told; nothing to do unless it keeps happening.</p>`,
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
      ? html`<ul>${sections.aiReplyTexts.map((t) => html`<li>"${t}"</li>`)}</ul>`
      : "";
    parts.push(html`<h3>AI auto-replies</h3><p>${n} customer message${plural(n)} got an AI auto-reply in the last 24 hours.</p>${samples}`);
  }

  // MONEY MOVED (audit bug 10a) — one section, every rail that moved cash
  // tonight. Ops should never learn that month-end ran from a bank statement.
  {
    const money: RawHtml[] = [];
    const usd = (n: number) => `$${n.toFixed(2)}`;
    const rp = sections.referralPayouts;
    if (rp && (rp.beneficiaries > 0 || rp.total > 0)) {
      money.push(html`<li>Referral payout batch: <b>${usd(rp.total)}</b> approved for ${rp.beneficiaries} beneficiar${rp.beneficiaries === 1 ? "y" : "ies"}.</li>`);
    }
    const cp = sections.crewPayouts;
    if (cp && (cp.batches > 0 || cp.total > 0)) {
      money.push(html`<li>Crew month-end payouts: <b>${usd(cp.total)}</b> queued across ${cp.batches} batch${cp.batches === 1 ? "" : "es"}.</li>`);
    }
    const rc = sections.referralCredits;
    if (rc && (rc.granted > 0 || (rc.total ?? 0) > 0)) {
      const amt = rc.total != null ? html` — <b>${usd(rc.total)}</b>` : "";
      money.push(html`<li>Referral earnings matured into spendable credits: ${rc.granted}${amt}.</li>`);
    }
    const cf = sections.cancellationFees;
    if (cf && (cf.collected > 0 || (cf.total ?? 0) > 0)) {
      const amt = cf.total != null ? html` — <b>${usd(cf.total)}</b>` : "";
      money.push(html`<li>Late-cancellation fee${plural(cf.collected)} collected on retry: ${cf.collected}${amt}.</li>`);
    }
    // NOT money that moved — money WAITING ON A DECISION. Rendered here
    // because it is the only branch of the recovery path that stalls without
    // a person, and phrased as an ask rather than a total so nobody reads it
    // as revenue already banked.
    const vf = sections.visitFees;
    if (vf && vf.proposed > 0) {
      money.push(
        html`<li><b>${vf.proposed} missed visit${plural(vf.proposed)}</b> passed the reschedule window with no reply — a fee is proposed and needs your yes or a waive. Nothing has been charged.</li>`,
      );
    }
    const tf = sections.tripFees;
    if (tf && tf.paid > 0) {
      const ours = tf.onUs > 0 ? html` — <b>${usd(tf.onUs)}</b> of it on us (waived fees and our own bad profiles)` : "";
      money.push(
        html`<li>Trip fee${plural(tf.paid)} to crews for visits that produced no work: ${tf.paid}, ${usd(tf.total)}${ours}.</li>`,
      );
    }
    const tips = sections.tipsCollected;
    if (tips && tips.count > 0) {
      money.push(
        html`<li>Tips from customers: <b>${tips.count}</b>, ${usd(tips.total)} — passed to crews in full. None of it is ours.</li>`,
      );
    }
    const rr = sections.refundsReconciled;
    if (rr && (rr.orphansCleared > 0 || rr.flipsCompleted > 0)) {
      // SAME SHAPE AS THE SWEEP BITS ABOVE, and it was left as a plain
      // string[] — so this one joined sentence went through the escaper while
      // every other literal in the file did not. It renders identically today
      // purely because these two sentences happen to contain no apostrophe,
      // ampersand or quote. The first person to write "the crew's refund" or
      // "invoice & referral" here would have found the only literal in the
      // file that silently escapes. One construct, one way.
      const bits: RawHtml[] = [];
      if (rr.flipsCompleted > 0) bits.push(html`${rr.flipsCompleted} refund${plural(rr.flipsCompleted)} finished settling (invoice flipped, referrals voided)`);
      if (rr.orphansCleared > 0) bits.push(html`${rr.orphansCleared} stranded claim${plural(rr.orphansCleared)} cleared (no cash ever moved)`);
      money.push(html`<li>Refunds reconciled: ${bits.map((b, i) => (i === 0 ? b : html`; ${b}`))}.</li>`);
    }
    if (money.length > 0) {
      parts.push(html`<h3>Money moved tonight</h3><ul>${money}</ul>`);
    }
  }

  if (sections.gapSla.alerted > 0) {
    parts.push(html`<h3>Gap SLA</h3><p>${sections.gapSla.alerted} job${plural(sections.gapSla.alerted)} sat unclaimed past the SLA tonight and triggered an ops alert.</p>`);
  }

  // OPEN WORK, EVERY MORNING. This is the count the repeating dead-end text
  // used to stand in for. Nothing here is an alarm: the ops text for a
  // service nobody offers goes out on its own weekly memory, and this line is
  // simply what the book looked like after tonight's re-check.
  const uf = sections.unfilled;
  if (uf && uf.jobs > 0) {
    const n = uf.jobs;
    const crews = uf.crewsNotified > 0
      ? html`The up-for-grabs notice reached ${uf.crewsNotified} crew${plural(uf.crewsNotified)} — the first to claim a job gets it.`
      : html`No crew was sent the up-for-grabs notice tonight.`;
    const dead = uf.deadEnd.length > 0
      ? html` <b>Nobody on the platform offers ${uf.deadEnd.map((s, i) => (i === 0 ? html`${s}` : html`, ${s}`))}</b> — a recruiting signal; there is nothing to dispatch until an active, insured crew offers ${uf.deadEnd.length === 1 ? "it" : "them"}.`
      : "";
    parts.push(
      html`<h3>Open work</h3><p>${n} job${plural(n)} still ${n === 1 ? "has" : "have"} no crew after tonight's re-check. ${crews}${dead}</p>`,
    );
  }

  if (sections.homesWithNoLake && sections.homesWithNoLake > 0) {
    const n = sections.homesWithNoLake;
    parts.push(
      html`<h3>${n} ${n === 1 ? "home has" : "homes have"} no lake set</h3><p>They're invisible to the freeze warning, the crew geo gate doesn't apply to them, and ice-out and the pull deadline enforce nothing on their water work. Set the lake on each one in ops.</p>`,
    );
  }

  if (parts.length === 0) return `<p>Quiet night — nothing needed a human. 🌊</p>`;
  return parts.map(String).join("\n");
}

