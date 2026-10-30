import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { payoutKey, recipientKey, mercuryConfigured, NOT_CONFIGURED } from "./mercury";
import { payoutEligibility } from "@/app/api/ops/payout-export/export-plan";

/**
 * PAYING CREWS THROUGH MERCURY INSTEAD OF A FILE.
 *
 * "lets get the mercury ach payouts to crews working" — 29 Oct 2026.
 *
 * Today a crew is paid by a CSV somebody downloads from /ops and hands a bank,
 * which decrypts every crew's routing and account number into one file. This
 * is the rail that replaces it, and both will exist for a while because there
 * is no honest moment to delete the file before the API has paid somebody.
 *
 * WHICH MAKES DOUBLE PAYMENT THE RISK. A batch that went into a bank file AND
 * to Mercury pays a crew twice out of LakeLife's own account, and nothing in
 * the ledger would say so. 0202 makes a batch take exactly one rail, and
 * before it `payout_batches` had NO TRIGGER AT ALL — any status could follow
 * any other.
 */

const here = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const mercury = here("./mercury.ts");
const sql = here("../../supabase/migrations/0202_a_payout_can_take_one_rail_only.sql");
const run = here("../app/ops/mercury-actions.ts");

describe("the path we can actually use", () => {
  it("REQUESTS, it does not send — because Vercel has no static IP", () => {
    // Mercury's `createTransaction` sends immediately and REQUIRES an IP
    // allowlist. `request-send-money` needs none — their docs say it is for
    // "situations where a static IP is not available" — and queues for
    // approval instead. Serverless has no static egress IP, so the direct
    // path is closed to us without a paid add-on.
    expect(mercury).toMatch(/request-send-money/);
    expect(strip(mercury), "the direct, allowlisted path crept in")
      .not.toMatch(/createTransaction/);
  });

  it("and the approval step is recorded as a FEATURE, not a workaround", () => {
    // It is this product's own standing rule — nothing goes out until he says
    // — enforced by the bank rather than by us.
    expect(mercury).toMatch(/nothing goes out until he says/i);
  });

  it("a queued request is NOT money that has moved", () => {
    // 0202 gave batches a `submitted` status rather than reusing `paid`, for
    // the same reason 0191 exists on the money-in side: a payment is not money
    // until it clears, and that cuts both ways.
    expect(sql).toMatch(/check \(status in \('building', 'queued', 'exported', 'submitted', 'paid', 'failed'\)\)/);
    expect(sql).toMatch(/'submitted' is NOT 'paid'/);
  });
});

describe("ONE RAIL — the guard this migration exists for", () => {
  it("a batch in a bank file cannot also go to Mercury", () => {
    expect(sql).toMatch(/already in a bank file[\s\S]{0,120}pay them twice/);
  });

  it("and a batch with Mercury cannot also go into a bank file", () => {
    expect(sql).toMatch(/already with Mercury[\s\S]{0,120}pay them twice/);
  });

  it("paid money does not go back to queued", () => {
    expect(sql).toMatch(/a batch is not un-paid/);
  });

  it("a batch sent to Mercury carries Mercury's id, and it is assigned once", () => {
    // The id is the only thing an approval or a return arriving later can be
    // matched against. Without it, money moves and nothing here can notice.
    expect(sql).toMatch(/a batch sent to Mercury needs the id Mercury gave it/);
    expect(sql).toMatch(/orphans it/);
    expect(sql).toMatch(/create unique index if not exists payout_batches_one_mercury_request_idx/);
  });

  it("the guard is a trigger, because there was none at all before", () => {
    expect(sql).toMatch(/create trigger payout_batches_take_one_rail/);
    expect(sql).toMatch(/before insert or update on public\.payout_batches/);
  });
});

