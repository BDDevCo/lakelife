import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * "WE'VE EMAILED YOU THIS TOO." — BEFORE ANY EMAIL WAS ATTEMPTED.
 *
 * The recap rendered that sentence the instant the profile saved. The send
 * was dispatched a line later as `sendWelcomeEmail().catch(() => {})`: its
 * {ok:false, error} return was never read and a rejection was swallowed. So
 * with Resend unconfigured, a Resend fault, the park holding notices, or a
 * recipient we may not write to, the screen still said "emailed". Every one of
 * those is a live branch of sendEmail today, not a hypothetical.
 *
 * The rule: a sentence in the past tense is earned by the thing having
 * happened. The recap now paints at once with the line PENDING (the Done
 * screen never waits on email), then settles to "We've emailed you this too"
 * on ok:true only, and otherwise to a line the person can act on — which is
 * to say, one that tells them nothing is lost.
 *
 * Three doors, each proven on its own and then wired together by a scan of
 * the real file: the pure settle (what the send returned → a status), the
 * pure line (a status → one sentence), and the caller (the wizard passes the
 * settled status into Recap, and Recap prints the line).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/profile/actions", () => ({ saveProfile: async () => ({ ok: true }) }));
vi.mock("@/app/profile/email-actions", () => ({ sendWelcomeEmail: async () => ({ ok: true }) }));
vi.mock("@/components/AddressAutocomplete", () => ({ AddressAutocomplete: () => null }));

// Imported inside each test on purpose: before the fix none of these symbols
// existed, and a top-level import would have turned every case below into
// one "module has no export" — the scan of the old `.catch(() => {})` shape
// is a red of its own and deserves to be seen as one.
const wizard = () => import("./ProfileWizard");

const SENT = "We&#x27;ve emailed you this too.";
const FAILED = "We couldn&#x27;t send the email copy";

const draft = {
  lake: "Big Long", newLakeName: "", address: "12 Shore Rd", lat: null, lng: null, place_id: null,
  park_id: null, wanted: ["Housekeeping"], sqft: 2400, gate: "", beds: 3, baths: 2,
  pier_sections: 8, ladder: true, bumpers: true, boat_lifts: 1, canopy: true, jet_skis: 0,
  pwc_lifts: 0, lawn_band: "medium" as const, panes: 0, drive_band: null, boats: [], toys: [],
};

const drawRecap = async (emailCopy: "sending" | "sent" | "failed") => {
  const { Recap } = await wizard();
  return renderToStaticMarkup(
    <Recap draft={draft as Parameters<typeof Recap>[0]["draft"]} priceOf={() => 180} emailCopy={emailCopy} onGo={() => {}} />,
  );
};

// ------------------------------------------------- 1. what the send returned

describe("the status follows what the send actually returned", () => {
  it("is sent only on ok:true", async () => {
    const { settleEmailCopy } = await wizard();
    expect(await settleEmailCopy(async () => ({ ok: true }))).toBe("sent");
  });

  it("is failed on ok:false — Resend down, notices held, an unsendable recipient", async () => {
    const { settleEmailCopy } = await wizard();
    expect(await settleEmailCopy(async () => ({ ok: false, error: "Resend 500" }))).toBe("failed");
  });

  it("is failed when Resend was never configured — nothing was attempted, so nothing was sent", async () => {
    const { settleEmailCopy } = await wizard();
    expect(await settleEmailCopy(async () => ({ ok: false, skipped: true }))).toBe("failed");
  });

  it("is failed when the action throws — the case the old .catch(() => {}) hid", async () => {
    const { settleEmailCopy } = await wizard();
    // getFullProfile can throw right after the save; a rejected server action
    // must land on the honest line, not on an unhandled promise.
    expect(await settleEmailCopy(async () => { throw new Error("profile read failed"); })).toBe("failed");
  });
});

// ------------------------------------------------------ 2. the one sentence

describe("the recap's email sentence is true of the state it renders in", () => {
  it("does not say 'emailed' while the send is still in flight", async () => {
    const html = await drawRecap("sending");
    expect(html, "the past tense is back on the pending screen").not.toContain(SENT);
    expect(html).not.toContain(FAILED);
    // Still says something — a blank where the sentence was reads as a bug.
    expect(html).toContain("emailing you a copy");
  });

  it("says 'emailed' only once the send came back ok", async () => {
    const html = await drawRecap("sent");
    expect(html).toContain(SENT);
    expect(html).not.toContain(FAILED);
  });

  it("says the copy did not go out, and that nothing is lost, when it failed", async () => {
    const html = await drawRecap("failed");
    expect(html, "a failed send still claims the email went").not.toContain(SENT);
    expect(html).toContain(FAILED);
    // The part the person can act on: the profile IS saved (the recap only
    // exists after saveProfile returned ok) and /profile shows it again.
    expect(html).toContain("everything below is saved");
    expect(html).toContain("come back to it any time");
  });

  it("keeps the rest of the recap in every state — the prices are the point of the screen", async () => {
    for (const s of ["sending", "sent", "failed"] as const) {
      const html = await drawRecap(s);
      expect(html).toContain("Housekeeping");
      expect(html).toContain("$180");
      expect(html).toContain("Book my services");
    }
  });

  it("the sentence Recap prints is emailCopyLine's, not a copy of it", async () => {
    const { emailCopyLine } = await wizard();
    expect(emailCopyLine("sent")).toBe("We've emailed you this too.");
    expect(emailCopyLine("failed")).toMatch(/^We couldn't send the email copy/);
    expect(emailCopyLine("sending")).not.toMatch(/emailed/);
  });
});

// ------------------------------------------------ 3. the wiring in the file

describe("the wizard wires the settled status into the recap", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  const src = strip(readFileSync(fileURLToPath(new URL("./ProfileWizard.tsx", import.meta.url)), "utf8"));

  it("the scanner is reading the real wizard", () => {
    expect(src).toContain("sendWelcomeEmail");
    expect(src).toMatch(/function Recap\(/);
    expect(src).toMatch(/setDone\(true\)/);
  });

  it("no longer fires the send and forgets it", () => {
    expect(src, "the send is dispatched and its result thrown away again")
      .not.toMatch(/sendWelcomeEmail\(\)\s*\.catch\(/);
  });

  it("settles the send AFTER the done screen is queued, and holds the result in state", () => {
    // Order matters: setDone first, so the recap paints while the email is
    // still out — then the settled status lands in state and re-renders it.
    const m = src.match(/setDone\(true\);\s*setEmailCopy\(await settleEmailCopy\(sendWelcomeEmail\)\)/);
    expect(m, "the settled status is not stored, or the done screen waits on the email").not.toBeNull();
  });

  it("hands that state to Recap, and Recap prints the line from it", () => {
    expect(src).toMatch(/<Recap[^>]*emailCopy=\{emailCopy\}/);
    expect(src).toMatch(/\{emailCopyLine\(emailCopy\)\}/);
  });

  it("no past-tense literal survives outside emailCopyLine", () => {
    // Widen the guard: if the sentence is ever pasted back into the JSX as a
    // literal, it is unconditional again. It may live in exactly one place,
    // and that place is the function that is gated on the status.
    const fn = src.match(/export function emailCopyLine\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "emailCopyLine is gone, so nothing gates the sentence").not.toBe("");
    expect(fn).toMatch(/We've emailed you this too/);
    const elsewhere = src.replace(fn, "");
    expect(elsewhere, "the past-tense sentence is written somewhere unconditional")
      .not.toMatch(/We(&apos;|')ve emailed you this too/);
  });
});
