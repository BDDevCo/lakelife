import "server-only";

/**
 * A FAILED READ IS NOT AN EMPTY ONE.
 *
 * ============================================================================
 * THE PROJECT'S DOMINANT BUG CLASS, INVERTED.
 * ============================================================================
 * Elsewhere the recurring fault is a column read everywhere and written by
 * nothing. This is its mirror image, and it hides better.
 *
 * supabase-js resolves to `{ data: null, error }` when a read fails. Written
 * the usual way —
 *
 *     const { data: park } = await admin.from("parks").select(...)
 *
 * — a dropped connection, an RLS refusal, a typo'd column and a genuinely
 * absent row all arrive as exactly the same value: `null`. The code then takes
 * its empty-case branch, which is usually a calm, plausible sentence written
 * for the case where the row really is missing:
 *
 *     "your park"                  instead of the park's name
 *     "No lot on your account"     to somebody who has paid rent for 11 years
 *     "Nothing recorded yet"       to somebody holding a receipt
 *     $0.00 held                   to somebody whose deposit is $500
 *
 * None of those look like faults. They look like facts, and a resident acts on
 * them — rings the office, pays twice, or believes their deposit is gone.
 * A crash would be kinder, because a crash is honest.
 *
 * Observed live 17 Aug 2026: one load of /parks/my rendered "Lot 7 · your park"
 * and the next was correct. Nothing was logged, nothing alerted, and the only
 * reason it was caught is that somebody happened to be looking at the screen.
 *
 * ============================================================================
 * THE RULE
 * ============================================================================
 * On a screen where the answer is somebody's identity or somebody's money,
 * every read either produces the truth or produces an error. It never produces
 * a reassuring guess.
 *
 * `mustRead` throws on `error` and returns `data` untouched. The empty case is
 * left entirely alone — `null` and `[]` still mean "there is genuinely nothing
 * here", and every existing branch that handles them keeps working. What
 * changes is that those branches become UNREACHABLE by failure, which is the
 * whole point: `return null` from a loader now means one thing instead of two.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: retry, fall back to a cache, or swallow.
 * A retry hides the rate at which this happens, and the rate is the thing worth
 * knowing.
 */

/** The shape every supabase-js read resolves to. Structural on purpose — this
 *  file must not import the client just to name a type. */
interface ReadResult<T> {
  data: T;
  error: { message?: string; code?: string; details?: string } | null;
}

interface CountResult {
  count: number | null;
  error: { message?: string; code?: string; details?: string } | null;
}

/**
 * Thrown when a read fails. Carries what was being read in human words, so the
 * server log says "couldn't read the bill" rather than naming a table nobody
 * outside the code has heard of.
 */
export class ReadFailed extends Error {
  constructor(
    /** Human words: "your lot", "the bill", "your payments". */
    readonly what: string,
    readonly detail: string | undefined,
  ) {
    super(`Couldn't read ${what}${detail ? `: ${detail}` : ""}`);
    this.name = "ReadFailed";
  }
}

/**
 * Unwrap a read, or throw.
 *
 * @param what human words for what was being fetched, used in the log line.
 */
export function mustRead<T>(what: string, res: ReadResult<T>): T {
  if (res.error) {
    // Logged HERE rather than at the boundary, because this is the only place
    // that still knows which read it was. The boundary sees a rendered page.
    console.error(`[read failed] ${what}:`, res.error.code ?? "", res.error.message ?? res.error);
    throw new ReadFailed(what, res.error.message);
  }
  return res.data;
}

/** The `{ count, head: true }` variant. Same rule; an errored count is not 0. */
export function mustCount(what: string, res: CountResult): number {
  if (res.error) {
    console.error(`[read failed] ${what}:`, res.error.code ?? "", res.error.message ?? res.error);
    throw new ReadFailed(what, res.error.message);
  }
  return res.count ?? 0;
}

/**
 * For the reads where failing the whole page is disproportionate.
 *
 * A maintenance-report list is not worth withholding somebody's rent balance
 * over — but "Nothing yet" is still a lie when the truth is "we couldn't
 * look". So this returns a flag the screen must render, and the caller has to
 * do something with it. It is a `[value, failed]` pair rather than a bare
 * fallback precisely so that ignoring the failure requires writing code that
 * visibly ignores it.
 */
export function softRead<T>(what: string, res: ReadResult<T>, whenFailed: T): [T, boolean] {
  if (res.error) {
    console.error(`[read failed, degraded] ${what}:`, res.error.code ?? "", res.error.message ?? res.error);
    return [whenFailed, true];
  }
  return [res.data, false];
}

/**
 * THE SAME RULE, FOR SERVER ACTIONS.
 *
 * A loader throws and the boundary catches it. An action cannot: its caller is
 * a button awaiting `{ ok, error }`, and a rejected promise inside a transition
 * surfaces as a blank failure with no sentence attached. So actions RETURN.
 *
 * Two things this message must do, both learned from what it replaces:
 *
 *   SAY NOTHING ABOUT THEIR ACCOUNT. The old refusals asserted facts —
 *   "That isn't your bill", "Add your bank details first", "No lot on your
 *   account" — precisely when the code had no fact to assert.
 *
 *   SAY WHETHER MONEY MOVED. It is the reader's first question and the one
 *   thing they cannot check from where they are standing. Callers that charge
 *   or pay pass `moved: false` to say so explicitly.
 */
export function readFailedMessage(
  what: string,
  error: unknown,
  opts?: { money?: boolean },
): string {
  console.error(`[read failed] ${what}:`, error);
  // "Nothing has been charged" was wrong half the time: these paths include
  // REFUNDS, where the reader's question is "did my money come back", not "was
  // I charged". Both are answered by naming the movement rather than the
  // direction — and it stays true because every one of these returns sits
  // BEFORE the processor call.
  return opts?.money
    ? "We couldn't check something just now, so no money has moved. Try again in a moment."
    : "We couldn't load something just now, so nothing has been changed. Try again in a moment.";
}

/** True when a supabase-js result carries an error. Keeps call sites to one line. */
export function readFailed(res: { error: unknown | null }): boolean {
  return !!res.error;
}
