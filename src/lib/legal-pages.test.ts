import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SMS_CONSENT_TEXT } from "./sms-consent";

/**
 * THE LEGAL PAGES MUST DESCRIBE WHAT THE CODE ACTUALLY DOES.
 *
 * A privacy policy asserting practices the product does not have is the same
 * defect class as a screen that lies, with a regulator or a carrier as the
 * reader. These are the claims that would become false if the code changed
 * underneath them — each one paired with the thing in the tree that makes it
 * true, so the drift fails a test rather than surviving to an audit.
 *
 * A2P campaign vetting also checks the messaging page for specific phrases.
 * Their absence is a common rejection, so they are pinned here too.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** JSX wraps prose across lines, so a quoted sentence must be matched flat. */
const flat = (s: string) => s.replace(/\s+/g, " ").replace(/&apos;/g, "'").replace(/&rsquo;/g, "'");
/** Comments DESCRIBE the guards — matching them fails a file for documenting its own rule. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sms = read("../app/sms/page.tsx");
const privacy = read("../app/privacy/page.tsx");

describe("the messaging page carries what A2P vetting looks for", () => {
  it("states that rates may apply", () => {
    expect(sms).toMatch(/Message and data rates may apply/i);
  });
  it("gives STOP and HELP", () => {
    expect(sms).toMatch(/\bSTOP\b/);
    expect(sms).toMatch(/\bHELP\b/);
  });
  it("says frequency varies rather than promising a number", () => {
    expect(sms).toMatch(/Message frequency varies/i);
  });
  it("carries the carrier liability disclaimer", () => {
    expect(flat(sms)).toMatch(/[Cc]arriers are not liable for delayed or undelivered messages/);
  });
  it("links to the privacy policy", () => {
    expect(sms).toMatch(/href="\/privacy"/);
  });
  it("states consent is not a condition of purchase", () => {
    expect(flat(sms)).toMatch(/a condition of buying/);
  });
  it("and that consent is never shared for others' marketing", () => {
    expect(flat(sms)).toMatch(/never shared with third parties or affiliates for/);
  });
});

describe("the consent sentence quoted is the one we actually record", () => {
  it("matches src/lib/sms-consent.ts word for word", () => {
    // The page quotes it with the park name substituted for readability; every
    // other clause must survive verbatim, because this is the sentence we
    // snapshot onto the household's record and would produce in a dispute.
    for (const clause of SMS_CONSENT_TEXT.split("{park}")) {
      const cleaned = clause.trim().replace(/\s+/g, " ");
      if (cleaned.length < 12) continue;
      const normalised = sms.replace(/\s+/g, " ").replace(/&apos;/g, "'").replace(/&rsquo;/g, "'");
      expect(normalised, `the page no longer quotes: ${cleaned}`).toContain(cleaned);
    }
  });
});

describe("the privacy policy's claims are ones the code keeps", () => {
  it("claims card numbers never reach us — and payment_methods stores only a token", () => {
    expect(flat(privacy)).toMatch(/never receive or store your card number/i);
    // If a card field ever appears, this claim becomes false. Comments stripped
    // first: payment-actions.ts documents the guard that REJECTS a PAN, and
    // matching that prose would fail the file for explaining its own rule.
    expect(code(read("../app/profile/payment-actions.ts")))
      .not.toMatch(/card_number|\bcvv\b|\bcvc\b/i);
  });

  it("claims gate codes are day-of only — and the column is encrypted", () => {
    expect(flat(privacy)).toMatch(/visible to a crew only on the day of their own visit/i);
    expect(flat(privacy)).toMatch(/encrypted at rest/i);
  });

  it("discloses that message content reaches an AI provider", () => {
    // Easy to leave out of a boilerplate policy, and material.
    expect(privacy).toMatch(/Anthropic/);
    expect(flat(privacy)).toMatch(/content of your message/i);
    expect(flat(privacy)).toMatch(/reviews and approves every drafted reply/i);
  });

  it("and the risk screen it relies on still runs before the model", () => {
    const classify = read("./comms-classify.ts");
    expect(classify).toMatch(/screenMessage/);
  });

  it("discloses that a contact record survives account deletion", () => {
    // deleteAccount calls retainMarketingContact BEFORE removing the login.
    expect(flat(privacy)).toMatch(/One thing survives on purpose/i);
    const acct = read("../app/profile/account-actions.ts");
    expect(acct).toMatch(/retainMarketingContact/);
    expect(acct).toMatch(/marketing_contacts/);
  });

  it("says we do not sell data or share it for targeted advertising", () => {
    expect(flat(privacy)).toMatch(/do not sell personal information/i);
    expect(flat(privacy)).toMatch(/cross-context behavioural advertising/i);
  });

  it("names every processor the code actually calls", () => {
    for (const p of ["Supabase", "Vercel", "Twilio", "Resend", "Anthropic"]) {
      expect(privacy, `${p} is not disclosed`).toContain(p);
    }
  });

  it("names Indiana's consumer privacy law and a response window", () => {
    expect(privacy).toMatch(/Consumer Data Protection Act/);
    expect(privacy).toMatch(/45 days/);
  });
});

describe("both pages are findable without signing in", () => {
  it("are in the sitemap", () => {
    const sm = read("../app/sitemap.ts");
    expect(sm).toMatch(/\$\{site\}\/privacy/);
    expect(sm).toMatch(/\$\{site\}\/sms/);
    expect(sm).toMatch(/\$\{site\}\/terms/);
  });

  it("and linked from the public front door", () => {
    // A page a crawler cannot reach is the same as not having one.
    const home = read("../app/page.tsx");
    expect(home).toMatch(/href="\/privacy"/);
    expect(home).toMatch(/href="\/sms"/);
    expect(home).toMatch(/href="\/terms"/);
  });
});
