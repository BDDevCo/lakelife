import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPreviewDeployment, worldActionRefusal, previewRefusalNote } from "./deployment";
import { paymentsAreLive } from "./charge-gate";
import { cronAuthorized } from "@/app/api/cron/auth";

/**
 * A BRANCH DEPLOY COULD ACT ON THE REAL WORLD.
 *
 * Read off Vercel on 20 October 2026 rather than remembered:
 *
 *   SUPABASE_SERVICE_ROLE_KEY   target: ["production", "preview"]
 *   CRON_SECRET                 target: ["production", "preview"]
 *   GATE_ENCRYPTION_KEY         target: ["production", "preview"]
 *   TWILIO_*, RESEND_API_KEY    target: ["production", "preview"]
 *
 * There is no staging database. Every pull-request preview deployment runs
 * against the LIVE database with the LIVE service-role key, holding the live
 * cron secret and live Twilio and Resend credentials.
 *
 * And nothing knew it was a preview: a grep for `VERCEL_ENV` across src/
 * returned NOTHING AT ALL. So a branch deploy could run the nightly against
 * production data — emailing real homeowners, writing real payout batches —
 * and the day `LAKELIFE_PAYMENTS_LIVE` is set on a scope rather than on one
 * deployment, charging a real card from somebody's feature branch.
 *
 * This is not the staging split; that needs a second database and is
 * Brendon's to approve. It is what can be true today for nothing, in the safe
 * direction: a preview refuses, which costs a developer a sentence on screen.
 */

const ENV = process.env.VERCEL_ENV;
const FLAG = process.env.LAKELIFE_PAYMENTS_LIVE;
const SECRET = process.env.CRON_SECRET;

afterEach(() => {
  // Restore exactly, including "was not set at all" — which is the state every
  // other test in this suite runs under and must keep running under.
  if (ENV === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = ENV;
  if (FLAG === undefined) delete process.env.LAKELIFE_PAYMENTS_LIVE; else process.env.LAKELIFE_PAYMENTS_LIVE = FLAG;
  if (SECRET === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = SECRET;
});

describe("which deployment this is", () => {
  it("only the string 'preview' is a preview", () => {
    process.env.VERCEL_ENV = "preview";
    expect(isPreviewDeployment()).toBe(true);
  });

  it("AND NOTHING ELSE IS — including unset, which is every test and every local run", () => {
    // The one place this file is deliberately permissive. `VERCEL_ENV` is
    // absent off Vercel entirely, so treating unset as "refuse" would block
    // the whole suite and `next dev`.
    for (const env of ["production", "development", "", "Preview", "PREVIEW", "staging"]) {
      process.env.VERCEL_ENV = env;
      expect(isPreviewDeployment(), JSON.stringify(env)).toBe(false);
    }
    delete process.env.VERCEL_ENV;
    expect(isPreviewDeployment(), "unset").toBe(false);
  });

  it("the refusal names the act, and there is one for each of the three doors", () => {
    process.env.VERCEL_ENV = "preview";
    expect(worldActionRefusal("send")).toMatch(/nothing is sent to a real person/i);
    expect(worldActionRefusal("charge")).toMatch(/no card or bank account is touched/i);
    expect(worldActionRefusal("cron")).toMatch(/belongs to production/i);
  });

  it("and off preview every door is open — or this proves nothing", () => {
    delete process.env.VERCEL_ENV;
    for (const a of ["send", "charge", "cron"] as const) {
      expect(worldActionRefusal(a), a).toBeNull();
    }
  });

  it("the log line names the branch, so nobody wonders why nothing happened", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_GIT_COMMIT_REF = "fix/the-thing";
    expect(previewRefusalNote("cron")).toMatch(/fix\/the-thing/);
    expect(previewRefusalNote("cron")).toMatch(/shares the production database/);
    delete process.env.VERCEL_GIT_COMMIT_REF;
    expect(previewRefusalNote("cron")).toMatch(/an unnamed branch/);
  });
});

describe("no card is touched from a branch", () => {
  it("A PREVIEW NEVER CHARGES, WHATEVER THE FLAG SAYS", () => {
    // The flag will be set on a SCOPE, not on one deployment — which is
    // exactly how a branch inherits it.
    process.env.LAKELIFE_PAYMENTS_LIVE = "true";
    process.env.VERCEL_ENV = "preview";
    expect(paymentsAreLive()).toBe(false);
  });

  it("and production with the flag on still charges", () => {
    process.env.LAKELIFE_PAYMENTS_LIVE = "true";
    process.env.VERCEL_ENV = "production";
    expect(paymentsAreLive()).toBe(true);
  });

  it("production without the flag still does not", () => {
    process.env.LAKELIFE_PAYMENTS_LIVE = "false";
    process.env.VERCEL_ENV = "production";
    expect(paymentsAreLive()).toBe(false);
  });
});

describe("the nightly belongs to production", () => {
  const withSecret = (secret: string) =>
    new Request("http://localhost/api/cron/nightly", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });

  it("A PREVIEW IS REFUSED EVEN WITH THE CORRECT SECRET", () => {
    // Which it legitimately holds: CRON_SECRET is scoped to preview too.
    process.env.CRON_SECRET = "the-real-one";
    process.env.VERCEL_ENV = "preview";
    expect(cronAuthorized(withSecret("the-real-one"))).toBe(false);
  });

  it("and production with the same secret runs — or this proves nothing", () => {
    process.env.CRON_SECRET = "the-real-one";
    process.env.VERCEL_ENV = "production";
    expect(cronAuthorized(withSecret("the-real-one"))).toBe(true);
  });

  it("a wrong secret is still refused in production", () => {
    process.env.CRON_SECRET = "the-real-one";
    process.env.VERCEL_ENV = "production";
    expect(cronAuthorized(withSecret("a-guess"))).toBe(false);
  });

  it("and an unset secret still fails closed", () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL_ENV = "production";
    expect(cronAuthorized(withSecret("anything"))).toBe(false);
  });
});

