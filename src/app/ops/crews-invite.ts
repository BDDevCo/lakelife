"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { html } from "@/lib/html-safe";
import { assertOps } from "./data";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { SERVED_LAKE_MATCH } from "@/lib/lake-visibility";
import { cleanCapacity, cleanProposedPhone, cleanWorkDays } from "@/lib/crew-setup";
import { computeRateRow, type RatePayload } from "@/app/vendor/rates-helpers";
import type { PricingModel, PricingParams } from "@/lib/pricing";
import {
  CROSS_REFERENCE_UNAVAILABLE,
  checkInviteEmail,
  findSimilarCrews,
  inviteCaseMessage,
  isOpenInviteCollision,
  type SimilarCrew,
} from "@/lib/invite-guard";

/**
 * WHAT OPS WAS TOLD ON THE PHONE. Every field optional, nothing seeded.
 *
 * This is a PROPOSAL, not a setting. It is written to `crew_setup_proposals`
 * (0181) and touches nothing the product reads until the crew themselves taps
 * confirm on it — edited or not. See lib/crew-setup.ts for why that line is
 * where it is, and what is deliberately absent from this shape: there is no
 * bank field, no terms field, no COI field and no verified-mobile field, and
 * none of them may ever be added.
 */
export interface CrewSetupInput {
  /** As they read it out. Pre-fills their verify box; never a sendable number. */
  phone?: string | null;
  /** lakes.id — a wrong tick silently drops them from every job on that water,
   *  which is the strongest argument for ops typing it while the crew is on
   *  the line, and for the crew confirming it before it counts. */
  lakeIds?: string[];
  workDays?: string[];
  dailyCapacity?: number | string | null;
  /** Keyed by services.id, in the crew's own units. "$50 a section". */
  rates?: Array<{ serviceId: string; payload: RatePayload }>;
  /** Ops' own note from the call. Shown to the crew, so it is theirs to read. */
  note?: string | null;
}

export interface InviteResult {
  ok: boolean;
  error?: string;
  /** Set when the crew row was created but the invitation email did not go. */
  warning?: string;
  /** NOT AN ERROR. The name looks like a crew we already have, so the door
   *  stops and asks. `error` is deliberately unset: the caller draws the list
   *  and can come straight back with `inviteAnyway`. */
  needsConfirm?: boolean;
  similar?: SimilarCrew[];
  /** The cross-reference could not be run. The invite still went — the
   *  exact-email constraint holds either way — and this says so. */
  crossReferenceUnavailable?: boolean;
}

