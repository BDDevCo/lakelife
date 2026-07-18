"use server";

import { createClient } from "@/lib/supabase/server";
import { getFullProfile, getPricedServices } from "./data";
import { formatPrice } from "@/lib/pricing";

/**
 * Send the warm setup recap as a welcome email via Resend.
 * No-ops gracefully if Resend isn't configured yet, so the wizard never
 * fails just because email is unavailable.
 *
 * Note: until the sending domain (lakelife.ai) is verified in Resend, this
 * sends from Resend's shared onboarding address, which only delivers to the
 * Resend account owner's own email in test mode. Verify the domain before beta.
 */
export async function sendWelcomeEmail(): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, skipped: true };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, error: "No email on file." };

  const profile = await getFullProfile();
  if (!profile?.hasProfile) return { ok: false, error: "No profile to summarize." };
  const services = await getPricedServices(profile);

  const priceOf = (name: string) => services.find((s) => s.name === name)?.price ?? 0;

  const rows: Array<[string, string]> = [
    ["Your house", `${profile.sqft.toLocaleString()} sq ft, ${profile.beds} bd / ${profile.baths} ba — housekeeping ${formatPrice(priceOf("Housekeeping"))} / visit`],
    ["Your pier", `${profile.pier_sections} sections — ${formatPrice(priceOf("Pier install / removal"))} per install or pull`],
    ["Your lifts", `${profile.boat_lifts} boat lift${profile.boat_lifts === 1 ? "" : "s"}${profile.pwc_lifts ? `, ${profile.pwc_lifts} PWC lift${profile.pwc_lifts === 1 ? "" : "s"}` : ""} — ${formatPrice(priceOf("Boat lift set / pull"))} per set or pull`],
    ["Your fleet", profile.boats.length ? `${profile.boats.map((b) => `${b.length_ft}' ${b.type}`).join(", ")} — ${formatPrice(priceOf("Boat storage & winterize"))} / season` : "No boats on file yet"],
    ["The lawn", `${profile.lawn_band} — ${formatPrice(priceOf("Lawn mowing & trim"))} mow & blow, weekly`],
  ];

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#20343d">
    <div style="background:#0A2430;padding:20px 24px;border-radius:14px 14px 0 0">
      <span style="color:#fff;font-size:20px;font-weight:800">Lake<span style="color:#E9B44C">Life</span></span>
    </div>
    <div style="border:1px solid #DCE9EC;border-top:none;border-radius:0 0 14px 14px;padding:24px">
      <h1 style="font-size:22px;margin:0 0 4px">Your place is all set${profile.address ? `, ${profile.address}` : ""}.</h1>
      <p style="color:#5D7681;font-size:14px;margin:0 0 18px">Every price below is exact to your property. We coordinate it all — you just pick the dates.</p>
      ${rows.map(([t, d]) => `<div style="padding:10px 0;border-bottom:1px dashed #DCE9EC"><b style="font-size:14px">${t}</b><div style="color:#5D7681;font-size:13px">${d}</div></div>`).join("")}
      <p style="color:#5D7681;font-size:12.5px;margin-top:18px">On ${profile.lake ?? "your lake"} · water work is scheduled around ice-out and the fall pull deadline automatically.</p>
    </div>
  </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "LakeLife <onboarding@resend.dev>",
        to: [user.email],
        subject: "Your LakeLife property is set up 🌊",
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
