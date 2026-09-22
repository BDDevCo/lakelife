/**
 * Small helpers so the app can run and render even before the keys
 * are pasted into .env.local. Instead of crashing, screens can show a
 * friendly "add your keys" message.
 */

export function supabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
}

export function supabaseAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
}

/** True once the Supabase URL + anon key are present. */
export function hasSupabaseEnv(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey());
}

/**
 * TWILIO IS TWO CHANNELS, AND ASKING ABOUT IT AS ONE HID A TWO-MONTH OUTAGE.
 *
 * There used to be a single `hasTwilioEnv()`, and it answered true on the
 * account SID, the auth token and the VERIFY service SID. Every screen that
 * asked it therefore asked the same question — "is Twilio set up?" — of two
 * completely different transports:
 *
 *   THE VERIFY CHANNEL sends the six-digit sign-in and opt-in codes. It goes
 *   out on Twilio's own managed sender pool, needs only the Verify service,
 *   and has worked without interruption the whole time.
 *
 *   THE MESSAGING CHANNEL sends everything else — booking confirmations, crew
 *   dispatch, Autopilot reminders, a park invite. It goes out on our own
 *   number, which carriers will only accept once the A2P 10DLC campaign is
 *   registered.
 *
 * From 19 July to 16 August 2026 the second one was dead: 81 messages sent,
 * ZERO delivered, 66 of them rejected 30034 for an unregistered sender. The
 * only text anybody ever confirmed receiving was a Verify code, and the only
 * predicate in the code said "Twilio: yes". The two facts were indistinguishable
 * for two months because one function answered for both.
 *
 * So they are two questions now, and each caller asks the one it means.
 */

/** The account itself — enough to talk to Twilio at all, and to READ the log. */
export function hasTwilioAccount(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

/** True once the codes can go out: the account plus the Verify service. */
export function hasTwilioVerifyEnv(): boolean {
  return hasTwilioAccount() && Boolean(process.env.TWILIO_VERIFY_SERVICE_SID);
}

/**
 * True once NOTIFICATIONS can go out on a registered sender.
 *
 * A BARE `TWILIO_PHONE_NUMBER` IS NOT ENOUGH, AND THAT IS THE WHOLE POINT OF
 * THIS PREDICATE. A registered A2P campaign attaches to a Messaging Service,
 * and carriers route on the Messaging Service — sending from the number
 * directly leaves the traffic unregistered and rejected, no matter how green
 * the Twilio console looks. `TWILIO_PHONE_NUMBER` alone is what this product
 * had all through the outage, so it is exactly the state that must not answer
 * true here.
 */
export function hasTwilioMessagingEnv(): boolean {
  return hasTwilioAccount() && Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID);
}

/** Which of a channel's variables are missing, BY NAME — never by value. */
export function missingTwilioVars(channel: "verify" | "messaging"): string[] {
  const names = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    channel === "verify" ? "TWILIO_VERIFY_SERVICE_SID" : "TWILIO_MESSAGING_SERVICE_SID",
  ];
  return names.filter((n) => !process.env[n]);
}

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}
