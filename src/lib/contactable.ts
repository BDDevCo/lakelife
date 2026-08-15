/**
 * MAY WE SEND TO THIS ADDRESS AT ALL?
 *
 * Every email and text in this app funnels through two functions — sendEmail
 * and sendSms — and until now neither asked anything about the recipient. That
 * was survivable only by accident: EMAIL_FROM is unset, so Resend's sandbox
 * sender silently swallowed everything aimed at a scratch address, and SMS had
 * no such luck at all. Setting one environment variable in Vercel ends the
 * email half of that with no code change and nothing on screen.
 *
 * THE TEST THAT MATTERS IS NOT "IS THIS A FIXTURE". It is: COULD THIS REACH A
 * STRANGER? Those are different questions and only the second one describes a
 * harm. A scratch address on a domain you own bounces into your own mailbox;
 * an invented phone number can ring a real person and tell them about work at
 * a lake house they have never heard of. Production data today has five
 * fixtures whose numbers are all in the 555 exchange — including
 * +1 260 555 1212, which is directory assistance.
 *
 * SO THE GATE IS BUILT ON RESERVED SPACE, NOT ON A LOCAL CONVENTION. Everything
 * refused below is reserved by a published standard as unroutable to a person.
 * That is what makes this different from the naming conventions this codebase
 * has been unpicking all week: `zz-` was a habit we agreed to, and habits get
 * forgotten. Nobody can be assigned example.com or a 555 line, so a false
 * positive is not merely unlikely here — it is not a thing that can happen.
 *
 * Pure and dependency-free so tests reach it, and so the two senders can call
 * it before doing anything expensive.
 */

/**
 * RFC 2606 §2 and §3 reserve these so they can never resolve to a real host,
 * precisely so documentation and test suites have somewhere safe to point.
 * `resend.dev` is added because it is our transport's own sandbox domain.
 */
const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com", "example.net", "example.org",
  "resend.dev",
]);

/** RFC 2606 §2 reserved TLDs — anything under these is guaranteed unroutable. */
const RESERVED_TLDS = ["test", "example", "invalid", "localhost", "local"];

export type ContactRefusal = {
  /** Short machine reason, for logs and tests. */
  code: "empty" | "malformed" | "reserved-domain" | "reserved-number" | "fixture";
  /** One sentence a human reads in a log line. */
  why: string;
};

/**
 * Why this email must not be sent to, or null if it is fine.
 *
 * NOTE THE DIRECTION OF THE DEFAULT: an address we cannot place is ALLOWED.
 * This gate exists to stop provable harm, not to vet customers — a stricter
 * rule here would start silently swallowing receipts for real people with
 * unusual addresses, and a customer who never gets their confirmation has no
 * way of knowing why. Refusals are for cases with a citation behind them.
 */
export function emailRefusal(raw: string | null | undefined): ContactRefusal | null {
  const addr = (raw ?? "").trim().toLowerCase();
  if (!addr) return { code: "empty", why: "no address" };

  const at = addr.lastIndexOf("@");
  // One @, something either side, a dot in the domain. Deliberately not a full
  // RFC 5322 validator — that is a famously unwinnable regex, and the transport
  // rejects malformed addresses anyway. This only catches obvious nonsense.
  if (at < 1 || at === addr.length - 1 || addr.includes(" ")) {
    return { code: "malformed", why: `not an address: ${addr}` };
  }
  const domain = addr.slice(at + 1);
  if (!domain.includes(".")) return { code: "malformed", why: `no domain dot: ${addr}` };

  if (RESERVED_EMAIL_DOMAINS.has(domain)) {
    return { code: "reserved-domain", why: `${domain} is reserved and cannot be a real mailbox` };
  }
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (RESERVED_TLDS.includes(tld)) {
    return { code: "reserved-domain", why: `.${tld} is a reserved TLD and cannot resolve` };
  }
  return null;
}

/**
 * Why this phone number must not be texted, or null if it is fine.
 *
 * THE 555 EXCHANGE IS THE WHOLE POINT. The North American Numbering Plan sets
 * 555-0100 to 555-0199 aside as permanently fictional, and the rest of the 555
 * exchange has never been assigned to consumer lines — 555-1212 is directory
 * assistance. No customer of a lake-services company in Indiana will ever have
 * one, and every fixture in this database does.
 *
 * Refusing the whole exchange rather than only 555-01XX is deliberate: the
 * fixtures here use 5551212, 5551213 and 5550000, none of which fall inside the
 * strictly-reserved block. A rule that only covered the reserved block would
 * have let every one of them through while looking rigorous.
 */
export function phoneRefusal(raw: string | null | undefined): ContactRefusal | null {
  const num = (raw ?? "").trim();
  if (!num) return { code: "empty", why: "no number" };

  const digits = num.replace(/[^\d]/g, "");
  if (digits.length < 10) return { code: "malformed", why: `too short to dial: ${num}` };

  // Work from the last 10 digits, so +1AAABBBCCCC and AAABBBCCCC agree.
  const ten = digits.slice(-10);
  const exchange = ten.slice(3, 6); // NXX — the central-office code
  if (exchange === "555") {
    return { code: "reserved-number", why: `${num} is in the 555 exchange, which reaches nobody` };
  }
  // 000 and 999 area codes / exchanges are not assignable either.
  const area = ten.slice(0, 3);
  if (area === "000" || area === "999" || exchange === "000") {
    return { code: "reserved-number", why: `${num} is not an assignable number` };
  }
  return null;
}

/** Convenience for callers that just want a yes/no. */
export const mayEmail = (addr: string | null | undefined) => emailRefusal(addr) === null;
export const maySms = (num: string | null | undefined) => phoneRefusal(num) === null;

/**
 * The addresses a fixture SHOULD use, so it is unreachable by construction
 * rather than by somebody remembering. Quoted in the fixture docs and used by
 * the tests.
 */
export const FIXTURE_EMAIL_DOMAIN = "example.com";
export const fixtureEmail = (who: string) => `${who}@${FIXTURE_EMAIL_DOMAIN}`;
/** 555-0100..0199 is the block NANP reserves for fiction. */
export const fixturePhone = (n: number) =>
  `+1260555${String(100 + (n % 100)).padStart(4, "0")}`;
