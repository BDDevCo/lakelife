"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { parseCustomers, type ParsedCustomer } from "./import-helpers";

export interface ImportResult {
  ok: boolean;
  error?: string;
  invited?: number;
  skipped?: number;
  skippedReasons?: string[];
}

/** Assert the caller owns a vendors row; return {id, company, status}. */
async function assertMyVendor(): Promise<{ id: string; company: string | null; status: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const { data } = await admin.from("vendors").select("id, company, status").eq("user_id", user.id).maybeSingle();
  if (!data) return null;
  return { id: data.id as string, company: (data.company as string) ?? null, status: data.status as string };
}

const MAX_IMPORT = 200;

/**
 * A crew imports their existing book of business. Each customer is STAGED in
 * customer_imports bound to this crew, and gets a warm, continuity-framed email
 * (from LakeLife on the crew's behalf) inviting them to claim their account —
 * on signup the row materializes into a real property with this crew pre-set as
 * preferred. TCPA-safe: email only (no cold SMS), crew-initiated from an authed
 * session, framed as "your crew moved to LakeLife", each recipient can ignore.
 * Dedup: skips emails that already have an account or an open import elsewhere.
 */
export async function importMyCustomers(pasted: string): Promise<ImportResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };

  const parsed = parseCustomers(pasted ?? "");
  if (parsed.valid.length === 0) {
    return { ok: false, error: "Add at least one customer with an email (one per line)." };
  }
  const rows = parsed.valid.slice(0, MAX_IMPORT);

  const admin = createServiceClient();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const crewName = vendor.company ?? "Your crew";

  let invited = 0;
  const skippedReasons: string[] = [];

  for (const c of rows) {
    const skip = await stageOne(admin, vendor.id, crewName, site, c);
    if (skip) skippedReasons.push(`${c.email}: ${skip}`);
    else invited++;
  }

  return {
    ok: true,
    invited,
    skipped: skippedReasons.length + parsed.invalid.length,
    skippedReasons: [...skippedReasons, ...parsed.invalid.map((x) => `${x.raw}: ${x.reason}`)].slice(0, 20),
  };
}

/** Stage one customer; returns a skip-reason string, or null on success. */
async function stageOne(
  admin: ReturnType<typeof createServiceClient>,
  vendorId: string,
  crewName: string,
  site: string,
  c: ParsedCustomer,
): Promise<string | null> {
  // Already a LakeLife account? Don't re-invite; ops can bind them by hand.
  const { data: existingUser } = await admin.from("users").select("id").ilike("email", c.email).maybeSingle();
  if (existingUser) return "already a LakeLife account";

  // Already staged (by anyone)? The open-email unique index also guards this.
  const { data: openImport } = await admin
    .from("customer_imports")
    .select("id")
    .ilike("invite_email", c.email)
    .eq("status", "pending")
    .maybeSingle();
  if (openImport) return "already invited";

  const { error: insErr } = await admin.from("customer_imports").insert({
    vendor_id: vendorId,
    invite_email: c.email,
    invite_name: c.name || null,
    address: c.address || null,
    phone: c.phone || null,
    status: "pending",
  });
  if (insErr) return insErr.message.includes("duplicate") ? "already invited" : insErr.message;

  const first = (c.name || "there").split(/\s+/)[0];
  void sendEmail({
    to: c.email,
    subject: `${crewName} is now booking through LakeLife`,
    html: `<p>Hi ${first},</p>
<p><b>${crewName}</b> — the crew you already use — has moved their scheduling to LakeLife. Same crew, same work, now with photos of every visit, easy online booking, and no more phone tag.</p>
<p>Claim your account in about 2 minutes${c.address ? ` (we've got your place at ${c.address})` : ""}: <a href="${site}">${site}</a> — sign up with this email (${c.email}).</p>
<p>${crewName} will stay your crew — they'll always be first on your jobs. 🌊</p>
<p style="color:#889;font-size:12px">Didn't expect this? You can ignore this email.</p>`,
  });

  return null;
}

/**
 * Claim any pending customer imports for a freshly-signed-in HOMEOWNER: turn each
 * staged row into a real property they own, with the importing crew pre-set as
 * preferred. Called from the portal front door (same place as crew-invite claim).
 * Idempotent + safe: only materializes rows still 'pending'.
 */
export async function claimCustomerImports(userId: string, userEmail: string | null | undefined): Promise<number> {
  if (!userId || !userEmail) return 0;
  const email = userEmail.trim().toLowerCase();
  const admin = createServiceClient();

  const { data: imports } = await admin
    .from("customer_imports")
    .select("id, vendor_id, address, place_id, lat, lng")
    .ilike("invite_email", email)
    .eq("status", "pending");
  if (!imports || imports.length === 0) return 0;

  let claimed = 0;
  for (const imp of imports) {
    // Materialize the property (owner = the new user), preferred = the crew.
    const { data: prop, error: propErr } = await admin
      .from("properties")
      .insert({
        owner_id: userId,
        address: (imp.address as string) ?? null,
        place_id: (imp.place_id as string) ?? null,
        lat: (imp.lat as number) ?? null,
        lng: (imp.lng as number) ?? null,
        preferred_vendor: imp.vendor_id,
      })
      .select("id")
      .single();
    if (propErr || !prop) continue; // e.g. place_id dedup — leave the import to ops
    await admin
      .from("customer_imports")
      .update({ status: "claimed", claimed_property: prop.id })
      .eq("id", imp.id);
    claimed++;
  }
  return claimed;
}
