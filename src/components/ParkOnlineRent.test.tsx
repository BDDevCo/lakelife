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
      processorLive={false}
      {...over}
    />,
  );

/** The markup with tags removed, so a claim split across elements still reads. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the switch is on and there is no processor — The Haven today", () => {
  it("does not claim residents can pay in the app", () => {
    expect(words(render())).not.toMatch(/Residents can pay rent in the app/);
  });

  it("says plainly that no processor is connected", () => {
    expect(words(render())).toMatch(/no card processor connected/i);
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

  it("says his switch is kept, not overridden", () => {
    // He set it deliberately. "We turned it off for you" would be a lie and
    // would send him back to flip a switch that is already where he wants it.
    expect(words(render())).toMatch(/switch\s+is on/i);
  });
});

describe("the switch is on and a processor exists", () => {
  it("makes the promise, because now it is true", () => {
    const html = words(render({ processorLive: true }));
    expect(html).toMatch(/Residents can pay rent in the app/);
    expect(html).toMatch(/20 of 20 households have claimed an account/);
    expect(html).not.toMatch(/no card processor connected/i);
  });
});

describe("the switch is off", () => {
  it("keeps saying the refusal is server-side, whatever the processor is doing", () => {
    for (const processorLive of [true, false]) {
      const html = words(render({ initialAccepting: false, processorLive }));
      expect(html, `processorLive=${processorLive}`)
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

  it("gates the pay button on a live processor, not on the dial alone", () => {
    // The ASSIGNMENT, not the interface field of the same name a hundred lines
    // above it — the first draft of this scan matched `acceptsOnlineRent:
    // boolean;` and would have passed against a type declaration forever.
    const line = src.match(/acceptsOnlineRent:\s*Boolean\([^\n]*/)?.[0] ?? "";
    expect(line, "the acceptsOnlineRent assignment is gone — this scan is measuring nothing")
      .not.toBe("");
    expect(line, "the dial alone decides whether she is offered a card")
      .toMatch(/paymentsAreLive\(\)/);
  });

  it("imports the gate it claims to use", () => {
    expect(src).toMatch(/import \{ paymentsAreLive \} from "@\/lib\/charge-gate"/);
  });
});
