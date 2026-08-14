import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { getRenterHome } from "@/app/parks/my-data";
import { RenterHome } from "@/components/RenterHome";

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
