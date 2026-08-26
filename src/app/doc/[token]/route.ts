import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { isBearerToken } from "@/lib/token-format";

export const dynamic = "force-dynamic";

/**
 * THE LINK IN THE EMAIL, AND THE ONLY THING THAT MAKES "OPENED" KNOWABLE.
 *
 * Without this route `park_document_deliveries.opened_at` would be a column
 * with no writer — this codebase's most-repaired defect — and the delivery log
 * would report "sent" for ever with no second state to reach.
 *
 * NO LOGIN, DELIBERATELY. The bearer token IS the authorization: it was minted
 * for one household and one document and emailed to that household's own
 * address. Requiring an account would mean a park could not send a document to
 * a resident who has not signed up, which is most of them — and asking somebody
 * to accept LAKELIFE'S terms before reading THEIR PARK'S lease would be exactly
 * backwards. There is no terms gate here for the same reason.
 *
 * IT OPENS THE DOCUMENT AND ASKS FOR NOTHING. No button to agree, no box to
 * tick, no signature. LakeLife is a courier here and the page it redirects to
 * is the park's own file.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  // Shape first, so a junk path never reaches the database.
  if (!isBearerToken(token)) {
    return new Response("That link isn't valid.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const admin = createServiceClient();

  const { data: delivery, error } = await admin
    .from("park_document_deliveries")
    .select("id, opened_at, park_documents(storage_path, title)")
    .eq("token", token)
    .maybeSingle();

  // A FAILED READ IS NOT A BAD LINK. Telling somebody their link is invalid
  // when the database simply did not answer sends them to the office over
  // nothing, and the park has no way to tell the two apart afterwards.
  if (error) {
    console.error("[doc link] read failed:", error.message);
    return new Response("We couldn't open that just now — try again in a minute.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!delivery) {
    return new Response("That link isn't valid.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const doc = (Array.isArray(delivery.park_documents)
    ? delivery.park_documents[0]
    : delivery.park_documents) as { storage_path?: string } | null;
  if (!doc?.storage_path) {
    console.error("[doc link] delivery has no document:", delivery.id);
    return new Response("We couldn't open that just now — try again in a minute.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const signed = await admin.storage
    .from("park-docs")
    .createSignedUrl(doc.storage_path, 3600);
  if (signed.error || !signed.data) {
    console.error("[doc link] signing failed:", signed.error?.message);
    return new Response("We couldn't open that just now — try again in a minute.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // FIRST OPEN, NOT LATEST. "Opened" means the day they first read it; letting
  // a re-read move the date would quietly rewrite the delivery record every
  // time somebody looked at their own lease.
  //
  // Stamped only AFTER the file is known to be servable — recording that
  // somebody opened a document we then failed to show them would be a false
  // entry in the one log that exists to be relied on.
  if (delivery.opened_at == null) {
    const { error: stampErr } = await admin
      .from("park_document_deliveries")
      .update({ opened_at: new Date().toISOString() })
      .eq("id", delivery.id as string)
      .is("opened_at", null);
    // The document still opens. A missed stamp understates the log, which is
    // the safe direction: it can never claim somebody read something.
    if (stampErr) console.error("[doc link] stamp failed:", stampErr.message);
  }

  return NextResponse.redirect(signed.data.signedUrl, { status: 302 });
}
