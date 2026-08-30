"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import {
  DOC_TYPES, MAX_DOC_BYTES, safeExt, validExpiry, validLatLng, activationGaps,
} from "./onboarding-helpers";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";

export interface OnboardingResult {
  ok: boolean;
  error?: string;
  /** Go-live needs the one-time scroll-and-agree; retry with tosAccepted. */
  needsTos?: boolean;
}

/**
 * Confirm the signed-in user owns a vendors row, and return its id + status.
 * Identity is asserted with the SESSION client (auth.getUser); the row is read
 * with the SERVICE client so RLS can't hide a still-onboarding record. NEVER
 * trust a vendorId sent from the browser.
 */
async function assertMyVendor(): Promise<{ id: string; status: string; user_id: string | null } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  // THROWS on a failed read. `null` from here means "you have no crew account",
  // and every caller below says exactly that out loud — a sentence a dropped
  // connection must never be able to put in front of a crew who has worked
  // these lakes all season. Each caller converts the throw into its own result.
  const data = mustRead(
    "your crew account",
    await admin
      .from("vendors")
      .select("id, status, user_id")
      .eq("user_id", user.id)
      .maybeSingle(),
  );
  if (!data) return null;
  return { id: data.id as string, status: data.status as string, user_id: (data.user_id as string) ?? null };
}

/**
 * Upload a Certificate of Insurance, W-9, or garagekeepers/bailee policy to
 * the private vendor-docs bucket and record its path on the vendor row. The
 * crew's device sends the file in a FormData; a COI or garagekeepers doc must
 * also send a future `expiry` (YYYY-MM-DD) — a standard COI excludes property
 * in the vendor's custody, so storage jobs need this second, separate policy
 * on file (storage-schema design, owner-approved 2026-07-22). The client can
 * ONLY ever move coi_url/coi_expiry/w9_url/garagekeepers_url/garagekeepers_expiry
 * — never status, capacity or payout (those are the service role's / ops' to set).
 */
