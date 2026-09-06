import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paymentsAreLive, chargeKey, takePayment, NO_PROCESSOR_REASON } from "./charge-gate";

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
        && rel !== "src/lib/payments-server.ts"
        && !rel.endsWith(".test.ts")
        && !rel.endsWith(".test.tsx");
  });

  it("finds files to scan — a scan over nothing proves nothing", () => {
    expect(APP_FILES.length).toBeGreaterThan(100);
  });

  it("no app file calls LakeLifePayments.charge directly", () => {
    const offenders = APP_FILES
      .filter((p) => /LakeLifePayments\w*\s*\.\s*charge\s*\(/.test(readFileSync(p, "utf8")))
      .map((p) => p.replace(process.cwd() + "/", ""));
    expect(offenders, "use takePayment() — a direct call skips the no-processor gate").toEqual([]);
  });

  it("no app file calls LakeLifePayments.refund directly", () => {
    // A refund the processor never made is the same lie in reverse, and
    // park_refunds (0142) is append-only — a row saying money went back is
    // not something a later correction can unsay.
    const offenders = APP_FILES
      .filter((p) => /LakeLifePayments\w*\s*\.\s*refund\s*\(/.test(readFileSync(p, "utf8")))
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

// ===========================================================================
// THE DAY IT STOPS DECLINING
// ===========================================================================
/**
 * Nothing below can cost anybody a cent today: `takePayment` refuses every
 * charge while `LAKELIFE_PAYMENTS_LIVE` is unset. All of it costs money on the
 * first morning that variable is set.
 *
 * Five of the six charge paths sent NO idempotency key, and every one of them
 * charged the card BEFORE writing the row that records it. A crash, a timeout
 * or a double-tapped button in between debits a customer twice and leaves the
 * ledger unable to tell which of the two it holds. The key is the only thing
 * that stops the second DEBIT — `payments_one_capture_per_invoice` refuses the
 * second ROW, which is one moment too late to matter.
 *
 * So these scan for the CLASS. A seventh charge path written next month has to
 * satisfy them without anybody remembering this file exists.
 */

/**
 * The same walk as above, at file scope so every scan below shares it. Listing
 * the money files by hand is exactly how a seventh doorway gets missed.
 */
const walkAll = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkAll(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
};
const SRC_FILES = walkAll(join(process.cwd(), "src")).filter((p) => {
  const r = p.replace(process.cwd() + "/", "");
  return r !== "src/lib/charge-gate.ts" && r !== "src/lib/payments.ts" && r !== "src/lib/payments-server.ts";
});

/** Source with comments stripped — prose may name anything; only code counts. */
const code = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const rel = (p: string) => p.replace(process.cwd() + "/", "");

/**
 * The argument text of every `name(...)` call — paren-balanced and
 * string-aware, because a call spans lines and its arguments contain both
 * parens and quoted text. A regex would stop at the first `)`.
 */
const callArgs = (src: string, name: string): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`${name.replace(/[.()"$]/g, "\\$&")}\\(`, "g"))) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let quote = "";
    let buf = "";
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (quote) {
        if (c === "\\") { buf += c + (src[i + 1] ?? ""); i += 2; continue; }
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      buf += c;
      i++;
    }
    out.push(buf);
  }
  return out;
};

