import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A SWITCH IS A WISH; A PROCESSOR IS A RAIL.
 *
 * The Haven's row has `accepts_online_rent = true` and `card_fee_pct = 3.00`
 * today, and there is no payment processor connected — `takePayment` declines
 * every charge unless LAKELIFE_PAYMENTS_LIVE is set, and it is set nowhere.
 *
 * So this card told the owner, in bold, "Residents can pay rent in the app",
 * and the resident's screen rendered a gold "Pay $542.53" button over a
 * confirm panel naming her saved card. Both were describing something that
 * could not happen. Its OFF branch — "the pay button is refused server-side,
 * not just hidden" — was the more accurate of the two.
 *
 * The charge gate made the failure honest. It did not stop the product
 * OFFERING. That is what these hold down.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/park/actions", () => ({ saveOnlineRent: async () => ({ ok: true }) }));

const { ParkOnlineRent } = await import("./ParkOnlineRent");

const render = (over: Partial<Parameters<typeof ParkOnlineRent>[0]> = {}) =>
  renderToStaticMarkup(
    <ParkOnlineRent
      parkId="p1"
      initialAccepting
      initialFeePct="3"
      ceiling={3}
      canChange
      households={20}
      unclaimed={0}
      rentReady={false}
      canAskForSetup={false}
      rentBlockSaid="No payment processor is connected to LakeLife yet, so no park can take rent online — including yours."
      {...over}
    />,
  );

