"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { likeLiteral } from "@/lib/sql-like";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { parseCustomers, type ParsedCustomer } from "./import-helpers";

export interface ImportResult {
  ok: boolean;
  error?: string;
  invited?: number;
  skipped?: number;
  skippedReasons?: string[];
  /** Staged fine, but the invitation email was refused — see stageOne. */
  notEmailed?: string[];
}

/**
 * Assert the caller owns a vendors row; return {id, company, status}.
 *
 * `null` means ONE thing: there is no crew account. A failed read THROWS
 * instead — "Your crew account isn't set up yet — call dispatch" said to a crew
 * who has been working these lakes all season sends them to the phone over a
 * dropped connection. importMyCustomers turns the throw into a sentence.
 */
async function assertMyVendor(): Promise<{ id: string; company: string | null; status: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const data = mustRead(
    "your crew account",
    await admin.from("vendors").select("id, company, status").eq("user_id", user.id).maybeSingle(),
  );
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
  let vendor: Awaited<ReturnType<typeof assertMyVendor>>;
  try {
    vendor = await assertMyVendor();
  } catch (e) {
    return { ok: false, error: readFailedMessage("your crew account", e) };
  }
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };

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
  const notEmailed: string[] = [];

  for (const c of rows) {
    const r = await stageOne(admin, vendor.id, crewName, site, c);
    if (r.skip) skippedReasons.push(`${c.email}: ${r.skip}`);
    else {
      invited++;
      // Staged, but nobody was told. Counted separately rather than folded
      // into `invited`, because the crew's next question is "who do I chase".
      if (!r.emailed) notEmailed.push(c.email);
    }
  }

  return {
    ok: true,
    invited,
    skipped: skippedReasons.length + parsed.invalid.length,
    skippedReasons: [...skippedReasons, ...parsed.invalid.map((x) => `${x.raw}: ${x.reason}`)].slice(0, 20),
    notEmailed,
  };
}

/**
 * Stage one customer.
 *
 * Returns `{ skip }` when the row did not stage at all, and `{ emailed }` for
 * one that did — because since 0126 those are different failures and only one
 * of them used to be visible.
 *
 * THE SEND USED TO BE `void`ed. That was harmless while sendEmail could only
 * fail on a transport error, and stopped being harmless the moment it grew a
 * recipient gate: a refused address returns {ok:false}, the row still staged
 * fine, and the crew was told "50 invited" while some number of those people
 * were never written to. A staged customer who never got the email cannot
 * claim their account and has no idea they were meant to — and a retry says
 * "already invited", so it is not self-correcting either.
 */
