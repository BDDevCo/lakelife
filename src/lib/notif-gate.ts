import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { staticGate, defaultFor, type Channel } from "@/lib/notif-prefs";

/**
 * DOES THIS PERSON WANT THIS MESSAGE?
 *
 * The settings screen has offered six notification switches since the start.
 * Two separate actions wrote them to `notification_prefs`. And NOTHING ON ANY
 * SEND PATH EVER READ THEM — the only two readers in the codebase filter
 * `type='growth'`, which is not one of the six. Every booking confirmation,
 * service-day reminder, completion text and seasonal email went out
 * unconditionally.
 *
 * So a customer who turned texts off kept getting texts. That is worse than
 * having no switch at all: a switch that does nothing is a promise broken
 * every time it is tested, and it is the kind of thing that ends up in a
 * complaint rather than a support ticket.
 *
 * THE DEFAULT IS THE DEF'S DEFAULT, NOT SILENCE. A customer who has never
 * opened the settings screen has no rows at all, and must still hear from us
 * about the crew arriving tomorrow.
 *
 * A LOCKED TYPE IGNORES THE SWITCH ENTIRELY. Receipts and invoices are records
 * of money changing hands; they are not marketing and are not optional.
 *
 * FAILS OPEN, DELIBERATELY. If the preference lookup errors, the message goes.
 * A database hiccup silently swallowing "your crew arrives at 8am" is a worse
 * failure than one unwanted text — and a swallowed send leaves no trace, which
 * is exactly the class of bug this whole audit kept finding.
 */
export async function allowsNotification(
  userId: string | null | undefined,
  type: string,
  channel: Channel,
): Promise<boolean> {
  if (!userId) return false;

  const decision = staticGate(type, channel);
  if (decision !== "consult") return decision === "allow";

  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("notification_prefs")
      .select("enabled")
      .eq("user_id", userId)
      .eq("type", type)
      .eq("channel", channel)
      .maybeSingle();
    if (error) return true;              // fail open — see above
    if (!data) return defaultFor(type);  // never touched the screen
    return data.enabled !== false;
  } catch {
    return true;
  }
}
