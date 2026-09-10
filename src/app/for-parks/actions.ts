"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";

/**
 * A PARK OWNER ASKING ABOUT US.
 *
 * Not a signup. Nothing in this product creates a park — there is no INSERT on
 * `parks` or `park_members` anywhere in `src`, deliberately — so the honest
 * shape of this door is a conversation, and the form says so.
 *
 * SERVICE CLIENT, and no client grant. `anon` holding INSERT on a table fed by
 * a public form is how it fills with rubbish, so 0164 revokes everything and
 * this action is the only writer.
 */

export interface EnquiryResult {
  ok: boolean;
  error?: string;
}

/** Trim, collapse whitespace, and cap. Null when there is nothing left. */
function tidy(v: FormDataEntryValue | null, max: number): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return s.length ? s : null;
}

export async function submitParkEnquiry(form: FormData): Promise<EnquiryResult> {
  if (!hasSupabaseEnv()) {
    return { ok: false, error: "We can't take that just now. Please email us instead." };
  }

  const name = tidy(form.get("name"), 120);
  const email = tidy(form.get("email"), 200);

  // THE TWO THINGS WITHOUT WHICH THIS IS NOT AN ENQUIRY. Everything else is
  // optional on purpose: a form that demands a lot count from somebody kicking
  // the tyres is a form they abandon halfway.
  if (!name) return { ok: false, error: "Please add your name so we know who we're talking to." };
  if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Please add an email address we can reply to." };
  }

  // A lot count is the single most useful number for judging whether a park is
  // worth a call — but a typo must not refuse the whole enquiry, so an
  // unreadable one is dropped rather than argued with.
  const lotsRaw = String(form.get("lots") ?? "").replace(/[^0-9]/g, "");
  const lots = lotsRaw ? Math.min(10000, Number(lotsRaw)) : null;

  const { error } = await createServiceClient().from("park_enquiries").insert({
    name,
    email,
    phone: tidy(form.get("phone"), 40),
    park_name: tidy(form.get("park_name"), 160),
    town: tidy(form.get("town"), 160),
    lots,
    note: tidy(form.get("note"), 2000),
  });

  if (error) {
    // NEVER "try again" over a constraint that will refuse it again, and never
    // the database's own words to a stranger.
    console.error("[park enquiry] insert failed:", error);
    return {
      ok: false,
      error: "That didn't send. Please email hello@lakelife.ai and we'll pick it up from there.",
    };
  }

  return { ok: true };
}