/** How many of the things ops typed actually landed, for the confirmation. */
interface SetupWriteResult {
  /** Null when no setup was supplied at all. */
  wrote: boolean | null;
  /** What could not be stored, in words ops can act on. */
  problem?: string;
  /** Services ops priced that were dropped, and why — never silently. */
  dropped: string[];
  /** A number was typed and could not be stored. The rest still saved. */
  phoneUnreadable?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Ops invites a crew: creates an UNCLAIMED vendors row (user_id null,
 * invite_email set) and emails the crew a join link. The invite is claimed
 * when someone signs in with that exact email (claimCrewInvite below) —
 * so the email address is the credential, and only ops can mint one.
 */
export async function inviteCrew(input: {
  company: string;
  email: string;
  serviceTypes: string[];
  /** Set by the caller AFTER the near-match list has been shown and dismissed.
   *  It skips the cross-reference and nothing else — no guard, no constraint. */
  inviteAnyway?: boolean;
  /**
   * WHAT HE TYPED WHILE THEY WERE ON THE PHONE. Optional: a crew invited with
   * nothing here gets exactly the flow they got yesterday, six cards and all.
   *
   * THIS IS THE SAME DOOR, NOT A FOURTH ONE. Every guard above still runs in
   * the same order — the one-account-per-email check, the open-invite check,
   * the near-match cross-reference — because a setup form that skipped them
   * would be the fourth hand-written copy of rules that have already drifted
   * three times.
   */
  setup?: CrewSetupInput;
}): Promise<InviteResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const company = (input.company ?? "").trim().slice(0, 120);
  const email = (input.email ?? "").trim().toLowerCase();
  if (!company) return { ok: false, error: "Give the crew a company name." };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "That email doesn't look right." };

  const admin = createServiceClient();

  // Whitelist service types against real, active services. A failed read
  // whitelists NOTHING, so the crew is created with an empty service_types and
  // the dispatch engine — which matches on exact service-name membership — will
  // never offer them a job. Silent, permanent, and indistinguishable on the
  // Crews tab from a crew who was invited for nothing.
  const svcRes = await admin.from("services").select("name").eq("active", true);
  if (svcRes.error) return { ok: false, error: readFailedMessage("the list of services", svcRes.error) };
  const valid = new Set((svcRes.data ?? []).map((s) => s.name as string));
  const serviceTypes = [...new Set((input.serviceTypes ?? []).filter((t) => valid.has(t)))];

  // ONE ACCOUNT PER EMAIL, ONE OPEN INVITE PER EMAIL — asked by the guard all
  // three invite doors call (lib/invite-guard.ts). It was three hand-written
  // copies of these reads, and the copies had already drifted: this one
  // pre-checked `invite_email` with a case-SENSITIVE `.eq` while the `users`
  // lookup beside it was case-INSENSITIVE, so `Josh@x.com` over a pending
  // `josh@x.com` sailed past the friendly check and hit the unique index —
  // which handed ops "duplicate key value violates unique constraint
  // vendors_invite_email_open" and a retry that could never work.
  //
  // A FAILED READ IS `read_failed`, NEVER "free": `{ data: null, error }` is
  // what "no such account" and "no open invite" look like too, and waving an
  // invitation through on a dropped connection is how a second row lands on an
  // address that already has one.
  const found = await checkInviteEmail(admin, email);
  if (found.kind !== "free") return { ok: false, error: inviteCaseMessage(found, "ops") };

  // THE CROSS-REFERENCE, AND IT ONLY EVER ASKS. A different address for a
  // business we already hold is the duplicate no constraint can catch — so ops
  // sees the near matches once and either says "that's them" and stops, or
  // comes back with `inviteAnyway`. A fuzzy match may not block a real invite.
  let crossReferenceUnavailable = false;
  if (!input.inviteAnyway) {
    const near = await findSimilarCrews(admin, company);
    if (!near.ok) {
      // NOT "no duplicates found". That sentence, over a read that failed, is
      // the confident lie that creates the duplicate — so the invite proceeds
      // (the exact-email constraint still holds) and the caller is told which
      // check did not happen.
      crossReferenceUnavailable = true;
    } else if (near.crews.length > 0) {
      return { ok: false, needsConfirm: true, similar: near.crews };
    }
  }

  const { data: created, error: insErr } = await admin.from("vendors").insert({
    company,
    invite_email: email,
    service_types: serviceTypes,
    // NULL, NOT 1 — A DEFAULT MUST BE WHAT IS TRUE ON DAY ONE.
    //
    // The old seed of 1 was called a "routable default", but activationGaps
    // only refuses `cap < 1`, so the seed SATISFIED the go-live gate the crew
    // was supposed to answer. Step 5 of the wizard rendered ticked with a
    // "Saved ✓" pill for a number nobody had chosen, the crew never opened it,
    // and dispatch then routed them exactly one job a day forever — isEligible
    // refuses at `assignedThatDay >= cap` and canClaim answers "Your day is
    // full". A number a crew never stated was being read as their answer.
    //
    // Null is the honest state: the gap fires, the step is a real step, and no
    // door to `active` can pass a crew without a capacity — approveCrew
    // validates 1–20 and assertRoutable now refuses a missing one.
    daily_capacity: null,
    status: "invited",
  }).select("id").single();
  // THE PRE-CHECK IS THE MESSAGE; THE CONSTRAINT IS THE TRUTH; THEY SAY THE
  // SAME THING. `vendors_invite_email_open` can still fire — two invites for
  // the same address a second apart — and the raw Postgres string is not a
  // sentence anybody can act on.
  if (isOpenInviteCollision(insErr)) {
    return { ok: false, error: inviteCaseMessage({ kind: "open_invite", vendorId: null, company: null }, "ops") };
  }
  if (insErr || !created) return { ok: false, error: insErr?.message ?? "Couldn't add that crew." };

  // THE PROPOSAL IS WRITTEN BEFORE THE EMAIL, because the email DESCRIBES it.
  // "We've already filled in your lakes and your rate" is a promise about a row
  // that has to exist before the sentence goes out — otherwise the crew opens a
  // blank six-card wizard looking for the setup they were told was waiting.
  const setupWrite = await writeSetupProposal(admin, {
    vendorId: created.id as string,
    opsUserId: ops.id,
    opsName: ops.name,
    serviceTypes,
    setup: input.setup,
  });

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const sent = await sendInvitation(admin, {
    company,
    email,
    site,
    // A FAILED PROPOSAL WRITE MUST NOT PRODUCE A LYING EMAIL. If the row did
    // not land, the crew is sent the ordinary invitation and does the wizard —
    // the outcome ops sees in the warning below.
    preFilled: setupWrite.wrote === true,
    proposerName: ops.name,
  });

  // THE SEND USED TO BE `void`ed, WHICH STOPPED BEING SAFE AT 0126. The invite
  // IS the email — the crew row is unreachable until somebody signs in with
  // that address — so a refused send leaves an invite nobody can claim and an
  // ops screen saying "invited". Worse, the row now blocks a second attempt:
  // inviteCrew above refuses a duplicate open invite. Ops has to hear it here
  // or not at all.
  //
  // AND NOW IT IS WRITTEN DOWN (0154). The toast above was the only place this
  // was ever said, and Toast.tsx clears it after 3800ms — after which a bounced
  // invite and an ignored one looked identical on the board forever.
  await stampInvite(admin, email, sent);

  // ONE WARNING LINE, ASSEMBLED FROM EVERYTHING THAT DID NOT GO TO PLAN.
  //
  // Three things can go sideways independently here — the email, the proposal
  // write, and services ops priced that were dropped — and each used to have
  // (or would have grown) its own early return. Whichever fired first would be
  // the only one ops ever heard about, and the toast that carries it clears
  // after 3800ms. They are collected instead, so a crew added with a failed
  // send AND a failed pre-fill reports both.
  const notes: string[] = [];
  if (!sent.ok) {
    notes.push(
      `the invite email didn't send (${sent.error ?? "unknown"}) — send them the link yourself: ${site}, or press Resend on their card`,
    );
  }
  if (setupWrite.problem) notes.push(setupWrite.problem);
  if (setupWrite.phoneUnreadable) {
    notes.push("that phone number wasn't one we could store, so it isn't on their card — everything else is");
  }
  if (setupWrite.dropped.length > 0) {
    notes.push(`no rate was stored for ${setupWrite.dropped.join(", ")} — you can tell them to set ${setupWrite.dropped.length > 1 ? "those" : "that one"} on their own rates screen`);
  }
  if (crossReferenceUnavailable) notes.push(CROSS_REFERENCE_UNAVAILABLE);

  if (notes.length > 0) {
    return {
      ok: true,
      ...(crossReferenceUnavailable ? { crossReferenceUnavailable: true } : {}),
      warning: `${company} is added, but ${notes.join("; and ")}.`,
    };
  }

  return { ok: true };
}

