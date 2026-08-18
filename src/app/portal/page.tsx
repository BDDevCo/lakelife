import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { hasSupabaseEnv } from "@/lib/env";
import { claimCrewInvite } from "@/app/ops/crews-invite";
import { claimCustomerImports } from "@/app/vendor/import-actions";
import { claimReferral } from "./referral-actions";

/**
 * The one front door after sign-in: sends each person to THEIR portal.
 * Crews land on today's route; homeowners land on booking. If this email
 * has a pending crew invite, it's claimed right here — sign up with the
 * invited email and you're a crew, no extra steps.
 */
export default async function PortalPage() {
  if (!hasSupabaseEnv()) redirect("/");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // This row decides which door they get. A failed read would read as "no
  // role" and send ops, crews and park owners to the homeowner booking page.
  const me = mustRead(
    "your account",
    await supabase.from("users").select("role").eq("id", user.id).maybeSingle(),
  );

  // Referral attribution (one-time, self-referral blocked) — §8 rails.
  await claimReferral(user.id);

  let role = me?.role;

  // PARK MEMBERS ROUTE FIRST, and deliberately BEFORE claimCrewInvite.
  //
  // Two bugs live in that ordering. The small one: a park owner signing in had
  // no branch at all and landed on /book, the homeowner booking page, with no
  // way to find his own park.
  //
  // The damaging one: claimCrewInvite flips ANY non-vendor/non-ops user to
  // role='vendor' on an email match. A park owner who also mows his own common
  // areas is exactly the person ops would invite as a crew — and that flip
  // empties his services menu, because services_read grants SELECT on services
  // only to ops or role='owner' (migration 0052 constraint 2 documents this).
  // guard_role_change then makes it awkward to undo. Park identity lives in a
  // side table precisely so it never has to touch users.role; honouring that
  // here means checking membership before anything can rewrite the role.
  if (role !== "ops") {
    const admin = createServiceClient();
    // FAILS OPEN if left alone, and this is the guard the comment above is
    // about: a failed read reads as "not a park member", so the park owner
    // falls straight into claimCrewInvite, which REWRITES users.role to
    // 'vendor' on an email match — a write guard_role_change then makes
    // awkward to undo. It must not be skipped because a read blipped.
    const membership = mustRead(
      "whether you own or manage a park",
      await admin
        .from("park_members")
        .select("park_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle(),
    );
    if (membership) redirect("/park");
  }

  if (role !== "vendor" && role !== "ops") {
    const claimed = await claimCrewInvite(user.id, user.email);
    if (claimed) role = "vendor";
  }

  // A RESIDENT HAS ONE DOOR, NOT TWO.
  //
  // Someone renting a lot was landing on /book — the lake-house booking page —
  // with no route to their rent, their deposit or the repair they reported.
  // Their own screen carries all of it AND the way through to booking, so this
  // is the whole portal for them rather than a second one.
  //
  // AFTER the crew check above, deliberately: a resident who also mows for a
  // living is a crew first, because that is the account that decides what they
  // are shown all day. Before the homeowner fallback, because a lot is a more
  // specific answer to "where does this person live" than "somewhere".
  if (role !== "vendor" && role !== "ops") {
    const admin = createServiceClient();
    const file = mustRead(
      "your resident file",
      await admin
        .from("park_renters")
        .select("id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle(),
    );
    if (file) {
      const stay = mustRead(
        "your tenancy",
        await admin
          .from("lot_reservations")
          .select("id")
          .eq("renter_id", file.id as string)
          .in("status", ["approved", "active"])
          .limit(1)
          .maybeSingle(),
      );
      // A claimed file with no live tenancy is an applicant, not a resident —
      // they carry on to the ordinary customer door rather than being sent to
      // a screen that would only tell them they have no lot.
      if (stay) redirect("/parks/my");
    }
  }

  // Homeowners: materialize any crew-imported properties (crew stays preferred).
  if (role !== "vendor" && role !== "ops") {
    await claimCustomerImports(user.id, user.email);
  }

  if (role === "ops") redirect("/ops");
  redirect(role === "vendor" ? "/vendor" : "/book");
}
