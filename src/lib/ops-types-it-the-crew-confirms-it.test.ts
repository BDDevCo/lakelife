import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toE164 } from "./phone";
import {
  WORK_DAYS,
  WORK_DAYS_IN_READING_ORDER,
  cleanWorkDays,
  cleanCapacity,
  cleanProposedPhone,
  isWorkDay,
  setupAttribution,
  MIN_DAILY_CAPACITY,
  MAX_DAILY_CAPACITY,
  ONLY_THE_CREW_CAN,
} from "./crew-setup";
import { payloadFromValues, initialRateValues, valuesCarryMoney, type RateField } from "@/app/vendor/rates-helpers";
import { activationGaps, readyToActivate, type ActivationInput } from "@/app/vendor/onboarding-helpers";

/**
 * OPS TYPES IT. THE CREW CONFIRMS IT. NOTHING IN BETWEEN IS TRUE.
 *
 * Brendon, 24 September 2026: "me add them directly and answer most of the
 * questions in some ops portal, then they get sent a confirmation email or text
 * where all they have to do is upload or input a few small items".
 *
 * The workflow is right and the risk is the whole posture: he abolished
 * LakeLife-set pricing this week, and a rate ops typed that goes live without
 * the crew confirming it is LakeLife setting a crew's price with extra steps.
 * So the tests below are almost all STRUCTURAL — they read the source and
 * require that the only writes on the ops side land in the proposal tables, and
 * that the confirmation goes through the crew's own doors rather than a second
 * copy of them.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments explain the rules; they must never be mistaken for code. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const INVITE = strip(read("../app/ops/crews-invite.ts"));
const CONFIRM = strip(read("../app/vendor/setup-actions.ts"));
const OPS_FORM = strip(read("../components/ops/CrewBoard.tsx"));
const DISPATCH = read("../app/book/dispatch.ts");

// ---------------------------------------------------------------------------
describe("the working week means one thing", () => {
  it("is spelled exactly the way dispatch spells it", () => {
    // THE SILENT FAILURE THIS PINS. `isEligible` asks
    // `c.workDays.includes(input.weekday)` and the weekday comes from
    // `WEEKDAYS[getDay()]`. A day stored in any other spelling — "Monday",
    // "mon" — is a day the router can never match, so the crew looks available
    // on every screen and is simply never offered work, with nothing anywhere
    // to explain it. Two lists in two files is how that drifts.
    const m = DISPATCH.match(/const WEEKDAYS = (\[[^\]]*\])/);
    expect(m, "app/book/dispatch.ts no longer declares WEEKDAYS — this test is measuring nothing").toBeTruthy();
    const theirs: string[] = JSON.parse(m![1].replace(/'/g, '"'));
    expect([...WORK_DAYS]).toEqual(theirs);
  });

  it("reads Monday-first for a person and holds the same seven days", () => {
    expect([...WORK_DAYS_IN_READING_ORDER].sort()).toEqual([...WORK_DAYS].sort());
    expect(WORK_DAYS_IN_READING_ORDER[0]).toBe("Mon");
  });

  it("drops a day the router could never match, and keeps dispatch's order", () => {
    expect(cleanWorkDays(["Monday", "Tue", "mon", "Sat"])).toEqual(["Tue", "Sat"]);
    expect(cleanWorkDays(["Sat", "Mon"])).toEqual(["Mon", "Sat"]); // Sun-first order
    expect(cleanWorkDays(["Mon", "Mon"])).toEqual(["Mon"]);
    expect(cleanWorkDays("Mon")).toEqual([]);
    expect(cleanWorkDays(null)).toEqual([]);
    expect(isWorkDay("Monday")).toBe(false);
  });

  it("is whitelisted in the CREW's own doorway too, not just the ops one", () => {
    // A rule in one doorway of two is not a rule. `toggleWorkDay` took whatever
    // it was handed and wrote it straight to `vendors.work_days`.
    const toggle = strip(read("../app/vendor/availability/actions.ts"));
    expect(toggle).toMatch(/isWorkDay\(/);
  });
});

// ---------------------------------------------------------------------------
describe("a number nobody chose is not an answer", () => {
  it("refuses a capacity outside the band the rest of the product enforces", () => {
    expect(cleanCapacity(5)).toBe(5);
    expect(cleanCapacity("5")).toBe(5);
    expect(cleanCapacity(MIN_DAILY_CAPACITY)).toBe(MIN_DAILY_CAPACITY);
    expect(cleanCapacity(MAX_DAILY_CAPACITY)).toBe(MAX_DAILY_CAPACITY);
    expect(cleanCapacity(0)).toBeNull();
    expect(cleanCapacity(MAX_DAILY_CAPACITY + 1)).toBeNull();
    expect(cleanCapacity(-3)).toBeNull();
  });

  it("answers null for an empty box rather than inventing a number", () => {
    // THE BUG THIS EXISTS TO NOT REBUILD: a seeded `daily_capacity` of 1 once
    // SATISFIED activationGaps, rendered the wizard's step ticked with a
    // "Saved" pill for a number nobody had chosen, and capped that crew at one
    // job a day forever. An empty box asks a question; a filled one answers it.
    expect(cleanCapacity("")).toBeNull();
    expect(cleanCapacity(null)).toBeNull();
    expect(cleanCapacity(undefined)).toBeNull();
    expect(cleanCapacity("three")).toBeNull();
  });

  it("takes a phone in the shape a person says it, and refuses a non-number", () => {
    expect(cleanProposedPhone("(260) 555-0134")).toBe("+12605550134");
    expect(cleanProposedPhone(" 2605550134 ")).toBe("+12605550134");
    expect(cleanProposedPhone("")).toBeNull();
    expect(cleanProposedPhone("call the shop")).toBeNull();
    expect(cleanProposedPhone(null)).toBeNull();
  });

  it("agrees with the constraint that has to store it", () => {
    // `toE164` is LOOSER than 0181's crew_setup_proposals_phone_is_e164: it
    // passes a leading zero, the constraint does not. Left to disagree, one
    // mistyped number would bounce the INSERT and take the crew's lakes, days
    // and rate down with it — the whole call lost to a typo.
    //
    // The regex is re-read from the migration rather than restated, so the two
    // cannot drift apart quietly.
    const sql = readFileSync(
      fileURLToPath(new URL("../../supabase/migrations/0181_ops_types_it_the_crew_confirms_it.sql", import.meta.url)),
      "utf8",
    );
    const m = sql.match(/phone_e164\s*~\s*'([^']+)'/);
    expect(m, "0181 no longer constrains the phone shape — this is measuring nothing").toBeTruthy();
    const constraint = new RegExp(m![1].replace(/\\\\/g, "\\"));

    for (const good of ["(260) 555-0134", "2605550134", "+12605550134"]) {
      const out = cleanProposedPhone(good)!;
      expect(out, `${good} was refused`).toBeTruthy();
      expect(constraint.test(out), `${out} would be refused by the database`).toBe(true);
    }
    // THE GAP ITSELF, with a number that actually reaches it. A ten-digit
    // string is read as US and prefixed with +1 whatever it starts with, so
    // the leading zero has to arrive on a NINE-digit international number to
    // survive toE164 — which hands it straight back, and the column refuses it.
    expect(toE164("+012345678")).toBe("+012345678");
    expect(constraint.test("+012345678")).toBe(false);
    expect(cleanProposedPhone("+012345678"), "a number the column refuses got through").toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("the card says who did this and when", () => {
  it("names the person and the date in words a person reads", () => {
    const line = setupAttribution({ proposerName: "Brendon", proposedAt: "2026-09-24T15:04:00Z" });
    expect(line).toContain("Brendon");
    expect(line).toContain("September 24, 2026");
    // Never the machine form. Months a person reads are "September 2026".
    expect(line).not.toContain("2026-09");
  });

  it("still attributes it to somebody when the name is missing", () => {
    // An unattributed pre-fill is indistinguishable from a default, and a
    // default that asserts a fact wrote nineteen leases nobody had signed.
    const line = setupAttribution({ proposerName: null, proposedAt: "2026-09-24T15:04:00Z" });
    expect(line).toContain("Someone at LakeLife");
    expect(line).toContain("September 24, 2026");
  });

  it("does not claim a date it does not have", () => {
    expect(setupAttribution({ proposerName: "Brendon", proposedAt: null })).toBe(
      "Brendon set this up from your call.",
    );
  });
});

// ---------------------------------------------------------------------------
describe("ops writes a proposal and nothing else", () => {
  /** Every `.from("x").update|insert|upsert|delete` in a chunk of source. */
  const WRITE = /\.from\(\s*["']([a-z_]+)["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;
  function tablesWritten(src: string): string[] {
    return [...new Set([...src.matchAll(WRITE)].map((m) => m[1]))].sort();
  }

  /**
   * ONE FUNCTION'S BODY, not the whole file.
   *
   * The first version of this test scanned all of crews-invite.ts and failed on
   * `claimCrewInvite`, which legitimately flips `users.role` when a crew signs
   * in — a write that has nothing to do with the setup form and every right to
   * be there. A file-wide scan would either have to permit `users` everywhere
   * (so a setup path writing it would sail through) or be deleted. Scoping it
   * to the writer is the rule I actually mean.
   */
  function bodyOf(src: string, fn: string): string {
    const at = src.indexOf(`function ${fn}(`);
    expect(at, `${fn} is gone — this test is measuring nothing`).toBeGreaterThan(-1);
    const open = src.indexOf("{", src.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error(`could not find the end of ${fn}`);
  }

  const WRITER = bodyOf(INVITE, "writeSetupProposal");

  it("puts what ops typed in the proposal tables and nowhere else", () => {
    // THE RULE, MADE STRUCTURAL RATHER THAN ASSERTED. A rate ops typed landing
    // in `vendor_rates`, or a lake landing on `vendors.service_lakes`, is a
    // crew's account set by somebody else, live, with nobody's agreement. The
    // table list is the whole check: the column names cannot get anywhere the
    // table did not.
    expect(tablesWritten(WRITER)).toEqual([
      "crew_setup_proposals",
      "crew_setup_proposed_rates",
    ]);
  });

  it("reads the lakes and services to whitelist them, and writes neither", () => {
    // It DOES read `lakes` and `services` — a stale lake id copied onto
    // `vendors.service_lakes` at confirmation would match no lake at all, and
    // the crew would be silently unroutable on water they believe they cover.
    expect(WRITER).toMatch(/\.from\("lakes"\)/);
    expect(WRITER).toMatch(/\.from\("services"\)/);
    expect(WRITER).not.toMatch(/\.from\("vendors"\)/);
    expect(WRITER).not.toMatch(/\.from\("vendor_rates"\)/);
    expect(WRITER).not.toMatch(/\.from\("users"\)/);
  });

  it("leaves the invite row's own capacity null, as it has been since 0126", () => {
    // A seeded 1 SATISFIED activationGaps, so the wizard's capacity step
    // rendered ticked for a number nobody chose and dispatch capped that crew
    // at one job a day forever. A setup form is exactly where that would be
    // rebuilt with a nicer face on it.
    expect(INVITE).toMatch(/daily_capacity:\s*null/);
    expect(bodyOf(INVITE, "writeSetupProposal")).not.toMatch(/daily_capacity:\s*[1-9]/);
  });

  it("has no field for the four things only the crew can do", () => {
    // Not masked, not optional — ABSENT, from the input type and from the form,
    // so no future edit can quietly grow one. A field that cannot honestly be
    // somebody else's act does not belong on this form.
    for (const forbidden of [/payout_token/, /routing_number/, /account_number/, /tos_accepted/, /coi_url/, /w9_url/, /phone_verified/]) {
      expect(INVITE, `crews-invite.ts writes ${forbidden}`).not.toMatch(forbidden);
      expect(OPS_FORM, `the ops form collects ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("says on screen which four they cannot do", () => {
    // Saying nothing would be true and useless: ops would go looking for a bank
    // field, and a crew who confirms the card would think they were finished.
    expect(OPS_FORM).toMatch(/can&apos;t enter their bank details/);
    expect(ONLY_THE_CREW_CAN.length).toBe(4);
    const card = read("../components/CrewSetupConfirm.tsx");
    expect(card).toMatch(/ONLY_THE_CREW_CAN\.map/);
    expect(card).toMatch(/Verify your mobile/);
  });

  it("never drops a typed phone number in silence, on any path out", () => {
    // A phone that cannot be stored must not cost the crew their lakes, their
    // days and their rate — and it must not vanish either, because ops has
    // just read it back down the phone. Every `return` from the writer that
    // could carry it, does: the early "nothing to propose" one is the path
    // that dropped it, when an unstorable number was the ONLY thing typed.
    // FROM THE LINE THE PHONE IS READ. The guard above it — "no setup was
    // supplied at all" — runs before any phone exists and cannot lose one.
    const from = WRITER.indexOf("const phone = cleanProposedPhone");
    expect(from, "the writer no longer reads a phone — this is measuring nothing").toBeGreaterThan(-1);
    const rets = [...WRITER.slice(from).matchAll(/return \{[\s\S]*?\};/g)].map((m) => m[0]);
    expect(rets.length, "writeSetupProposal has no returns after the phone").toBeGreaterThan(3);
    for (const r of rets) {
      // A return that gives up on the whole proposal says so in `problem`;
      // every other one has to carry the phone's fate.
      const abandons = /wrote:\s*false/.test(r);
      expect(
        abandons || /phoneUnreadable/.test(r),
        `a path out of writeSetupProposal loses the phone silently:\n${r}`,
      ).toBe(true);
    }
  });

  it("draws the near-match list, which this doorway alone never did", () => {
    // `inviteCrew` has always returned `needsConfirm` with `error` DELIBERATELY
    // unset, and this card toasted `res.error ?? "Couldn't send that invite."`
    // — a bare refusal with no reason and no list. The rule was in one doorway
    // of three.
    expect(OPS_FORM).toMatch(/res\.needsConfirm/);
    expect(OPS_FORM).toMatch(/<SimilarCrewList/);
  });
});

// ---------------------------------------------------------------------------
describe("the crew's confirmation goes through the crew's own doors", () => {
  it("calls the actions rather than writing the columns itself", () => {
    // Those actions carry rules invisible from here that a second copy drops:
    // setServiceLakes refuses a lake this crew is COOLING DOWN off and fences
    // fixture lakes out; setDailyCapacity holds the 1–20 band assertRoutable
    // depends on; setMyRate re-derives the pricing STRUCTURE from the service
    // row so only the crew's dollars reach vendor_rates.
    expect(CONFIRM).toMatch(/setServiceLakes\(/);
    expect(CONFIRM).toMatch(/setDailyCapacity\(/);
    expect(CONFIRM).toMatch(/setMyRate\(/);
    expect(CONFIRM).not.toMatch(/service_lakes\s*:/);
    expect(CONFIRM).not.toMatch(/daily_capacity\s*:/);
    expect(CONFIRM).not.toMatch(/from\(\s*["']vendor_rates["']\s*\)/);
  });

  it("finds the proposal by the SESSION's vendor, never by the id it was handed", () => {
    // This file is "use server", so both exports are public endpoints and
    // `proposalId` arrived from a browser. Looking a proposal up by that id
    // would let anyone signed in reach somebody else's — 0181's trigger would
    // still refuse the write, but a raw Postgres string on a stranger's screen
    // is not the same as a door that was never open.
    expect(CONFIRM).toMatch(/\.eq\("vendor_id", vendorId\)/);
    expect(CONFIRM).not.toMatch(/\.eq\("id", proposalId\)/);
  });

  it("de-duplicates what it reports back, so one cause is one line", () => {
    // Three rates failing for one reason is one thing to fix, not three.
    //
    // THE RULE THIS PAIRS WITH — that a half-applied setup is never marked
    // confirmed — IS NOT TESTED HERE, deliberately. The first version of it
    // pinned the ORDER of two strings in this file, and a break of exactly the
    // shape it existed to catch (`if (false && left.length > 0)`) sailed
    // straight past. It lives in
    // app/vendor/a-half-applied-setup-is-not-confirmed.test.ts now, which runs
    // the real action against a stubbed database and watches what it writes.
    expect(CONFIRM).toMatch(/partial:\s*\[\.\.\.new Set\(left\)\]/);
  });

  it("records the crew as the one who settled it — never ops", () => {
    // 0181's trigger refuses anything else, but the action must not be the one
    // testing that: `settled_by` is the session's own user id, and there is no
    // path here that could pass another.
    expect(CONFIRM).toMatch(/settled_by:\s*me\.userId/);
    expect(CONFIRM).not.toMatch(/settled_by:\s*(?!me\.userId)[a-zA-Z]/);
  });
});

// ---------------------------------------------------------------------------
describe("confirming a setup does not make anybody live", () => {
  it("leaves every gate only the crew can open still shut", () => {
    // THE WHOLE POINT OF THE FLOW IS THAT IT SHORTENS THE TYPING, NOT THE GATE.
    // A crew whose lakes, days, capacity and rates were all taken down on the
    // phone and confirmed still has no insurance certificate and no W-9 on
    // file, so `activationGaps` still refuses — and the go-live card still
    // names both. Weakening this to make the flow feel finished is how a dock
    // gets worked by somebody with no cover.
    const afterConfirming: ActivationInput = {
      coi_url: null,
      coi_expiry: null,
      coi_named_insured: null,
      company: "Josh's Docks",
      w9_url: null,
      service_types: ["Pier install / removal"],
      service_lakes: ["lake-1"],
      daily_capacity: 4,
    };
    const gaps = activationGaps(afterConfirming, "2026-09-24");
    expect(readyToActivate(afterConfirming, "2026-09-24")).toBe(false);
    expect(gaps.join(" ")).toMatch(/insurance certificate/i);
    expect(gaps.join(" ")).toMatch(/W-9/);
    // ...and the three the call DID settle are no longer asked for.
    expect(gaps.join(" ")).not.toMatch(/kind of work you do/i);
    expect(gaps.join(" ")).not.toMatch(/lakes you service/i);
    expect(gaps.join(" ")).not.toMatch(/jobs a day/i);
  });

  it("refuses a crew whose setup is waiting and unconfirmed", () => {
    // Until they tap, `vendors` holds none of it — which is exactly why the
    // gate still fires. Nothing about the proposal existing changes this.
    const beforeConfirming: ActivationInput = {
      coi_url: null, coi_expiry: null, coi_named_insured: null,
      company: "Josh's Docks", w9_url: null,
      service_types: ["Pier install / removal"], service_lakes: null, daily_capacity: null,
    };
    const gaps = activationGaps(beforeConfirming, "2026-09-24");
    expect(gaps.join(" ")).toMatch(/lakes you service/i);
    expect(gaps.join(" ")).toMatch(/jobs a day/i);
  });
});

// ---------------------------------------------------------------------------
describe("one rate form, three screens", () => {
  const FIELDS: RateField[] = [
    { key: "base", kind: "base", label: "Base", value: 10, payout: null },
    { key: "unit_rate", kind: "unit", label: "Per section", value: 50, payout: null },
    { key: "small", kind: "band", label: "Small", value: null, payout: null },
  ];

  it("splits base, unit and band into the keys computeRateRow expects", () => {
    // Getting this split wrong writes a band price into `base`, which is not a
    // validation error anywhere — it is simply a different, wrong price, saved
    // and confirmed. Three hand-copies is how that happens.
    const p = payloadFromValues(FIELDS, { base: "10", unit_rate: "50", small: "95" });
    expect(p.base).toBe("10");
    expect(p.unitRate).toBe("50");
    expect(p.band).toEqual({ small: "95" });
  });

  it("starts the boxes at the saved values, and empty where there are none", () => {
    expect(initialRateValues(FIELDS)).toEqual({ base: "10", unit_rate: "50", small: "" });
  });

  it("knows a card with nothing in it is not a rate", () => {
    // "A blank card counts as unpriced" is the rule everywhere else; the ops
    // form must not send a row of zeros that 0181's trigger then refuses.
    expect(valuesCarryMoney({ base: "", unit_rate: "" })).toBe(false);
    expect(valuesCarryMoney({ base: "0", unit_rate: "0" })).toBe(false);
    expect(valuesCarryMoney({ base: "", unit_rate: "50" })).toBe(true);
    expect(valuesCarryMoney({})).toBe(false);
  });

  it("is the same helper on all three screens, not three copies", () => {
    expect(OPS_FORM).toMatch(/payloadFromValues\(/);
    expect(strip(read("../components/CrewSetupConfirm.tsx"))).toMatch(/payloadFromValues\(/);
    expect(strip(read("../components/VendorRates.tsx"))).toMatch(/payloadFromValues\(/);
  });
});

// ---------------------------------------------------------------------------
describe("the scanners bite", () => {
  it("would catch a write to a table that is not allowed", () => {
    // Absence-only assertions pass against a broken scanner. Feed it both.
    const src = `await admin.from("vendor_rates").upsert({ base: 1 });`;
    const found = [...src.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g)]
      .map((m) => m[1]);
    expect(found).toEqual(["vendor_rates"]);
    const clean = `await admin.from("vendor_rates").select("base");`;
    expect([...clean.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g)]).toHaveLength(0);
  });

  it("is reading the real files, not empty strings", () => {
    // A scanner over nothing passes forever.
    expect(INVITE.length).toBeGreaterThan(2000);
    expect(CONFIRM.length).toBeGreaterThan(2000);
    expect(OPS_FORM.length).toBeGreaterThan(2000);
    expect(INVITE).toContain("inviteCrew");
    expect(CONFIRM).toContain("confirmMySetup");
  });
});