/**
 * STORE WHAT OPS TYPED — AS A PROPOSAL, IN ITS OWN TABLE, TOUCHING NOTHING ELSE.
 *
 * Not `vendors.service_lakes`, not `vendors.daily_capacity`, not `vendor_rates`.
 * Those are columns the product READS — dispatch matches on the lakes, the
 * capacity caps the day, the rates decide what a crew is paid — and a value
 * ops typed landing in any of them is LakeLife answering a question on the
 * crew's behalf. The crew's own confirmation is what copies them across.
 *
 * NOT FATAL. The vendors row already exists by the time this runs and the
 * invitation is about to go; failing the whole action here would report
 * "couldn't add that crew" about one that is already added and already blocking
 * a retry as a duplicate. So it reports what did not land, and ops sees it.
 */
async function writeSetupProposal(
  admin: ReturnType<typeof createServiceClient>,
  input: {
    vendorId: string;
    opsUserId: string;
    opsName: string | null;
    /** The services ops ticked, already whitelisted against active services. */
    serviceTypes: string[];
    setup?: CrewSetupInput;
  },
): Promise<SetupWriteResult> {
  const setup = input.setup;
  if (!setup) return { wrote: null, dropped: [] };

  const phone = cleanProposedPhone(setup.phone);
  // TYPED SOMETHING, GOT NOTHING. A phone that cannot be stored must not cost
  // the crew their lakes, their days and their rate — but it must not vanish
  // either, because ops has just read it back down the phone and has every
  // reason to think it landed.
  const phoneUnreadable = typeof setup.phone === "string" && setup.phone.trim() !== "" && phone == null;
  const workDays = cleanWorkDays(setup.workDays);
  const capacity = cleanCapacity(setup.dailyCapacity);
  const note = (setup.note ?? "").trim().slice(0, 1000) || null;

  // LAKE IDS ARE CHECKED AGAINST REAL, SERVED LAKES. A stale id stored here
  // would be copied onto `vendors.service_lakes` at confirmation and then match
  // no lake at all — the crew ticks water they believe they cover and is never
  // offered a job on it, with nothing on any screen to explain why.
  let lakeIds: string[] = [];
  const wantedLakes = [...new Set((setup.lakeIds ?? []).filter((id) => typeof id === "string" && id))];
  if (wantedLakes.length > 0) {
    const lakeRes = await admin.from("lakes").select("id").match(SERVED_LAKE_MATCH).in("id", wantedLakes);
    // A FAILED READ WHITELISTS NOTHING, and says so. Storing the unchecked list
    // would be trusting a browser for the one field whose errors are silent.
    if (lakeRes.error) {
      return {
        wrote: false,
        problem: "we couldn't check the lakes you picked, so none of the setup was stored — they'll do the full sign-up instead",
        dropped: [],
      };
    }
    lakeIds = (lakeRes.data ?? []).map((l) => l.id as string);
  }

  // THE RATES. Priced against the SERVICE's own pricing model, by the same
  // `computeRateRow` the crew's rates screen calls — so ops cannot type a
  // shape the crew's own form would have refused.
  const dropped: string[] = [];
  const rateRows: Array<{ service_id: string; base: number; unit_rate: number; band_pricing: PricingParams | null }> = [];
  const wantedRates = (setup.rates ?? []).filter((r) => r && typeof r.serviceId === "string" && r.serviceId);
  if (wantedRates.length > 0) {
    const svcRes = await admin
      .from("services")
      .select("id, name, pricing_model, band_pricing, active, kind")
      .in("id", wantedRates.map((r) => r.serviceId));
    if (svcRes.error) {
      return {
        wrote: false,
        problem: "we couldn't read the services you priced, so none of the setup was stored — they'll do the full sign-up instead",
        dropped: [],
      };
    }
    const byId = new Map((svcRes.data ?? []).map((v) => [v.id as string, v]));
    for (const r of wantedRates) {
      const svc = byId.get(r.serviceId);
      // A service that is gone, inactive, or not one ops ticked for this crew.
      // Named in the warning rather than dropped quietly: ops just read a number
      // down the phone and has every reason to think it was written down.
      if (!svc || svc.active !== true || !input.serviceTypes.includes(svc.name as string)) {
        dropped.push((svc?.name as string) ?? "an unknown service");
        continue;
      }
      const built = computeRateRow(
        {
          pricing_model: svc.pricing_model as PricingModel,
          band_pricing: (svc.band_pricing as PricingParams | null) ?? null,
        },
        r.payload ?? {},
      );
      if (!built.ok || !built.row) {
        dropped.push(svc.name as string);
        continue;
      }
      // A BLANK CARD COUNTS AS UNPRICED, here as everywhere. 0181's trigger
      // refuses a row with no money in it; catching it here means the rest of
      // the proposal still lands instead of the whole write failing on a
      // service ops tapped and then left empty.
      const hasMoney =
        built.row.base > 0 ||
        built.row.unit_rate > 0 ||
        bandCarriesMoney(built.row.band_pricing);
      if (!hasMoney) continue; // not "dropped" — nothing was typed to drop
      rateRows.push({
        service_id: svc.id as string,
        base: built.row.base,
        unit_rate: built.row.unit_rate,
        band_pricing: built.row.band_pricing,
      });
    }
  }

  // NOTHING TO PROPOSE IS NOT A PROPOSAL. An empty row would put a card on the
  // crew's screen saying somebody set them up, listing nothing.
  const anything =
    phone != null || lakeIds.length > 0 || workDays.length > 0 || capacity != null ||
    note != null || rateRows.length > 0;
  if (!anything) {
    // `phoneUnreadable` RIDES OUT OF HERE TOO. If the only thing ops typed was
    // a phone number we could not store, there is nothing to propose — and
    // returning without saying so would drop it in total silence, which is the
    // one outcome this whole function is written to avoid.
    return { wrote: null, dropped, phoneUnreadable };
  }

  const propRes = await admin
    .from("crew_setup_proposals")
    .insert({
      vendor_id: input.vendorId,
      proposed_by: input.opsUserId,
      // SNAPSHOT. The crew's card says who set this up, and that sentence is a
      // record of what we told them — it must not change later because a users
      // row did. It also keeps this table from ever embedding `users`, which it
      // references TWICE (proposed_by, settled_by) and would be ambiguous.
      proposed_by_name: input.opsName,
      note,
      phone_e164: phone,
      service_lakes: lakeIds.length > 0 ? lakeIds : null,
      work_days: workDays.length > 0 ? workDays : null,
      daily_capacity: capacity,
    })
    .select("id")
    .single();
  if (propRes.error || !propRes.data) {
    return {
      wrote: false,
      problem: `what you filled in couldn't be saved (${propRes.error?.message ?? "unknown"}) — they'll do the full sign-up instead`,
      dropped,
    };
  }

  if (rateRows.length > 0) {
    const { error: rateErr } = await admin
      .from("crew_setup_proposed_rates")
      .insert(rateRows.map((r) => ({ proposal_id: propRes.data.id as string, ...r })));
    if (rateErr) {
      // THE REST OF THE PROPOSAL STANDS. Their lakes, days and capacity are
      // still waiting for them; only the numbers have to be typed again, and
      // the rates screen is where a crew types their own numbers anyway.
      return {
        wrote: true,
        problem: `their lakes and hours were saved but the rates weren't (${rateErr.message}) — they'll set those on their own rates screen`,
        dropped,
        phoneUnreadable,
      };
    }
  }

  return { wrote: true, dropped, phoneUnreadable };
}

