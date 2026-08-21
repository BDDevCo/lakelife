import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { myAgreements } from "@/app/agreements/data";
import { MyAgreements } from "@/components/MyAgreements";

export const metadata = { title: "What you've agreed to — LakeLife" };

/**
 * ONE PAGE, EVERY ROLE.
 *
 * A homeowner, a crew, a park owner and a resident all accept the same
 * document, in four different places. They get one screen to read it back
 * from, scoped by the session rather than by role — so it needs no idea which
 * of the four is looking at it.
 */
export default async function AgreementsPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const view = await myAgreements();

  if (!view) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: 20, margin: "0 0 6px" }}>Sign in to see this</h2>
            <p className="mut" style={{ fontSize: 13.5, margin: "0 0 12px", lineHeight: 1.6 }}>
              What you&apos;ve agreed to is tied to your account.
            </p>
            <Link className="ll-btn" href="/">Sign in</Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <MyAgreements view={view} />
    </>
  );
}
