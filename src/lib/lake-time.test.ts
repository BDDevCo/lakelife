import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shortDate, crewDate, longDate, longDay, lakeStamp } from "./lake-time";

/**
 * EVERY DATE A PERSON READS, WRITTEN ONE WAY, ON THE LAKES' CLOCK.
 *
 * The one that was live: two of the three real payments in production were
 * taken at 8:58 PM lake time — 00:58 UTC the next day — and the homeowner's
 * invoice card, a SERVER component rendering in UTC with no timezone, said
 * "Charged to your card on file on July 20" under a job done July 18.
 */

// 8:58 PM on the 18th in Indiana (EDT, UTC-4) is 00:58 UTC on the 19th.
const LATE_EVENING = "2026-07-19T00:58:00Z";

describe("a late-evening timestamp is still that day on the lakes", () => {
  it("does not slip to the next day in any shape", () => {
    expect(shortDate(LATE_EVENING, new Date("2026-07-20T12:00:00Z"))).toBe("Jul 18");
    expect(longDate(LATE_EVENING)).toBe("July 18, 2026");
    expect(crewDate(LATE_EVENING)).toBe("Sat, Jul 18");
    expect(longDay(LATE_EVENING)).toBe("Saturday, July 18, 2026");
    expect(lakeStamp(LATE_EVENING)).toBe("Jul 18, 2026, 8:58 PM");
  });

  it("is the failure the unpinned code actually had", () => {
    // The same instant through a bare toLocaleDateString, as the old server
    // render did on Vercel (UTC). This is what the homeowner read.
    const utc = new Date(LATE_EVENING).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    expect(utc).toBe("July 19");
  });
});

describe("a bare date never becomes the evening before", () => {
  it("anchors 2026-09-11 at noon rather than midnight UTC", () => {
    // new Date("2026-09-11") is midnight UTC = 8 PM on the 10th in Indiana.
    expect(shortDate("2026-09-11", new Date("2026-09-12T12:00:00Z"))).toBe("Sep 11");
    expect(crewDate("2026-09-11")).toBe("Fri, Sep 11");
    expect(longDay("2026-09-11")).toBe("Friday, September 11, 2026");
  });
});

describe("the year appears only when it is not this year", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  it("Sep 11 for this year", () => expect(shortDate("2026-09-11", now)).toBe("Sep 11"));
  it("Nov 7, 2025 for last year — the prototype's :449", () => expect(shortDate("2025-11-07", now)).toBe("Nov 7, 2025"));
  it("judges 'this year' on the lakes' clock at the boundary", () => {
    // 11 PM on 31 Dec 2025 in Indiana is 04:00 UTC on 1 Jan 2026.
    expect(shortDate("2026-01-01T04:00:00Z", new Date("2026-06-01T12:00:00Z"))).toBe("Dec 31, 2025");
  });
});

describe("garbage renders as nothing, never as 'Invalid Date'", () => {
  it("empties on junk and null", () => {
    for (const fn of [shortDate, crewDate, longDate, longDay, lakeStamp]) {
      expect(fn("not a date")).toBe("");
      expect(fn(null)).toBe("");
      expect(fn(undefined)).toBe("");
    }
  });
});

describe("no server page formats a person's date without the lakes' clock", () => {
  // The sites the audit named, each confirmed by two skeptics. A page that
  // renders on the server in UTC and calls toLocaleDateString with no
  // timeZone is final — nothing corrects it in the browser.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (rel: string) => strip(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

  it("the homeowner's invoice card", () => {
    const src = read("../app/requests/job-detail-data.ts") + read("../app/requests/[id]/page.tsx");
    expect(src, "a date still goes through toLocaleDateString without the lakes' zone")
      .not.toMatch(/toLocaleDateString\("en-US",\s*\{\s*month:\s*"long",\s*day:\s*"numeric"\s*\}\)/);
    expect(src).toMatch(/from "@\/lib\/lake-time"/);
  });

  it("the homeowner's billing history", () => {
    const src = read("../app/billing/page.tsx");
    expect(src, "billing history still calls a bare toLocaleDateString()").not.toMatch(/toLocaleDateString\(\)/);
    expect(src).toMatch(/shortDate\(/);
  });

  it("the ops job file's timeline", () => {
    const src = read("../app/ops/jobs/[id]/page.tsx");
    expect(src).toMatch(/lakeStamp|longDay/);
    expect(src, "prettyStamp still formats in the server's zone")
      .not.toMatch(/function prettyStamp[\s\S]{0,300}toLocaleString\("en-US",\s*\{\s*month/);
  });

  it("the crew's late-cancellation text", () => {
    const src = read("../app/requests/actions.ts");
    expect(src, "the crew is still texted a raw ISO date").not.toMatch(/on \$\{l\.job\.date\}/);
    expect(src).toMatch(/crewDate\(l\.job\.date\)/);
  });

  it("the resident's receipt and the office's claim email", () => {
    expect(read("../app/park/receipt-helpers.ts")).toMatch(/longDate\(r\.receivedOn\)/);
    expect(read("../app/parks/pay-actions.ts")).toMatch(/longDate\(c\.paidOn\)/);
    expect(read("./confirm-server.ts")).toMatch(/longDate\(/);
  });

  it("the ops escalation card", () => {
    expect(read("../app/ops/page.tsx")).not.toMatch(/opened \{e\.openedAt\}/);
  });

  it("the requests list", () => {
    expect(read("../app/requests/page.tsx")).toMatch(/shortDate\(/);
  });
});
