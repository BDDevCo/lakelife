import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, softRead } from "@/lib/must-read";
import { ClaimMyLot } from "@/components/ClaimMyLot";
import { SignInHere } from "@/components/SignInHere";

export const metadata = { title: "See your lot — LakeLife" };

/**
 * WHERE A SLIP OF PAPER LEADS.
 *
 * Under /parks (the resident-facing namespace), never /park (the owner's).
 *
 * The park can be pre-filled from the URL — the slip prints
 * /parks/claim?park=the-haven — so in the ordinary case she types her lot
 * number and the code and nothing else. The slug in the query string is not a
 * credential and grants nothing: it only saves her typing, and every real
 * check happens inside claim_park_file against the session.
 */
export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ park?: string; c?: string }>;
}) {
  const { park, c } = await searchParams;

  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Only to put a name on the screen — "See your lot at The Haven" reads like
  // it knows her, and the slug alone does not. Read with the service client
  // because an anonymous visitor legitimately reaches this page before they
  // sign in, and parks_read would hide even an active park from them.
  let parkName: string | undefined;
  // WHICH KEYBOARD HER LOT NUMBER NEEDS.
  //
  // The field asked for `inputMode="numeric"`, which on iOS is a keypad with
  // no letters on it. Every lot in the system today is a plain number so it
  // has never bitten, but `lot_number` is text and the importer stores
  // whatever the roll says — the first park with a lot "12A" or "B-3" hands
  // its residents a keyboard that cannot type their own address. Ask the park
  // rather than assume, and default to letters when we can't (a full keyboard
  // can type digits; a keypad cannot type letters).
  let lotsAreNumeric = false;
  const slug = (park ?? "").trim().toLowerCase();
  if (slug) {
    const admin = createServiceClient();
    // Throws rather than quietly dropping the name: a nameless "See your lot"
    // on a page reached from a slip that names her park is the moment she
    // decides the link is not from the office after all. The boundary at
    // src/app/error.tsx says the fault is ours and offers Try again.
    const data = mustRead("the park on your slip", await admin
      .from("parks").select("id, name").eq("slug", slug).eq("active", true).maybeSingle());
    parkName = (data?.name as string) ?? undefined;
    if (data?.id) {
      // Degraded rather than fatal, because the failure direction is the safe
      // one: not knowing means the full keyboard, which can type digits. A
      // keypad that cannot type "12A" is the fault worth avoiding, and it is
      // unreachable from here. The flag keeps that a decision rather than an
      // accident.
      const [lots, lotsUnknown] = softRead<{ lot_number: string | null }[] | null>(
        "this park's lot numbers",
        await admin
          .from("park_lots").select("lot_number").eq("park_id", data.id as string),
        null,
      );
      lotsAreNumeric =
        !lotsUnknown &&
        (lots?.length ?? 0) > 0 &&
        lots!.every((l) => /^\d+$/.test(String(l.lot_number ?? "")));
    }
  }

  // The exact screen she is on, to be handed back to her after the sign-in.
  // Rebuilt from the params we already validated rather than read off a header,
  // so nothing a proxy sets can steer where the sign-in lands.
  const q = new URLSearchParams();
  if (slug) q.set("park", slug);
  if (c) q.set("c", c);
  const qs = q.toString();
  const selfUrl = `/parks/claim${qs ? `?${qs}` : ""}`;

  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 56, maxWidth: 620 }}>
        {!user ? (
          // SIGN IN FIRST, AND SAY WHY IN ONE SENTENCE. Being bounced to a
          // sign-in screen with no explanation is where somebody puts the
          // phone down and rings the office instead.
          <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
            <h2 style={{ fontSize: 22, margin: "0 0 8px" }}>
              First, sign in{parkName ? ` — ${parkName}` : ""}
            </h2>
            <p style={{ fontSize: 15, lineHeight: 1.6, margin: "0 0 16px" }}>
              Your lot is kept under your own account, so nobody else can see
              it. Sign in or create an account, then come straight back here
              with your slip.
            </p>
            {/* IN PLACE, AND IT COMES BACK HERE. This used to link to "/",
                where signing in ended at /portal — a services portal that has
                nothing to do with the slip in her hand — and she had to find
                her way back to this page on her own. */}
            <SignInHere next={selfUrl} />
            <p className="mut" style={{ fontSize: 13, marginTop: 14, lineHeight: 1.55 }}>
              Keep the slip — you&apos;ll need the code on it in a moment.
            </p>
          </div>
        ) : (
          // The code arrives pre-filled when she scanned the square on the
          // slip, so all that is left is her lot number. Typed entry still
          // works identically — the field is editable and starts empty when
          // there is nothing in the link.
          <ClaimMyLot
            parkSlug={slug || undefined}
            parkName={parkName}
            presetCode={c}
            lotsAreNumeric={lotsAreNumeric}
          />
        )}

        {/* THE ANTI-SCAM SENTENCE, on the page rather than only on the slip.
            An older resident being asked to type a code into a phone has every
            reason to be suspicious, and telling her what we will NEVER do is
            more use than telling her we are trustworthy. */}
        <p className="mut" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 22 }}>
          LakeLife will never phone or text you asking for this code, and never
          asks for card or bank details to set your lot up. The code comes from
          your park office, on paper, and nowhere else.
        </p>
      </main>
    </>
  );
}
