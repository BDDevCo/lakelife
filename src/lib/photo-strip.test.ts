import { describe, it, expect } from "vitest";
import { photoStripHtml, STRIP_MAX } from "./photo-strip";

/**
 * This builder writes RAW HTML into a page reached from an SMS with no
 * session. Two of its three inputs are not ours: the signed URL is full of
 * `&` and `=`, and `slot` is free-ish text off a database column. Both go
 * through the same escape as every other token page.
 */

const sign = (n: number) =>
  `https://x.supabase.co/storage/v1/object/sign/job-photos/${n}.jpg?token=a.b.c&x=1`;

describe("the condition strip", () => {
  it("is empty when there is nothing to show, not an empty-state sentence", () => {
    // On a page whose button says the work went well, "no photos yet" is an
    // accusation — and a failed read produces it exactly as readily as a real
    // absence. The caller concatenates this, so it must be a plain "".
    expect(photoStripHtml([])).toBe("");
    expect(photoStripHtml(null)).toBe("");
    expect(photoStripHtml(undefined)).toBe("");
  });

  it("drops a row that failed to sign rather than rendering a broken image", () => {
    expect(photoStripHtml([{ url: "" }, { url: "   " } as never])).not.toContain("<img");
  });

  it("shows the shot name under each photo", () => {
    const html = photoStripHtml([{ url: sign(1), slot: "port_side" }]);
    expect(html).toContain("Port side");
    expect(html).toContain("What your crew photographed:");
  });

  it("escapes the signed URL, which is full of & and =", () => {
    // An unescaped & in an attribute is how a URL silently truncates.
    const html = photoStripHtml([{ url: sign(1) }]);
    expect(html).toContain("&amp;x=1");
    expect(html).not.toContain("c&x=1");
  });

  it("escapes a slot, because it is a database column and not our words", () => {
    const html = photoStripHtml([{ url: sign(1), slot: '"><script>alert(1)</script>' }]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // and the attribute it sits in cannot be closed early
    expect(html).not.toMatch(/alt="[^"]*"[^>]*onerror/);
  });

  it("labels an unlabelled photo without inventing a name for it", () => {
    const html = photoStripHtml([{ url: sign(1), slot: null }]);
    expect(html).toContain('alt="Job photo"');
    // no caption band on a photo with nothing to caption
    expect(html).not.toContain("linear-gradient");
  });

  it("caps the strip and says how many it did not show", () => {
    const many = Array.from({ length: STRIP_MAX + 3 }, (_, i) => ({ url: sign(i), slot: "bow" }));
    const html = photoStripHtml(many);
    expect(html.match(/<img /g) ?? []).toHaveLength(STRIP_MAX);
    // NO SILENT TRUNCATION. A strip that quietly stops at eight reads as
    // "this is everything they took".
    expect(html).toContain("+ 3 more in your portal.");
  });

  it("says nothing about extras when there are none", () => {
    const html = photoStripHtml([{ url: sign(1) }, { url: sign(2) }]);
    expect(html).not.toContain("more in your portal");
  });
});
