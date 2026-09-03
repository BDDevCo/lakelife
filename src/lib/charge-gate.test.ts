import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paymentsAreLive } from "./charge-gate";

/**
 * A MOCK MUST NEVER CREDIT A BILL.
 *
 * `LakeLifePayments.charge()` returns `{ ok: true, ref: "ch_mock_…" }` for any
 * valid token — correct for a mock of a processor contract, catastrophic as
 * the last thing between a resident and a bill marked PAID. Six paths in this
 * app charge a card and every one of them would have succeeded.
 *
 * The gate makes them all behave like a decline, which every caller already
 * handles. These tests hold two things down: that it is OFF by default, and
 * that no app file has quietly gone round it.
 */

const ENV = "LAKELIFE_PAYMENTS_LIVE";
afterEach(() => { delete process.env[ENV]; });

describe("off unless somebody explicitly switched it on", () => {
  it("is off when the variable is unset — the truth today and the safe default", () => {
    delete process.env[ENV];
    expect(paymentsAreLive()).toBe(false);
  });

  it("is off for every value that is not exactly 'true'", () => {
    // A processor is not connected by accident, and not by a typo either.
    for (const v of ["", "false", "0", "1", "yes", "TRUE", "True", " true", "true "]) {
      process.env[ENV] = v;
      expect(paymentsAreLive(), `${JSON.stringify(v)} must not switch payments on`).toBe(false);
    }
  });

  it("is on only for the exact string", () => {
    process.env[ENV] = "true";
    expect(paymentsAreLive()).toBe(true);
  });
});

describe("nothing goes round the gate", () => {
  // Walk src/ rather than listing files: a seventh charge path added next
  // month has to be caught without anybody remembering to update this list.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e)) out.push(p);
    }
    return out;
  };

  const APP_FILES = walk(join(process.cwd(), "src")).filter((p) => {
    const rel = p.replace(process.cwd() + "/", "");
    // The gate itself and the mock's own tests are the only places allowed to
    // name the raw processor.
    return rel !== "src/lib/charge-gate.ts"
        && rel !== "src/lib/payments.ts"
        && !rel.endsWith(".test.ts")
        && !rel.endsWith(".test.tsx");
  });

  it("finds files to scan — a scan over nothing proves nothing", () => {
    expect(APP_FILES.length).toBeGreaterThan(100);
  });

  it("no app file calls LakeLifePayments.charge directly", () => {
    const offenders = APP_FILES
      .filter((p) => /LakeLifePayments\s*\.\s*charge\s*\(/.test(readFileSync(p, "utf8")))
      .map((p) => p.replace(process.cwd() + "/", ""));
    expect(offenders, "use takePayment() — a direct call skips the no-processor gate").toEqual([]);
  });

  it("no app file calls LakeLifePayments.refund directly", () => {
    // A refund the processor never made is the same lie in reverse, and
    // park_refunds (0142) is append-only — a row saying money went back is
    // not something a later correction can unsay.
    const offenders = APP_FILES
      .filter((p) => /LakeLifePayments\s*\.\s*refund\s*\(/.test(readFileSync(p, "utf8")))
      .map((p) => p.replace(process.cwd() + "/", ""));
    expect(offenders, "use giveRefund() instead").toEqual([]);
  });

  it("every money path still goes through the gate — six charges and two refunds", () => {
    // The counterpart to the two scans above: they prove nothing bypasses the
    // gate, this proves the paths did not simply vanish. A refactor that
    // deleted a charge call would pass the negative scans silently.
    const src = APP_FILES.map((p) => readFileSync(p, "utf8")).join("\n");
    expect((src.match(/\btakePayment\(/g) ?? []).length,
      "six card-charging paths: 2 service bookings, rent, the recovery fee, the nightly settle, a cancel fee")
      .toBe(6);
    expect((src.match(/\bgiveRefund\(/g) ?? []).length,
      "two refund paths: the park ledger and refund-core")
      .toBe(2);
  });
});

describe("the resident is told which failure it was", () => {
  it("payRent does not say 'try again' when retrying cannot work", () => {
    // "That payment didn't go through. Try again" is true of a decline and a
    // lie when no processor exists — the same defect as the retry loop over a
    // unique-index collision.
    const s = readFileSync(join(process.cwd(), "src/app/parks/pay-actions.ts"), "utf8");
    expect(s, "the no-processor branch must exist").toMatch(/if \(!paymentsAreLive\(\)\)/);
    expect(s, "and say so in the resident's own terms")
      .toMatch(/aren't switched on for this park yet/);
  });
});
