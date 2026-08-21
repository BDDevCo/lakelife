import { TopBar } from "@/components/Brand";
import { TermsGate } from "@/components/TermsGate";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getMyPark } from "@/app/park/data";
import { hasAccepted } from "@/lib/acceptances";
import { TOS_VERSION } from "@/lib/tos";

/**
 * THE PARK OWNER HAS NEVER BEEN ASKED TO AGREE TO ANYTHING.
 *
 * Homeowners accept at the moment of booking and crews at go-live. A park
 * owner had no acceptance path at all — he could onboard a park, import
 * nineteen households and raise real bills without ever seeing the terms, and
 * until 0139 the terms did not mention a park owner in any case.
 *
 * WHY A LAYOUT AND NOT A PAGE. There are thirteen routes under /park and the
 * crew's gate covers exactly one route because /vendor is where a crew lands.
 * A park owner with /park/rent bookmarked never passes through /park at all, so
 * gating the index would be a guard with twelve ways around it. A layout wraps
 * every child route, which is the difference between fixing the guard and
 * fixing the instance.
 *
 * NOT A MEMBER, NOT OUR BUSINESS. When `getMyPark` returns nothing this passes
 * straight through: each page already says "this is the park area" in its own
 * words, and a terms card is a worse answer to "you are not a park owner" than
 * the sentence that is already there.
 *
 * `hasAccepted` THROWS on a failed read rather than answering "hasn't agreed".
 * A dropped connection must not put the terms in front of somebody who has
 * already accepted them and collect a second acceptance when they tap.
 */
export default async function ParkLayout({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv()) return <>{children}</>;

  // The session is the identity, as everywhere else — `MyPark` describes the
  // park, not the person looking at it.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <>{children}</>;

  const park = await getMyPark();
  if (!park) return <>{children}</>;

  if (await hasAccepted({ userId: user.id }, "tos", TOS_VERSION)) {
    return <>{children}</>;
  }

  return (
    <>
      <TopBar />
      <TermsGate
        heading="Before you run a park here 🌊"
        intro={
          "One read-through, once. There's a section in here about what LakeLife " +
          "does and doesn't do for a park — it never owns your lots, never writes " +
          "your lease, and never handles cash."
        }
        next="/park"
        cta="I agree — take me to my park"
      />
    </>
  );
}
