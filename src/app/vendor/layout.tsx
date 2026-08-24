import { TopBar } from "@/components/Brand";
import { TermsGate } from "@/components/TermsGate";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getMyVendor } from "@/app/vendor/data";
import { hasAccepted } from "@/lib/acceptances";
import { TOS_VERSION } from "@/lib/tos";

/**
 * THE CREW'S GATE, MOVED WHERE IT ACTUALLY GATES.
 *
 * It lived inside `/vendor/page.tsx` and covered exactly that one route, while
 * eight exist — open, schedule, availability, rates, crew, earnings, import.
 * Worse, the card RENDERED VendorNav directly above itself, so the tab strip
 * linking to all seven of the others was sitting on the screen a crew was being
 * asked to accept terms on. Tapping "Open jobs" walked straight past it and
 * claimed a job.
 *
 * That is the same reason the park owner's gate is a layout: a guard with seven
 * ways around it is not a guard. Fix the guard, not the instance.
 *
 * ONLY AN ACTIVE CREW, which is the rule the old gate carried and this keeps.
 * A crew still onboarding accepts at go-live instead — `activateVendor` calls
 * `ensureTos` and refuses to go live without it — so gating them here would
 * put the terms in front of somebody twice and block the checklist that is the
 * only way to reach the acceptance that clears it.
 *
 * NOT A CREW AT ALL: pass through. Every vendor page already explains itself to
 * a visitor who is not one, and a contract is a worse answer than the sentence
 * that is already there.
 */
export default async function VendorLayout({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv()) return <>{children}</>;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <>{children}</>;

  const vendor = await getMyVendor();
  if (!vendor || vendor.status !== "active") return <>{children}</>;

  // Throws rather than answering "hasn't agreed" — a dropped read must not put
  // a crew who already accepted back in front of the agreement, then record a
  // second acceptance when they tap.
  if (await hasAccepted({ userId: user.id }, "tos", TOS_VERSION)) {
    return <>{children}</>;
  }

  return (
    <>
      <TopBar />
      {/* Deliberately WITHOUT VendorNav — it is not even imported here. The
          nav is how the old gate was walked around, and a tab strip a crew
          cannot use yet is an invitation to try. */}
      <TermsGate
        heading={"The ground rules\u00A0🌊"}
        intro={
          "One read-through before your next job. You're an independent business " +
          "here — the work is yours, and so is the money for it."
        }
        next="/vendor"
        cta="I agree — back to my route 🌊"
      />
    </>
  );
}
