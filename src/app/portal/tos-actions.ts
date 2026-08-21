"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureTos } from "@/lib/tos-server";

/** Explicit, versioned acceptance — stamped who/which/when, then onward.
 *  Used by the grandfathered-crew card (crews active before the rails). */
export async function acceptTos(form: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  // ONE WRITER, AND IT IS THE LEDGER. This wrote the two columns directly,
  // which meant the grandfathered-crew card recorded an acceptance with none of
  // the words — the exact gap 0139 exists to close. `ensureTos` carries the
  // snapshot, so both doors record the same thing.
  await ensureTos(user.id, true);
  const next = String(form.get("next") ?? "/portal");
  redirect(next.startsWith("/") ? next : "/portal");
}