/**
 * Does a computed band carry a real number anywhere? Mirrors 0181's trigger and
 * `hasRealRate` — a band object keyed small/medium/large, or a tiers array.
 */
function bandCarriesMoney(band: PricingParams | null): boolean {
  if (!band) return false;
  const bag = band as unknown as Record<string, unknown>;
  for (const [key, v] of Object.entries(bag)) {
    if (key === "tiers") continue;
    if (typeof v === "number" && v > 0) return true;
  }
  const tiers = (band as { tiers?: Array<{ price?: unknown }> }).tiers;
  if (Array.isArray(tiers)) {
    for (const t of tiers) if (Number(t?.price ?? 0) > 0) return true;
  }
  return false;
}

/**
 * THE INVITATION ITSELF — built once, so the first send and every resend say
 * the same thing. Two copies would be two sets of promises to keep true, and
 * the copy corrections below would have to be made twice.
 */
async function sendInvitation(
  admin: ReturnType<typeof createServiceClient>,
  { company, email, site, preFilled = false, proposerName = null }: {
    company: string;
    email: string;
    site: string;
    /** A setup proposal is waiting for them, so the six steps are now two. */
    preFilled?: boolean;
    proposerName?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  // Lake list is DYNAMIC — an invite sent the day a new lake launches must
  // name it. SERVED LAKES ONLY (lib/lake-visibility.ts): this list goes out in
  // a real email to a real crew as the water LakeLife works, so naming a place
  // nobody here has agreed to is not a cosmetic slip — it is a promise of work
  // made in correspondence, and the crew would be right to hold us to it. The
  // old fence, `is_fixture = false`, only kept our own scratch rows out.
  const lakeRes = await admin
    .from("lakes").select("name").match(SERVED_LAKE_MATCH).order("name");
  // Soft on purpose: the vendors row is already inserted by the caller, so
  // refusing here would leave an invite nobody can claim. The fallback names no
  // place that doesn't exist — but it logs, because "your local lakes" going
  // out in real correspondence is worth knowing about.
  if (lakeRes.error) console.error("[read failed, degraded] the lakes named in the invite email:", lakeRes.error);
  const shortNames = (lakeRes.data ?? []).map((l) => (l.name as string).replace(/ Lake$/, ""));
  // The joining `&amp;` is MARKUP, not a lake's name — so the multi-lake arm is
  // its own `html` template: the entity stays an entity, and only the names
  // coming out of the database are escaped.
  const lakeList = shortNames.length > 1
    ? html`${shortNames.slice(0, -1).join(", ")} &amp; ${shortNames[shortNames.length - 1]}`
    : shortNames[0] ?? "your local lakes";

  // BOTH DOORS, AND NO CLOCK ON THE MONEY.
  //
  // This paragraph used to say "your day's stops arrive by text, in drive
  // order, and payouts release the moment a job is photo-verified complete."
  // Text has delivered 0 of 81 since 19 July — the A2P campaign was rejected
  // twice and was finally approved on 22 Sep 2026, which changed the odds and
  // not the record: still 0 delivered — while `notify()` sends by both
  // doors at once, so the route link a crew actually receives comes by EMAIL.
  // Naming only the dead channel tells a stranger to watch their phone for the
  // one thing that decides whether they make money that day.
  //
  // And "the moment" was a promise about timing. Photo verification really
  // does release the payout — that is the crew's protection and it is worth
  // saying — but the money moves in a batch, and no money can move at all
  // until the processor is live. So the sentence describes what photo
  // verification DOES, and dates nothing.
  //
  // THE THIRD STEP USED TO SAY "LakeLife reviews and jobs start routing."
  // There is no review. finishOnboarding's own header calls this "ZERO-OPS
  // SELF-ACTIVATION (Phase A) — the crew flips THEMSELVES from 'invited' to
  // 'active' ... no ops approval", and the Crews board says the same back to
  // ops: "they go live THEMSELVES — zero touch from you." So the sentence
  // invented a queue and sat the crew in it, waiting for something nobody was
  // going to do. It also named three steps while five gate go-live — the lakes
  // and the daily number were never mentioned at all, and neither was the
  // button. A crew who does every step in this list is still not live.
  // ============ TWO DIFFERENT EMAILS, BECAUSE TWO DIFFERENT THINGS ARE TRUE ==
  //
  // A crew ops set up on the phone opens a card with their lakes, their days
  // and their own rate already in the boxes, and four things nobody else can do
  // for them. Sending that crew the six-step wizard email would be describing a
  // screen they will not see — and the six steps are the SLOG this whole pass
  // exists to remove. A crew invited cold still gets the six steps, because for
  // them the six steps are the truth.
  //
  // WHAT NEITHER VERSION SAYS IS THAT ANYTHING IS SETTLED. "We've filled in
  // what you told us" is a description of a pre-fill; "check it and confirm" is
  // the act that makes it theirs. A default that asserts a fact wrote nineteen
  // leases nobody had signed in this product already.
  const who = (proposerName ?? "").trim() || "We";
  const setUpLine = who === "We"
    ? html`We've already filled in what you told us on the phone`
    : html`${who} has already filled in what you told him on the phone`;

  const steps = preFilled
    ? html`<p><b>${setUpLine} — so there are two things left:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email address (${email}). Your lakes, your working days and your rates are waiting there. <b>Check them and confirm</b>; change anything that isn't right. Nothing we typed counts until you say so, and nothing is offered to a customer before then.</li>
<li>Four things only you can do: upload your insurance certificate (COI) and your W-9, add the bank account your payouts land in, agree to the crew terms, and verify your mobile. Then tap <b>Go live</b>.</li>
</ol>`
    : html`<p><b>You set yourself up — there's no queue and nobody to wait for:</b></p>
<ol>
<li>Create your account at <a href="${site}">${site}</a> — use THIS email address (${email}).</li>
<li>Upload your insurance certificate (COI) and W-9.</li>
<li>Tell us what work you do, which lakes you cover, and how many jobs a day you can take.</li>
<li>Set what you charge for each kind of work — we never offer you a job you haven't priced, and a blank card counts as unpriced.</li>
<li>Add your bank details, so a payout has somewhere to land. A payout only ever goes to an account on file.</li>
<li>Tap <b>Go live</b>. Jobs for the work you've priced start reaching you from that moment.</li>
</ol>`;

  return sendEmail({
    to: email,
    subject: `${company} — you're invited to LakeLife crews`,
    html: html`<p>Hi ${company},</p>
<p>LakeLife routes work on ${lakeList} — lake homes, and the mobile-home and RV parks on those lakes — to trusted local crews. Your day's stops come to you in drive order, by email and text, and photo-verifying a job is what releases its payout — you never chase an invoice. Released pay goes to the bank account you add yourself, so put one in before your first job.</p>
${steps}
<p>No insurance on file, no jobs — it's how we keep every dock covered. 🌊</p>`,
  });
}

/**
 * Write down what happened to the invitation (0154). NULL invite_sent_at means
 * it has never left our hands, which is what lets the board tell a bounced
 * invite from one somebody simply hasn't opened.
 *
 * DELIBERATELY NOT FATAL. The email has already gone (or already failed) by the
 * time this runs, and failing the action over the bookkeeping would report
 * "invite not sent" about one sitting in the crew's inbox. It logs instead.
 */
async function stampInvite(
  admin: ReturnType<typeof createServiceClient>,
  email: string,
  sent: { ok: boolean; error?: string },
): Promise<void> {
  const patch = sent.ok
    ? { invite_sent_at: new Date().toISOString(), invite_error: null }
    : { invite_error: (sent.error ?? "unknown").slice(0, 500) };
  const { error } = await admin
    .from("vendors").update(patch).eq("invite_email", email).is("user_id", null);
  if (error) console.error("[write failed] recording the invite send for", email, error);
}

export interface ResendResult {
  ok: boolean;
  error?: string;
  /** The address it went to, for the confirmation. */
  email?: string;
}

/**
 * SEND THE INVITATION AGAIN — the recovery that did not exist.
 *
 * `inviteCrew` refuses a duplicate open invite, which is right and is exactly
 * what made a failed send a dead end: the only way through was a database edit.
 * This is the same email to the same still-open row, so the duplicate guard
 * stays untouched.
 *
 * ONLY A STILL-OPEN INVITE. `.is("user_id", null)` on the lookup: a crew who
 * has signed up does not need an invitation, and re-sending one to somebody
 * already working reads as us having lost track of them.
 */
export async function resendCrewInvite(vendorId: string): Promise<ResendResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const admin = createServiceClient();
  const res = await admin
    .from("vendors")
    .select("id, company, invite_email")
    .eq("id", vendorId)
    .is("user_id", null)
    .maybeSingle();
  // "They've already signed up" is a claim about the crew's account, and a
  // dropped read has no standing to make it — ops would stop chasing somebody
  // who never heard from us.
  if (res.error) return { ok: false, error: readFailedMessage("that crew's invite", res.error) };
  const v = res.data;
  if (!v) return { ok: false, error: "That crew has already signed up — nothing to resend." };
  const email = (v.invite_email as string | null) ?? "";
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "There's no valid email on that invite — add the crew again with the right address." };
  }

  // A RESEND MUST DESCRIBE THE SCREEN THEY WILL ACTUALLY OPEN.
  //
  // `sendInvitation` now writes two different emails — the six-step wizard, and
  // the two-step "your setup is waiting, check it and confirm". Which one is
  // true depends on whether an unsettled proposal exists for this crew, and a
  // resend that always sent the six steps would tell Josh to fill in the lakes
  // and the rate Brendon already read back to him on the phone. Same rule, both
  // doorways.
  //
  // A FAILED READ SENDS THE SIX-STEP VERSION, which is the safe wrong answer:
  // it describes more work than they have to do, rather than promising a card
  // that might not be there.
  const propRes = await admin
    .from("crew_setup_proposals")
    .select("proposed_by_name")
    .eq("vendor_id", vendorId)
    .is("settled_at", null)
    .maybeSingle();
  if (propRes.error) console.error("[read failed, degraded] whether a setup is waiting for", email, propRes.error);
  const pending = propRes.data;

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const sent = await sendInvitation(admin, {
    company: (v.company as string) ?? "there",
    email,
    site,
    preFilled: pending != null,
    proposerName: (pending?.proposed_by_name as string | null) ?? null,
  });
  await stampInvite(admin, email, sent);
  if (!sent.ok) {
    return { ok: false, error: `Still couldn't send it (${sent.error ?? "unknown"}). Send them this link yourself: ${site}` };
  }
  return { ok: true, email };
}

