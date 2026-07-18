import { NextResponse } from "next/server";
import twilio from "twilio";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { hasTwilioEnv } from "@/lib/env";
import { toE164 } from "@/lib/phone";

/**
 * POST /api/verify/check  { phone, code }
 * Confirms the SMS code with Twilio. On success, records the mobile as
 * verified on the user's profile — the second half of the "email AND
 * SMS-verified before booking" rule (CLAUDE.md rule 5).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }

  const { phone, code } = await request.json().catch(() => ({}));
  const e164 = toE164(String(phone ?? ""));
  if (!e164 || !code) {
    return NextResponse.json({ error: "Missing phone or code." }, { status: 400 });
  }

  if (!hasTwilioEnv()) {
    return NextResponse.json(
      { error: "Twilio isn't configured yet.", needsKeys: true },
      { status: 503 },
    );
  }

  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!,
    );
    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verificationChecks.create({ to: e164, code: String(code) });

    if (check.status !== "approved") {
      return NextResponse.json(
        { error: "That code didn't match. Try again or resend." },
        { status: 400 },
      );
    }

    // Code is good — mark the phone verified. Use the service client so this
    // trusted write isn't blocked by row-level security, but scope it strictly
    // to the currently-signed-in user's own row.
    const admin = createServiceClient();
    const { error } = await admin
      .from("users")
      .update({ phone: e164, phone_verified: true })
      .eq("id", user.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
