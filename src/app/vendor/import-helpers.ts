// Pure parsing/validation for the crew "import my customers" flow — no server
// imports, so vitest loads it cleanly. A crew pastes one customer per line in a
// forgiving format; we extract email (required) + name + address + phone.

export interface ParsedCustomer {
  name: string;
  email: string;
  address: string;
  phone: string;
  raw: string;
}

export interface ParseResult {
  valid: ParsedCustomer[];
  invalid: Array<{ raw: string; reason: string }>;
}

const EMAIL_RE = /[^\s,;]+@[^\s,;]+\.[^\s,;]+/;
const PHONE_RE = /([(+]?\d[\d\-().\s]{6,}\d)/;

/** A field looks like a US-ish address if it has a number then letters (street). */
function looksLikeAddress(s: string): boolean {
  return /\d/.test(s) && /[a-zA-Z]{2,}/.test(s) && s.length >= 6;
}

/**
 * Parse pasted rows. Each non-empty line becomes one customer. We split on
 * commas OR tabs (CSV or spreadsheet paste), then classify fields: the token
 * matching an email is the email; a phone-shaped token is the phone; the
 * longest address-shaped token is the address; the remaining leading token is
 * the name. A line with no valid email is reported invalid (email is the claim
 * key). De-dupes by email (first wins).
 */
export function parseCustomers(text: string): ParseResult {
  const valid: ParsedCustomer[] = [];
  const invalid: Array<{ raw: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw) continue;

    const emailMatch = raw.match(EMAIL_RE);
    if (!emailMatch) {
      invalid.push({ raw, reason: "no email found" });
      continue;
    }
    const email = emailMatch[0].toLowerCase();
    if (seen.has(email)) {
      invalid.push({ raw, reason: "duplicate email in list" });
      continue;
    }

    // Fields left after removing the email token, split on comma/tab.
    const rest = raw.replace(emailMatch[0], "").split(/[,\t]/).map((s) => s.trim()).filter(Boolean);
    let phone = "";
    let address = "";
    const others: string[] = [];
    for (const f of rest) {
      if (!phone && PHONE_RE.test(f) && !looksLikeAddress(f)) phone = f.match(PHONE_RE)![1].trim();
      else if (looksLikeAddress(f) && f.length > address.length) address = f;
      else others.push(f);
    }
    const name = (others[0] ?? "").slice(0, 120);

    seen.add(email);
    valid.push({ name, email, address: address.slice(0, 200), phone: phone.slice(0, 30), raw });
  }

  return { valid, invalid };
}
