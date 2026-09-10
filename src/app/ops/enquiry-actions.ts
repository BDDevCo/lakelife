"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";

/**
 * MARK A PARK ENQUIRY ANSWERED.
 *
 * The card reads only unanswered ones, so this is what stops the list growing
 * forever — an enquiry board that never shrinks is one somebody stops reading,
 * which is the same failure as never having built it, arriving more slowly.
 *
 * It records WHO cleared it. There is one ops account today and that will not
 * always be true, and "who said they had replied to this person" is the
 * question asked when somebody says nobody ever got back to them.
 */
export async function markEnquiryHandled(id: string): Promise<{ ok: boolean; error?: string }> {
  const me = await assertOps();
  if (!me) return { ok: false, error: "Ops only." };
  if (!id) return { ok: false, error: "Nothing selected." };

  const { data, error } = await createServiceClient()
    .from("park_enquiries")
    .update({ handled_at: new Date().toISOString(), handled_by: me.id })
    .eq("id", id)
    .is("handled_at", null)   // a second tap loses rather than restamping
    .select("id");

  if (error) return { ok: false, error: "That didn't save — try again." };
  if (!data?.length) return { ok: false, error: "Somebody already picked that one up." };

  revalidatePath("/ops");
  return { ok: true };
}
