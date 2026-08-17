import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { FollowInvite } from "@/components/FollowInvite";
import { INVITE_TOKEN_RE } from "@/lib/park-invite";
import { SignInHere } from "@/components/SignInHere";

export const metadata = { title: "See your lot — LakeLife" };

/**
 * WHERE THE EMAILED LINK LANDS.
 *
 * She tapped a link in a message from her park. There is nothing to type here
 * — the token is in the URL and her identity is her session — so the only
 * thing this page ever asks for is a sign-in, and only when she isn't.
 *
 * THE TOKEN IS NOT A PASSWORD. Holding it opens nothing: the claim refuses
 * unless the signed-in address matches the one the invite was sent to. That is
 * why it is safe to have it sitting in a URL, in an inbox, on a screen behind
 * her on a bus.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  const token = (t ?? "").trim();

  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const shaped = INVITE_TOKEN_RE.test(token);
  // Rebuilt from the token we just shape-checked, never from a request header.
  const selfUrl = `/parks/welcome?t=${encodeURIComponent(token)}`;

  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 56, maxWidth: 620 }}>
        {!shaped ? (
          <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
            <h2 style={{ fontSize: 22, margin: "0 0 8px" }}>That link looks incomplete</h2>
            <p style={{ fontSize: 15, lineHeight: 1.6, margin: "0 0 8px" }}>
              Try tapping it again in the email rather than copying it across —
              long links sometimes get cut in half on the way.
            </p>
            <p className="mut" style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
              If it still doesn&apos;t work, your park office can print you a slip
              with a short code on it instead.
            </p>
          </div>
        ) : !user ? (
          // SIGN IN, AND SAY WHICH ADDRESS. This is the one instruction that
          // decides whether the link works, because the claim is refused unless
          // the account matches the address the invite went to.
          <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
            <h2 style={{ fontSize: 22, margin: "0 0 8px" }}>First, sign in</h2>
            <p style={{ fontSize: 15, lineHeight: 1.6, margin: "0 0 16px" }}>
              Use <strong>the same email address this message was sent to</strong>.
              Your lot is kept under your own account, so nobody else can see it.
            </p>
            {/* THE MODAL OPENS HERE AND HANDS HER BACK. The old button went
                to "/" and the sentence under it had to say "then come back to
                this page" — which, on a phone, means switching to Mail and
                finding the link a second time. */}
            <SignInHere next={selfUrl} />
            <p className="mut" style={{ fontSize: 13, marginTop: 14, lineHeight: 1.55 }}>
              You&apos;ll come straight back here. The link stays good for 30 days.
            </p>
          </div>
        ) : (
          <FollowInvite token={token} selfUrl={selfUrl} />
        )}

        <p className="mut" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 22 }}>
          LakeLife never asks for card or bank details to set your lot up, and
          never phones or texts you asking for a code or a password.
        </p>
      </main>
    </>
  );
}
