"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { getPlatformSettings } from "@/lib/settings";
import { notify } from "@/lib/notify";
import { money } from "@/app/park/ledger-helpers";
import { longDate } from "@/lib/lake-time";
import {
  addonMoney,
  normaliseAddonRequest,
  normaliseCrewQuote,
  normaliseDeclineReason,
  offerBack,
  ADDON_OFFER_BACK_DAYS,
  ADDON_OPEN_REQUESTS_MAX,
} from "@/lib/addons";

/**
 * THE FIVE STEPS, AS FIVE ACTIONS.
 *
 *   askForAnExtra      the owner types what they want
 *   quoteAddon         the crew names their number
 *   declineToQuote     the crew says they'd rather not
 *   acceptAddon        the owner says yes -> the money joins the visit
 *   declineAddonPrice  the owner says no
 *   repeatAddon        the same extra again, at the number that crew gave
 *
 * WHAT NONE OF THEM DOES IS TOUCH THE VISIT. Not one writes `jobs.status`,
 * `held_at`, `held_flag_id`, `stood_down_at` or `recovery_state`. No action in
 * this file writes `jobs` at all: the only writes to that table in the whole
 * feature are `accept_job_addon` (0180), which moves exactly three money
 * columns for an extra the owner accepted, and the trigger that takes those
 * same columns back off when the crew who priced it leaves the visit.
 * `src/app/addons/an-extra-never-blocks-the-visit.test.ts` scans for it. The
 * mow happens.
 *
 * THE FEE RIDES `lib/platform-fee.ts` AND NOTHING RE-DERIVES IT. The crew's
 * number is q; the customer pays round2(q x (1 + c)); the crew is paid
 * round2(q x (1 - k)); LakeLife keeps the difference of the two rounded ends.
 * Both percentages are FROZEN onto the add-on row at the instant of
 * acceptance, so tuning a dial afterwards cannot reprice work already agreed —
 * and 0180's CHECK refuses any pair of numbers that does not tie back to the
 * crew's quote at those frozen percentages.
 *
 * NOTHING IS SENT DIRECTLY. Every message goes through `notify`, which reaches
 * `sendSms`/`sendEmail`, which check `recipientIsHeld` (the notice hold, which
 * fails CLOSED) and the fixture gate before anything leaves. The free text a
 * customer typed is passed as a PLAIN STRING and escaped by the one escaper on
 * its way into the mail body (`asHtml` -> `html` -> `escapeHtml`); no HTML is
 * assembled here.
 */

export interface AddonResult {
  ok: boolean;
  error?: string;
  addonId?: string;
  /** What the customer will pay, for the toast. Only on accept. */
  price?: number;
}

const one = <T,>(v: unknown): T | null => (Array.isArray(v) ? (v[0] as T) ?? null : (v as T) ?? null);

/**
 * A WRITE THAT FAILED, IN ENGLISH — never in Postgres.
 *
 * `error.message` was returned straight to the screen on six paths, so a CHECK
 * violation reached a homeowner as `new row for relation "job_addons" violates
 * check constraint "job_addons_money_ties_to_the_quote"`. The constraint names
 * are for us and they are in the log; the person holding the phone gets a
 * sentence, and one that says whether any money moved.
 */
function writeFailed(what: string, err: unknown, opts?: { money?: boolean }): string {
  console.error(`[addons] ${what} failed:`, err);
  return (
    `We couldn't ${what} just now. ` +
    (opts?.money ? "Nothing was added and nothing was charged. " : "Nothing has changed. ") +
    "Try again in a moment."
  );
}

/** The visit statuses an extra may be attached to. Not a finished one. */
const OPEN_JOB = ["requested", "scheduled", "in_progress"] as const;

/* ------------------------------------------------------------ the gates -- */

type JobForAddon = {
  id: string;
  status: string;
  date: string | null;
  property_id: string;
  service_id: string | null;
  vendor_id: string | null;
  /** Non-null on a package visit, whose bill is the sum of its legs. */
  group_id: string | null;
  serviceName: string | null;
  ownerId: string;
};

/**
 * This job, if the signed-in person owns the property it is on.
 *
 * The SAME test `assertOwnerFlag` applies — `properties.owner_id === user.id`
 * — which is also the test that makes a PARK's extra the park's to accept: a
 * park's grounds and its own homes are `properties` rows owned by the park
 * owner's user (`mintServiceProperty`).
 *
 * A FAILED READ IS A THIRD STATE. `null` means "no such job, or not yours";
 * `readFailed` means we could not tell, and the caller says so instead of
 * accusing somebody about their own house.
 */
