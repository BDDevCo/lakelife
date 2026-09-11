/**
 * TEXT A PERSON TYPED, ON ITS WAY INTO AN HTML EMAIL.
 *
 * Every notification body in this codebase is a template literal assembled by
 * hand, and for a long time that was safe by construction: the values going
 * into them were names, addresses, counts and prices we composed ourselves.
 *
 * Then the crew got a box to type a sentence into, and that sentence started
 * arriving in the owner's inbox. A crew writing
 *
 *     gate is <4ft wide, truck won't fit
 *
 * sends an email a mail client renders as
 *
 *     Your crew can't start until you've seen this: "gate is
 *
 * because everything from `<4ft` onward is eaten as an unknown tag — including
 * the sentence telling them nothing is charged while they decide. They are
 * then asked to hold or release somebody's job on half a sentence. That is not
 * primarily a security story, it is the plain one: the message did not arrive.
 *
 * THE FIX IS THE DEFAULT, NOT THE DISCIPLINE. SIX of the email bodies here had
 * already grown their own inline escaper — the same `.replace()` chain, copied
 * into lib/notify.ts, lib/park-invite.ts, lib/digest-render.ts,
 * app/park/ledger-actions.ts, app/park/reminder-actions.ts and
 * app/parks/pay-actions.ts. Five handled `&` `<` `>` only; one also did `"`.
 * NOT ONE of the six escaped `'`, so every O'Neil and every "don't" went out
 * with a character the chain was supposed to cover. That is this codebase's
 * own signature: a rule copied into six doorways and complete in none. A
 * seventh hand-rolled copy would not have helped.
 *
 * (Seven MORE live outside the email path — the token landing pages,
 * photo-strip, the printable statement, two components. Those serve web pages
 * rather than mail and are a separate sweep, deliberately not done here.)
 *
 * So `html` is a tagged template that escapes every interpolated value, and
 * markup you MEANT to nest is opted out explicitly with `raw()` — which is
 * greppable, unlike remembering. Getting it wrong in the safe direction shows
 * a literal `<p>` in an email, which somebody notices; getting it wrong in the
 * unsafe direction is the silent truncation above. Default-escape puts every
 * mistake in the noisy direction.
 */

const RAW = Symbol("html-safe.raw");

export interface RawHtml {
  readonly [RAW]: true;
  readonly value: string;
  toString(): string;
}

function makeRaw(value: string): RawHtml {
  return { [RAW]: true, value, toString: () => value };
}

function isRaw(v: unknown): v is RawHtml {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[RAW] === true;
}

/**
 * Escape text for HTML — an email body, a printed notice, a token page.
 *
 * Apply at the point text ENTERS HTML, never where the sentence is composed:
 * the same strings go out by SMS too, and an owner reading `&quot;` aloud is
 * the bug. `html` below calls this for you; use it directly only when building
 * a document some other way (a print window, a route handler's own template).
 *
 * THE ONE COPY. There were ten: six in the email path and four more serving
 * web pages, covering three, four or five characters depending on which was
 * written first. This is the only one now.
 */
export function escapeHtml(text: string): string {
  return text
    // & FIRST, or the ampersands introduced below are escaped a second time
    // and the owner reads `&amp;lt;`.
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * MARKUP I MEANT. Opts a value out of escaping.
 *
 * Only ever wrap markup this code produced — a `<li>` row built from a map, a
 * conditional `<p>`. Never wrap a value that came from a person, a database
 * column somebody typed into, or anything upstream you have not read.
 */
export function raw(value: string): RawHtml {
  return makeRaw(value);
}

/**
 * An HTML body whose interpolations are escaped.
 *
 *   html`<p>Hi ${name},</p>${detail ? html`<p>${detail}</p>` : ""}`
 *
 * Nested `html` returns RawHtml and passes through untouched, so composing a
 * body out of pieces works without a single `raw()`. `null`, `undefined` and
 * `false` render as nothing, so `cond && html`…`` is safe to inline.
 *
 * Returns RawHtml rather than a string so that nesting cannot double-escape.
 * `sendEmail` accepts it directly; `String(...)` anywhere else.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return makeRaw(out);
}

function render(v: unknown): string {
  // A falsy branch renders nothing rather than the word "false" or "null" —
  // `{cond && html`…`}` is the shape every one of these bodies wants.
  if (v == null || v === false) return "";
  if (isRaw(v)) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

/**
 * A PLAIN-TEXT BODY, SHOWN AS HTML.
 *
 * Several notices are written once as plain text and sent down both channels —
 * the text goes out verbatim by SMS and this wraps the same words for the
 * email half. `white-space: pre-wrap` is what keeps the line breaks the author
 * put there.
 *
 * There were TWO of these, byte-identical in markup and not in behaviour:
 * lib/notify.ts and app/park/reminder-actions.ts each had a private copy, both
 * escaping only & < >, so a resident called O'Neil went out with the
 * apostrophe raw. One rule, two doorways. This is the one doorway now.
 */
export function asHtml(body: string): RawHtml {
  return html`<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${body}</div>`;
}