/** The markup with tags removed, so a claim split across elements still reads. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the switch is on and the money has nowhere to go — The Haven today", () => {
  it("does not claim residents can pay in the app", () => {
    expect(words(render())).not.toMatch(/Residents can pay rent in the app/);
  });

  it("says plainly WHY, in the verdict's own words", () => {
    // The sentence is not written here any more. payRent, the resident's
    // screen, the readiness row and this card all take it from one verdict,
    // because two sets of words about one fact is how they end up disagreeing.
    expect(words(render())).toMatch(/No payment processor is connected to LakeLife yet/);
  });

  it("carries whatever reason it is given, not one reason it knows about", () => {
    const owner = words(render({
      rentBlockSaid: "Before this park can take rent online, you need to be set up to receive it.",
    }));
    expect(owner).toMatch(/you need to be set up to receive it/);
    expect(owner).not.toMatch(/Residents can pay rent in the app/);
  });

  it("does not blame the households, who have done nothing wrong", () => {
    // The old ON branch counted claimed accounts — "20 of 20 households have
    // claimed an account and can use it". With no rail behind it, that number
    // is an answer to a question nobody should be asking yet.
    expect(words(render())).not.toMatch(/households have claimed an account and can use it/);
  });

  it("tells him what still works, so the card is not a dead end", () => {
    expect(words(render())).toMatch(/pay you the way they do now/i);
  });

  it("does not tell him to go and flip a switch that is already on", () => {
    // He set it deliberately. "We turned it off for you" would be a lie and
    // would send him back to a switch that is already where he wants it.
    const html = words(render());
    expect(html).not.toMatch(/turn(ed)? (it )?off/i);
    expect(html).toMatch(/Not yet/);
  });
});

describe("the switch is on and this park can actually be paid", () => {
  it("makes the promise, because now it is true", () => {
    const html = words(render({ rentReady: true, rentBlockSaid: "" }));
    expect(html).toMatch(/Residents can pay rent in the app/);
    expect(html).toMatch(/20 of 20 households have claimed an account/);
    expect(html).not.toMatch(/Not yet/);
  });
});

describe("the switch is off", () => {
  it("keeps saying the refusal is server-side, whatever the rail is doing", () => {
    for (const rentReady of [true, false]) {
      const html = words(render({ initialAccepting: false, rentReady, rentBlockSaid: "" }));
      expect(html, `rentReady=${rentReady}`)
        .toMatch(/Residents cannot pay in the app/);
      expect(html).toMatch(/refused\s+server-side, not just hidden/);
    }
  });
});

describe("the resident's side agrees with the owner's", () => {
  // my-data.ts is a server module (`server-only`) and cannot be imported from
  // a test at all, so this is read as source. It is the render gate for
  // PayRentButton: without it the button appears and declines every time.
  const SRC = fileURLToPath(new URL("../app/parks/my-data.ts", import.meta.url));
  const src = readFileSync(SRC, "utf8");

  it("gates the pay button on the capability, not on the dial alone", () => {
    // The ASSIGNMENT, not the interface field of the same name a hundred lines
    // above it — the first draft of this scan matched `acceptsOnlineRent:
    // boolean;` and would have passed against a type declaration forever.
    //
    // THREE CONDITIONS NOW. This used to require `paymentsAreLive()` inline,
    // which was right when there were two: the park's wish and a processor
    // connected to LakeLife. 0196 added the third — whether THIS park's owner
    // can receive the money at all — and all three moved behind one verdict so
    // that payRent and this screen cannot answer differently.
    // THE ASSIGNMENT, NOT THE DECLARATION, and the loose version of this scan
    // walked straight back into the trap the paragraph above describes: a bare
    // `acceptsOnlineRent:\s*[^\n]*` matches `acceptsOnlineRent: boolean;` in
    // the interface a hundred lines earlier and reports on a type.
    const all = [...src.matchAll(/^\s*acceptsOnlineRent:\s*(.+)$/gm)].map((m) => m[1]);
    expect(all.length, "no acceptsOnlineRent at all — this scan is measuring nothing")
      .toBeGreaterThan(0);
    const assignment = all.find((v) => !/^boolean;?$/.test(v.trim())) ?? "";
    expect(assignment, "only the type declaration is left — the assignment is gone")
      .not.toBe("");
    expect(assignment, "the dial alone decides whether she is offered a card")
      .toMatch(/rentCap\.canTakeOnlineRent/);
    // And the two-condition version it replaced is really gone.
    expect(src).not.toMatch(/Boolean\(park\?\.accepts_online_rent\) && paymentsAreLive\(\)/);
  });

  it("imports the gate it claims to use, and asks it about THIS park", () => {
    expect(src).toMatch(/import \{ loadRentCapability \} from "@\/app\/parks\/rent-capability"/);
    expect(src, "the verdict is computed without naming the park it is about")
      .toMatch(/loadRentCapability\(\s*admin,\s*file\.park_id/);
  });

  it("and the capability still contains the processor check it replaced", () => {
    // Moving the rule must not drop it. The deployment flag is now read inside
    // rent-capability rather than at this call site, and this is what keeps
    // that true.
    const cap = readFileSync(
      fileURLToPath(new URL("../app/parks/rent-capability.ts", import.meta.url)), "utf8");
    expect(cap).toMatch(/paymentsAreLive\(\)/);
    expect(cap).toMatch(/"no_processor"/);
  });
});

/**
 * THE ONE BLOCK HE CAN END HIMSELF.
 *
 * 0196's registry shipped with no writer, so every park read as "nobody has
 * been set up to receive it" permanently and no screen could change it — a
 * gate that can never open. This is the door. It appears only for that block:
 * a processor LakeLife has not connected, an application still sitting with
 * them, and a closed account are all ours, and a button that could not move
 * them would be the dead control this card exists to remove.
 */
describe("asking to be set up", () => {
  it("offers the button when that is what is blocking", () => {
    const html = words(render({
      canAskForSetup: true,
      rentBlockSaid: "Before this park can take rent online, you need to be set up to receive it.",
    }));
    expect(html).toMatch(/Set me up to receive rent/);
  });

  it("and never when the block is ours to clear", () => {
    const html = words(render({
      canAskForSetup: false,
      rentBlockSaid: "No payment processor is connected to LakeLife yet.",
    }));
    expect(html).not.toMatch(/Set me up to receive rent/);
  });

  it("nor once the park can already be paid", () => {
    const html = words(render({ rentReady: true, rentBlockSaid: "", canAskForSetup: true }));
    expect(html).not.toMatch(/Set me up to receive rent/);
  });

  it("nor when the switch is off, because nothing is blocked yet", () => {
    const html = words(render({ initialAccepting: false, canAskForSetup: true }));
    expect(html).not.toMatch(/Set me up to receive rent/);
  });
});
