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
import { TERMS_DIGESTS } from "@/lib/terms-versions";

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
   * THE GUARD `terms-content.ts` PROMISES — now with the hole closed.
   *
   * v1 of this guard pinned two independent constants IN THIS FILE: a digest
   * and a version. Change a word and only the digest assertion failed, and its
   * own message told the editor to paste the new digest in. Doing exactly that
   * turned CI green with NEW WORDS UNDER THE OLD VERSION STRING — the precise
   * failure it was written to prevent. Nothing compared the new digest to what
   * that version had hashed to before, because nothing remembered.
   *
   * `src/lib/terms-versions.ts` remembers, is committed, and is append-only.
   *
   * If you are reading this because CI failed: you changed the terms. Add a NEW
   * entry to TERMS_DIGESTS with a NEW version string and point TOS_VERSION at
   * it. Do not edit an existing entry — that is rewriting what somebody already
   * agreed to, and the second test below is watching for it.
   */

  it("termsVersionGuard: the current version's entry matches the current words", () => {
    expect(TERMS_DIGESTS[TOS_VERSION]).toBe(textFingerprint(termsPlainText()));
  });

  it("and these words have never shipped under a DIFFERENT version", () => {
    // The rule with teeth. Editing an old entry to silence the test above
    // rewrites history; this catches the old digest reappearing, and the diff
    // shows a reviewer exactly what was changed.
    const digest = textFingerprint(termsPlainText());
    const under = Object.entries(TERMS_DIGESTS)
      .filter(([, d]) => d === digest)
      .map(([v]) => v);
    expect(under).toEqual([TOS_VERSION]);
  });

  it("every recorded version is a real sha256, and none repeats", () => {
    const digests = Object.values(TERMS_DIGESTS);
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
    // Two versions with the same digest would mean a bump that changed nothing,
    // which re-prompts everybody for no reason.
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("the version currently shipping is recorded at all", () => {
    expect(Object.keys(TERMS_DIGESTS)).toContain(TOS_VERSION);
  });

  it("the digest really is of the terms, not of an empty string", () => {
    // Guards the guard: a termsPlainText() that returned "" would otherwise
    // just need its entry updated once and would then never fail again.
    expect(termsPlainText().length).toBeGreaterThan(500);
    expect(textFingerprint("")).not.toBe(TERMS_DIGESTS[TOS_VERSION]);
  });

  it("would notice a single changed word", () => {
    const tampered = termsPlainText().replace("third-party", "third party");
    expect(tampered).not.toBe(termsPlainText());
    expect(textFingerprint(tampered)).not.toBe(TERMS_DIGESTS[TOS_VERSION]);
  });

  it("tos-v0-beta is absent, because its words were never captured", () => {
    // Inventing a digest for it would assert we know something we do not —
    // the same reason the four migrated ledger rows carry a NULL sha.
    expect(Object.keys(TERMS_DIGESTS)).not.toContain("tos-v0-beta");
  });
});