/**
 * IS THIS PERSON A LAKELIFE CREW — claimed row, or an invitation still waiting?
 *
 * /welcome is the first screen after a new account verifies its phone, and it
 * is the homeowner wizard: "let's build your property profile". A crew invited
 * by ops lands there, because the invitation links the bare site and the verify
 * panel finishes at /welcome. Their vendors row is still unclaimed at that
 * moment (user_id null), so their OWN client cannot see it through RLS — which
 * is why this read is service-role.
 *
 * TAKES NO ARGUMENTS ON PURPOSE. This file is "use server", so every export is
 * a public endpoint; deriving both the id and the address from the session
 * means the only thing a caller can ever learn is something about themselves.
 *
 * It THROWS on a failed read rather than answering false. A dropped connection
 * that answers "no" renders the property wizard at a crew — the exact class of
 * bug this function exists to close.
 */
export async function hasCrewInvite(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const admin = createServiceClient();
  const claimed = mustRead(
    "whether you're set up as a LakeLife crew",
    await admin.from("vendors").select("id").eq("user_id", user.id).maybeSingle(),
  );
  if (claimed) return true;

  // Same `.eq` rule as claimCrewInvite below, and for the same reason: `_` in
  // an ilike pattern matches any single character, which is how a stranger
  // could once match somebody else's invitation.
  const email = (user.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return false;
  const invited = mustRead(
    "whether a crew invitation is waiting for you",
    await admin
      .from("vendors")
      .select("id")
      .eq("invite_email", email)
      .is("user_id", null)
      .maybeSingle(),
  );
  return invited != null;
}

/**
 * Claim a pending crew invite for the SIGNED-IN user (called from the portal
 * router, not the browser directly). The match is strict: the auth email must
 * equal the invite email. On claim: vendors.user_id is set and users.role
 * flips to 'vendor' (guard_role_change allows the service role as of 0013).
 * Idempotent: no pending invite -> no-op.
 *
 * THE EMAIL IS THE CREDENTIAL, SO IT HAS TO COME FROM THE SESSION.
 *
 * "Called from the portal router, not the browser directly" was a description
 * of the intended caller, not a property of the code. This file carries
 * "use server", so this export is a POST endpoint like any other, and both
 * arguments arrived from whoever called it. `inviteCrew` above says plainly
 * that the invited address IS the credential — and this took that credential
 * as a parameter. Anyone signed in could pass an invited crew's email with
 * their OWN user id, attach themselves to that vendors row, and be flipped to
 * role='vendor': the crew's route, their jobs, their payout account.
 *
 * So the session decides who is claiming and which address they hold. The
 * arguments must AGREE with it or the claim is refused — the portal passes
 * exactly these two values from its own getUser(), so nothing legitimate
 * changes, and there is no longer a caller-supplied path to somebody else's
 * invite.
 */
export async function claimCrewInvite(userId: string, userEmail: string | null | undefined): Promise<boolean> {
  if (!userId || !userEmail) return false;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.id !== userId) return false;

  const email = (user.email ?? "").trim().toLowerCase();
  if (!email || email !== userEmail.trim().toLowerCase()) return false;
  if (!EMAIL_RE.test(email)) return false;

  const admin = createServiceClient();
  // `.eq`, NOT `.ilike`. THIS IS THE LINE THE TAKEOVER RAN THROUGH.
  //
  // `.ilike` sends the address to Postgres as a PATTERN, and `_` matches any
  // single character. Invite `crew.mow@outlook.com`, and a stranger who
  // registers the real address `crew_mow@outlook.com` matches it, claims the
  // vendors row, and is flipped to role='vendor' — the crew's route, jobs and
  // payout account. Deriving the email from the session (the fix above) proves
  // who they are; it does not stop them being a wildcard.
  //
  // No escaping needed here: `invite_email` is ours and written lower-cased
  // (inviteCrew above, inviteMyContractor in book/contractor-actions.ts), and
  // `email` is lower-cased on the line above, so exact match is correct AND
  // strictly safer than any pattern.
  const inviteRes = await admin
    .from("vendors")
    .select("id")
    .eq("invite_email", email)
    .is("user_id", null)
    .maybeSingle();
  // NOT CONVERTED TO A THROW, deliberately: the only caller is /portal, which
  // uses the boolean to decide where to send somebody, and this returns false on
  // every ordinary homeowner sign-in. It stays false on a failed read — the
  // claim is idempotent, so their next portal load tries again — but it says so
  // in the log, because a crew silently landing in the homeowner portal on the
  // day they join has otherwise no explanation anywhere.
  if (inviteRes.error) console.error("[read failed] a pending crew invite for", email, inviteRes.error);
  const invite = inviteRes.data;
  if (!invite) return false;

  // Attach the person to the crew row first; only claim a still-open row.
  const claimRes = await admin
    .from("vendors")
    .update({ user_id: userId })
    .eq("id", invite.id)
    .is("user_id", null)
    .select("id");
  // Same posture as the read above: an empty result means somebody else claimed
  // it first, a failed one means we don't know. Both are safe to retry, neither
  // may be silent.
  if (claimRes.error) console.error("[write failed] claiming the crew invite for", email, claimRes.error);
  const claimed = claimRes.data;
  if (!claimed || claimed.length === 0) return false;

  // Then flip their role so /portal routes them to the crew side.
  const { error: roleErr } = await admin.from("users").update({ role: "vendor" }).eq("id", userId);
  if (roleErr) {
    // Roll the claim back rather than leave a half-vendor.
    await admin.from("vendors").update({ user_id: null }).eq("id", invite.id);
    console.error(`[claimCrewInvite] role flip failed for ${userId}:`, roleErr.message);
    return false;
  }
  return true;
}
