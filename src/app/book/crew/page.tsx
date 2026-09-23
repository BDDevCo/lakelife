import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile, getPricedServices } from "@/app/profile/data";
import { nextDayISO, todayLakeDate } from "@/lib/booking";
import { CrewPicker } from "@/components/CrewPicker";

/**
 * CHOOSE YOUR CREW — the screen where the buyer sees every option.
 *
 * Brendon, 23 September 2026: "the owner needing the service should still see
 * all the options, if any, for the crews available and their pricing... then
 * they make the decision."
 *
 * ONE SCREEN, BOTH CUSTOMERS. A park is a customer like any other (0176), and
 * a park owner's profile IS their grounds property — the same fact that lets
 * /book serve both — so nothing here branches on who is looking.
 *
 * The property is resolved SERVER-SIDE from the signed-in session and never
 * taken from the URL. The offers themselves come from `loadCrewOffers`, which
 * proves ownership again at its own door.
 */
export default async function ChooseCrewPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string; date?: string }>;
}) {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }
  const sp = await searchParams;

  const profile = await getFullProfile();
  if (!profile?.hasProfile || !profile.propertyId) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad">
            <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>Set up your place first</h2>
            <p className="mut" style={{ fontSize: 14 }}>
              We price every crew against your property, so we need it on file before we can
              show you who can do the work and what they charge.
            </p>
            <Link className="ll-btn gold" href="/profile/setup">Start guided setup →</Link>
          </div>
        </div>
      </>
    );
  }

  const priced = await getPricedServices(profile);
  // THE FIRST DAY THIS SCREEN CAN SELL. Crew-priced work is refused same-day
  // by name (book/actions.ts), so defaulting to today drew a full list of
  // crews, prices and live Choose buttons on which every tap failed.
  const earliest = nextDayISO(todayLakeDate());
  // CREW-PRICED ONLY, and that is not a filter for tidiness: on a menu-priced
  // service the price is LakeLife's and identical whoever comes, so there is
  // nothing to choose between and the router picks — that path is deliberately
  // untouched. Offering a choice there would be a screen that lies.
  const choosable = priced.filter((s) => s.crewPriced);
  // A PARK SERVICE WAITING ON HIS PRICE IS NOT "ONE LAKELIFE PRICE".
  //
  // The empty sentence below claimed every service on the list has a single
  // LakeLife price and that we line up the crew. For The Haven's grounds that
  // list contains snow clearing and both common-area cleanups — active,
  // park_only, and carrying NO park rate at all. LakeLife has no price for
  // those and there is no crew behind the snow one. /book already says so in
  // its own words; the same count, the same sentence, so the two screens
  // cannot tell him different things about the same services.
  const parkUnpricedCount =
    priced.filter((s) => s.parkUnpriced && s.price <= 0 && !s.crewPriced).length;
  const service = sp.service ? choosable.find((s) => s.id === sp.service) : null;

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 0, paddingBottom: 48 }}>
        <h1 style={{ fontSize: 26 }}>Choose your crew</h1>
        <p className="mut" style={{ fontSize: 14, margin: "0 0 18px", maxWidth: 620 }}>
          Every crew who can do the work on your day, with the price each one charges for
          your place. You pick.
        </p>

        {!service ? (
          choosable.length === 0 ? (
            <div className="ll-card ll-card-pad">
              {/* HONEST, AND IT DOES NOT BLAME THE BENCH OR THE BUYER. Today
                  no service is crew-priced at all, so this is what this screen
                  says in production right now. */}
              <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Nothing to choose between yet</h3>
              <p className="mut" style={{ fontSize: 14, margin: 0 }}>
                None of the services on your list is priced by the crew who does it, so there is
                nothing to compare here yet.{" "}
                <Link href="/book">Back to booking</Link>.
              </p>
              {parkUnpricedCount > 0 && (
                <p className="ll-notice" style={{ fontSize: 13.5, margin: "12px 0 0" }}>
                  {parkUnpricedCount === 1
                    ? "One more service is available for the park and is waiting on your price."
                    : `${parkUnpricedCount} more services are available for the park and are waiting on your price.`}{" "}
                  Every park pays its own number for these, so we will not put one here.{" "}
                  <Link href="/park/services">Set your rates</Link>.
                </p>
              )}
            </div>
          ) : (
            <div className="ll-card ll-card-pad">
              <h3 style={{ fontSize: 16, margin: "0 0 10px" }}>Which job?</h3>
              <div style={{ display: "grid", gap: 8 }}>
                {choosable.map((s) => (
                  <Link key={s.id} className="ll-btn" href={`/book/crew?service=${s.id}`} style={{ textAlign: "left" }}>
                    {s.name} →
                  </Link>
                ))}
              </div>
            </div>
          )
        ) : (
          <CrewPicker
            propertyId={profile.propertyId}
            serviceId={service.id}
            serviceName={service.name}
            frequencyOptions={service.frequency_options ?? []}
            earliestDate={earliest}
            // A LINKED-IN DATE IS STILL CLAMPED. `?date=` arrives from a link,
            // and a past or same-day one would list live prices nobody can buy.
            initialDate={sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) && sp.date >= earliest ? sp.date : earliest}
          />
        )}
      </div>
    </>
  );
}
