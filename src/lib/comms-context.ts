import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { renderCustomerContext, renderCrewContext, type CustomerContext, type CrewContext } from "@/lib/comms-render";

/**
 * Context builders for personalized AI comms (owner directive, 2026-07-23:
 * "customized text or email responses based on each customer / crew
 * profile / services / jobs done / employees").
 *
 * RULE 1 IS ENFORCED HERE STRUCTURALLY, not by prompt: these builders are
 * the ONLY data source the AI ever sees, and they select only the columns
 * each audience is allowed to know. Customer context carries customer
 * prices and never vendor_cost/margin; crew context carries the crew's own
 * take-home and never customer prices or margins. The render layer
 * (lib/comms-render.ts, pure) is tested to hold that line.
 */

const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

export async function buildCustomerContext(userId: string): Promise<CustomerContext | null> {
  const admin = createServiceClient();
  const { data: user } = await admin.from("users").select("id, name, email").eq("id", userId).maybeSingle();
  if (!user) return null;

  const { data: props } = await admin
    .from("properties")
    .select("id, address, nickname, lakes(name)")
    .eq("owner_id", userId);
  const propIds = (props ?? []).map((p) => p.id as string);

  const [{ data: jobs }, { data: autopilot }, { data: credits }] = await Promise.all([
    propIds.length
      ? admin.from("jobs")
          .select("date, status, customer_price, services(name), properties(nickname, address)")
          .in("property_id", propIds)
          .in("status", ["requested", "scheduled", "in_progress", "complete", "paid"])
          .order("date", { ascending: false })
          .limit(12)
      : Promise.resolve({ data: [] as never[] }),
    admin.from("autopilot_enrollments").select("services(name)").eq("owner_id", userId).limit(10),
    admin.from("user_credits").select("amount").eq("user_id", userId),
  ]);

  return {
    name: (user.name as string) ?? null,
    properties: (props ?? []).map((p) => ({
      label: (p.nickname as string) ?? (p.address as string) ?? "their place",
      lake: (one(p.lakes) as { name?: string } | null)?.name ?? null,
    })),
    jobs: (jobs ?? []).map((j) => ({
      service: (one(j.services) as { name?: string } | null)?.name ?? "service",
      date: (j.date as string) ?? "",
      status: j.status as string,
      // The ALL-IN price is the customer's own number — allowed.
      price: j.customer_price == null ? null : Number(j.customer_price),
      where: (one(j.properties) as { nickname?: string; address?: string } | null)?.nickname
        ?? (one(j.properties) as { address?: string } | null)?.address ?? null,
    })),
    autopilotServices: (autopilot ?? []).map((a) => (one(a.services) as { name?: string } | null)?.name ?? "").filter(Boolean),
    creditBalance: Math.round(((credits ?? []).reduce((s, c) => s + Number(c.amount ?? 0), 0)) * 100) / 100,
  };
}

export async function buildCrewContext(vendorId: string): Promise<CrewContext | null> {
  const admin = createServiceClient();
  const { data: v } = await admin
    .from("vendors")
    .select("id, company, service_types, service_lakes, coi_expiry, garagekeepers_expiry")
    .eq("id", vendorId)
    .maybeSingle();
  if (!v) return null;

  const [{ data: lakes }, { data: trucks }, { data: payouts }, { data: upcoming }] = await Promise.all([
    admin.from("lakes").select("id, name").in("id", (v.service_lakes as string[]) ?? []),
    admin.from("crew_units").select("name, capacity, work_start, work_end, active").eq("vendor_id", vendorId),
    // The crew's OWN take-home ledger — their numbers, allowed.
    admin.from("payouts").select("amount, status, kind").eq("vendor_id", vendorId).limit(500),
    admin.from("jobs").select("date, services(name)").eq("vendor_id", vendorId)
      .in("status", ["scheduled", "in_progress"]).order("date", { ascending: true }).limit(8),
  ]);

  const released = (payouts ?? []).filter((p) => p.status === "released").reduce((s, p) => s + Number(p.amount ?? 0), 0);
  return {
    company: (v.company as string) ?? "your crew",
    services: (v.service_types as string[]) ?? [],
    lakes: (lakes ?? []).map((l) => l.name as string),
    trucks: (trucks ?? []).map((t) => ({
      name: t.name as string,
      capacity: Number(t.capacity ?? 0),
      hours: `${t.work_start}–${t.work_end}`,
      active: !!t.active,
    })),
    pendingTakeHome: Math.round(released * 100) / 100,
    upcomingJobs: (upcoming ?? []).map((j) => ({
      service: (one(j.services) as { name?: string } | null)?.name ?? "job",
      date: (j.date as string) ?? "",
    })),
    coiExpiry: (v.coi_expiry as string) ?? null,
    garagekeepersExpiry: (v.garagekeepers_expiry as string) ?? null,
  };
}

export { renderCustomerContext, renderCrewContext };
