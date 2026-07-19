import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { loadNotifPrefs } from "./actions";
import { NotifPrefs } from "./NotifPrefs";

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

  const prefs = await loadNotifPrefs();

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 620 }}>
        <h1 style={{ fontSize: 26, marginBottom: 6 }}>Notification settings</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
          Turn each update on or off per channel. Changes save as you tap.
        </p>
        <NotifPrefs initial={prefs} />
      </div>
    </>
  );
}
