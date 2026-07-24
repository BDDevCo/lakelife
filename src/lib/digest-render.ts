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
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain-English HTML body. Every section is skippable — only what actually
 *  happened tonight shows up. Pure: no I/O, easy to unit test. */
export function composeNightlyDigest(sections: DigestSections): string {
  const parts: string[] = [];
  const plural = (n: number) => (n === 1 ? "" : "s");

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

  if (sections.aiAutoReplies > 0) {
    // The TEXTS, not just the count — an auto-sent reply that promised
    // something it shouldn't have needs to be seen the next morning, not
    // discovered by the customer holding LakeLife to it (review finding).
    const samples = sections.aiReplyTexts.length > 0
      ? `<ul>${sections.aiReplyTexts.map((t) => `<li>"${escHtml(t)}"</li>`).join("")}</ul>`
      : "";
    parts.push(`<h3>AI auto-replies</h3><p>${sections.aiAutoReplies} customer message${plural(sections.aiAutoReplies)} got an AI auto-reply in the last 24 hours.</p>${samples}`);
  }

  if (sections.gapSla.alerted > 0) {
    parts.push(`<h3>Gap SLA</h3><p>${sections.gapSla.alerted} job${plural(sections.gapSla.alerted)} sat unclaimed past the SLA tonight and triggered an ops alert.</p>`);
  }

  if (parts.length === 0) return `<p>Quiet night — nothing needed a human. 🌊</p>`;
  return parts.join("\n");
}