describe("the three doors all ask, and ask FIRST", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const here = (p: string) => strip(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));

  it("email asks before it looks at the recipient", () => {
    // "May this deployment write to anyone" is a narrower question than "may
    // we write to this person", so it belongs in front of it.
    const src = here("./email.ts");
    const deploy = src.indexOf('worldActionRefusal("send")');
    const recipient = src.indexOf("emailRefusal(opts.to)");
    expect(deploy, "the email door does not ask").toBeGreaterThan(-1);
    expect(recipient).toBeGreaterThan(-1);
    expect(deploy).toBeLessThan(recipient);
  });

  it("sms asks before it looks at the number", () => {
    const src = here("./sms.ts");
    const deploy = src.indexOf('worldActionRefusal("send")');
    const recipient = src.indexOf("phoneRefusal(to)");
    expect(deploy, "the sms door does not ask").toBeGreaterThan(-1);
    expect(recipient).toBeGreaterThan(-1);
    expect(deploy).toBeLessThan(recipient);
  });

  it("the cron door asks before it checks the secret", () => {
    const src = here("../app/api/cron/auth.ts");
    const deploy = src.indexOf('worldActionRefusal("cron")');
    const secret = src.indexOf("process.env.CRON_SECRET");
    expect(deploy, "the cron door does not ask").toBeGreaterThan(-1);
    expect(deploy).toBeLessThan(secret);
  });

  it("and the charge gate asks inside the one predicate everything branches on", () => {
    const src = here("./charge-gate.ts");
    const fn = src.slice(src.indexOf("export function paymentsAreLive"));
    const body = fn.slice(0, fn.indexOf("}"));
    expect(body).toMatch(/worldActionRefusal\("charge"\)/);
  });

  it("THERE ARE NO OTHER DOORS claiming to be one", () => {
    // If a fourth outward-facing act appears, it should reach this predicate
    // rather than invent its own test — and this is the scan that notices.
    const all = here("./deployment.ts");
    expect(all).toMatch(/export type WorldAction = "send" \| "charge" \| "cron";/);
  });
});
