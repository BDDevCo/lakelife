import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveMerchant, rentCapability, type MerchantFacts } from "./rent-capability";

/**
 * WHO THE MONEY SETTLES TO.
 *
 * Verified against production on 15 Oct 2026, before any of this existed:
 *
 *   processor account registry : DID NOT EXIST
 *   parks / vendors            : no merchant column
 *   The Haven                  : accepts_online_rent = TRUE, card_fee_pct 3.00
 *
 * So a park was switched on to take rent online and **nothing recorded who
 * receives it.** `payRent` checked the dial; `takePayment` checked
 * LAKELIFE_PAYMENTS_LIVE, one deployment-wide boolean meaning "LakeLife has a
 * processor". Neither asked whether THIS park's owner can receive money.
 *
 * Under Architecture A rent settles to the owner's own merchant. With none on
 * file the only merchant that exists is LakeLife's — so the day that flag is
 * set, somebody else's rent settles into our balance. That is the pooled model
 * we rejected, arriving by omission rather than by decision.
 */

const active = (over: Partial<MerchantFacts> = {}): MerchantFacts => ({
  status: "active", canAcceptAch: true, canAcceptCard: true,
  settlementLast4: "4471", ...over,
});

const ask = (over: Parameters<typeof rentCapability>[0]) =>
  rentCapability({ processorConnected: true, ...over });

