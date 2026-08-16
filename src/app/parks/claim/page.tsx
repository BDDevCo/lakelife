import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ClaimMyLot } from "@/components/ClaimMyLot";
import Link from "next/link";

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
  const slug = (park ?? "").trim().toLowerCase();
  if (slug) {
    const admin = createServiceClient();
    const { data } = await admin
      .from("parks").select("name").eq("slug", slug).eq("active", true).maybeSingle();
    parkName = (data?.name as string) ?? undefined;
  }

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
            <Link className="ll-btn" href="/" style={{ display: "inline-block", minHeight: 48 }}>
              Sign in
            </Link>
            <p className="mut" style={{ fontSize: 13, marginTop: 14, lineHeight: 1.55 }}>
              Keep the slip — you&apos;ll need the code on it in a moment.
            </p>
          </div>
        ) : (
          // The code arrives pre-filled when she scanned the square on the
          // slip, so all that is left is her lot number. Typed entry still
          // works identically — the field is editable and starts empty when
          // there is nothing in the link.
          <ClaimMyLot parkSlug={slug || undefined} parkName={parkName} presetCode={c} />
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