async function ownerJob(
  jobId: string,
): Promise<{ readFailed: true; error: unknown } | { readFailed: false; job: JobForAddon | null; userId: string } | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const res = await admin
    .from("jobs")
    .select("id, status, date, property_id, service_id, vendor_id, group_id, services(name), properties(owner_id)")
    .eq("id", jobId)
    .maybeSingle();
  if (res.error) return { readFailed: true, error: res.error };
  const d = res.data;
  if (!d) return { readFailed: false, job: null, userId: user.id };
  const prop = one<{ owner_id?: string }>(d.properties);
  if (prop?.owner_id !== user.id) return { readFailed: false, job: null, userId: user.id };
  return {
    readFailed: false,
    userId: user.id,
    job: {
      id: d.id as string,
      status: d.status as string,
      date: (d.date as string | null) ?? null,
      property_id: d.property_id as string,
      service_id: (d.service_id as string | null) ?? null,
      vendor_id: (d.vendor_id as string | null) ?? null,
      group_id: (d.group_id as string | null) ?? null,
      serviceName: one<{ name?: string }>(d.services)?.name ?? null,
      ownerId: prop.owner_id as string,
    },
  };
}

/** This add-on, if it belongs to the signed-in owner. Same three states. */
async function ownerAddon(addonId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const res = await admin
    .from("job_addons")
    .select("id, job_id, property_id, vendor_id, service_id, request_text, status, crew_quote, quoted_at, properties!job_addons_property_id_fkey(owner_id), jobs!job_addons_job_id_fkey(status, date, group_id, services(name))")
    .eq("id", addonId)
    .maybeSingle();
  if (res.error) return { readFailed: true as const, error: res.error };
  const d = res.data;
  if (!d) return { readFailed: false as const, addon: null, userId: user.id };
  const prop = one<{ owner_id?: string }>(d.properties);
  if (prop?.owner_id !== user.id) return { readFailed: false as const, addon: null, userId: user.id };
  const job = one<{ status?: string; date?: string; group_id?: string | null; services?: unknown }>(d.jobs);
  return {
    readFailed: false as const,
    userId: user.id,
    addon: {
      id: d.id as string,
      jobId: d.job_id as string,
      propertyId: d.property_id as string,
      vendorId: d.vendor_id as string,
      serviceId: (d.service_id as string | null) ?? null,
      requestText: d.request_text as string,
      status: d.status as string,
      crewQuote: d.crew_quote == null ? null : Number(d.crew_quote),
      quotedAt: (d.quoted_at as string | null) ?? null,
      jobStatus: (job?.status as string | undefined) ?? null,
      jobGroupId: (job?.group_id as string | null) ?? null,
      jobDate: (job?.date as string | undefined) ?? null,
      serviceName: one<{ name?: string }>(job?.services)?.name ?? null,
    },
  };
}

/** This add-on, if it is on a job assigned to the signed-in crew. */
async function crewAddon(addonId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  // `null` here must mean "not your add-on" and never "the read failed" — a
  // crew told somebody else owns their own job stops trusting the screen.
  const v = mustRead("your crew account", await admin.from("vendors").select("id").eq("user_id", user.id).maybeSingle());
  const vendorId = (v?.id as string) ?? null;
  if (!vendorId) return null;
  const res = await admin
    .from("job_addons")
    // NO customer_price. This is the crew path (rule 1) and the column list is
    // the fence — the table also grants a crew no select policy at all (0180).
    .select("id, job_id, vendor_id, request_text, status, jobs!job_addons_job_id_fkey(status, date, services(name))")
    .eq("id", addonId)
    .maybeSingle();
  if (res.error) return { readFailed: true as const, error: res.error };
  const d = res.data;
  if (!d || d.vendor_id !== vendorId) return { readFailed: false as const, addon: null };
  const job = one<{ status?: string; date?: string; services?: unknown }>(d.jobs);
  return {
    readFailed: false as const,
    addon: {
      id: d.id as string,
      jobId: d.job_id as string,
      vendorId,
      requestText: d.request_text as string,
      status: d.status as string,
      jobStatus: (job?.status as string | undefined) ?? null,
      jobDate: (job?.date as string | undefined) ?? null,
      serviceName: one<{ name?: string }>(job?.services)?.name ?? null,
    },
  };
}

/* --------------------------------------------------------------- telling -- */

/** The crew's phone and email, or nulls. Never throws at its caller. */
async function crewContact(admin: ReturnType<typeof createServiceClient>, vendorId: string) {
  try {
    const v = mustRead("the crew to tell", await admin
      .from("vendors").select("user_id, company").eq("id", vendorId).maybeSingle());
    const userId = (v?.user_id as string) ?? null;
    if (!userId) return null;
    const u = mustRead("the crew's contact details", await admin
      .from("users").select("phone, email").eq("id", userId).maybeSingle());
    return {
      phone: (u?.phone as string | null) ?? null,
      email: (u?.email as string | null) ?? null,
      company: (v?.company as string | null) ?? null,
    };
  } catch (e) {
    console.error("[addons] couldn't look up the crew to tell:", e);
    return null;
  }
}

