import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { err: () => {} }) }));

const { VerifyPanel } = await import("@/components/VerifyPanel");

/**
 * A WALL WITH NO WAY PAST IT.
 *
 * Signing up landed on /verify with three controls — text me a code, resend,
 * wrong number — and no fourth. An account could not be created without
 * accepting a text, on a channel where 0 of 81 messages have ever been
 * delivered.
 *
 * A2P 10DLC rejected the campaign for exactly this on 4 October 2026: "treats
 * consent as a required condition to complete a transaction or create an
 * account... Consumers must be provided an explicit skip option." So this is a
 * carrier requirement, and it was also the January blocker: a Haven resident
 * books nothing and only ever pays rent, and could not get in at all.
 */
describe("the verification screen", () => {
  const words = () =>
    renderToStaticMarkup(<VerifyPanel />).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

  it("offers a way past without accepting a text", () => {
    expect(words()).toMatch(/Skip for now/i);
  });

  it("says texts are optional, in words", () => {
    expect(words()).toMatch(/Texts are optional/i);
  });

  it("still asks for the code, so the happy path is unchanged", () => {
    expect(words()).toMatch(/Text me a code/i);
  });

  it("names where a number IS required, rather than implying nowhere is", () => {
    // CLAUDE.md asks for a verified mobile before first booking, and /book
    // enforces it. The skip must not read as "we never need this".
    expect(words()).toMatch(/before you book/i);
  });
});