describe("the mock never looks like a success", () => {
  it("is off unless BOTH secrets are set", () => {
    // Half-configured is the state that produces a confusing failure at the
    // worst moment: a token with no account id cannot address a payment.
    const token = process.env.MERCURY_API_TOKEN;
    const acct = process.env.MERCURY_ACCOUNT_ID;
    try {
      delete process.env.MERCURY_API_TOKEN;
      delete process.env.MERCURY_ACCOUNT_ID;
      expect(mercuryConfigured()).toBe(false);
      process.env.MERCURY_API_TOKEN = "t";
      expect(mercuryConfigured(), "a token with no account id counted as configured").toBe(false);
      process.env.MERCURY_ACCOUNT_ID = "a";
      expect(mercuryConfigured()).toBe(true);
    } finally {
      if (token === undefined) delete process.env.MERCURY_API_TOKEN; else process.env.MERCURY_API_TOKEN = token;
      if (acct === undefined) delete process.env.MERCURY_ACCOUNT_ID; else process.env.MERCURY_ACCOUNT_ID = acct;
    }
  });

  it("AND RETURNS NO ID WHEN IT IS MOCKED", () => {
    // This codebase once had six charge paths all "succeed" against a mock.
    // A mocked payout that handed back a fake request id would be stored by
    // 0202 and matched against by a later approval that never comes.
    const call = mercury.slice(mercury.indexOf("async function call<T>"));
    const body = call.slice(0, call.indexOf("try {"));
    expect(body).toMatch(/mocked: true/);
    expect(body, "the mock returns ok").not.toMatch(/ok: true/);
    expect(NOT_CONFIGURED).toMatch(/nothing was sent/i);
  });

  it("a network error says we do not know, rather than that it failed", () => {
    // We cannot tell whether Mercury received it, so the batch must not be
    // marked sent AND must not be blindly retried.
    expect(mercury).toMatch(/We couldn't reach Mercury/);
    expect(mercury).toMatch(/don't know whether it got through/);
  });

  it("and a response with no id is not treated as one", () => {
    expect(mercury).toMatch(/didn't give us an id for it/);
    expect(mercury).toMatch(/didn't tell us its id/);
  });
});

describe("the worst state the run can reach is never silent", () => {
  it("ASKED MERCURY AND COULD NOT RECORD IT is logged and surfaced", () => {
    // Money queued at Mercury with our ledger not saying so. The same posture
    // as a charge that succeeded with a row that failed — and the sentence
    // tells ops the one thing that stops it becoming a double payment.
    expect(run).toMatch(/ASKED MERCURY FOR/);
    expect(run).toMatch(/AND COULD NOT RECORD IT/);
    expect(run).toMatch(/do NOT approve it in Mercury/);
  });

  it("the batch flip is guarded on 'queued', so two taps cannot claim one batch", () => {
    expect(run).toMatch(/\.eq\("id", b\.id\)\s*\n\s*\.eq\("status", "queued"\)/);
  });

  it("and it refuses before reading anything when the key is missing", () => {
    // Without BANK_ENCRYPTION_KEY every blob fails to open, and counting each
    // as "no bank on file" blames the crews for a missing env var — which is
    // exactly what the CSV rail learned.
    //
    // THE FIRST VERSION OF THIS TEST ONLY CHECKED POSITION, and a mutation
    // that collapsed the branch to `if (false && !bankKeyConfigured())` left
    // the token exactly where it was and passed. A source scan proves a token
    // is PRESENT, never that it is REACHABLE — so pin the whole condition and
    // forbid the collapsed forms.
    expect(run, "the key check is gone or reworded").toMatch(/if \(!bankKeyConfigured\(\)\) \{/);
    expect(run, "the key check was collapsed to a constant")
      .not.toMatch(/if \((?:false|true) &&/);
    const i = run.indexOf("if (!bankKeyConfigured()) {");
    const j = run.indexOf('.from("payout_batches")');
    expect(i).toBeGreaterThan(-1);
    expect(i, "it reads the queue before checking it can decrypt").toBeLessThan(j);
  });
});

describe("both rails agree on who is owed", () => {
  it("the fixture fence and the no-bank skip are ONE function", () => {
    expect(payoutEligibility({ isFixture: true } as never, true)).toBe("fixture");
    expect(payoutEligibility({ isFixture: false } as never, false)).toBe("no-bank");
    expect(payoutEligibility({ isFixture: false } as never, true)).toBe("pay");
  });

  it("a fixture is fenced out BEFORE its bank is even considered", () => {
    // Production holds three released payouts to a crew whose OWNER is
    // is_fixture. Order matters: a fixture with a bank on file must still be
    // excluded as a fixture, not planned and then skipped.
    expect(payoutEligibility({ isFixture: true } as never, true)).toBe("fixture");
  });

  it("and the Mercury run uses it rather than its own copy", () => {
    expect(run).toMatch(/payoutEligibility\(/);
  });
});

describe("the keys that stop a retry paying twice", () => {
  it("are derived from the thing being paid, not invented per caller", () => {
    expect(payoutKey("abc-123")).toBe("payout:abc-123");
    expect(recipientKey("u-1")).toBe("recipient:u-1");
  });

  it("and two batches never share one", () => {
    expect(payoutKey("a")).not.toBe(payoutKey("b"));
  });
});
