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
export async function GET(request: Request) {
  const park = await getMyPark();
  if (!park) return new Response("Not found", { status: 404 });

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

  const csv = receiptsCsv(page.receipts, {
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