/** The owner's phone and email. Never throws at its caller. */
async function ownerContact(admin: ReturnType<typeof createServiceClient>, userId: string) {
  try {
    const u = mustRead("the owner's contact details", await admin
      .from("users").select("phone, email").eq("id", userId).maybeSingle());
    return { phone: (u?.phone as string | null) ?? null, email: (u?.email as string | null) ?? null };
  } catch (e) {
    console.error("[addons] couldn't look up the owner to tell:", e);
    return null;
  }
}

/* ----------------------------------------------------- 1. the owner asks -- */

/**
 * The owner types what they want doing beyond the booked job.
 *
 * NO PRICE IS INVENTED HERE OR ANYWHERE. The row is filed unpriced and stays
 * that way until the crew types a number. An unpriced extra is the safe state.
 */
export async function askForAnExtra(jobId: string, rawText: string): Promise<AddonResult> {
  const ctx = await ownerJob(jobId);
  if (!ctx) return { ok: false, error: "Please sign in." };
  if (ctx.readFailed) return { ok: false, error: readFailedMessage("this visit", ctx.error) };
  const job = ctx.job;
  if (!job) return { ok: false, error: "That visit isn't yours." };

  // A SANITISED VALUE LOOKS LIKE AN ABSENT ONE, so the refusal names the
  // number rather than describing an empty box they did not leave empty.
  const req = normaliseAddonRequest(rawText);
  if (!req.ok) return { ok: false, error: req.problem ?? "We couldn't read that." };

  if (!OPEN_JOB.includes(job.status as (typeof OPEN_JOB)[number])) {
    return {
      ok: false,
      error: `That visit is already ${job.status === "paid" ? "paid for" : job.status}, so nothing more can be added to it. Book the extra as its own job and we'll price it.`,
    };
  }
  // NO CREW, NOBODY TO NAME A PRICE. The crew names the number or there is no
  // add-on — so a job not yet assigned cannot carry one, and the sentence says
  // why rather than failing silently.
  if (!job.vendor_id) {
    return { ok: false, error: "No crew is on this visit yet. Once one is assigned you can ask them for extras." };
  }
  // A PACKAGE'S BILL IS THE SUM OF ITS LEGS, AND AN EXTRA IS NOT A LEG. The
  // owner's package breakdown is assembled from `job_items`
  // (requests/package-data.ts) while the invoice is raised off
  // `jobs.customer_price`; an extra folded into the second and not the first
  // leaves the parts short of the total with nothing explaining the gap.
  // `accept_job_addon` refuses it at the write as well.
  if (job.group_id) {
    return {
      ok: false,
      error:
        "This visit is part of a package, and we can't add an extra to a package visit yet — the breakdown you see is the sum of its parts and an extra wouldn't appear in it. " +
        "Book the extra as its own job and we'll price it.",
    };
  }

  const admin = createServiceClient();

  // NOTHING COUNTED, AND EVERY REQUEST IS AN SMS AND AN EMAIL AT A NAMED
  // CONTRACTOR'S OWN PHONE. There is no moderation in either direction and no
  // human in the loop, so the only thing between this box and five hundred
  // texts was that nobody had tried. Only the UNANSWERED ones count: a crew
  // who prices or declines what is there clears the way at once.
  //
  // A FAILED COUNT MAKES A GUARD PASS, so it is read as a third state rather
  // than defaulted to zero.
  const openRes = await admin
    .from("job_addons")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id)
    .eq("status", "requested");
  if (openRes.error || openRes.count == null) {
    return { ok: false, error: writeFailed("check what you've already asked for on this visit", openRes.error) };
  }
  if (openRes.count >= ADDON_OPEN_REQUESTS_MAX) {
    return {
      ok: false,
      error:
        `You've got ${openRes.count} things waiting on your crew for this visit already, which is as many as we'll send them at once. ` +
        "Once they've priced or turned those down you can ask for more. Nothing about the booked visit changes either way.",
    };
  }

  const ins = await admin
    .from("job_addons")
    .insert({
      job_id: job.id,
      property_id: job.property_id,
      vendor_id: job.vendor_id,
      service_id: job.service_id,
      requested_by: ctx.userId,
      request_text: req.text,
      status: "requested",
    })
    .select("id")
    .maybeSingle();
  if (ins.error) return { ok: false, error: writeFailed("send that to your crew", ins.error) };
  const addonId = (ins.data?.id as string) ?? undefined;

  // TELL THE CREW. Plain strings only — `notify` escapes the body through the
  // one escaper on its way into HTML, and the same words go out by SMS
  // unescaped, which is why nothing here is pre-escaped by hand.
  const contact = await crewContact(admin, job.vendor_id);
  if (contact) {
    // "the owner at your a job" is what `your ${serviceName ?? "a job"}`
    // produced on a service-less job, and `jobs.service_id` is nullable. The
    // possessive is part of the SUBSTITUTION, not part of the sentence.
    const where = job.serviceName ? `your ${job.serviceName}` : "one of your jobs";
    await notify(
      "the crew that an owner has asked for something extra",
      { phone: contact.phone, email: contact.email },
      {
        sms: `LakeLife: the owner at ${where}${job.date ? ` on ${longDate(job.date)}` : ""} has asked for something extra: "${req.text}" — open the job to name your price, or say you'd rather not. The booked job goes ahead either way. 🌊`,
        subject: "An owner has asked for something extra",
        body:
          `The owner at ${where}${job.date ? ` on ${longDate(job.date)}` : ""} has asked for this, beyond what's booked:\n\n` +
          `"${req.text}"\n\n` +
          "Open the job in LakeLife and either name your price or say you'd rather not take it on. " +
          "You set the number; we add our fee to the customer's side and take ours from yours, and you'll see both before you send it.\n\n" +
          "Either way, do the booked job as normal — this doesn't change it.",
      },
    );
  }

  return { ok: true, addonId };
}

