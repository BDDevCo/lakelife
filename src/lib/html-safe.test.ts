import { describe, it, expect } from "vitest";
import { html, raw, escapeHtml, asHtml, type RawHtml } from "./html-safe";

/**
 * THE SWEEP'S FOUNDATION.
 *
 * Every email body in this codebase is a template literal assembled by hand,
 * and SIX had already grown their own inline escaper — the same `.replace()`
 * chain copied six times. Five did `&` `<` `>`; one also did `"`. None did
 * `'`. A rule copied into six doorways and complete in none, which is this
 * project's own signature defect.
 *
 * So the escaping becomes the DEFAULT and the opt-out becomes greppable. The
 * tests below pin the three things that decide whether that is safe:
 *   - an interpolated value is escaped, always;
 *   - a nested `html` is NOT double-escaped (or every body turns to soup);
 *   - `raw()` passes through, and is the only thing that does.
 */

/** What a mail client actually shows: tags eaten, text left behind. */
const asRendered = (h: RawHtml | string) => String(h).replace(/<[^>]*>?/g, "");

describe("a typed sentence survives the mail client", () => {
  it("keeps the words after an angle bracket", () => {
    // THE BUG THIS EXISTS FOR. Unescaped, a mail client eats from `<4ft`
    // onward — including the sentence saying nothing is charged.
    const note = "gate is <4ft wide, truck won't fit";
    const body = html`<p>They said: "${note}" Nothing is charged.</p>`;
    expect(asRendered(body)).toContain("4ft wide");
    expect(asRendered(body)).toContain("Nothing is charged");
  });

  it("is the failure the old code actually had", () => {
    // The same body without the tag, to prove the test is measuring the right
    // thing rather than passing for free.
    const note = "gate is <4ft wide, truck won't fit";
    const unsafe = `<p>They said: "${note}" Nothing is charged.</p>`;
    expect(asRendered(unsafe)).not.toContain("Nothing is charged");
  });

  it("escapes the five characters that matter, and nothing else", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
    expect(escapeHtml("a plain sentence — with an em dash")).toBe("a plain sentence — with an em dash");
  });

  it("escapes the ampersand first, or the owner reads &amp;lt;", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("catches the apostrophe not one of the six escapers handled", () => {
    // Five of the six did & < > only and the sixth added "; none did '. So
    // every O'Neil and every "don't" carried a character the chain was
    // supposed to cover.
    expect(escapeHtml('say "hi"')).toContain("&quot;");
    expect(escapeHtml("it's")).toContain("&#39;");
  });
});

describe("composing a body out of pieces", () => {
  it("does not double-escape a nested html block", () => {
    // The trap that would turn every converted body into soup: if `html`
    // returned a plain string, the outer template would escape the inner's
    // tags and the owner would read literal <p>.
    const inner = html`<p>Hi ${"Dale"},</p>`;
    const outer = html`<div>${inner}</div>`;
    expect(String(outer)).toBe("<div><p>Hi Dale,</p></div>");
    expect(String(outer)).not.toContain("&lt;p&gt;");
  });

  it("still escapes a person's words inside the nested block", () => {
    const inner = html`<p>${"<script>x</script>"}</p>`;
    expect(String(html`<div>${inner}</div>`)).not.toContain("<script>");
  });

  it("renders a falsy branch as nothing, not as 'false' or 'null'", () => {
    // `${cond && html`…`}` is the shape most of these bodies want.
    expect(String(html`<p>${false}${null}${undefined}</p>`)).toBe("<p></p>");
  });

  it("joins an array of pieces — the <li> map shape", () => {
    const rows = ["a", "b"].map((d) => html`<li>${d}</li>`);
    expect(String(html`<ul>${rows}</ul>`)).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("keeps a zero — a count of nothing is a fact worth printing", () => {
    expect(String(html`<p>${0}</p>`)).toBe("<p>0</p>");
  });
});

describe("raw is the only way out, and it is greppable", () => {
  it("passes markup through untouched", () => {
    expect(String(html`<div>${raw("<hr>")}</div>`)).toBe("<div><hr></div>");
  });

  it("escapes a plain string that merely looks like markup", () => {
    // An unwrapped value is escaped however much it resembles a tag — the
    // whole point of default-escape is that forgetting fails NOISILY.
    expect(String(html`<div>${"<hr>"}</div>`)).toBe("<div>&lt;hr&gt;</div>");
  });

  it("cannot be faked by an object claiming to be raw", () => {
    // The brand is a module-private symbol, so a value arriving from JSON —
    // a database column, a webhook body — can never opt itself out.
    const impostor = { value: "<script>x</script>", toString: () => "<script>x</script>" };
    expect(String(html`<div>${impostor}</div>`)).not.toContain("<script>");
  });
});

describe("asHtml — the plain-text body both channels share", () => {
  it("escapes a resident whose name carries an apostrophe", () => {
    // The reminder-actions copy escaped & < > only, so O'Neil went out with
    // the apostrophe raw while the rest of the chain had run. One doorway now.
    expect(String(asHtml("Dear O'Neil,"))).toContain("&#39;");
    expect(String(asHtml('she said "no"'))).toContain("&quot;");
  });

  it("keeps the wrapper byte-identical to the two it replaced", () => {
    // If this markup drifts, every reminder and every notify email changes
    // shape at once — and nobody would be looking at those two files.
    expect(String(asHtml("x"))).toBe(
      '<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">x</div>',
    );
  });

  it("escapes an ampersand exactly once", () => {
    // The failure mode of re-adding a "helpful" escape step in front of the
    // tag: the reader gets "Tom &amp;amp; Jerry". Both hand-rolled copies
    // started with .replace(/&/g,"&amp;"), so this is the shape most likely
    // to come back.
    expect(String(asHtml("Tom & Jerry"))).toContain("Tom &amp; Jerry");
    expect(String(asHtml("Tom & Jerry"))).not.toContain("&amp;amp;");
  });

  it("keeps the author's line breaks — that is what pre-wrap is for", () => {
    expect(String(asHtml("one\ntwo"))).toContain("one\ntwo");
  });
});

describe("an apostrophe is not a thing the reader sees", () => {
  it("renders as an apostrophe once the mail client draws it", () => {
    // A conversion nearly kept a raw() escape hatch on the strength of "the
    // tag would render crew&#39;s to the reader's eye". It would not: &#39; is
    // how a mail client is TOLD to draw an apostrophe. An unnecessary escape
    // hatch is a hole waiting for the day somebody puts a name in that array.
    const line = html`<p>Deadline sweep: ${"3 closed in the crew's favor"}.</p>`;
    expect(String(line)).toContain("crew&#39;s");
    // What a client actually shows: entities decoded, tags gone.
    const shown = String(line)
      .replace(/<[^>]*>/g, "")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(shown).toBe("Deadline sweep: 3 closed in the crew's favor.");
  });
});
