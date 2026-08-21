import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TermsBody } from "./TermsBody";
import {
  TERMS_SECTIONS,
  termsPlainText,
  runText,
} from "@/lib/terms-content";
import { textFingerprint } from "@/lib/acceptances";
import { TOS_VERSION } from "@/lib/tos";

/**
 * THE WORDS ON SCREEN ARE THE WORDS IN THE RECORD.
 *
 * The acceptance ledger snapshots `termsPlainText()`. The person taps a button
 * under `<TermsBody />`. That is only one source if the component actually
 * renders every word the ledger stores — and the first version of this suite
 * never rendered anything: it compared `termsPlainText()` back against
 * `TERMS_SECTIONS`, which is where it is built from, so it could only have
 * failed if the join itself dropped a run.
 *
 * This renders the component and checks the two against each other.
 */

const html = () => renderToStaticMarkup(<TermsBody />);

/** Rendered markup as a person reads it: tags gone, entities decoded. */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

describe("TermsBody renders every word the ledger will store", () => {
  it("renders something at all", () => {
    expect(html().length).toBeGreaterThan(200);
  });

  it("every run of every section appears on screen, verbatim", () => {
    const screen = visibleText(html());
    for (const section of TERMS_SECTIONS) {
      expect(screen).toContain(section.heading);
      for (const run of section.body) {
        expect(screen).toContain(runText(run));
      }
    }
  });

  it("the screen carries nothing the record does not", () => {
    // The other direction, which is the one that matters for a dispute: no
    // sentence may appear above the button without also being in the ledger.
    const screen = visibleText(html());
    const record = termsPlainText();
    // Compare on words rather than whitespace — the component adds layout.
    const words = (s: string) => s.replace(/\s+/g, " ").trim();
    for (const section of TERMS_SECTIONS) {
      const sentence = words(section.body.map(runText).join(""));
      expect(words(screen)).toContain(sentence);
      expect(words(record)).toContain(sentence);
    }
  });

  it("emphasis is presentation only — the words survive losing it", () => {
    const markup = html();
    expect(markup).toContain("<b>");
    const bolded = [...markup.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(bolded.length).toBeGreaterThan(0);
    for (const b of bolded) {
      // Bold on screen, plain in the record, same words in both.
      expect(termsPlainText()).toContain(b);
    }
  });
});

describe("the guard that keeps the words and the version in step", () => {
  /**
   * THE GUARD `terms-content.ts` PROMISES, WHICH DID NOT EXIST.
   *
   * That file told the next editor — in the one place every word of the
   * agreement lives, and directly beneath the instruction to replace the body
   * with the attorney's full text — that a test named `termsVersionGuard`
   * would catch a word change unaccompanied by a TOS_VERSION bump. Nothing of
   * the kind existed. The gate is `latest.version === TOS_VERSION`, so a
   * changed sentence shipped without a bump would leave every existing
   * acceptance in force against words nobody had seen, and would file new
   * acceptances of DIFFERENT text under the SAME version string.
   *
   * Here it is. If you are reading this because CI failed: you changed the
   * terms. Bump TOS_VERSION in `src/lib/tos.ts` and paste the digest the
   * failure prints into TERMS_DIGEST below — both, in this commit.
   */
  const TERMS_DIGEST =
    "6c536ec99fe7d02d16108038123e4c8d09f014d4c503b1ef79bf9e15f525c7f2";
  const DIGEST_IS_FOR_VERSION = "tos-v0-beta";

  it("termsVersionGuard: the words have not changed without the version", () => {
    expect(textFingerprint(termsPlainText())).toBe(TERMS_DIGEST);
  });

  it("and the pinned digest belongs to the version now shipping", () => {
    expect(TOS_VERSION).toBe(DIGEST_IS_FOR_VERSION);
  });

  it("the digest really is of the terms, not of an empty string", () => {
    // Guards the guard: a termsPlainText() that returned "" would otherwise
    // just need its constant updated once and would then never fail again.
    expect(termsPlainText().length).toBeGreaterThan(500);
    expect(textFingerprint("")).not.toBe(TERMS_DIGEST);
  });

  it("would notice a single changed word", () => {
    const tampered = termsPlainText().replace("third-party", "third party");
    expect(tampered).not.toBe(termsPlainText());
    expect(textFingerprint(tampered)).not.toBe(TERMS_DIGEST);
  });
});