async function stageOne(
  admin: ReturnType<typeof createServiceClient>,
  vendorId: string,
  crewName: string,
  site: string,
  c: ParsedCustomer,
): Promise<{ skip?: string; emailed?: boolean }> {
  // Already a LakeLife account? Don't re-invite; ops can bind them by hand.
  // users.email comes from Supabase auth, so case is not ours to promise:
  // case-insensitive, wildcards escaped.
  const existingRes = await admin.from("users").select("id").ilike("email", likeLiteral(c.email)).maybeSingle();
  // BOTH DEDUP READS FAIL OPEN IF SWALLOWED — `null` reads as "no account" and
  // "not staged", so the insert below runs anyway. For this one there is no
  // backstop: it stages a row against somebody who already has a LakeLife
  // account and emails them "claim your account", while the crew is told they
  // were invited. Skipping leaves the customer untouched, so simply re-running
  // the import picks them up.
  if (existingRes.error) {
    console.error("[read failed] whether this customer already has an account:", existingRes.error);
    return { skip: "couldn't check this one just now — not invited, try again" };
  }
  const existingUser = existingRes.data;
  if (existingUser) return { skip: "already a LakeLife account" };

  // Already staged (by anyone)? The open-email unique index also guards this.
  const openRes = await admin
    .from("customer_imports")
    .select("id")
    .eq("invite_email", c.email)
    .eq("status", "pending")
    .maybeSingle();
  if (openRes.error) {
    console.error("[read failed] whether this customer is already staged:", openRes.error);
    return { skip: "couldn't check this one just now — not invited, try again" };
  }
  const openImport = openRes.data;
  if (openImport) return { skip: "already invited" };

  const { error: insErr } = await admin.from("customer_imports").insert({
    vendor_id: vendorId,
    invite_email: c.email,
    invite_name: c.name || null,
    address: c.address || null,
    phone: c.phone || null,
    status: "pending",
  });
  if (insErr) return { skip: insErr.message.includes("duplicate") ? "already invited" : insErr.message };

  const first = (c.name || "there").split(/\s+/)[0];
  const sent = await sendEmail({
    to: c.email,
    subject: `${crewName} is now booking through LakeLife`,
    html: `<p>Hi ${first},</p>
<p><b>${crewName}</b> — the crew you already use — has moved their scheduling to LakeLife. Same crew, same work, now with photos of every visit, easy online booking, and no more phone tag.</p>
<p>Claim your account in about 2 minutes${c.address ? ` (we've got your place at ${c.address})` : ""}: <a href="${site}">${site}</a> — sign up with this email (${c.email}).</p>
<p>${crewName} will stay your crew — they'll always be first on your jobs. 🌊</p>
<p style="color:#889;font-size:12px">Didn't expect this? You can ignore this email.</p>`,
  });

  return { emailed: sent.ok };
}

/**
 * Claim any pending customer imports for a freshly-signed-in HOMEOWNER: turn each
 * staged row into a real property they own, with the importing crew pre-set as
 * preferred. Called from the portal front door (same place as crew-invite claim).
 * Idempotent + safe: only materializes rows still 'pending'.
 *
 * THE STAGED EMAIL IS THE CREDENTIAL, SO IT HAS TO COME FROM THE SESSION.
 *
 * Same hole as `claimCrewInvite`, and the same fix. This file carries
 * "use server", so this export is a POST endpoint and both arguments came from
 * the caller. Passing somebody else's staged address with your OWN user id
 * materialized THEIR house — street address, coordinates, their crew — as a
 * property owned by you, visible in your portal, and burned the staged row so
 * the person it was actually meant for could never claim it.
 *
 * The session decides. The arguments must agree with it; the portal passes
 * exactly these two values from its own getUser(), so the real path is
 * unchanged.
 */
export async function claimCustomerImports(userId: string, userEmail: string | null | undefined): Promise<number> {
  if (!userId || !userEmail) return 0;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.id !== userId) return 0;

  const email = (user.email ?? "").trim().toLowerCase();
  if (!email || email !== userEmail.trim().toLowerCase()) return 0;

  const admin = createServiceClient();

  // `.eq`, NOT `.ilike` — same hole as claimCrewInvite, and worse here because
  // this returns a LIST. A stranger registering `john_smith@outlook.com` swept
  // up every staged row whose address differs by one character: each becomes a
  // property they own, carrying the real customer's street address, with that
  // customer's crew pre-set as preferred — so the stranger can book a job and
  // send that crew to a house that isn't theirs. The real customer's row is
  // marked claimed, so they get nothing when they sign up.
  //
  // `customer_imports.invite_email` is written from parseCustomers, which
  // lower-cases (import-helpers.ts), and `email` is lower-cased above.
  const importsRes = await admin
    .from("customer_imports")
    .select("id, vendor_id, address, place_id, lat, lng")
    .eq("invite_email", email)
    .eq("status", "pending");
  // Swallowed on purpose, because the alternative is worse: this returns a
  // COUNT the portal discards, and throwing would take out the whole front
  // door — a homeowner locked out of their portal by a read that failed while
  // materializing a property. Nothing is written on this path, so the staged
  // rows are still 'pending' and the next sign-in claims them. Logged, because
  // "nothing staged" and "we couldn't look" claim exactly the same number of
  // properties.
  if (importsRes.error) {
    console.error("[read failed] your staged properties:", importsRes.error);
    return 0;
  }
  const imports = importsRes.data;
  if (!imports || imports.length === 0) return 0;

  let claimed = 0;
  for (const imp of imports) {
    // CLAIM THE ROW FIRST (atomic): flip pending -> claiming, guarded on the row
    // still being 'pending'. Only the runner whose update returns a row proceeds,
    // so a double-invocation (prefetch + navigation) can't create two properties.
    const wonRes = await admin
      .from("customer_imports")
      .update({ status: "claiming" })
      .eq("id", imp.id)
      .eq("status", "pending")
      .select("id");
    // An errored UPDATE flipped nothing, so skipping is the right direction —
    // but it is not the same event as losing the race, and only one of the two
    // is worth anybody's attention.
    if (wonRes.error) {
      console.error("[read failed] claiming your staged property:", wonRes.error);
      continue;
    }
    const won = wonRes.data;
    if (!won || won.length === 0) continue; // another runner already took it

    // WHICH LAKE. This was left NULL on every crew-imported property, and a
    // null lake is not a small gap:
    //   · dispatch's geo gate is skipped entirely, so a crew who doesn't serve
    //     that lake is eligible for the job
    //   · the booking calendar's capacity is unscoped
    //   · `lakeSeason` returns {null,null}, so ice-out and the pull deadline —
    //     the two dates the whole water business runs on — enforce nothing
    //   · `sendSeasonalPullReminders` filters on lake_id, so the household is
    //     never warned about the freeze at all
    //
    // Lakes carry no coordinates, so there is nothing to match lat/lng
    // against. The honest source is the importing crew: when they serve
    // exactly ONE lake, that is where their customer is. When they serve
    // several, we cannot know, and guessing would put a home on the wrong
    // lake — so it stays null and ops sees it in the needs-attention feed
    // rather than the system pretending it knows.
    const crewRes = await admin
      .from("vendors").select("service_lakes").eq("id", imp.vendor_id as string).maybeSingle();
    // A DROPPED READ LOOKED EXACTLY LIKE "this crew serves several lakes".
    // Empty service_lakes gives a null lake_id, which is the deliberate
    // we-cannot-know outcome above — reached here by not having looked, and
    // paid for by the household: no geo gate, no capacity scope, no ice-out,
    // no freeze warning. Nothing has been materialized yet, so the row goes
    // back to 'pending' and the next sign-in tries again with a real answer.
    if (crewRes.error) {
      console.error("[read failed] the importing crew's lakes:", crewRes.error);
      await admin.from("customer_imports").update({ status: "pending" }).eq("id", imp.id);
      continue;
    }
    const importingCrew = crewRes.data;
    const crewLakes = ((importingCrew?.service_lakes as string[] | null) ?? []).filter(Boolean);
    const lakeId = crewLakes.length === 1 ? crewLakes[0] : null;

    // Materialize the property (owner = the new user), preferred = the crew.
    const { data: prop, error: propErr } = await admin
      .from("properties")
      .insert({
        owner_id: userId,
        address: (imp.address as string) ?? null,
        place_id: (imp.place_id as string) ?? null,
        lat: (imp.lat as number) ?? null,
        lng: (imp.lng as number) ?? null,
        lake_id: lakeId,
        preferred_vendor: imp.vendor_id,
      })
      .select("id")
      .single();
    if (propErr || !prop) {
      // Materialization failed (e.g. place_id dedup) — release the row for ops.
      await admin.from("customer_imports").update({ status: "pending" }).eq("id", imp.id);
      continue;
    }
    // Referral attribution (§8b cross-sell arm) BEFORE the final status flip —
    // a crash after 'claimed' would otherwise lose the crew's attribution
    // forever (the loop only ever processes 'pending' rows).
    const crewRowRes = await admin.from("vendors").select("user_id").eq("id", imp.vendor_id as string).maybeSingle();
    // Swallowed, and it has to be: the property exists now, so releasing the
    // row would materialize a second one on the retry. The attribution is the
    // thing lost, and the comment above is about exactly how permanent that
    // loss is — so it is logged rather than left to be inferred from a crew
    // asking why a referral never showed up.
    if (crewRowRes.error) console.error("[read failed] the crew to credit for this referral:", crewRowRes.error);
    const crewRow = crewRowRes.data;
    if (crewRow?.user_id && crewRow.user_id !== userId) {
      await admin.from("users").update({ referred_by: crewRow.user_id }).eq("id", userId).is("referred_by", null);
    }

    await admin
      .from("customer_imports")
      .update({ status: "claimed", claimed_property: prop.id })
      .eq("id", imp.id);
    claimed++;
  }
  return claimed;
}
