import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE SWITCH-ON DIAGNOSTIC, AND THE LAST ATTEMPT IT REPORTS.
 *
 * Twilio is mocked here — deliberately and completely. Every test in this file
 * would otherwise reach api.twilio.com with whatever credentials happen to be
 * in the environment, and a test suite is not allowed to touch a live account
 * or send anything to anybody.
 */
const listMock = vi.fn();
vi.mock("twilio", () => ({
  default: () => ({ messages: { list: (...args: unknown[]) => listMock(...args) } }),
}));

const { getSmsHealth, LOG_WINDOW } = await import("./sms-health");
const { getTextingSetup } = await import("./texting-setup");

const VARS = [
  "NEXT_PUBLIC_SITE_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VERIFY_SERVICE_SID",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_PHONE_NUMBER",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
const clear = () => { for (const v of VARS) delete process.env[v]; };

function account() {
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "tok_test";
}

/** A Twilio message as the SDK hands it over. */
function msg(status: string, iso: string | null, errorCode?: number) {
  return {
    status,
    errorCode: errorCode ?? null,
    dateSent: iso ? new Date(iso) : null,
    dateCreated: iso ? new Date(iso) : null,
  };
}

beforeEach(() => {
  clear();
  listMock.mockReset();
});

afterAll(() => {
  clear();
  for (const [k, v] of Object.entries(SAVED)) if (v !== undefined) process.env[k] = v;
});

describe("reading the delivery log", () => {
  it("does not ask at all without the account credentials", async () => {
    const h = await getSmsHealth();
    expect(h.configured).toBe(false);
    expect(h.window).toBeNull();
    expect(h.lastAttempt).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("asks for the window it tells the screen about", async () => {
    account();
    listMock.mockResolvedValue([]);
    await getSmsHealth();
    // The number on the page and the number in the query are the same number.
    expect(listMock).toHaveBeenCalledWith({ limit: LOG_WINDOW });
  });

  it("counts what reached a handset, and names why the rest did not", async () => {
    account();
    listMock.mockResolvedValue([
      msg("delivered", "2026-09-20T15:00:00Z"),
      msg("undelivered", "2026-09-19T15:00:00Z", 30034),
      msg("failed", "2026-09-18T15:00:00Z", 30034),
    ]);
    const h = await getSmsHealth();
    expect(h.window).toEqual({ sent: 3, delivered: 1, failed: 2 });
    expect(h.reasons[0].code).toBe("30034");
    expect(h.reasons[0].count).toBe(2);
    expect(h.reasons[0].text).toMatch(/A2P 10DLC/);
  });

  it("takes the newest attempt BY TIMESTAMP, not by list order", async () => {
    account();
    const newest = msg("undelivered", "2026-09-21T09:00:00Z", 30034);
    const older = msg("delivered", "2026-08-01T09:00:00Z");
    // Newest first, as Twilio returns it today…
    listMock.mockResolvedValue([newest, older]);
    const a = await getSmsHealth();
    expect(a.lastAttempt?.at).toBe("2026-09-21T09:00:00.000Z");
    expect(a.lastAttempt?.status).toBe("undelivered");
    expect(a.lastAttempt?.errorCode).toBe("30034");
    expect(a.lastAttempt?.errorText).toMatch(/isn't registered for business texting/);

    // …and reversed, which must not change the answer.
    listMock.mockResolvedValue([older, newest]);
    const b = await getSmsHealth();
    expect(b.lastAttempt?.at).toBe("2026-09-21T09:00:00.000Z");
    expect(b.lastAttempt?.status).toBe("undelivered");
  });

  it("carries no error text when the attempt did not fail", async () => {
    account();
    listMock.mockResolvedValue([msg("delivered", "2026-09-21T09:00:00Z")]);
    const h = await getSmsHealth();
    expect(h.lastAttempt?.errorCode).toBeNull();
    expect(h.lastAttempt?.errorText).toBeNull();
  });

  it("still reports an attempt Twilio gave no timestamp for", async () => {
    account();
    listMock.mockResolvedValue([msg("queued", null)]);
    const h = await getSmsHealth();
    expect(h.lastAttempt).not.toBeNull();
    expect(h.lastAttempt?.at).toBeNull();
    expect(h.lastAttempt?.status).toBe("queued");
  });

  it("never renders a blank status — an unknown one is still a fact", async () => {
    account();
    listMock.mockResolvedValue([msg("", "2026-09-21T09:00:00Z")]);
    const h = await getSmsHealth();
    expect(h.lastAttempt?.status).toBe("unknown");
  });

  it("an empty log is an empty log, not a missing attempt dressed up", async () => {
    account();
    listMock.mockResolvedValue([]);
    const h = await getSmsHealth();
    expect(h.window).toEqual({ sent: 0, delivered: 0, failed: 0 });
    expect(h.lastAttempt).toBeNull();
  });

  it("A FAILED LOOKUP IS NOT A CLEAN BILL OF HEALTH", async () => {
    account();
    listMock.mockRejectedValue(new Error("network down"));
    const h = await getSmsHealth();
    expect(h.configured).toBe(true);
    // Null, never zero: zero would read on screen as "nothing has failed".
    expect(h.window).toBeNull();
    expect(h.lastAttempt).toBeNull();
    expect(h.error).toBe("network down");
  });
});

describe("the switch-on diagnostic", () => {
  it("answers the two channels separately", async () => {
    account();
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA_test";
    listMock.mockResolvedValue([]);
    const s = await getTextingSetup();
    expect(s.verify.ready).toBe(true);
    expect(s.messaging.ready).toBe(false);
    expect(s.messaging.missing).toEqual(["TWILIO_MESSAGING_SERVICE_SID"]);

    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    const t = await getTextingSetup();
    expect(t.messaging.ready).toBe(true);
    expect(t.messaging.missing).toEqual([]);
  });

  it("calls out a bare number with no Messaging Service — and only then", async () => {
    account();
    listMock.mockResolvedValue([]);
    process.env.TWILIO_PHONE_NUMBER = "+12605550142";
    expect((await getTextingSetup()).bareNumberOnly).toBe(true);

    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    expect((await getTextingSetup()).bareNumberOnly).toBe(false);

    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    delete process.env.TWILIO_PHONE_NUMBER;
    expect((await getTextingSetup()).bareNumberOnly).toBe(false);
  });

  it("NEVER returns the value of a credential, only whether it is set", async () => {
    account();
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_a_real_looking_secret";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA_another_secret";
    listMock.mockResolvedValue([]);
    const s = JSON.stringify(await getTextingSetup());
    expect(s).not.toContain("MG_a_real_looking_secret");
    expect(s).not.toContain("VA_another_secret");
    expect(s).not.toContain("tok_test");
  });

  it("says it could not ask about holds when there is no database", async () => {
    account();
    listMock.mockResolvedValue([]);
    const s = await getTextingSetup();
    // Not an empty list — "no park is holding notices" is an answer this
    // function did not earn with no database to ask.
    expect(s.holds.unavailable).toBe(true);
    expect(s.holds.failed).toBe(false);
    expect(s.holds.parks).toEqual([]);
  });
});

/* -- the screen renders each of those states ------------------------------ */

const PAGE = readFileSync(
  fileURLToPath(new URL("./texting/page.tsx", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the page is gated, and says which fact it read", () => {
  it("scans the real page — not an empty string", () => {
    expect(PAGE.length).toBeGreaterThan(2000);
    expect(PAGE).toMatch(/export default async function OpsTextingPage/);
    // Proof the comment strip works rather than deleting the file.
    expect(PAGE).not.toMatch(/THE PAGE THAT SAYS WHETHER TEXTING IS ON/);
  });

  it("is ops-only, and reads its own gate rather than trusting the link", () => {
    expect(PAGE).toMatch(/await assertOps\(\)/);
    expect(PAGE).toMatch(/Operations only/);
  });

  it("names the columns and variables behind its sentences", () => {
    expect(PAGE).toMatch(/parks\.notices_held_at/);
    expect(PAGE).toMatch(/TWILIO_MESSAGING_SERVICE_SID/);
    expect(PAGE).toMatch(/TWILIO_VERIFY_SERVICE_SID/);
  });

  it("has a branch for a failed holds read that does not say 'none'", () => {
    expect(PAGE).toMatch(/holds\.failed \?/);
    expect(PAGE).toMatch(/failed read,\s+not an answer/);
    // And the healthy sentence exists too, so the branch is really a branch.
    expect(PAGE).toMatch(/No park is holding notices/);
  });

  it("has a branch for a failed Twilio read that does not say 'nothing failed'", () => {
    // The branch moved into one helper (deliveryVerdict, ops/sms-health.ts)
    // when the footer checklist was found asserting "the log shows nothing
    // delivered" on a log it had just failed to read. The page must still take
    // that branch by name, and still say so in words.
    expect(PAGE).toMatch(/verdict\.state === "unreadable"/);
    expect(PAGE).toMatch(/couldn&apos;t reach Twilio/);
  });

  it("never prints the value of the Messaging Service SID", () => {
    // Whether it is set, never what it is — this page gets screenshotted.
    expect(PAGE).not.toMatch(/process\.env\.TWILIO_MESSAGING_SERVICE_SID/);
    expect(PAGE).toMatch(/value is deliberately not shown/);
  });
});

/**
 * THE VERDICT HAS TO HAVE A DOOR TO COME BACK THROUGH.
 *
 * Both branches are collapsed here, in both directions. An assertion that only
 * proved `wired` false on an unset variable would pass just as happily against
 * a `deliveryVerdicts` hardcoded to false — and false is the safe-looking
 * answer, so that is exactly the half that would never be noticed. The screen
 * prints a red box on one branch and an address on the other; each is pinned
 * to the condition that produces it.
 */
describe("whether a carrier verdict can reach us", () => {
  it("is NOT wired when no site origin is set", async () => {
    account();
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    listMock.mockResolvedValue([]);
    const s = await getTextingSetup();
    expect(s.deliveryVerdicts.wired).toBe(false);
    expect(s.deliveryVerdicts.url).toBeNull();
    // ...and it is independent of the SID, which IS set here. The two silent
    // failures are separate, and one being fixed must not report the other.
    expect(s.messaging.ready).toBe(true);
  });

  it("is NOT wired on localhost — https alone is not reachable", async () => {
    account();
    process.env.NEXT_PUBLIC_SITE_URL = "https://localhost:3000";
    listMock.mockResolvedValue([]);
    expect((await getTextingSetup()).deliveryVerdicts.wired).toBe(false);
  });

  it("is NOT wired on a plain http origin", async () => {
    account();
    process.env.NEXT_PUBLIC_SITE_URL = "http://www.lakelife.ai";
    listMock.mockResolvedValue([]);
    expect((await getTextingSetup()).deliveryVerdicts.wired).toBe(false);
  });

  it("IS wired on the real production origin, and names the callback path", async () => {
    account();
    process.env.NEXT_PUBLIC_SITE_URL = "https://www.lakelife.ai";
    listMock.mockResolvedValue([]);
    const s = await getTextingSetup();
    expect(s.deliveryVerdicts.wired).toBe(true);
    expect(s.deliveryVerdicts.url).toBe("https://www.lakelife.ai/api/twilio/status");
  });

  it("never returns a credential in the url", async () => {
    account();
    process.env.NEXT_PUBLIC_SITE_URL = "https://www.lakelife.ai";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_secret_value";
    listMock.mockResolvedValue([]);
    const s = await getTextingSetup();
    expect(JSON.stringify(s)).not.toContain("MG_secret_value");
    expect(JSON.stringify(s)).not.toContain("tok_test");
  });
});

/**
 * The screen has to SAY which of the two it is. A page that read the fact and
 * rendered nothing would be the fact having no reader.
 */
describe("the page renders both verdict branches", () => {
  const PAGE = readFileSync(
    fileURLToPath(new URL("./texting/page.tsx", import.meta.url)),
    "utf8",
  );
  it("prints the warning on the unwired branch and the address on the wired one", () => {
    expect(PAGE).toContain("!deliveryVerdicts.wired");
    expect(PAGE).toContain("deliveryVerdicts.wired &&");
    expect(PAGE).toContain("NEXT_PUBLIC_SITE_URL");
    expect(PAGE).toContain("{deliveryVerdicts.url}");
  });
  it("destructures the field it renders", () => {
    expect(PAGE).toMatch(/const \{[^}]*deliveryVerdicts[^}]*\} = setup;/);
  });
});
