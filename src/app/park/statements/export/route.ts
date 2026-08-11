import { getMyPark } from "@/app/park/data";
import { getStatement } from "@/app/park/receipts-actions";
import { receiptsCsv, receiptsFilename } from "@/app/park/receipts-helpers";

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

  const page = await getStatement(park.id, from, to);
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