/* ------------------------------------------------ 2. the crew names a price */

/**
 * The crew types their own number.
 *
 * LAKELIFE NEVER SUGGESTS ONE. There is no default, no placeholder amount and
 * no "others charge about" line anywhere on this path: the crew names the
 * number or there is no add-on.
 */
export async function quoteAddon(addonId: string, rawAmount: string | number): Promise<AddonResult> {
  const ctx = await crewAddon(addonId);
  if (!ctx) return { ok: false, error: "Please sign in with your crew account." };
  if (ctx.readFailed) return { ok: false, error: readFailedMessage("this request", ctx.error) };
  const a = ctx.addon;
  if (!a) return { ok: false, error: "That request isn't on one of your jobs." };
  if (a.status !== "requested") {
    return { ok: false, error: a.status === "quoted" ? "You've already priced this one — it's with the owner." : "That request has already been settled." };
  }

  const q = normaliseCrewQuote(rawAmount);
  if (!q.ok) return { ok: false, error: q.problem ?? "We couldn't read that amount." };

  const admin = createServiceClient();
  // The status predicate IS the lock: two taps must not both send a price.
  const upd = await admin
    .from("job_addons")
    .update({ status: "quoted", crew_quote: q.amount, quoted_at: new Date().toISOString() })
    .eq("id", addonId)
    .eq("status", "requested")
    .select("id, property_id, request_text");
  if (upd.error) return { ok: false, error: writeFailed("send that price", upd.error) };
  if (!upd.data || upd.data.length === 0) return { ok: false, error: "That request has already been settled." };

  // TELL THE OWNER WHAT IT COSTS THEM — the customer number, never the crew's.
  const fee = await feeNow();
  const m = addonMoney(q.amount, fee);
  const propertyId = upd.data[0].property_id as string;
  const ownerId = await ownerOf(admin, propertyId);
  if (ownerId) {
    const to = await ownerContact(admin, ownerId);
    if (to) {
      // `your ${serviceName ?? "your visit"}` printed "your your visit" on a
      // service-less job. The possessive belongs to the substitution.
      const svc = a.serviceName ? `your ${a.serviceName}` : "your visit";
      await notify(
        "the owner that their crew has priced the extra they asked for",
        { phone: to.phone, email: to.email },
        {
          sms: `LakeLife: your crew will do "${a.requestText}" for ${money(m.customerPrice)}, added to ${svc}. Open LakeLife to say yes or no — ${svc} goes ahead either way. 🌊`,
          subject: "Your crew has priced the extra you asked for",
          body:
            `You asked your crew for this:\n\n"${a.requestText}"\n\n` +
            `They'll do it for ${money(m.customerPrice)}, added to ${svc}.\n\n` +
            "Nothing is charged until you say yes. Say no and " + svc + " still goes ahead exactly as booked, at the price you already have.",
        },
      );
    }
  }

  return { ok: true, addonId };
}

