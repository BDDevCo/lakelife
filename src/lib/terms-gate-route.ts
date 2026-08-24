import "server-only";
import { createClient } from "@/lib/supabase/server";
import { hasAccepted } from "@/lib/acceptances";
import { TOS_VERSION } from "@/lib/tos";
import { ReadFailed } from "@/lib/must-read";

/**
 * THE TERMS GATE, FOR THE ROUTES A LAYOUT CANNOT REACH.
 *
 * `src/app/park/layout.tsx` and `src/app/vendor/layout.tsx` cover every PAGE in
 * their tree. They cover no Route Handler at all: Next.js layouts wrap pages,
 * and this app has no middleware. Three handlers therefore sat outside the
 * gate — the crew's printable earnings statement and its CSV, and the park's
 * receipts CSV — each a plain GET link the app itself puts in the address bar,
 * so each already in history and bookmarks.
 *
 * Identity was never the hole: all three already prove who is asking and scope
 * the read to their own rows. What walked past was the AGREEMENT.
 *
 * ONE FUNCTION, so the next handler dropped under either tree has something to
 * call and a test can insist that it did — rather than three hand-rolled copies
 * that drift. Returns a Response to send, or null to carry on.
 *
 * FAILS CLOSED. `hasAccepted` throws on a dropped read rather than answering
 * "hasn't agreed", and a document is not the thing to hand out while we cannot
 * tell. The page tree answers a failed read with the error boundary; a handler
 * has none, so it answers in plain text.
 */
export async function termsGateForRouteHandler(
  backTo: "/park" | "/vendor",
): Promise<Response | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // No session is not this function's problem — the caller has already proved
  // identity its own way and would not have reached here without one.
  if (!user) return null;

  try {
    if (await hasAccepted({ userId: user.id }, "tos", TOS_VERSION)) return null;
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return new Response(
      "We couldn't check your terms acceptance just now. Try again in a moment.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  return new Response(
    `There's an updated agreement to read before this file can be downloaded. ` +
      `Open ${backTo} and it's the first thing on the screen.`,
    { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