describe("the third condition", () => {
  it("a live merchant, a connected processor and the dial on means YES", () => {
    const c = ask({ parkSwitchOn: true, merchant: active() });
    expect(c.canTakeOnlineRent).toBe(true);
    expect(c.byAch).toBe(true);
    expect(c.byCard).toBe(true);
    expect(c.block).toBeNull();
  });

  it("NOBODY SET UP TO RECEIVE IT means no, however keen the park is", () => {
    // The production state on the day this was written.
    const c = ask({ parkSwitchOn: true, merchant: null });
    expect(c.canTakeOnlineRent).toBe(false);
    expect(c.block).toBe("owner_not_onboarded");
  });

  it("still with the processor means no", () => {
    for (const status of ["draft", "submitted"] as const) {
      const c = ask({ parkSwitchOn: true, merchant: active({ status, settlementLast4: null }) });
      expect(c.canTakeOnlineRent, status).toBe(false);
      expect(c.block).toBe("owner_pending");
    }
  });

  it("closed means no", () => {
    for (const status of ["rejected", "disabled"] as const) {
      const c = ask({ parkSwitchOn: true, merchant: active({ status }) });
      expect(c.canTakeOnlineRent, status).toBe(false);
      expect(c.block).toBe("owner_closed");
    }
  });

  it("LIVE BUT APPROVED FOR NOTHING means no", () => {
    // A merchant approved only to be PAID can still not be paid BY a resident.
    const c = ask({
      parkSwitchOn: true,
      merchant: active({ canAcceptAch: false, canAcceptCard: false }),
    });
    expect(c.canTakeOnlineRent).toBe(false);
    expect(c.block).toBe("owner_cannot_collect");
  });

  it("approved for only one rail says which", () => {
    const ach = ask({ parkSwitchOn: true, merchant: active({ canAcceptCard: false }) });
    expect(ach.canTakeOnlineRent).toBe(true);
    expect(ach.byAch).toBe(true);
    expect(ach.byCard).toBe(false);

    const card = ask({ parkSwitchOn: true, merchant: active({ canAcceptAch: false }) });
    expect(card.canTakeOnlineRent).toBe(true);
    expect(card.byCard).toBe(true);
    expect(card.byAch).toBe(false);
  });

  it("A FAILED READ IS NOT A YES, and not a no about the owner either", () => {
    // `undefined` means nobody looked. Treating it as "not onboarded" would be
    // a confident statement about somebody's paperwork made at the exact
    // moment we had no idea.
    const c = ask({ parkSwitchOn: true, merchant: undefined });
    expect(c.canTakeOnlineRent).toBe(false);
    expect(c.block).toBe("read_failed");
    expect(c.saidToOwner).toMatch(/couldn't read/i);
  });
});

describe("the two conditions that were already there", () => {
  it("no processor connected to LakeLife at all", () => {
    const c = rentCapability({
      parkSwitchOn: true, merchant: active(), processorConnected: false,
    });
    expect(c.canTakeOnlineRent).toBe(false);
    expect(c.block).toBe("no_processor");
  });

  it("the dial off", () => {
    const c = ask({ parkSwitchOn: false, merchant: active() });
    expect(c.canTakeOnlineRent).toBe(false);
    expect(c.block).toBe("park_switch_off");
  });

  it("THE ORDER RUNS FROM FURTHEST FROM HIM TO NEAREST", () => {
    // Told "switch online rent on" when the real problem is that LakeLife has
    // no processor, an owner switches it on and finds nothing changed.
    const c = rentCapability({
      parkSwitchOn: false, merchant: null, processorConnected: false,
    });
    expect(c.block).toBe("no_processor");
  });
});

describe("two audiences, two sentences", () => {
  const blocked = [
    ask({ parkSwitchOn: true, merchant: null }),
    ask({ parkSwitchOn: true, merchant: active({ status: "submitted", settlementLast4: null }) }),
    ask({ parkSwitchOn: true, merchant: active({ status: "disabled" }) }),
    ask({ parkSwitchOn: false, merchant: active() }),
    rentCapability({ parkSwitchOn: true, merchant: active(), processorConnected: false }),
  ];

  it("a resident is NEVER told whose paperwork is unfinished", () => {
    for (const c of blocked) {
      expect(c.saidToResident, `leaked: ${c.saidToResident}`)
        .not.toMatch(/merchant|processor|onboard|approval|owner|landlord|setup/i);
    }
  });

  it("and she always gets the one thing she can do instead", () => {
    for (const c of blocked) {
      expect(c.saidToResident).toMatch(/pay the office/i);
    }
  });

  it("the OWNER gets the real reason, and they differ from each other", () => {
    const said = blocked.map((c) => c.saidToOwner);
    expect(new Set(said).size, "two blocks give the owner the same sentence")
      .toBe(said.length);
    for (const s of said) expect(s.length).toBeGreaterThan(30);
  });

  it("a working park tells the owner where the money goes", () => {
    expect(ask({ parkSwitchOn: true, merchant: active() }).saidToOwner)
      .toMatch(/ending 4471/);
    expect(ask({ parkSwitchOn: true, merchant: active({ settlementLast4: null }) }).saidToOwner)
      .toMatch(/your own bank account/i);
  });

  it("no sentence leaks a placeholder", () => {
    for (const c of blocked) {
      expect(c.saidToResident + c.saidToOwner).not.toMatch(/undefined|NaN|null|\[object/);
    }
  });
});

describe("picking the one live account", () => {
  it("null means the registry said there are none", () => {
    expect(liveMerchant([])).toBeNull();
  });

  it("undefined means nobody looked, and it stays undefined", () => {
    expect(liveMerchant(null)).toBeUndefined();
    expect(liveMerchant(undefined)).toBeUndefined();
  });

  it("a closed account is a NO, not a weaker yes", () => {
    expect(liveMerchant([active({ status: "disabled" })])).toBeNull();
    expect(liveMerchant([active({ status: "rejected" })])).toBeNull();
  });

  it("and a live one is found past the closed ones", () => {
    const m = liveMerchant([active({ status: "rejected" }), active()]);
    expect(m?.status).toBe("active");
  });
});

/**
 * THE RULE IN EVERY DOORWAY, not one of four.
 */
describe("every doorway asks the same question", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (f: string) =>
    strip(readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8"));

  it("the money doorway refuses on the verdict, before charging", () => {
    const pay = read("./pay-actions.ts");
    expect(pay).toMatch(/loadRentCapability\(/);
    const gate = pay.indexOf("capability.canTakeOnlineRent");
    const charge = pay.indexOf("takePayment(");
    expect(gate, "payRent never checks the capability").toBeGreaterThan(-1);
    expect(charge).toBeGreaterThan(-1);
    expect(gate, "the card is charged before the capability is checked")
      .toBeLessThan(charge);
  });

  it("and it no longer gates on the dial alone", () => {
    const pay = read("./pay-actions.ts");
    expect(pay).not.toMatch(/if \(!park\?\.accepts_online_rent\) \{/);
  });

  it("the resident's screen reaches the same verdict", () => {
    const md = read("./my-data.ts");
    expect(md).toMatch(/loadRentCapability\(/);
    expect(md).toMatch(/acceptsOnlineRent: rentCap\.canTakeOnlineRent/);
  });

  it("the loader treats a failed read as a refusal, not as 'none'", () => {
    const cap = read("./rent-capability.ts");
    expect(cap).toMatch(/if \(res\.error\)/);
    expect(cap).toMatch(/merchant: undefined/);
  });
});

/**
 * The registry itself.
 */
describe("the registry holds no bank credentials", () => {
  const migration = (() => {
    const dir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
    let found = "";
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      const body = readFileSync(dir + f, "utf8");
      if (/create table if not exists public\.processor_accounts/.test(body)) found = body;
    }
    return found;
  })();

  it("FOUR DIGITS AND NOTHING MORE", () => {
    // The dividend of Architecture A: the processor is the regulated party
    // that holds bank credentials. A registry that accumulated them would hand
    // us back the custody problem we designed out.
    expect(migration.length, "0196 was not found").toBeGreaterThan(1000);
    expect(migration).toMatch(/settlement_last4 text check \(settlement_last4 ~ '\^\[0-9\]\{4\}\$'\)/);
    // THE COLUMN LIST, NOT THE WHOLE FILE. Both the header comment and the
    // table's own COMMENT ON say "no bank account or routing numbers" in so
    // many words — a whole-file scan fails on the sentences promising the
    // opposite, which is a test that breaks when the documentation is good.
    const create = migration.slice(
      migration.indexOf("create table if not exists public.processor_accounts"),
    );
    const columns = create.slice(0, create.indexOf(");")).replace(/^\s*--.*$/gm, "");
    expect(columns.length, "the column list is empty — this scan is measuring nothing")
      .toBeGreaterThan(400);
    expect(columns).toMatch(/settlement_last4/);
    for (const forbidden of [/routing/i, /account_number/i, /encrypted/i, /\biban\b/i]) {
      expect(columns, `the registry grew a bank credential column: ${forbidden}`)
        .not.toMatch(forbidden);
    }
  });

  it("capabilities default to false — they are the processor's answer", () => {
    for (const c of ["can_accept_ach", "can_accept_card", "can_receive_payout"]) {
      expect(migration).toMatch(new RegExp(`${c}\\s+boolean not null default false`));
    }
  });

  it("a row names exactly one recipient", () => {
    expect(migration).toMatch(/check \(\(park_id is null\) <> \(vendor_id is null\)\)/);
  });

  it("an active merchant has an id, a day and a destination", () => {
    expect(migration).toMatch(/an active merchant needs the id/);
    expect(migration).toMatch(/an active merchant needs the day/);
    expect(migration).toMatch(/an active merchant needs the account/);
  });

  it("status runs forward only", () => {
    expect(migration).toMatch(/already live — disable the account/);
    expect(migration).toMatch(/that account is closed/);
  });

  it("and an account cannot be re-pointed at a different recipient", () => {
    // It would redirect somebody's rent.
    expect(migration).toMatch(/an account belongs to the recipient it was opened for/);
  });

  it("RLS is on and client writes are revoked", () => {
    // A signed-in client writing this table means marking their own merchant
    // active and pointing a park's rent at an account of their choosing.
    expect(migration).toMatch(/alter table public\.processor_accounts enable row level security/);
    expect(migration).toMatch(/revoke insert, update, delete on public\.processor_accounts from anon, authenticated/);
  });
});
