import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { TermsGate } from "@/components/TermsGate";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getRenterHome } from "@/app/parks/my-data";
import { RenterHome } from "@/components/RenterHome";
import { hasAccepted } from "@/lib/acceptances";
import { TOS_VERSION } from "@/lib/tos";

export const metadata = { title: "My lot — LakeLife" };

/**
 * THE RESIDENT'S HOME SCREEN.
 *
 * Deliberately under /parks (the renter-facing namespace) and not /park (the
 * owner's). Nothing here is scoped by park membership — it is scoped by the
 * claimed renter file, so a park owner opening it sees their own tenancy if
 * they have one and nothing if they do not.
 */
export default async function MyLotPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const view = await getRenterHome();

  // THE RESIDENT HAS NEVER BEEN ASKED TO AGREE TO ANYTHING EITHER.
  //
  // Asked HERE and nowhere else, deliberately. The other renter-facing doors
  // are the claim slip, the welcome link and four no-login token routes, and
  // none of them is the right place: gating the claim would ask somebody to
  // agree before they have a file to agree about, and gating a token route
  // would put a wall in front of a person tapping "yes, I paid" from a text.
  // This page IS the resident's portal, and reaching it means a claimed file
  // and a session.
  //
  // AFTER the tenancy check on purpose. Somebody with no lot is not a resident
  // and has nothing to agree to yet; the sentence below is the answer they
  // need, not a contract.
  if (view) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    // hasAccepted THROWS on a failed read rather than answering "hasn't
    // agreed" — a dropped connection must not put the terms in front of
    // somebody who already accepted them and take a second acceptance.
    if (user && !(await hasAccepted({ userId: user.id }, "tos", TOS_VERSION))) {
      return (
        <>
          <TopBar />
          <TermsGate
            heading="One read-through before we start 🌊"
            intro={
              "There's a section in here about renting a lot — the short version " +
              "is that your agreement is with your park, not with us, and we never " +
              "screen or score you."
            }
            next="/parks/my"
            cta="I agree — show me my lot"
          />
        </>
      );
    }
  }

  if (!view) {
    // THE QUIET STATE SAYS WHAT IT CHECKED. "Nothing here" with no reason is
    // how a resident concludes the app is broken and rings the office —
    // which is the phone call this whole module exists to stop.
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 40, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad">
            <h2 style={{ fontSize: 20, margin: "0 0 6px" }}>No lot on your account</h2>
            <p className="mut" style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
              We looked for a tenancy attached to this sign-in and didn&apos;t
              find one. If you rent a lot and the office set you up by hand,
              your file isn&apos;t linked to this account yet — ring them and
              they can join the two up.
            </p>
            <Link className="ll-btn" href="/portal" style={{ marginTop: 12, display: "inline-block" }}>
              Go to my portal
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <RenterHome view={view} />
    </>
  );
}
