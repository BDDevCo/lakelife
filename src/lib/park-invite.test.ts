import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  mintInviteToken, inviteTokenHash, inviteUrl, inviteCopy,
  inviteClaimSays, inviteIssueSays, inviteWorked, officeCanReissue,
  INVITE_TOKEN_RE, firstNameFrom,
} from "./park-invite";

describe("the token", () => {
  it("is 64 hex characters and never repeats", () => {
    const a = mintInviteToken();
    const b = mintInviteToken();
    expect(a).toMatch(INVITE_TOKEN_RE);
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it("hashes the same way every time, which is the whole point", () => {
    // Bcrypt salts per row and so cannot be looked up. A link has to be FOUND
    // by its token; that is why this is SHA-256 (see 0132).
    const t = mintInviteToken();
    expect(inviteTokenHash(t)).toBe(inviteTokenHash(t));
    expect(inviteTokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(inviteTokenHash(t)).not.toBe(t);      // the plaintext never lands in a column
  });

  it("matches the shape the database will accept", () => {
    // The SQL guards with '^[0-9a-f]{64}$'. If these two ever disagree, every
    // invite mints fine and every link is refused.
    const sqlShape = /^[0-9a-f]{64}$/;
    expect(sqlShape.test(inviteTokenHash(mintInviteToken()))).toBe(true);
    expect(sqlShape.test(mintInviteToken())).toBe(true);
  });

  it("builds a link without doubling the slash", () => {
    const t = "a".repeat(64);
    expect(inviteUrl("https://lakelife.ai/", t)).toBe(`https://lakelife.ai/parks/welcome?t=${t}`);
    expect(inviteUrl("http://localhost:3000", t)).toBe(`http://localhost:3000/parks/welcome?t=${t}`);
  });
});

describe("the message", () => {
  const copy = inviteCopy({
    parkName: "Cedar Bend",
    lotNumber: "14",
    displayName: "Reyes, Donna",
    url: "https://lakelife.ai/parks/welcome?t=" + "a".repeat(64),
  });

  it("names the park in the subject, because that is the only familiar word", () => {
    expect(copy.subject).toContain("Cedar Bend");
  });

  it("greets her by her GIVEN name when the roll writes 'Surname, First'", () => {
    // The first draft took the text before the comma and greeted her as
    // "Reyes". Being surnamed by a company you've never heard of, in an
    // unexpected email about your home, reads as a mail merge or a scam.
    expect(copy.text).toContain("Hello Donna,");
    expect(copy.html).toContain("Hello Donna,");
    expect(copy.text).not.toContain("Hello Reyes");
  });

  it("handles a plain 'First Last' too", () => {
    const c = inviteCopy({ parkName: "P", lotNumber: "1", displayName: "Earl Whitcomb", url: "https://x/y" });
    expect(c.text).toContain("Hello Earl,");
  });

  it("says just 'Hello,' rather than a wrong name", () => {
    // A household label is not a person. Better an unaddressed greeting than
    // "Hello Lot" or "Hello The".
    for (const label of ["Lot 14 household", "The Reyes Family", "", "  ", "Unit 3", "A & B Nowak"]) {
      const c = inviteCopy({ parkName: "P", lotNumber: "1", displayName: label, url: "https://x/y" });
      expect(c.text.startsWith("Hello,")).toBe(true);
    }
  });

  it("promises plainly that nothing about paying changes", () => {
    for (const body of [copy.text, copy.html]) {
      expect(body).toMatch(/Nothing about how you pay is changing/);
      expect(body).toMatch(/cheque or in cash/);
    }
  });

  it("gives her a way to do nothing, and says nobody will chase her", () => {
    // A quarter to a third of a park never converts, and that is a settled
    // outcome rather than a failure to follow up.
    for (const body of [copy.text, copy.html]) {
      expect(body).toMatch(/ignore this/);
      expect(body).toMatch(/nobody will chase you/);
    }
  });

  it("CARRIES NO CODE — the slip's promise depends on it", () => {
    // The printed slip says "we will never ring or text you asking for this
    // code". That stays true only if a code never travels in a message. A link
    // cannot be read aloud to somebody pretending to be the office.
    for (const body of [copy.text, copy.html]) {
      expect(body).not.toMatch(/[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}/);
      expect(body).not.toMatch(/\bcode\b(?!\s*or\s*a\s*password)/i);
    }
  });

  it("says what we will never ask for", () => {
    for (const body of [copy.text, copy.html]) {
      expect(body).toMatch(/never ask you for card or bank details/);
    }
  });

  it("escapes a park name with markup in it", () => {
    const nasty = inviteCopy({
      parkName: 'Cedar <script>alert(1)</script> Bend',
      lotNumber: "1", displayName: "X", url: "https://x/y",
    });
    expect(nasty.html).not.toContain("<script>");
    expect(nasty.html).toContain("&lt;script&gt;");
  });
});

describe("what each outcome tells the reader", () => {
  it("tells her which account to use when she's signed in as the wrong one", () => {
    // The most likely real failure, and the one she can actually fix.
    const said = inviteClaimSays("invite_wrong_account");
    expect(said).toMatch(/different email/i);
    expect(said).toMatch(/sign out/i);
  });

  it("never leaves her without a next step", () => {
    const outcomes = [
      "claim_not_signed_in", "invite_bad_token", "invite_unknown", "invite_expired",
      "invite_wrong_account", "claim_already_set_up", "claim_member_may_not_claim",
      "claim_already_here", "claim_no_open_lot", "claim_file_merged", "something_new",
    ];
    for (const o of outcomes) {
      const said = inviteClaimSays(o);
      expect(said.length).toBeGreaterThan(20);
      // No raw reason codes leaking onto a resident's screen.
      expect(said).not.toMatch(/_/);
    }
  });

  it("knows which failures the office can fix by sending another", () => {
    expect(officeCanReissue("invite_expired")).toBe(true);
    expect(officeCanReissue("invite_unknown")).toBe(true);
    // Not these: another invite changes nothing.
    expect(officeCanReissue("invite_wrong_account")).toBe(false);
    expect(officeCanReissue("claim_already_set_up")).toBe(false);
  });

  it("reads an office refusal as a fact, not a fault", () => {
    expect(inviteIssueSays("invite_declined")).toMatch(/said no thanks/);
    expect(inviteIssueSays("invite_too_soon")).toMatch(/until tomorrow/);
    expect(inviteWorked("invited")).toBe(true);
    expect(inviteWorked("invite_too_soon")).toBe(false);
  });
});

describe("the send path", () => {
  const source = () => {
    const raw = readFileSync(
      new URL("../app/parks/invite-actions.ts", import.meta.url), "utf8");
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("finds the file it is scanning", () => {
    expect(source()).toMatch(/export async function inviteHousehold/);
    expect(source()).toMatch(/export async function inviteEveryone/);
  });

  it("AWAITS the send, so a refusal cannot be reported as sent", () => {
    // The crew invites shipped with `void sendEmail(...)`, which turned every
    // refused send into "50 invited" — including the ones the recipient gate
    // had deliberately stopped.
    const s = source();
    expect(s).not.toMatch(/void\s+sendEmail/);
    expect(s).toMatch(/const\s+sent\s*=\s*await\s+sendEmail/);
    // The guard now also weighs the text: an invite only unwinds when NOTHING
    // reached her, so a bounced email can't kill a link already on her phone.
    expect(s).toMatch(/if\s*\(!sent\.ok && !textQueued\)/);
  });

  it("never tells the office a resident was TEXTED", () => {
    // 81 sent since July, 0 delivered. Twilio accepting a message is not the
    // carrier delivering it, and the office must not print slips on the
    // strength of a text nobody received.
    const s = source();
    expect(s).not.toMatch(/Emailed and texted/);
    expect(s).toMatch(/A text was sent too/);
  });

  it("mints in the database BEFORE sending", () => {
    // Sending first and recording after is how somebody gets two emails and a
    // token that opens nothing.
    const s = source();
    expect(s.indexOf("issue_park_invite")).toBeLessThan(s.indexOf("await sendEmail"));
  });

  it("uses the user-scoped client for both RPCs, never the service role", () => {
    // Both functions read auth.uid(); the claim also reads auth.email(). The
    // service role carries no session and would refuse every time.
    const s = source();
    expect(s).toMatch(/supabase\.rpc\("issue_park_invite"/);
    expect(s).toMatch(/supabase\.rpc\("claim_park_file_by_invite"/);
    expect(s).not.toMatch(/admin\.rpc\("issue_park_invite"/);
    expect(s).not.toMatch(/admin\.rpc\("claim_park_file_by_invite"/);
  });

  it("skips anyone already invited, so the button is not a second send", () => {
    // No /s flag — the tsconfig target predates it, and a dotAll here would
    // compile locally and fail the typecheck in CI.
    const s = source();
    expect(s).toMatch(/if \(r\.invite_sent_at != null\) \{ skipped\+\+; continue; \}/);
  });
});

describe("the name we dare use", () => {
  it("reads both orderings", () => {
    expect(firstNameFrom("Reyes, Donna")).toBe("Donna");
    expect(firstNameFrom("Donna Reyes")).toBe("Donna");
    expect(firstNameFrom("Nowak, Teresa Ann")).toBe("Teresa");
  });

  it("keeps the punctuation real names have", () => {
    expect(firstNameFrom("O'Brien, Siobhan")).toBe("Siobhan");
    expect(firstNameFrom("Jean-Luc Picard")).toBe("Jean-Luc");
    expect(firstNameFrom("Renée Dubois")).toBe("Renée");
  });

  it("refuses anything that is a home rather than a person", () => {
    for (const label of ["Lot 14 household", "The Reyes Family", "Unit 3",
                         "A & B Nowak", "", "   ", "X", "Estate of J Smith"]) {
      expect(firstNameFrom(label)).toBeNull();
    }
  });
});
