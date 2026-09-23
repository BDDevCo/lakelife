import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE FREEZE WARNING'S OWN SKIP LIST WENT INTO AN HTTP RESPONSE NOBODY READS.
 *
 * This cron fires once per lake per season, on an exact date match: a lake
 * skipped tonight is not retried tomorrow, because the target date has moved
 * on. The runner builds a `skipped` list precisely to say so — and the route
 * returned it as JSON, which nothing in this repo reads. A throw was worse:
 * with no try/catch a refused read on the lakes table 500s and leaves no
 * record anywhere at all.
 *
 * The three lake deadlines are five to six weeks out as this is written, so
 * the branch below is not a hypothetical: it is the last chance anybody has to
 * find out that a lake's households were never warned about the ice.
 */

vi.mock("server-only", () => ({}));

const auto = {
  sendSeasonalPullReminders: vi.fn(async () => ({ ok: true, lakes: 1, emailed: 4, skipped: [] as string[] })),
  alertOps: vi.fn(async (_subject: string, _body: string | { toString(): string }) => ({ notified: 1 })),
};
vi.mock("@/lib/automation", () => auto);

const { GET } = await import("./route");
const SECRET = "cron_test_secret";
const run = (qs = "") => {
  process.env.CRON_SECRET = SECRET;
  return GET(new Request(`https://lakelife.test/api/cron/seasonal${qs}`, { headers: { authorization: `Bearer ${SECRET}` } }));
};
/** [subject, body] of the one email ops was sent. */
const alert = (): [string, string] => {
  const call = vi.mocked(auto.alertOps).mock.calls.at(-1)!;
  return [String(call[0]), String(call[1])];
};

beforeEach(() => {
  vi.mocked(auto.alertOps).mockClear();
  vi.mocked(auto.sendSeasonalPullReminders).mockClear();
});

describe("a lake that lost its freeze warning reaches a person", () => {
  it("names the lake, and names the way back", async () => {
    vi.mocked(auto.sendSeasonalPullReminders).mockResolvedValueOnce({
      ok: true, lakes: 2, emailed: 9,
      skipped: ["Pretty Lake: couldn't read the homes on the lake, so NOBODY got this season's pull-deadline warning (deadline 2026-11-12). This fires on one date a year — it will not retry itself."],
    });

    const res = await run();
    expect(auto.alertOps, "the skip list has a reader at last").toHaveBeenCalledTimes(1);
    const [subject, body] = alert();
    expect(subject).toMatch(/1 lake got no freeze warning/);
    expect(body).toContain("Pretty Lake");
    // THE RECOVERY IS THE WHOLE VALUE OF THE EMAIL. The once-a-season claim is
    // unique per property, and a skipped lake writes no claim row, so a re-run
    // reaches only the households that missed out. Without this sentence he
    // reads "Pretty Lake got no warning" and thinks it is over.
    expect(body).toMatch(/lead=/);
    expect(body).toMatch(/once-a-season claim|only the ones who missed out/);
    expect(res.status, "and the cron log goes red").toBe(500);
  });

  it("a run that died does NOT name a lake it never learned", async () => {
    // The throw comes from the read that discovers which lakes are due. No
    // lake is known on this path, so an email naming one would be inventing it.
    vi.mocked(auto.sendSeasonalPullReminders).mockRejectedValueOnce(new Error("the lakes and their season dates: connection terminated"));

    const res = await run("?lead=9");
    expect(auto.alertOps).toHaveBeenCalledTimes(1);
    const [subject, body] = alert();
    expect(subject).toMatch(/did not run/i);
    expect(body).toContain("connection terminated");
    expect(body, "it says what it does not know").toMatch(/if any lake's pull deadline is 9 days out/i);
    expect(body).not.toMatch(/Pretty|Big Long|Big Turkey/);
    expect(body).toMatch(/lead=/);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it("a night where every lake was warned says nothing at all", async () => {
    const res = await run();
    expect(auto.alertOps, "no news is the whole point of a quiet cron").not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, emailed: 4 });
  });

  it("an unauthorized call runs nothing and tells nobody", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(new Request("https://lakelife.test/api/cron/seasonal"));
    expect(res.status).toBe(401);
    expect(auto.sendSeasonalPullReminders).not.toHaveBeenCalled();
    expect(auto.alertOps).not.toHaveBeenCalled();
  });
});
