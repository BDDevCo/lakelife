import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A LIVE MERCHANT HAD NO DOORS AT ALL.
 *
 * From the money-rails audit. `OpsPaymentSetup` rendered its Close button
 * only for rows whose status was NOT active, so once a merchant went live:
 *
 *   nothing could stop it collecting rent, and
 *   nothing could correct the four digits we show a park owner as the account
 *   his residents' rent settles to.
 *
 * Both are permitted by 0196 — verified on production rather than assumed. The
 * guard refuses active -> draft/submitted and refuses reviving a closed
 * account, but active -> disabled is allowed and `settlement_last4` is not
 * frozen. So this was a UI gap wearing the shape of a rule.
 *
 * PROVEN AGAINST PRODUCTION, rolled back:
 *   a corrected_to=4321              b junk_last4_refused=t
 *   c live_merchant_stopped=disabled  d revive_refused=t
 *   e closed_not_editable             f fresh_setup_after_close=ok
 */

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const here = (p: string) => strip(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));

const src = here("./processor-actions.ts");
const panel = here("../../components/ops/OpsPaymentSetup.tsx");
const panelRaw = readFileSync(
  fileURLToPath(new URL("../../components/ops/OpsPaymentSetup.tsx", import.meta.url)), "utf8");

describe("correcting which account we say the money settles to", () => {
  it("is ops only", () => {
    const at = src.indexOf("export async function correctSettlementAccount");
    expect(at, "correctSettlementAccount is gone — repoint this").toBeGreaterThan(-1);
    expect(src.slice(at, at + 260)).toMatch(/await assertOps\(\)/);
  });

  it("takes four digits or nothing", () => {
    const body = src.slice(src.indexOf("export async function correctSettlementAccount"));
    expect(body).toMatch(/\/\^\\d\{4\}\$\/\.test\(four\)/);
  });

  it("ONLY ON A LIVE ONE", () => {
    // A draft has no settlement account yet, and a closed row is a record of
    // what used to be true — editing either is rewriting history rather than
    // correcting a copy. Proven: the filter matches nothing on a closed row.
    const body = src.slice(src.indexOf("export async function correctSettlementAccount"));
    const write = body.slice(body.indexOf(".update("), body.indexOf("if (error)"));
    expect(write.length, "the update is gone — this scan is measuring nothing").toBeGreaterThan(30);
    expect(write).toMatch(/\.eq\("status", "active"\)/);
  });

  it("AND IT SAYS IT CHANGED OUR COPY, NOT THE DESTINATION", () => {
    // The processor owns where the money goes and nothing here can move it.
    // An ops person who believes they have just redirected it will stop
    // looking — which is the one outcome worse than the wrong four digits.
    const body = src.slice(src.indexOf("export async function correctSettlementAccount"));
    expect(body).toMatch(/changed OUR copy only/);
    expect(body).toMatch(/has to be fixed with them/);
  });

  it("writes nothing else on the row", () => {
    // provider_merchant_id, the stamps and the capabilities are the
    // processor's answers; 0196 freezes most of them and this door has no
    // business near any of them.
    const body = src.slice(src.indexOf("export async function correctSettlementAccount"));
    const write = body.slice(body.indexOf(".update({"), body.indexOf("if (error)"));
    expect(write).toMatch(/settlement_last4: four/);
    for (const forbidden of [/status:/, /provider_merchant_id:/, /activated_at:/, /can_accept/, /disabled_at:/]) {
      expect(write, `the correction writes ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

describe("the ops panel finally has both", () => {
  it("OFFERS THEM ON A LIVE ROW, which is where there was nothing", () => {
    expect(panel).toMatch(/a\.status === "active" && openOn\?\.id !== a\.id/);
    expect(panelRaw).toMatch(/Fix the settlement account/);
    expect(panelRaw).toMatch(/Stop this merchant/);
  });

  it("and still closes a draft or submitted one the way it always did", () => {
    expect(panel).toMatch(/a\.status !== "active" && \(/);
    expect(panelRaw).toMatch(/Close this setup/);
  });

  it("STOPPING A LIVE MERCHANT IS CONFIRMED, and says what it stops", () => {
    // It takes the pay button away from residents, and 0196 makes it one-way:
    // a closed account cannot be reopened, only replaced.
    expect(panel).toMatch(/openOn\.what === "close"/);
    expect(panelRaw).toMatch(/stops being able to collect/);
    expect(panelRaw).toMatch(/cannot be reopened/);
    expect(panelRaw).toMatch(/Yes, stop collecting rent/);
    expect(panelRaw).toMatch(/Leave it live/);
  });

  it("the correction warns before it saves, not after", () => {
    expect(panel).toMatch(/openOn\.what === "fix"/);
    expect(panelRaw).toMatch(/corrects <b>our record<\/b>/);
    expect(panelRaw).toMatch(/does not move the money/);
  });

  it("the Correct it button is dead until four digits are typed", () => {
    expect(panel).toMatch(/!\/\^\\d\{4\}\$\/\.test\(\(fixLast4\[a\.id\] \?\? ""\)\.trim\(\)\)/);
  });

  it("and the decision panel closes once the write lands", () => {
    // Otherwise a confirmed Stop leaves its own confirm box on screen beside
    // a row that has already changed.
    const act = panel.slice(panel.indexOf("function act("), panel.indexOf("const rail ="));
    expect(act).toMatch(/setOpenOn\(null\);/);
  });
});

describe("nothing here invents the integration", () => {
  it("no action reaches out to a processor", () => {
    // Creating or changing the merchant with the processor is their API, and
    // its shape is still Step 1 of the roadmap. These actions record.
    for (const forbidden of [/fetch\(/, /https:\/\//, /axios/]) {
      expect(src, `processor-actions reaches out: ${forbidden}`).not.toMatch(forbidden);
    }
  });
});
