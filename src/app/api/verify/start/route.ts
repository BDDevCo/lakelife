import { NextResponse } from "next/server";
import twilio from "twilio";
import { createClient } from "@/lib/supabase/server";
import { hasTwilioEnv } from "@/lib/env";
import { toE164 } from "@/lib/phone";

/**
 * POST /api/verify/start  { phone }
 * Sends a 6-digit SMS code via Twilio Verify to the logged-in user's mobile.
 */
export async function POST(request: Request) {
  // Must be signed in first (SSO or email) — matches CLAUDE.md rule 5 order.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }

  const { phone } = await request.json().catch(() => ({ phone: "" }));
  const e164 = toE164(String(phone ?? ""));
  if (!e164) {
    return NextResponse.json(
      { error: "That doesn't look like a valid US mobile number." },
      { status: 400 },
    );
  }

  // If Twilio isn't configured yet, don't crash — tell the UI so it can
  // show a friendly note. (Lets you click through before keys are in.)
  if (!hasTwilioEnv()) {
    return NextResponse.json(
      { error: "Twilio isn't configured yet. Add your Twilio keys to .env.local.", needsKeys: true },
      { status: 503 },
    );
  }

  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!,
    );
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verifications.create({ to: e164, channel: "sms" });

    return NextResponse.json({ ok: true, sentTo: e164 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not send the code.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