/** The crew would rather not take this one on. The booked job is unaffected. */
export async function declineToQuote(addonId: string, rawReason: string): Promise<AddonResult> {
  const ctx = await crewAddon(addonId);
  if (!ctx) return { ok: false, error: "Please sign in with your crew account." };
  if (ctx.readFailed) return { ok: false, error: readFailedMessage("this request", ctx.error) };
  const a = ctx.addon;
  if (!a) return { ok: false, error: "That request isn't on one of your jobs." };
  if (a.status !== "requested") return { ok: false, error: "That request has already been settled." };

  // NOT `.slice()`. A silently truncated reason is quoted back to the owner
  // inside quotation marks as if it were the whole sentence, and a guard
  // downstream of a sanitiser cannot tell "they sent nothing" from "we binned
  // it" — so the refusal names the number they hit.
  const why = normaliseDeclineReason(rawReason);
  if (!why.ok) return { ok: false, error: why.problem ?? "We couldn't read that." };
  const reason = why.text;

  const admin = createServiceClient();
  const upd = await admin
    .from("job_addons")
    .update({ status: "crew_declined", crew_declined_reason: reason || null })
    .eq("id", addonId)
    .eq("status", "requested")
    .select("id, property_id");
  if (upd.error) return { ok: false, error: writeFailed("tell them that", upd.error) };
  if (!upd.data || upd.data.length === 0) return { ok: false, error: "That request has already been settled." };

  const ownerId = await ownerOf(admin, upd.data[0].property_id as string);
  if (ownerId) {
    const to = await ownerContact(admin, ownerId);
    const svc = a.serviceName ? `your ${a.serviceName}` : "your visit";
    if (to) {
      await notify(
        "the owner that their crew won't take on the extra they asked for",
        { phone: to.phone, email: to.email },
        {
          sms: `LakeLife: your crew isn't taking on "${a.requestText}"${reason ? ` — ${reason}` : ""}. Nothing charged. ${svc.charAt(0).toUpperCase()}${svc.slice(1)} goes ahead as booked. 🌊`,
          subject: "Your crew can't take on that extra",
          body:
            `You asked your crew for this:\n\n"${a.requestText}"\n\n` +
            `They aren't taking it on${reason ? `: "${reason}".` : "."}\n\n` +
            `Nothing was added and nothing was charged. ${svc.charAt(0).toUpperCase()}${svc.slice(1)} goes ahead exactly as booked. ` +
            "If it's something you'd still like doing, tell us and we'll see whether another crew covers it.",
        },
      );
    }
  }
  return { ok: true, addonId };
}

/* ------------------------------------------------- 3. the owner decides -- */

async function feeNow() {
  const s = await getPlatformSettings();
  return { customerPct: s.platformFeeCustomerPct, crewPct: s.platformFeeCrewPct };
}

async function ownerOf(admin: ReturnType<typeof createServiceClient>, propertyId: string): Promise<string | null> {
  try {
    const p = mustRead("who owns this property", await admin
      .from("properties").select("owner_id").eq("id", propertyId).maybeSingle());
    return (p?.owner_id as string) ?? null;
  } catch (e) {
    console.error("[addons] couldn't look up the property owner:", e);
    return null;
  }
}

/**
 * THE OWNER SAYS YES, and the money joins the visit — atomically.
 *
 * `accept_job_addon` (0180) locks the row FOR UPDATE, re-checks the owner and
 * the visit's status in the database, writes the frozen recipe and adds the
 * two numbers to the job in one statement. The status flip and the money move
 * together or not at all, which is what stops a second tap on a second device
 * adding the extra twice.
 *
 * THE PERCENTAGES ARE FROZEN HERE. `feeNow` is the live dial at this instant;
 * once written they never move, so a dial tuned tomorrow cannot reprice this.
 * The two money figures are computed by `platform-fee.ts` and by nothing else;
 * the database refuses them if they do not tie to the crew's quote.
 *
 * `shownPrice` IS THE NUMBER ON THE BUTTON THEY TAPPED, and it is required
 * rather than optional because a guard nobody passes an input to is a guard
 * that enforces nothing. `getPlatformSettings` is cached per REQUEST, and the
 * render and this action are two requests — so a dial tuned in between, or a
 * settings read that quietly fell back to the launch defaults, would bill a
 * figure the screen never said. If the two disagree, nothing is written and
 * both numbers are named.
 *
 * AND A LIVE QUOTE GOES STALE TOO. The ninety-day rule used to apply only to a
 * REMEMBERED price, so a pier job booked in May for an October date could
 * carry a May quote accepted in October. It is checked here, at the write, as
 * well as in the loader that draws the button.
 */
