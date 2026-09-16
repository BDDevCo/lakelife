/**
 * THE DATABASE'S OWN SENTENCE, without the table it prefixes.
 *
 * A guard that refuses by name (0169's void guard, 0167's allocation
 * guards) raises `park_charges: 100.00 of money on account is against this
 * bill — take it off the bill first (with a reason), then cancel it`. The
 * words after the colon are for the office; the table before it is for
 * the developer. Every door that prints the refusal stripped the prefix
 * with its own regex — four copies, four tables — and the doors that had
 * none printed "couldn't be cancelled." with no why at all. One strip,
 * here, so a refusal reaches the office as the same sentence from
 * whichever door raised it.
 *
 * `fallback` is what to say when the database gave no words — never
 * "try again" for a refusal that will never come true.
 */
export function dbSaid(message: unknown, table: string, fallback = "the ledger refused it"): string {
  const said = String(message ?? "").replace(new RegExp(`^${table}:\\s*`), "").trim();
  return said || fallback;
}
