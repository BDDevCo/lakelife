"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";
import { validateSelection, anchorServiceId } from "@/lib/packages";
import { todayLakeDate } from "@/lib/booking";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { autoAssignJob } from "@/app/book/dispatch";
import { getPackageViews } from "./data";

export interface PackageBookingResult {
  ok: boolean;
  error?: string;
  needsVerification?: boolean;
  /** Honest cold-start state: booked, no crew locked yet — we hunt. */
  findingCrew?: boolean;
}

/**
 * Book a storage/winterize package: ONE season envelope (job_group), ONE
 * fall visit job with per-component line items, and the SPRING selection
 * held on the envelope (the spring job is born at ice-out — S4 — so no
 * phantom far-future job ever pollutes the waitlist/expiry machinery).
 *
 * Money truth: everything is re-derived server-side — the recipe from the
 * DB, the legality from validateSelection, every price from priceService
 * against THIS property. The client's numbers are display-only.
 */
export async function createPackageBooking(input: {
  packageId: string;
  selectedServiceIds: string[]; // "serviceId" or "serviceId|phase" keys
  fallDate: string; // YYYY-MM-DD
  agreementAccepted: boolean;
}): Promise<PackageBookingResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // RULE 5: working email AND SMS-verified mobile before any booking.
  const { data: me } = await supabase
    .from("users")
    .select("email_verified, phone_verified, phone, email")
    .eq("id", user.id)
    .maybeSingle();
  const emailOk = (me?.email_verified ?? false) || Boolean(user.email_confirmed_at);
  const phoneOk = me?.phone_verified ?? false;
  if (!emailOk || !phoneOk) {
    return { ok: false, needsVerification: true, error: "One quick step first: verify your contact info, then you're ready to book." };
  }

  const profile = await getFullProfile();
  if (!profile?.hasProfile || !profile.propertyId) return { ok: false, error: "Set up your property first." };
  if (!profile.boats.length) return { ok: false, error: "Add your boat to your property profile first — storage is priced by it." };

  // Server-truth recipe + prices; the wizard's copy of both is display-only.
  const pkgs = await getPackageViews(toPricingProfile(profile));
  const pkg = pkgs.find((p) => p.id === input.packageId);
  if (!pkg) return { ok: false, error: "That package isn't available." };

  const sel = validateSelection(pkg, input.selectedServiceIds);
  if (!sel.ok) return { ok: false, error: sel.error };
  if (sel.fall.length === 0) return { ok: false, error: "Nothing selected for the fall visit." };
  if (sel.storageTierId && !input.agreementAccepted) {
    return { ok: false, error: "Please agree to the winter storage terms first." };
  }

  // Date sanity: future date, and inside the water window when the fall
  // visit touches the lake (haul/return are water work; shop work isn't).
  const today = todayLakeDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fallDate) || input.fallDate <= today) {
    return { ok: false, error: "Pick a date at least a day out — storage runs are planned, not same-day." };
  }
  const admin = createServiceClient();
  const { data: propRow } = await admin
    .from("properties")
    .select("lake_id, lakes(name, ice_out_actual, pull_deadline)")
    .eq("id", profile.propertyId)
    .maybeSingle();
  const lake = (Array.isArray(propRow?.lakes) ? propRow?.lakes[0] : propRow?.lakes) as
    | { name?: string; ice_out_actual?: string; pull_deadline?: string } | undefined;
  const { data: fallSvcRows } = await admin
    .from("services").select("id, is_water_work").in("id", sel.fall);
  const touchesWater = (fallSvcRows ?? []).some((s) => s.is_water_work);
  if (touchesWater && lake?.pull_deadline && input.fallDate > lake.pull_deadline) {
    return { ok: false, error: `That's past ${lake.name ?? "your lake"}'s pull deadline (${lake.pull_deadline}) — the water work has to happen before the freeze window.` };
  }

  const anchor = anchorServiceId(pkg, "fall", sel.fall);
  if (!anchor) return { ok: false, error: "Nothing selected for the fall visit." };
  const priceOf = new Map(pkg.components.map((c) => [`${c.serviceId}|${c.phase}`, c.price]));

  // 1) The season envelope.
  const { data: group, error: groupErr } = await admin
    .from("job_groups")
    .insert({
      property_id: profile.propertyId,
      package_id: pkg.id,
      storage_service_id: sel.storageTierId,
      spring_service_ids: sel.spring,
      spring_quote: sel.springTotal,
    })
    .select("id")
    .single();
  if (groupErr || !group) return { ok: false, error: groupErr?.message ?? "Could not start the booking." };

  // 2) The fall visit job (anchor service; items carry the full breakdown).
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .insert({
      property_id: profile.propertyId,
      service_id: anchor,
      date: input.fallDate,
      frequency: "One-time (fall)",
      status: "requested",
      customer_price: sel.fallTotal,
      group_id: group.id,
      phase: "fall",
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    await admin.from("job_groups").delete().eq("id", group.id);
    return { ok: false, error: jobErr?.message ?? "Could not book that." };
  }
  await admin.from("job_groups").update({ fall_job_id: job.id }).eq("id", group.id);
  const { error: itemsErr } = await admin.from("job_items").insert(
    sel.fall.map((sid) => ({
      job_id: job.id,
      service_id: sid,
      customer_price: priceOf.get(`${sid}|fall`) ?? 0,
      vendor_cost: 0,
    })),
  );
  if (itemsErr) {
    await admin.from("jobs").delete().eq("id", job.id);
    await admin.from("job_groups").delete().eq("id", group.id);
    return { ok: false, error: itemsErr.message };
  }

  // 3) Route it. Same honesty rules as every booking: a genuinely-full day
  //    backs out; "no crew yet" confirms as a Finding-a-crew waitlist row.
  let assigned = false;
  try {
    const outcome = await autoAssignJob(job.id as string);
    assigned = outcome.assigned;
    if (!outcome.assigned && outcome.decision.reasonNoFit === "all_full_or_blocked") {
      await admin.from("jobs").delete().eq("id", job.id);
      await admin.from("job_groups").delete().eq("id", group.id);
      return { ok: false, error: "That day just filled up — pick another date." };
    }
  } catch {
    /* leave as requested; the sweeps keep hunting */
  }

  // 4) Honest confirmations, including the split-billing promise.
  const pretty = new Date(input.fallDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const springLine = sel.spring.length > 0
    ? ` Spring work (~$${sel.springTotal.toLocaleString()}) is quoted now and billed at splash.`
    : "";
  if (me?.phone) {
    void sendSms(
      me.phone,
      assigned
        ? `LakeLife: ${pkg.name} is booked for ${pretty} — $${sel.fallTotal.toLocaleString()} for the fall visit, charged only when it's done and photo-verified.${springLine} 🌊`
        : `LakeLife: got it — ${pkg.name} for ${pretty}. We're lining up the right crew now (storage needs the right barn and insurance) and you'll hear the moment one's locked in. You're never charged until the work is done.${springLine} 🌊`,
    );
  }
  if (me?.email) {
    void sendEmail({
      to: me.email,
      subject: `Booked: ${pkg.name} 🌊`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#20343d">
          <h2>Winter's handled.</h2>
          <p><b>${pkg.name}</b> — fall visit ${pretty}</p>
          <p style="color:#5D7681">Fall visit: <b>$${sel.fallTotal.toLocaleString()}</b>, charged after the work is complete and photos are in.${springLine ? `<br>${springLine.trim()}` : ""}</p>
          ${sel.storageTierId ? `<p style="color:#5D7681;font-size:13px">Storage season runs through May 31 — after that a small per-day charge applies until pickup. Condition photos at every hand-off; balance due before spring splash.</p>` : ""}
        </div>`,
    });
  }

  return { ok: true, findingCrew: !assigned };
}