export async function acceptAddon(addonId: string, shownPrice: number | null): Promise<AddonResult> {
  const ctx = await ownerAddon(addonId);
  if (!ctx) return { ok: false, error: "Please sign in." };
  if (ctx.readFailed) return { ok: false, error: readFailedMessage("this extra", ctx.error, { money: true }) };
  const a = ctx.addon;
  if (!a) return { ok: false, error: "That extra isn't yours." };
  if (a.status !== "quoted") {
    return {
      ok: false,
      error:
        a.status === "requested"
          ? "Your crew hasn't put a price on this yet."
          : a.status === "accepted"
            ? "You've already added this one."
            : "That one has already been settled.",
    };
  }
  if (a.crewQuote == null || !(a.crewQuote > 0)) {
    return { ok: false, error: "We can't read your crew's price for this, so we won't add it. Ask them to send it again." };
  }
  if (a.jobGroupId) {
    return {
      ok: false,
      error:
        "This visit is part of a package, and we can't add an extra to a package visit yet. Nothing was added and nothing was charged.",
    };
  }
  // THE SAME NINETY DAYS AS A REMEMBERED PRICE — see lib/addons `offerBack`.
  // Measured from `quoted_at`, the day the crew named the number.
  const fresh = offerBack(a.quotedAt);
  if (!fresh.offerable) {
    return { ok: false, error: fresh.why ?? "That price is too old to add now. Ask your crew to price it again." };
  }

  const fee = await feeNow();
  const m = addonMoney(a.crewQuote, fee);

  if (shownPrice == null) {
    return { ok: false, error: "We couldn't show you a price for this, so we won't charge one. Pull the page again." };
  }
  if (Math.abs(shownPrice - m.customerPrice) > 0.005) {
    return {
      ok: false,
      error:
        `The screen said ${money(shownPrice)} and this would bill ${money(m.customerPrice)}, so we haven't added it. ` +
        "Nothing was charged. Pull the page again and it'll show the right figure.",
    };
  }

  const admin = createServiceClient();
  const { error } = await admin.rpc("accept_job_addon", {
    p_addon_id: addonId,
    p_user: ctx.userId,
    p_fee_customer_pct: fee.customerPct,
    p_fee_crew_pct: fee.crewPct,
    p_customer_price: m.customerPrice,
    p_crew_payout: m.crewPayout,
  });
  if (error) return { ok: false, error: writeFailed("add that to your visit", error, { money: true }) };

  const contact = await crewContact(admin, a.vendorId);
  if (contact) {
    await notify(
      "the crew that the owner agreed their price for the extra",
      { phone: contact.phone, email: contact.email },
      {
        sms: `LakeLife: the owner said yes to your ${money(m.crewQuote)} for "${a.requestText}". You're paid ${money(m.crewPayout)} for it after the platform fee, with the booked job. 🌊`,
        subject: "The owner agreed your price for the extra",
        body:
          `The owner said yes to your price for this:\n\n"${a.requestText}"\n\n` +
          `You quoted ${money(m.crewQuote)}. You'll be paid ${money(m.crewPayout)} for it after the platform fee, ` +
          "on top of the booked job and in the same payout.\n\n" +
          "Do it on the same visit.",
      },
    );
  }

  return { ok: true, addonId, price: m.customerPrice };
}

/** The owner says no to the price. Nothing is added, nothing is charged. */
export async function declineAddonPrice(addonId: string): Promise<AddonResult> {
  const ctx = await ownerAddon(addonId);
  if (!ctx) return { ok: false, error: "Please sign in." };
  if (ctx.readFailed) return { ok: false, error: readFailedMessage("this extra", ctx.error) };
  const a = ctx.addon;
  if (!a) return { ok: false, error: "That extra isn't yours." };
  if (a.status !== "quoted") return { ok: false, error: "That one has already been settled." };

  const admin = createServiceClient();
  // The predicate is the lock, the way `declineFlag`'s is: the sentence below
  // must not be sent twice.
  const upd = await admin
    .from("job_addons")
    .update({ status: "owner_declined", decided_at: new Date().toISOString(), decided_by: ctx.userId })
    .eq("id", addonId)
    .eq("status", "quoted")
    .select("id");
  if (upd.error) return { ok: false, error: writeFailed("record that", upd.error, { money: true }) };
  if (!upd.data || upd.data.length === 0) return { ok: false, error: "That one has already been settled." };

  const contact = await crewContact(admin, a.vendorId);
  if (contact) {
    await notify(
      "the crew that the owner turned down their price for the extra",
      { phone: contact.phone, email: contact.email },
      {
        sms: `LakeLife: the owner turned down your price for "${a.requestText}". Don't do the extra — the booked job goes ahead as normal. 🌊`,
        subject: "The owner turned down that extra",
        body:
          `The owner has turned down your price for this:\n\n"${a.requestText}"\n\n` +
          "Don't do the extra. The booked job goes ahead exactly as normal and nothing about your pay for it changes.",
      },
    );
  }
  return { ok: true, addonId };
}

/** The owner takes a request back before the crew has priced it. */
export async function withdrawAddon(addonId: string): Promise<AddonResult> {
  const ctx = await ownerAddon(addonId);
  if (!ctx) return { ok: false, error: "Please sign in." };
  if (ctx.readFailed) return { ok: false, error: readFailedMessage("this extra", ctx.error) };
  if (!ctx.addon) return { ok: false, error: "That extra isn't yours." };
  if (ctx.addon.status !== "requested") return { ok: false, error: "Your crew has already answered this one." };

  const admin = createServiceClient();
  const upd = await admin
    .from("job_addons")
    .update({ status: "withdrawn", decided_at: new Date().toISOString(), decided_by: ctx.userId })
    .eq("id", addonId)
    .eq("status", "requested")
    .select("id");
  if (upd.error) return { ok: false, error: writeFailed("take that back", upd.error) };
  if (!upd.data || upd.data.length === 0) return { ok: false, error: "Your crew has already answered this one." };
  return { ok: true, addonId };
}

/* ------------------------------------- 4. the same extra, the next time -- */

