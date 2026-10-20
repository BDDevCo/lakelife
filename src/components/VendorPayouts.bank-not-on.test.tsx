import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { PayoutState } from "@/app/vendor/bank-data";

/**
 * DO NOT ASK A CREW FOR THEIR BANK DETAILS WHEN WE CANNOT KEEP THEM.
 *
 * Found by an adversarial audit of the money rails. `setPayoutAccount` seals
 * routing and account numbers with BANK_ENCRYPTION_KEY and REFUSES when it is
 * unset — which it is, in every environment. Three surfaces on this screen
 * invited a crew to add a bank account anyway, and the refusal arrived only
 * AFTER a full routing and account number had been typed.
 *
 * That is two harms. The dead end is the obvious one. The other is that a
 * person typed their bank credentials into a form that was never going to
 * store them, which is not undone by an error toast.
 *
 * THIS SCREEN HAD NO TEST AT ALL before this file, which is why a required new
 * field on `PayoutState` broke nothing and proved nothing.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({
  toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }),
}));
vi.mock("@/app/vendor/bank-actions", () => ({
  setPayoutAccount: async () => ({ ok: true }),
  requestEarlyPayout: async () => ({ ok: true, net: 0 }),
}));

const { VendorPayouts } = await import("./VendorPayouts");

const state = (over: Partial<PayoutState> = {}): PayoutState => ({
  canStoreBank: true,
  hasAccount: false,
  bankName: null,
  last4: null,
  readyNow: 0,
  feePct: 0.02,
  feeNow: 0,
  netNow: 0,
  batches: [],
  ...over,
});

/**
 * Tags out, entities back to characters. `renderToStaticMarkup` escapes an
 * apostrophe as `&#x27;`, so a plain tag-strip makes every assertion about a
 * contraction fail for a reason that has nothing to do with the screen.
 */
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;|&rsquo;|\u2019/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x2014;|\u2014/g, "—")
    .replace(/\s+/g, " ");
const render = (over: Partial<PayoutState> = {}) =>
  words(renderToStaticMarkup(<VendorPayouts state={state(over)} />));

describe("when bank storage is not switched on", () => {
  it("ASKS FOR NOTHING — no routing field, no account field", () => {
    const html = render({ canStoreBank: false });
    expect(html).not.toMatch(/Routing number/i);
    expect(html).not.toMatch(/Where should the money land/i);
  });

  it("says so plainly, and says nothing is lost", () => {
    // A crew reading "not switched on" about their pay needs the second half
    // of the sentence or it reads as "you are not getting paid".
    const html = render({ canStoreBank: false });
    expect(html).toMatch(/aren't switched on yet/i);
    expect(html).toMatch(/Nothing is lost/i);
    expect(html).toMatch(/what you have earned are recorded/i);
  });

  it("AND THE NUDGE DOES NOT SEND THEM TO THE FORM EITHER", () => {
    // "Add your bank to unlock payouts" appeared whenever money was ready,
    // which is exactly when a crew is most motivated to type it.
    const html = render({ canStoreBank: false, readyNow: 400, netNow: 392, feeNow: 8 });
    expect(html).not.toMatch(/Add your bank to unlock payouts/i);
    expect(html).toMatch(/aren't switched on yet/i);
  });

  it("and a crew whose details are already on file still sees them", () => {
    // Those rows predate the key going missing. Hiding them would read as
    // "we lost your bank account", which is worse and also untrue.
    const html = render({ canStoreBank: false, hasAccount: true, bankName: "Lake Community Bank", last4: "6789" });
    expect(html).toMatch(/Lake Community Bank/);
    expect(html).toMatch(/6789/);
    // But nothing offers to take new ones.
    expect(html).not.toMatch(/Routing number/i);
    expect(html).toMatch(/can't be changed just now/i);
  });
});

describe("when it IS switched on — or the tests above prove nothing", () => {
  it("asks for the bank account", () => {
    const html = render({ canStoreBank: true });
    expect(html).toMatch(/Where should the money land/i);
    expect(html).toMatch(/Routing number/i);
  });

  it("offers Change to a crew already on file", () => {
    const html = render({ canStoreBank: true, hasAccount: true, bankName: "Lake Community Bank", last4: "6789" });
    expect(html).toMatch(/Change/);
    expect(html).not.toMatch(/can't be changed just now/i);
  });

  it("and nudges a crew with money waiting", () => {
    const html = render({ canStoreBank: true, readyNow: 400, netNow: 392, feeNow: 8 });
    expect(html).toMatch(/Add your bank to unlock payouts/i);
  });
});

describe("the loader reads it once, and never hands the key on", () => {
  it("derives a boolean from the environment, not the value", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../app/vendor/bank-data.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/const canStoreBank = !!process\.env\.BANK_ENCRYPTION_KEY;/);
    // Nothing downstream has any business holding the key itself.
    expect(src).not.toMatch(/bankKey|encryptionKey|BANK_ENCRYPTION_KEY as string/);
  });
});