describe("every charge and every refund carries a key the processor can dedupe on", () => {
  it("the extractor actually finds the calls — a scan over nothing proves nothing", () => {
    const all = SRC_FILES.flatMap((p) => callArgs(code(p), "takePayment"));
    expect(all.length, "six charge paths").toBe(6);
    for (const a of all) expect(a.length, "an empty argument list means the extractor broke").toBeGreaterThan(20);
  });

  it("every takePayment call sends an idempotencyKey", () => {
    const offenders = SRC_FILES.flatMap((p) =>
      callArgs(code(p), "takePayment").filter((a) => !/idempotencyKey/.test(a)).map(() => rel(p)),
    );
    expect(offenders,
      "a charge with no key: a retry after a timeout debits the card a second time and only the ledger notices",
    ).toEqual([]);
  });

  it("every giveRefund call sends an idempotencyKey", () => {
    const offenders = SRC_FILES.flatMap((p) =>
      callArgs(code(p), "giveRefund").filter((a) => !/idempotencyKey/.test(a)).map(() => rel(p)),
    );
    expect(offenders,
      "a double-submitted refund reaches the processor twice and the office is told it went back once",
    ).toEqual([]);
  });

  it("the two cancellation-fee doors send the SAME key", () => {
    // requests/actions.ts charges the fee at the moment of cancelling;
    // automation.ts retries it every night until it sticks. Two doors onto ONE
    // invoice: different keys make the retry a second debit.
    const customer = code(join(process.cwd(), "src/app/requests/actions.ts"));
    const nightly = code(join(process.cwd(), "src/lib/automation.ts"));
    for (const [what, s] of [["the customer's cancel", customer], ["the nightly retry", nightly]] as const) {
      expect(s, `${what} must build its key from the shared helper`).toMatch(/chargeKey\("cancel_fee",/);
    }
  });

  it("the tip is keyed on the JOB, because a tip has no invoice", () => {
    // 0097 hangs a tip off `payments.tip_job_id` and raises no invoice. An
    // invoice key would be a key for an amount the processor never saw.
    const s = code(join(process.cwd(), "src/app/requests/actions.ts"));
    expect(s).toMatch(/chargeKey\("tip", jobId/);
  });

  it("a decline gets a NEW key, so a real retry is a real attempt", () => {
    // A processor replays a decline for the same key for about 24 hours, and
    // the nightly runs exactly 24 hours apart: a key that never moves answers
    // every retry with yesterday's refusal and burns the five-night cap on
    // attempts that never reached a bank.
    expect(chargeKey("service", "inv-1", 0)).toBe(chargeKey("service", "inv-1", 0));
    expect(chargeKey("service", "inv-1", 1)).not.toBe(chargeKey("service", "inv-1", 0));
    expect(chargeKey("service", "inv-2", 0)).not.toBe(chargeKey("service", "inv-1", 0));
    expect(chargeKey("cancel_fee", "inv-1", 0)).not.toBe(chargeKey("service", "inv-1", 0));
  });

  it("the settle counts the declines it has already had before it keys the charge", () => {
    const s = code(join(process.cwd(), "src/lib/automation.ts"));
    const start = s.indexOf("export async function settleJob");
    expect(start, "settleJob not found — this scan is measuring nothing").toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf("export async function", start + 40));
    const count = body.search(/"status", "failed"/);
    const charge = body.indexOf("takePayment(");
    expect(count, "nothing counts the failed attempts on this invoice").toBeGreaterThan(-1);
    expect(charge, "no charge found — this scan is stale").toBeGreaterThan(-1);
    expect(count, "the count decides the key, so it must be read first").toBeLessThan(charge);
  });
});

describe("a charge that succeeded and a row that did not always shouts", () => {
  const MONEY = [
    "src/lib/automation.ts",
    "src/app/requests/actions.ts",
    "src/app/ops/recovery-actions.ts",
  ];

  it("no money path alerts on 23505 alone", () => {
    // The narrow condition meant only a DUPLICATE was reported. Any other
    // insert failure — a dropped connection, a constraint nobody thought of —
    // was silent, and the next line marked the invoice paid anyway: money
    // taken, bill settled, no payments row, nobody told. refund-core then says
    // "Nothing captured on this job — there's no cash to send back."
    const offenders = MONEY.filter((f) =>
      /payErr\?\.code === "23505"/.test(code(join(process.cwd(), f))),
    );
    expect(offenders, "the condition is `charge.ok && payErr` — ANY failure to record a real charge").toEqual([]);
  });

  it("no payments insert that follows a charge throws its result away", () => {
    // The nightly cancel-fee retry discarded the insert result entirely — no
    // error captured, no alert, and it still flipped the invoice to paid.
    for (const f of MONEY) {
      const s = code(join(process.cwd(), f));
      expect(s.match(/^\s*await admin\.from\("payments"\)\.insert\(/gm) ?? [],
        `${f}: an awaited insert whose result nobody destructures cannot be checked`).toEqual([]);
    }
  });

  it("each of the four sites carries the widened condition", () => {
    const sites = [
      ["src/lib/automation.ts", 2],
      ["src/app/requests/actions.ts", 2],
      ["src/app/ops/recovery-actions.ts", 1],
    ] as const;
    for (const [f, n] of sites) {
      const s = code(join(process.cwd(), f));
      expect((s.match(/charge\.ok && payErr/g) ?? []).length, `${f} should guard ${n} charge(s)`).toBe(n);
    }
  });
});

describe("the tip claims the visit before it charges the card", () => {
  const tip = () => {
    const s = code(join(process.cwd(), "src/app/requests/actions.ts"));
    const start = s.indexOf("export async function addTip");
    expect(start, "addTip not found — this scan is measuring nothing").toBeGreaterThan(-1);
    const rest = s.slice(start);
    const end = rest.indexOf("\nexport ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("stamps tip_amount first and refuses if the claim is already taken", () => {
    // The guard used to run AFTER the charge: two tabs, or one retry, debited
    // the customer twice and the second stamp simply matched no rows. Claim
    // first — the same order cancelRequest already uses.
    const body = tip();
    const claim = body.search(/tip_amount: v\.amount/);
    const charge = body.indexOf("takePayment(");
    expect(claim, "nothing claims the job").toBeGreaterThan(-1);
    expect(charge, "no charge found — this scan is stale").toBeGreaterThan(-1);
    expect(claim, "the claim must be won before the card is touched").toBeLessThan(charge);
  });

  it("releases the claim when the card declines, so another card can be tried", () => {
    const body = tip();
    const charge = body.indexOf("takePayment(");
    expect(body, "nothing hands the visit back").toMatch(/tip_amount: null, tipped_at: null/);
    expect(body.slice(charge), "a declined tip must not leave the visit stamped")
      .toMatch(/releaseClaim\(\)/);
  });

  it("reads the error on the crew's payout insert", () => {
    // The customer is charged, the visit is stamped immutable, and a refused
    // payout insert left the crew unpaid with no retry and nobody told.
    const body = tip();
    const payout = body.indexOf('from("payouts")');
    expect(payout, "no payout insert found — this scan is stale").toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, payout - 200), payout),
      "the payout insert's error is discarded").toMatch(/error: payoutErr/);
  });
});

