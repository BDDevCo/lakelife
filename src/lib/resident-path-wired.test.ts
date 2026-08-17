import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE THREE SCREENS A RESIDENT ACTUALLY TOUCHES, CHECKED AT THE SOURCE.
 *
 * Every claim below was a real defect found by opening these pages at 375px
 * rather than by reading them, so each test names the failure it prevents
 * rather than the code it matches.
 */

// The repo path contains a space, so URL.pathname hands back "%20" and readFileSync
// looks for a directory that does not exist. fileURLToPath is the one that decodes.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the source files this test scans exist", () => {
  it("finds all five", () => {
    expect(read("../components/TextOptIn.tsx")).toMatch(/export function TextOptIn/);
    expect(read("../components/AuthModal.tsx")).toMatch(/export function AuthModal/);
    expect(read("../components/SignInHere.tsx")).toMatch(/export function SignInHere/);
    expect(read("../components/FollowInvite.tsx")).toMatch(/export function FollowInvite/);
    expect(read("../app/parks/claim/page.tsx")).toMatch(/ClaimMyLot/);
  });
});

describe("the consent tick", () => {
  const s = () => read("../components/TextOptIn.tsx");

  it("EXISTS, because the A2P filing says it does", () => {
    // docs/a2p-registration.md tells The Campaign Registry that "residents
    // additionally tick an explicit consent line". For a while that sentence
    // was false: the disclosure was 12.5px grey text and the affirmative act
    // was a button labelled "Send me a code".
    expect(s()).toMatch(/type="checkbox"/);
    expect(s()).toMatch(/checked=\{agreed\}/);
  });

  it("starts UNTICKED — a pre-ticked box asserts a fact nobody stated", () => {
    expect(s()).toMatch(/useState\(false\)/);
    expect(s()).not.toMatch(/agreed.*useState\(true\)/);
  });

  it("gates the send, so the tick is not decoration", () => {
    expect(s()).toMatch(/disabled=\{busy \|\| !phone\.trim\(\) \|\| !agreed\}/);
  });

  it("shows the SAME sentence it records", () => {
    // One constant, rendered and written. A paraphrase in either place is how
    // a consent record ends up describing something nobody was shown.
    expect(s()).toMatch(/smsConsentText\(parkName\)/);
    expect(read("../app/parks/consent-actions.ts")).toMatch(/sms_consent_text: smsConsentText\(/);
  });
});

describe("signing in keeps her place", () => {
  it("AuthModal validates its destination instead of trusting it", () => {
    // `next` reaches an OAuth redirectTo. Unvalidated, that is an open
    // redirect with LakeLife's sign-in wrapped around it.
    const s = read("../components/AuthModal.tsx");
    expect(s).toMatch(/import \{ safeNext \}/);
    expect(s).toMatch(/const dest = safeNext\(next\)/);
    // and the raw prop never reaches a navigation
    expect(s).not.toMatch(/router\.push\(next\)/);
    expect(s).not.toMatch(/redirectTo: `\$\{siteUrl\(\)\}\/auth\/callback\?next=\$\{next\}`/);
  });

  it("uses the destination on every way out of the modal", () => {
    const s = read("../components/AuthModal.tsx");
    expect(s).toMatch(/router\.push\(dest \?\? "\/portal"\)/);         // password sign-in
    expect(s).toMatch(/dest \?\? \(mode === "signup" \? "\/verify" : "\/portal"\)/); // SSO
    expect(s).toMatch(/dest \? `\/verify\?next=/);                     // new account
  });

  it("survives the mobile-verify step a new account has to pass", () => {
    // Otherwise a resident who CREATES an account from her invite link
    // verifies her phone and lands in the lake-services welcome wizard, with
    // the link she arrived on nowhere on screen.
    const s = read("../components/VerifyPanel.tsx");
    expect(s).toMatch(/safeNext\(next\) \?\? "\/welcome"/);
    expect(read("../app/verify/page.tsx")).toMatch(/next=\{next\}/);
  });

  it("the two resident screens sign in IN PLACE, not via the front page", () => {
    // Both linked to "/" and the sign-in ended at /portal — a services portal
    // that has nothing to do with the slip in her hand.
    for (const p of ["../app/parks/claim/page.tsx", "../app/parks/welcome/page.tsx"]) {
      const s = read(p);
      expect(s, p).toMatch(/<SignInHere next=\{selfUrl\}/);
      expect(s, p).not.toMatch(/className="ll-btn" href="\/"/);
    }
  });

  it("builds the return address from validated params, never a request header", () => {
    // A header a proxy can set must not decide where a sign-in lands.
    expect(read("../app/parks/claim/page.tsx")).toMatch(/const selfUrl = `\/parks\/claim/);
    expect(read("../app/parks/welcome/page.tsx")).toMatch(/const selfUrl = `\/parks\/welcome\?t=\$\{encodeURIComponent\(token\)\}`/);
    for (const p of ["../app/parks/claim/page.tsx", "../app/parks/welcome/page.tsx"]) {
      expect(read(p), p).not.toMatch(/headers\(\)/);
    }
  });
});

describe("the wrong-account dead end", () => {
  it("offers the button its own sentence promises", () => {
    // The message said "sign out and sign in with that address" and gave her
    // nothing to press. The only sign-out was the top bar's, which navigates
    // to "/" and throws the invite link away.
    const s = read("../components/FollowInvite.tsx");
    expect(s).toMatch(/said\.outcome === "invite_wrong_account"/);
    expect(s).toMatch(/<SwitchAccount next=\{selfUrl\}/);
  });

  it("comes back to the same link rather than the front page", () => {
    const s = read("../components/SignInHere.tsx");
    expect(s).toMatch(/auth\.signOut\(\)/);
    expect(s).toMatch(/window\.location\.href = next/);
    expect(s).not.toMatch(/router\.push\("\/"\)/);
  });

  it("still reports the outcome the button keys on", () => {
    // A silent rename of the reason code would hide the button forever, and
    // nothing else on screen would change — the message would still read
    // "sign out and sign in with that address" with nothing to press.
    const s = read("../app/parks/invite-actions.ts");
    expect(s).toMatch(/return \{ ok, outcome, message: inviteClaimSays\(outcome\)/);
    // and the copy layer still has a sentence for that exact code
    expect(read("./park-invite.ts")).toMatch(/invite_wrong_account/);
  });
});

describe("the keyboard the lot-number field asks for", () => {
  it("is a keypad only when the park's lots are ALL numbers", () => {
    // inputMode="numeric" is an iOS keypad with no letters on it. Every lot
    // today is a plain number, so this never bit — and the first park with a
    // lot "12A" would hand its residents a keyboard that cannot type their
    // own address.
    const s = read("../components/ClaimMyLot.tsx");
    expect(s).toMatch(/inputMode=\{lotsAreNumeric \? "numeric" : "text"\}/);
  });

  it("fails to the KEYBOARD, not the keypad", () => {
    // A keyboard can type digits; a keypad cannot type letters. The default
    // has to be the one whose failure mode is mild.
    expect(read("../components/ClaimMyLot.tsx")).toMatch(/lotsAreNumeric = false/);
  });

  it("is answered from the park's own lots", () => {
    const s = read("../app/parks/claim/page.tsx");
    expect(s).toMatch(/from\("park_lots"\)/);
    expect(s).toMatch(/every\(\(l\) => \/\^\\d\+\$\/\.test/);
  });
});

describe("the top bar fits a phone", () => {
  it("styles the pills in CSS, where a media query can reach them", () => {
    // They were five React.CSSProperties objects. At 375px the signed-out
    // pair ran a pixel past the right edge of the screen and the signed-in
    // pair wrapped to three lines inside a 64px bar, and no stylesheet could
    // say otherwise.
    const s = read("../components/TopBarAuth.tsx");
    expect(s).toMatch(/className="ll-navbtn signin"/);
    expect(s).toMatch(/className="ll-navbtn join"/);
    expect(s).toMatch(/className="ll-navbtn portal"/);
    expect(s).toMatch(/className="ll-navbtn ghost"/);
    expect(s).not.toMatch(/style=\{signInBtn\}|style=\{joinBtn\}|style=\{linkBtn\}|style=\{ghostBtn\}/);
  });

  it("has the mobile rules those classes exist for", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.ll-navbtn\b/);
    // nowrap on ALL of them: the signed-in pair lacked it, which is why it
    // wrapped while its sibling overflowed.
    // No /s flag — the tsconfig target predates dotAll, and one here compiles
    // locally and fails the typecheck in CI. `[^}]*` already crosses newlines.
    expect(css).toMatch(/\.ll-navbtn \{[^}]*white-space: nowrap/);
    const mobile = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(mobile).toMatch(/\.ll-topbar \{\s*padding: 0 16px/);
    expect(mobile).toMatch(/\.ll-navbtn \{/);
  });
});