/**
 * "THAT NEW PRICING FROM THE CREW PREVIOUSLY."
 *
 * The owner taps a remembered extra on a new visit and it goes straight on,
 * at the number that crew gave, WITHOUT the crew being asked again — which is
 * what he described. Three things make that safe:
 *
 *   IT IS THE SAME CREW, THE SAME PROPERTY AND THE SAME SERVICE. Re-checked
 *   here against the source row, not trusted from the button.
 *
 *   IT IS STILL FRESH. `offerBack` refuses anything older than ninety days,
 *   and it is applied HERE as well as in the loader that drew the button — a
 *   rule in one doorway of two is not a rule, and a page left open overnight
 *   is exactly how a stale one would get through.
 *
 *   THE OWNER TAPPED IT, KNOWING THE PRICE AND THE DATE. The card says what
 *   that crew charged and when. Nothing auto-accepts, auto-renews or arrives
 *   pre-ticked; there is no path by which a remembered price bills without
 *   somebody choosing it on the day.
 *
 * THE PERCENTAGES ARE TODAY'S, NOT THE OLD ROW'S. This is NEW work agreed
 * today, so it is sold at today's published fee. `shownPrice` is the figure
 * that was on the button, and a mismatch refuses rather than bills.
 *
 * `quoted_at` IS CARRIED FORWARD, NOT RESTAMPED, and that is the staleness
 * rule's whole spine. Writing `now()` here made the ninety days reset on every
 * repeat: a January number tapped every six weeks was still "fresh" in 2028
 * and the crew was never asked again, because `CrewAddonPanel` draws controls
 * only for a `requested` row. It also made the card's "Your crew priced it on
 * ..." name a day the crew did nothing. The chain now ages from the day the
 * number was actually named and dies ninety days after it.
 */