describe("the crew's share of a fee has ONE home", () => {
  it("nothing recomputes it inline", () => {
    // cancellation.ts and automation.ts rounded the same expression
    // differently and disagreed by a cent on the same job.
    const offenders = SRC_FILES.filter((p) => {
      const s = code(p);
      return /\(fee \/ price\) \* cost/.test(s) || /vendor_cost \?\? 0\)\) \* dials\.cancelFeePct/.test(s);
    }).map(rel);
    expect(offenders, "call crewShareOfFee() from @/lib/cancellation").toEqual([]);
  });

  it("both fee paths call the helper", () => {
    for (const f of ["src/lib/automation.ts", "src/app/ops/recovery-actions.ts"]) {
      expect(code(join(process.cwd(), f)), `${f} computes the crew's share by hand`)
        .toMatch(/crewShareOfFee\(/);
    }
  });
});

describe("a fixture crew is never paid", () => {
  it("the month-end batch fences the crew by its OWNER, the way dispatch does", () => {
    // Production holds three released payouts totalling $224 to GreenEdge Lawn
    // Co., whose owner is `is_fixture`. Nothing in the batch knew what a
    // fixture was; on the day the bank rail is live that is $224 of real money
    // leaving for a scratch account.
    const s = code(join(process.cwd(), "src/lib/automation.ts"));
    const start = s.indexOf("export async function runMonthlyPayoutBatches");
    expect(start, "the monthly batch is gone — this scan is stale").toBeGreaterThan(-1);
    const body = s.slice(start);
    expect(body, "the crew's owner is what makes it a fixture (0126)")
      .toMatch(/users!vendors_user_id_fkey!inner\(is_fixture\)/);
    expect(body).toMatch(/\.eq\("users\.is_fixture", false\)/);
  });
});

