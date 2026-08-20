import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { loadNotifPrefs } from "./actions";
import { NotifPrefs } from "./NotifPrefs";
import { OwnerHeader } from "@/components/OwnerHeader";
import { VendorNav } from "@/components/VendorNav";
import { listProperties } from "@/app/profile/data";
import { getMyVendorId } from "@/app/vendor/data";

export default async function NotificationSettingsPage() {
  if (!hasSupabaseEnv()) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad">Add your Supabase keys to <code>.env.local</code> first.</div>
        </div>
      </>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in to manage notifications</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  // THIS PAGE WAS A ROOM WITH NO DOORS.
  //
  // In the prototype these switches are a card ON the property-profile screen,
  // so there was always a way back. Splitting them onto their own route lost
  // that: every render was a TopBar and nothing else. A customer who taps
  // "Notification settings →" from their profile, or the "Manage
  // notifications" line at the foot of one of our emails, arrives at a screen
  // whose only exit is the logo.
  //
  // AND NOT EVERYONE WHO ARRIVES IS A HOMEOWNER. Two of the crew emails carry
  // that same footer (the referral-earnings note and the fill-in-rates note),
  // so a crew clicking it lands on six switches about bookings, service days
  // and approvals — none of which govern a single message we send them. Six
  // toggles that look like they would is worse than none: they would turn them
  // off and keep getting the mail.
  const [prefs, properties, vendorId] = await Promise.all([
    loadNotifPrefs(),
    listProperties(),
    getMyVendorId(),
  ]);
  // Having a property is what makes these switches yours — an account can be
  // both, and then it is the homeowner half these govern.
  //
  // Both reads throw rather than returning empty, and that is load-bearing: a
  // swallowed failure on `listProperties` would hand a homeowner the crew
  // message and hide the switches they came here to change. Wrong screen beats
  // no screen only if the screen is right.
  const isCustomer = properties.length > 0;
  const crewOnly = !isCustomer && vendorId !== null;

  return (
    <>
      <TopBar />
      {isCustomer ? <OwnerHeader /> : crewOnly ? <VendorNav /> : null}
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 620 }}>
        <h1 style={{ fontSize: 26, marginBottom: 6 }}>Notification settings</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
          Turn each update on or off per channel. Changes save as you tap.
        </p>
        {crewOnly ? (
          <div className="ll-card ll-card-pad">
            <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>These are a homeowner&apos;s updates</h2>
            <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
              The switches on this page cover what we send the people who book work —
              booking confirmations, service-day reminders, completion photos. None of
              them change what we send you about your own jobs, so there is nothing
              here for you to set yet. If our mail to you is landing wrong, tell us and
              we&apos;ll sort it.
            </p>
            <p style={{ fontSize: 14, marginTop: 12, marginBottom: 0 }}>
              <Link href="/vendor">Back to your route →</Link>
            </p>
          </div>
        ) : (
          <NotifPrefs initial={prefs} />
        )}
      </div>
    </>
  );
}