export async function repeatAddon(jobId: string, sourceAddonId: string, shownPrice: number | null): Promise<AddonResult> {
  const ctx = await ownerJob(jobId);
  if (!ctx) return { ok: false, error: "Please sign in." };
  if (ctx.readFailed) return { ok: false, error: readFailedMessage("this visit", ctx.error, { money: true }) };
  const job = ctx.job;
  if (!job) return { ok: false, error: "That visit isn't yours." };
  if (!OPEN_JOB.includes(job.status as (typeof OPEN_JOB)[number])) {
    return { ok: false, error: "That visit is already finished, so nothing more can be added to it." };
  }
  if (!job.vendor_id) return { ok: false, error: "No crew is on this visit yet." };
  if (job.group_id) {
    return {
      ok: false,
      error:
        "This visit is part of a package, and we can't add an extra to a package visit yet. Nothing was added and nothing was charged.",
    };
  }

  const admin = createServiceClient();
  const srcRes = await admin
    .from("job_addons")
    .select("id, property_id, vendor_id, service_id, request_text, status, crew_quote, quoted_at")
    .eq("id", sourceAddonId)
    .maybeSingle();
  if (srcRes.error) return { ok: false, error: readFailedMessage("what your crew charged last time", srcRes.error, { money: true }) };
  const src = srcRes.data;
  // A FAILED READ IS NOT A MISSING ROW — handled above. This is genuinely "no
  // such remembered extra".
  if (!src) return { ok: false, error: "We can't find that earlier extra." };
  if (src.status !== "accepted") return { ok: false, error: "That one was never agreed, so there's no price to bring forward." };
  if (src.property_id !== job.property_id || src.vendor_id !== job.vendor_id) {
    return { ok: false, error: "That price was for a different crew or a different place, so we won't carry it over." };
  }
  if ((src.service_id ?? null) !== (job.service_id ?? null)) {
    return { ok: false, error: "That price was for a different service, so we won't carry it over." };
  }
  const quote = src.crew_quote == null ? null : Number(src.crew_quote);
  if (quote == null || !(quote > 0)) {
    return { ok: false, error: "We can't read what your crew charged last time, so we won't bill it. Ask them below and they'll price it fresh." };
  }
  // THE SECOND DOORWAY ON THE STALENESS RULE, measured from the day the crew
  // NAMED the number — which a repeat carries forward, so a chain of repeats
  // cannot keep an old price alive by being tapped.
  const namedAt = (src.quoted_at as string | null) ?? null;
  if (!namedAt) {
    return { ok: false, error: "We can't tell when your crew gave that price, so we won't carry it over. Ask them below and they'll price it as it stands." };
  }
  const fresh = offerBack(namedAt);
  if (!fresh.offerable) return { ok: false, error: fresh.why ?? "That price is too old to carry over." };

  const req = normaliseAddonRequest(src.request_text as string);
  if (!req.ok) return { ok: false, error: "We can't read what was asked for last time. Type it again below." };

  // NOT TWICE ON ONE VISIT. The loader dedupes what it OFFERS by text; this
  // door did not, so two tabs or two taps filed and accepted the same extra
  // twice and the visit carried it twice over. The read is the guard the
  // loader's dedupe implies, said in the doorway that writes the money.
  const dupRes = await admin
    .from("job_addons")
    .select("id, request_text, status")
    .eq("job_id", job.id)
    .in("status", ["requested", "quoted", "accepted"]);
  if (dupRes.error) {
    return { ok: false, error: writeFailed("check what's already on this visit", dupRes.error, { money: true }) };
  }
  const already = (dupRes.data ?? []).some(
    (r) => ((r.request_text as string) ?? "").trim().toLowerCase() === req.text.trim().toLowerCase(),
  );
  if (already) {
    return { ok: false, error: "That extra is already on this visit. Nothing was added twice and nothing extra was charged." };
  }

  const fee = await feeNow();
  const m = addonMoney(quote, fee);
  if (shownPrice == null) {
    return { ok: false, error: "We couldn't show you a price for this, so we won't charge one. Pull the page again." };
  }
  if (Math.abs(shownPrice - m.customerPrice) > 0.005) {
    return {
      ok: false,
      error:
        `The screen said ${money(shownPrice)} and this would bill ${money(m.customerPrice)}, so we haven't added it. ` +
        "Nothing was charged. Pull the page again and it'll show the right figure.",
    };
  }

  // Filed ALREADY QUOTED at that crew's own number, then accepted through the
  // one acceptance function — so the frozen recipe, the CHECK that ties it to
  // the quote, and the atomic fold into the job are all the same code that
  // runs for a fresh extra. There is no second acceptance path.
  const ins = await admin
    .from("job_addons")
    .insert({
      job_id: job.id,
      property_id: job.property_id,
      vendor_id: job.vendor_id,
      service_id: job.service_id,
      requested_by: ctx.userId,
      request_text: req.text,
      status: "quoted",
      crew_quote: quote,
      // THE DAY THE CREW NAMED IT, carried forward unchanged. See the note
      // above: restamping this is what made the ninety days reset for ever.
      quoted_at: namedAt,
      repeat_of: src.id as string,
    })
    .select("id")
    .maybeSingle();
  if (ins.error) return { ok: false, error: writeFailed("add that to this visit", ins.error, { money: true }) };
  const newId = ins.data?.id as string | undefined;
  if (!newId) return { ok: false, error: "We couldn't add that. Please try again." };

  const { error: rpcErr } = await admin.rpc("accept_job_addon", {
    p_addon_id: newId,
    p_user: ctx.userId,
    p_fee_customer_pct: fee.customerPct,
    p_fee_crew_pct: fee.crewPct,
    p_customer_price: m.customerPrice,
    p_crew_payout: m.crewPayout,
  });
  if (rpcErr) {
    // THE ROW MUST NOT SURVIVE AS A QUOTE NOBODY MADE. If the fold into the
    // job failed, this add-on is a price the crew never typed today sitting in
    // the owner's "your decision" list, one tap from an invoice. Withdraw it —
    // AND CHECK THAT THE WITHDRAWAL LANDED. An unchecked rollback is not a
    // rollback: if it errors the row survives as `quoted`, and the sentence
    // below would have told the owner nothing happened.
    const undo = await admin
      .from("job_addons").update({ status: "withdrawn" })
      .eq("id", newId).eq("status", "quoted").select("id");
    if (undo.error || !undo.data || undo.data.length === 0) {
      console.error("[addons] repeat rollback did not land:", undo.error ?? "no row moved", { newId });
      return {
        ok: false,
        error:
          "We couldn't add that and we couldn't tidy up after ourselves either — you may see it listed as waiting on your decision. " +
          "Nothing was charged. Decline it and ask your crew again, and tell us if it won't go.",
      };
    }
    return { ok: false, error: writeFailed("add that to this visit", rpcErr, { money: true }) };
  }

  const contact = await crewContact(admin, job.vendor_id);
  if (contact) {
    await notify(
      "the crew that the owner has added the same extra again at their own earlier price",
      { phone: contact.phone, email: contact.email },
      {
        sms: `LakeLife: the owner has added "${req.text}" to your ${job.serviceName ?? "job"}${job.date ? ` on ${longDate(job.date)}` : ""} again, at your own ${money(m.crewQuote)}. You're paid ${money(m.crewPayout)} for it after the platform fee. 🌊`,
        subject: "An extra you've done before has been added again",
        body:
          `The owner has asked for this again, at the price you gave last time:\n\n"${req.text}"\n\n` +
          `Your number: ${money(m.crewQuote)}. You'll be paid ${money(m.crewPayout)} for it after the platform fee, with the booked job.\n\n` +
          // WHAT WAS HERE INSTRUCTED A CONTROL THAT DOES NOT EXIST — "tell us
          // before the visit and we'll take it off". There is no take-off
          // door: `withdrawAddon` is the owner's and refuses anything past
          // `requested`, and the crew's panel draws controls only for an
          // unanswered request. Pointing a contractor at a door that is not
          // drawn, about money, is this codebase's own bug class. This says
          // what is true and instructs nothing.
          `That price came from you on ${longDate(namedAt)}. We stop carrying a number forward once it's more than ${ADDON_OFFER_BACK_DAYS} days old, ` +
          "and after that the owner has to ask again so you can name a current one.",
      },
    );
  }

  return { ok: true, addonId: newId, price: m.customerPrice };
}