describe("real processor keys never ship to the browser", () => {
  it("charge and refund live behind server-only", () => {
    const s = readFileSync(join(process.cwd(), "src/lib/payments-server.ts"), "utf8");
    expect(s.slice(0, 400), "the module that would hold the keys must refuse to be bundled")
      .toMatch(/import "server-only"/);
    expect(s).toMatch(/async charge\(/);
    expect(s).toMatch(/async refund\(/);
  });

  it("the hosted-fields half keeps tokenize and gives up charging", () => {
    // CLAUDE.md rule 4: tokenize() runs in the browser by design — the card
    // number never leaves the field. charge() must not sit beside it.
    const s = code(join(process.cwd(), "src/lib/payments.ts"));
    expect(s, "tokenize is the client's half and stays").toMatch(/async tokenize\(/);
    expect(s, "nothing that would read a processor key belongs here").not.toMatch(/async charge\(/);
    expect(s, "nor the refund").not.toMatch(/async refund\(/);
  });

  it("no 'use client' file imports the server half", () => {
    const offenders = SRC_FILES.filter((p) => {
      const s = readFileSync(p, "utf8");
      return /^\s*["']use client["']/.test(s) && /payments-server/.test(s);
    }).map(rel);
    expect(offenders, "a client import puts the processor's keys in the browser bundle").toEqual([]);
  });
});

describe("a decline nobody asked for is not a decline", () => {
  /**
   * THE GATE'S REFUSAL IS NOT A CARD'S REFUSAL, AND EVERY CALLER TREATED IT
   * AS ONE.
   *
   * With no processor connected `takePayment` returns `{ok: false}`. settleJob
   * reads that exactly as it reads a bank saying no: it writes a `payments`
   * row with `status: "failed"`, leaves the invoice due, and the nightly then
   * emails the customer "Your card on file was declined."
   *
   * Nobody asked their card. There is no processor to ask.
   *
   * And the lie compounds. `reconcileUnsettledJobs` counts `failed` rows to
   * decide when to stop retrying; at five it caps the invoice and never settles
   * it again. So a job completed at The Haven between today and go-live earns
   * five phantom declines, sends the customer five emails blaming their card,
   * and then becomes permanently uncollectable — the work done, the money
   * unreachable even after a real processor is wired in.
   *
   * `NO_PROCESSOR_REASON` has been exported for exactly this distinction since
   * the gate was written, and a grep across src found NO caller reading it —
   * this repo's own "a column with no reader" shape, sitting on the money path.
   *
   * The fix is at the WRITE, not the wording: with no processor there is no
   * attempt, so there is no attempt to record.
   */
  it("says WHY it refused, so a caller can tell the two apart", async () => {
    const before = process.env.LAKELIFE_PAYMENTS_LIVE;
    delete process.env.LAKELIFE_PAYMENTS_LIVE;
    const res = await takePayment({ token: "tok_x", amountCents: 1000 });
    if (before !== undefined) process.env.LAKELIFE_PAYMENTS_LIVE = before;
    expect(res.ok).toBe(false);
    expect(
      res.reason,
      "the gate refuses without saying it was the gate, so every caller has to " +
        "guess — and they all guess 'the card said no'",
    ).toBe(NO_PROCESSOR_REASON);
  });

  it("and a real decline carries no such reason", async () => {
    // Only the absence of a processor gets the marker. A bank's refusal is a
    // refusal and must keep reading like one.
    const before = process.env.LAKELIFE_PAYMENTS_LIVE;
    process.env.LAKELIFE_PAYMENTS_LIVE = "true";
    const res = await takePayment({ token: "tok_declineme", amountCents: 1000 });
    if (before === undefined) delete process.env.LAKELIFE_PAYMENTS_LIVE;
    else process.env.LAKELIFE_PAYMENTS_LIVE = before;
    expect(res.reason).toBeUndefined();
  });

  it("no charge path records a failed payment for a charge nobody attempted", () => {
    // THE CLASS, not the instance. Both settle doors write
    // `status: charge.ok ? "captured" : "failed"`, and a third would too.
    // Every one of them must first ask whether anybody was asked.
    const offenders: string[] = [];
    for (const f of ["src/lib/automation.ts", "src/app/requests/actions.ts", "src/app/ops/recovery-actions.ts"]) {
      const src = code(f);
      const writes = (src.match(/status: charge\.ok \? "captured" : "failed"/g) ?? []).length;
      if (!writes) continue;
      // THE GUARD EXPRESSION, not the symbol. Matching NO_PROCESSOR_REASON
      // anywhere in the file passes on the IMPORT LINE alone — I proved that
      // by deleting a guard and watching this stay green. One guard per
      // failed-row writer, counted.
      const guards = (src.match(/charge\.reason === NO_PROCESSOR_REASON/g) ?? []).length;
      if (guards < writes) offenders.push(`${f} (${writes} write(s), ${guards} guard(s))`);
    }
    expect(
      offenders,
      "these write a 'failed' payment row without ever asking whether a " +
        "processor exists, so the gate's own refusal is filed as the customer's " +
        "card being declined — and five of them cap the invoice forever.",
    ).toEqual([]);
  });
});