export async function uploadVendorDoc(kind: "coi" | "w9" | "garagekeepers", form: FormData): Promise<OnboardingResult> {
  // assertMyVendor THROWS when the read fails rather than answer "no crew
  // account". A rejection out of a "use server" action is a blank failure on the
  // crew's phone, so it becomes this action's own result. Nothing written yet.
  let vendor: Awaited<ReturnType<typeof assertMyVendor>> = null;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  // A PAUSED CREW MAY STILL SEND PAPERWORK.
  //
  // This used to refuse them, and the most common reason a crew is paused is a
  // lapsed certificate of insurance — so the one thing that would get them
  // working again was the one thing they were blocked from doing. `reactivateCrew`
  // re-runs `assertRoutable`, which fails on an expired COI, so ops could not
  // lift the pause either. It took a database edit to break the loop.
  //
  // Uploading changes nothing about the pause: it files a document. Only ops
  // can reinstate, and now they have something to reinstate against.
  if (kind !== "coi" && kind !== "w9" && kind !== "garagekeepers") return { ok: false, error: "Unknown document." };

  // COI and garagekeepers both need a valid future expiry BEFORE we store anything.
  let expiry: string | null = null;
  let namedInsured: string | null = null;
  if (kind === "coi" || kind === "garagekeepers") {
    expiry = validExpiry(form.get("expiry"), todayLakeDate());
    const label = kind === "coi" ? "COI" : "garagekeepers policy";
    if (!expiry) return { ok: false, error: `Enter the ${label}'s expiry date — it must be in the future.` };

    // THE NAME ON THE CERTIFICATE (0152). Required, because a policy with no
    // named insured tells us nothing about whose it is.
    const rawName = form.get("named_insured");
    namedInsured = typeof rawName === "string" ? rawName.trim().slice(0, 200) : "";
    if (!namedInsured) {
      return { ok: false, error: `Type the insured business name exactly as it appears on the ${label}.` };
    }
    // A MISMATCH DOES NOT REFUSE THE UPLOAD. The document is filed either way
    // — a genuine DBA is a conversation, and throwing the paperwork away
    // because the legal name differs would make that conversation harder. It
    // becomes an activation gap instead (activationGaps / assertRoutable),
    // which is what "mismatch blocks activation" means.
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No file received." };
  if (!(DOC_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Use a PDF, JPG, PNG, WEBP or HEIC file." };
  }
  if (file.size > MAX_DOC_BYTES) return { ok: false, error: "File is too large (max 10MB)." };

  const admin = createServiceClient();
  const ext = safeExt(file.name);
  const path = `${vendor.id}/${kind}-${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await admin.storage.from("vendor-docs").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (upErr) return { ok: false, error: upErr.message };

  // The confirmation columns are nulled here as well as by 0152's trigger.
  // The trigger is what makes it TRUE for every writer; this is what makes it
  // legible at the place a person will read the code.
  const patch =
    kind === "coi"
      ? {
          coi_url: path, coi_expiry: expiry, coi_named_insured: namedInsured,
          coi_expiry_confirmed_at: null, coi_expiry_confirmed_by: null,
        }
    : kind === "garagekeepers"
      ? {
          garagekeepers_url: path, garagekeepers_expiry: expiry,
          garagekeepers_named_insured: namedInsured,
          garagekeepers_expiry_confirmed_at: null, garagekeepers_expiry_confirmed_by: null,
        }
    : { w9_url: path };
  const { error: rowErr } = await admin.from("vendors").update(patch).eq("id", vendor.id);
  if (rowErr) return { ok: false, error: rowErr.message };
  return { ok: true };
}

/** A short-lived signed URL to view a stored vendor doc (own row only). */
export async function getVendorDocUrl(kind: "coi" | "w9" | "garagekeepers"): Promise<string | null> {
  // DELIBERATELY NOT RETHROWN. This hands a bare `string | null` to an onClick
  // in VendorDocs.tsx that has no catch, so a rejection would be an unhandled
  // one and the crew would see nothing happen at all. The failure is logged by
  // mustRead and becomes `null`, which that button already renders as
  // "Couldn't open that one" — which stays true when the read is what failed.
  try {
    const vendor = await assertMyVendor();
    if (!vendor) return null;
    const admin = createServiceClient();
    const data = mustRead(
      "the document on file",
      await admin
        .from("vendors")
        .select("coi_url, w9_url, garagekeepers_url")
        .eq("id", vendor.id)
        .maybeSingle(),
    );
    const path = (
      kind === "coi" ? data?.coi_url : kind === "garagekeepers" ? data?.garagekeepers_url : data?.w9_url
    ) as string | null;
    if (!path) return null;
    const { data: signed, error: signErr } = await admin.storage.from("vendor-docs").createSignedUrl(path, 3600);
    if (signErr) {
      // Storage, not Postgres, but the same rule as the mustRead above. `null`
      // is the right ANSWER here — the button already renders it as "Couldn't
      // open that one", which stays true when signing is what failed — but the
      // failure was invisible, so a crew reporting they can't open their own
      // COI left no trace anywhere to look at.
      console.error("[read failed] signing the document on file:", signErr);
      return null;
    }
    return signed?.signedUrl ?? null;
  } catch (e) {
    if (e instanceof ReadFailed) return null;
    throw e;
  }
}

/**
 * Store which services this crew does. Every name is whitelisted against the
 * ACTIVE services table (service role select) so a tampered client can't invent
 * work types. Writes vendors.service_types only — nothing else.
 */
export async function setServiceTypes(types: string[]): Promise<OnboardingResult> {
  // assertMyVendor THROWS when the read fails rather than answer "no crew
  // account". A rejection out of a "use server" action is a blank failure on the
  // crew's phone, so it becomes this action's own result. Nothing written yet.
  let vendor: Awaited<ReturnType<typeof assertMyVendor>> = null;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };
  }

  const admin = createServiceClient();
  // A FAILED WHITELIST READ IS NOT AN EMPTY ONE. `svcs ?? []` allowed nothing,
  // so every service the crew had just ticked was filtered away and the update
  // below wrote `service_types: []` and returned ok — the crew read "saved" and
  // silently dropped out of matching for every kind of work they do. Refuse
  // instead: nothing is written at this point.
  const svcsRes = await admin.from("services").select("name").eq("active", true);
  if (svcsRes.error) return { ok: false, error: readFailedMessage("the list of services", svcsRes.error) };
  const allowed = new Set((svcsRes.data ?? []).map((s) => s.name as string));

  const wanted = Array.isArray(types) ? types : [];
  const clean = [...new Set(wanted.filter((t) => typeof t === "string" && allowed.has(t)))];

  const { error } = await admin
    .from("vendors")
    .update({ service_types: clean })
    .eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Clamp to a whole-number daily capacity in the allowed 1–20 range. */
function validCapacity(n: unknown): number | null {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 20) return null;
  return v;
}

/**
 * Crew self-sets how many jobs a day they can take (1–20). Writes
 * vendors.daily_capacity only, own row, via the service role after an identity
 * check — the same trust model as setServiceTypes. This replaces the ops-only
 * setCrewCapacity for the onboarding path.
 */
export async function setDailyCapacity(n: number): Promise<OnboardingResult> {
  // assertMyVendor THROWS when the read fails rather than answer "no crew
  // account". A rejection out of a "use server" action is a blank failure on the
  // crew's phone, so it becomes this action's own result. Nothing written yet.
  let vendor: Awaited<ReturnType<typeof assertMyVendor>> = null;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };

  const cap = validCapacity(n);
  if (cap == null) return { ok: false, error: "Enter a whole number of jobs per day, 1 to 20." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ daily_capacity: cap }).eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Crew self-selects the lakes they service. Every id is whitelisted against the
 * lakes table (service-role select) so a tampered client can't invent a lake or
 * claim one that doesn't exist. Writes vendors.service_lakes only.
 */
export async function setServiceLakes(lakeIds: string[]): Promise<OnboardingResult> {
  // assertMyVendor THROWS when the read fails rather than answer "no crew
  // account". A rejection out of a "use server" action is a blank failure on the
  // crew's phone, so it becomes this action's own result. Nothing written yet.
  let vendor: Awaited<ReturnType<typeof assertMyVendor>> = null;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };

  const admin = createServiceClient();
  // 0124. This whitelist is what stops a crew claiming a lake that isn't real
  // — and a fixture IS real as far as an id check goes, so it passed. Fencing
  // it here is what lets the downstream reads of vendors.service_lakes stay
  // unfenced: nothing can get into the column in the first place.
  const lakesRes = await admin.from("lakes").select("id, name").eq("is_fixture", false);
  // Same shape as setServiceTypes: an unread whitelist allowed nothing, so the
  // crew's chosen lakes all filtered out and they were told "Choose at least one
  // lake you service" having just chosen several. Nothing is written yet.
  if (lakesRes.error) return { ok: false, error: readFailedMessage("the list of lakes", lakesRes.error) };
  const lakes = lakesRes.data;
  const allowed = new Set((lakes ?? []).map((l) => l.id as string));

  const wanted = Array.isArray(lakeIds) ? lakeIds : [];
  let clean = [...new Set(wanted.filter((id) => typeof id === "string" && allowed.has(id)))];
  if (clean.length === 0) return { ok: false, error: "Choose at least one lake you service." };

  // Phase E: a lake the crew is paused on can't be re-added until its
  // cooldown runs out (missing table pre-migration ⇒ no pauses — safe).
  try {
    const { isCoolingDown } = await import("@/lib/lake-standing");
    const { getPlatformSettings } = await import("@/lib/settings");
    const [pausesRes, settings] = await Promise.all([
      admin.from("vendor_lake_demotions").select("lake_id, demoted_at").eq("vendor_id", vendor.id),
      getPlatformSettings(),
    ]);
    // THE GUARD PASSED BECAUSE IT COULDN'T RUN. `pauses ?? []` meant "no pauses",
    // so a crew cooling down off a lake was silently re-added to it and back in
    // the routing pool. A MISSING TABLE still means what the note above says —
    // no pauses exist pre-migration — so 42P01 alone keeps that allowance and
    // every other error refuses. Nothing is written at this point.
    if (pausesRes.error && pausesRes.error.code !== "42P01") {
      return { ok: false, error: readFailedMessage("your lake standing", pausesRes.error) };
    }
    const pauses = pausesRes.data;
    const cooling = new Set(
      (pauses ?? [])
        .filter((p) => isCoolingDown(p.demoted_at as string, settings.lakeDemotionCooldownDays, Date.now()))
        .map((p) => p.lake_id as string),
    );
    const blocked = clean.filter((id) => cooling.has(id));
    if (blocked.length > 0) {
      const nameById = new Map((lakes ?? []).map((l) => [l.id as string, l.name as string]));
      const names = blocked.map((id) => nameById.get(id) ?? "that lake").join(", ");
      clean = clean.filter((id) => !cooling.has(id));
      if (clean.length === 0) {
        return { ok: false, error: `${names} is paused for your crew right now — it reopens automatically. Pick your other lakes for now.` };
      }
    }
  } catch {
    /* pre-migration: no pause table yet — proceed */
  }

  const { error } = await admin.from("vendors").update({ service_lakes: clean }).eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export interface AddLakeResult {
  ok: boolean;
  error?: string;
  lakeName?: string;
}

/**
 * Crew adds a lake they serve that isn't in the onboarding list — demand-born
 * lakes (owner directive 2026-07-23): a crew expanding coverage creates the
 * lake, ops gets an FYI, never a bottleneck. The actual service_lakes write
 * goes through setServiceLakes so the SAME whitelist + Phase E cooldown guard
 * applies — a crew cooling down on this lake gets that same friendly refusal
 * instead of a silent re-add.
 */
export async function addLakeAndServe(rawName: string): Promise<AddLakeResult> {
  // assertMyVendor THROWS when the read fails rather than answer "no crew
  // account". A rejection out of a "use server" action is a blank failure on the
  // crew's phone, so it becomes this action's own result. Nothing written yet.
  let vendor: Awaited<ReturnType<typeof assertMyVendor>> = null;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };

  const { findOrCreateLake } = await import("@/lib/lake-birth");
  const born = await findOrCreateLake(rawName, "crew");
  if (!born.ok || !born.lakeId) return { ok: false, error: born.error ?? "Couldn't add that lake just now." };

  const admin = createServiceClient();
  // THIS READ IS THE WHOLE LIST, AND THE WRITE BELOW REPLACES IT. On a failed
  // read `current` was `[]`, so adding one lake sent setServiceLakes an array of
  // exactly one — ERASING every other lake the crew serves, and reporting
  // success. Nothing is written at this point.
  const vRes = await admin.from("vendors").select("service_lakes").eq("id", vendor.id).maybeSingle();
  if (vRes.error) return { ok: false, error: readFailedMessage("the lakes you already serve", vRes.error) };
  const v = vRes.data;
  const current: string[] = (v?.service_lakes as string[] | null) ?? [];
  if (current.includes(born.lakeId)) {
    return { ok: true, lakeName: born.lakeName }; // already served — nothing to change
  }

  const res = await setServiceLakes([...current, born.lakeId]);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, lakeName: born.lakeName };
}

/**
 * Crew self-sets a home base (from address autocomplete → lat/lng). Optional:
 * it sharpens distance ranking but must NEVER block activation. Coordinates are
 * sanity-bounded (rejects 0,0 and out-of-region typos) before storing.
 */
export async function setBaseLocation(lat: number, lng: number): Promise<OnboardingResult> {
  // assertMyVendor THROWS when the read fails rather than answer "no crew
  // account". A rejection out of a "use server" action is a blank failure on the
  // crew's phone, so it becomes this action's own result. Nothing written yet.
  let vendor: Awaited<ReturnType<typeof assertMyVendor>> = null;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };

  const base = validLatLng(lat, lng);
  if (!base) return { ok: false, error: "That location didn't look right — pick your town from the list." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ base_lat: base.lat, base_lng: base.lng }).eq("id", vendor.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * ZERO-OPS SELF-ACTIVATION (Phase A). The crew flips THEMSELVES from 'invited'
 * to 'active' the moment their documents + declarations clear the mechanical
 * gate — no ops approval. Every requirement is re-checked SERVER-SIDE against a
 * fresh service-role read (never trust the browser). A suspended crew can never
 * self-reactivate here (that stays an ops-only override), and verified_at is
 * stamped for the annual COI re-validation cycle.
 *
 * Note: this proves the docs are present, typed, and unexpired — not that the
 * COI is authentic. Authenticity is carried by the onboarding agreement + the
 * yearly re-attest + a future third-party verification callback.
 */
export async function finishOnboarding(tosAccepted?: boolean): Promise<OnboardingResult> {
  // assertMyVendor THROWS when the read fails rather than answer "no crew
  // account". A rejection out of a "use server" action is a blank failure on the
  // crew's phone, so it becomes this action's own result. Nothing written yet.
  let vendor: Awaited<ReturnType<typeof assertMyVendor>> = null;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "active") return { ok: true }; // already live — idempotent

  // THE AGREEMENT at go-live: crews accept the same terms — independent
  // businesses, responsible and liable for the work they provide.
  const { ensureTos } = await import("@/lib/tos-server");
  // Caught for the same reason assertMyVendor is, twenty lines up: ensureTos
  // asks the acceptance ledger and throws ReadFailed rather than answering
  // "hasn't agreed" on a dropped read.
  if (vendor.user_id) {
    let tos: "ok" | "needs" | "failed";
    try {
      tos = await ensureTos(vendor.user_id, tosAccepted);
    } catch (e) {
      if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your terms acceptance", e) };
      throw e;
    }
    if (tos === "failed") {
      return { ok: false, error: "We couldn't record your agreement just now — you're not live yet. Try once more." };
    }
    if (tos === "needs") return { ok: false, needsTos: true };
  }

  const admin = createServiceClient();
  const vRes = await admin
    .from("vendors")
    .select("coi_url, coi_expiry, coi_named_insured, company, w9_url, service_types, service_lakes, daily_capacity")
    .eq("id", vendor.id)
    .maybeSingle();
  // The refusal below asserts the account does not exist. On a failed read it
  // said that on the last screen of onboarding to a crew whose paperwork is
  // complete and filed. Nothing is written until the status flip further down.
  if (vRes.error) return { ok: false, error: readFailedMessage("your onboarding paperwork", vRes.error) };
  const v = vRes.data;
  if (!v) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };

  const gaps = activationGaps(
    {
      coi_url: (v.coi_url as string | null) ?? null,
      coi_expiry: (v.coi_expiry as string | null) ?? null,
      coi_named_insured: (v.coi_named_insured as string | null) ?? null,
      company: (v.company as string | null) ?? null,
      w9_url: (v.w9_url as string | null) ?? null,
      service_types: (v.service_types as string[] | null) ?? [],
      service_lakes: (v.service_lakes as string[] | null) ?? [],
      daily_capacity: (v.daily_capacity as number | null) ?? null,
    },
    todayLakeDate(),
  );
  if (gaps.length > 0) return { ok: false, error: gaps[0] };

  const { error } = await admin
    .from("vendors")
    .update({ status: "active", verified_at: new Date().toISOString() })
    .eq("id", vendor.id)
    .eq("status", "invited"); // guard: only invited→active, never resurrect a suspension
  if (error) return { ok: false, error: error.message };

  // SUPPLY JUST ARRIVED: sweep the waitlist right now — customers stuck in
  // "Finding a crew" on this crew's lakes shouldn't wait for tonight's cron.
  try {
    const { sweepWaitlist } = await import("@/lib/automation");
    await sweepWaitlist();
  } catch {
    /* nightly sweep is the backstop */
  }
  return { ok: true };
}
