/**
 * ONE CSV CELL, ESCAPED ONCE, FOR EVERY FILE WE HAND SOMEBODY.
 *
 * There were three copies of this rule — `csvText` in the park receipts, a
 * private `csvField` in the ACH export, and `csvCell` in the crew's earnings —
 * and they had already drifted three ways:
 *
 *   * the crew's earnings had NO formula guard at all, so an address or a crew
 *     name beginning with `=` went into the file live;
 *   * the ACH export did not quote a lone carriage return, which splits a row
 *     in the middle for anything reading strict RFC 4180;
 *   * and both of the guarded ones prefixed NEGATIVE NUMBERS, turning a -45.00
 *     clawback into the text `'-45.00`.
 *
 * That last one is why this is a shared function and not three fixed copies:
 * the obvious repair for the earnings file — paste the guard across — would
 * have shipped a fresh bug into the one column that must import as a number.
 *
 * THE GUARD. A leading =, +, - or @ makes Excel, Sheets and Numbers treat the
 * cell as a FORMULA rather than text, so a payer called "-Smith" or a crew
 * called "=HYPERLINK(...)" executes on open. Anything starting with one is
 * prefixed with a single quote, which those programs strip on display.
 *
 * THE EXEMPTION. `-45.00` is a number, not a formula, and these files exist to
 * be imported into bookkeeping software. A well-formed decimal is left exactly
 * as written; everything else that leads with one of those characters — even
 * "+1", even "-", even "-45.00 (partial)" — is treated as text and guarded.
 */

/** A plain decimal: optional minus, digits, optional fractional part. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Leading characters a spreadsheet reads as the start of a formula. */
const LOOKS_LIKE_FORMULA = /^[=+\-@\t\r]/;

/** Characters that force RFC 4180 quoting. */
const NEEDS_QUOTES = /[",\n\r]/;

export function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  if (LOOKS_LIKE_FORMULA.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  if (NEEDS_QUOTES.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Join one row from cells, escaping each. */
export function csvRow(cells: ReadonlyArray<string | number | null | undefined>): string {
  return cells.map(csvCell).join(",");
}
