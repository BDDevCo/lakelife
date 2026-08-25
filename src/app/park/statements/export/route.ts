import { termsGateForRouteHandler } from "@/lib/terms-gate-route";
import { getMyPark } from "@/app/park/data";
import { getStatement } from "@/app/park/receipts-actions";
import { receiptsCsv, receiptsFilename } from "@/app/park/receipts-helpers";
import { ReadFailed } from "@/lib/must-read";

export const dynamic = "force-dynamic";

/**
 * The download.
 *
 * A GET, so it is a plain link the browser handles — no client JS, nothing to
 * fail silently on a phone, and it changes nothing on the server. Park scoping
 * comes from the signed-in user via `getMyPark`, NOT from a query parameter, so
 * a forwarded URL cannot fetch somebody else's park.
 */
/**
 * A LAYOUT DOES NOT WRAP A ROUTE HANDLER.
 *
 * The terms gate lives in src/app/park/layout.tsx, and every page under it is covered. This
 * is not a page — Next.js layouts wrap pages, there is no middleware, and the
 * codebase already records the sibling fact that a route handler has no error
 * boundary either. So while the whole park area was showing the agree card,
 * this URL kept returning the document, and it is a plain GET link the app
 * itself puts in the address bar: it is in history and in bookmarks.
 *
 * Identity was never the hole — getMyPark scopes to the caller's own park and 404s a stranger. What walked past was the AGREEMENT.
 */
export async function GET(request: Request) {
  const park = await getMyPark();
  if (!park) return new Response("Not found", { status: 404 });
  const gate = await termsGateForRouteHandler("/park");
  if (gate) return gate;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  // `getStatement` THROWS on a failed read now, and a Route Handler has no
  // error boundary above it — an escape here is a bare 500 where a CSV was
  // expected. Refused the same plain way the bad dates below are refused, and
  // deliberately NOT as an empty file: a short statement filed with an
  // accountant is worse than no statement.
  let page: Awaited<ReturnType<typeof getStatement>>;
  try {
    page = await getStatement(park.id, from, to);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return new Response(
      "We couldn't build that statement just now, so nothing has been downloaded. Try again in a moment.",
      { status: 503 },
    );
  }
  if (!page) return new Response("Those dates don't work.", { status: 400 });

  // BOTH ARRAYS. `page.receipts` is rent against a bill; `page.otherReceipts`
  // is the deposits, on-account money and amenity income that also hit the
  // bank. Passing only the first is what made this file impossible to
  // reconcile.
  const csv = receiptsCsv(page.receipts, page.otherReceipts, {
    parkName: page.parkName,
    generatedAt: page.generatedAt,
  });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${receiptsFilename(page.parkName, page.period)}"`,
      "Cache-Control": "no-store",
    },
  });
}
