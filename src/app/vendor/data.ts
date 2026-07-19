import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { decryptGate } from "@/lib/gate";
import { todayLakeDate } from "@/lib/booking";

export interface VendorStop {
  id: string;
  service_name: string | null;
  min_photos: number;
  date: string | null;
  status: string;
  sequence: number | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  lake_name: string | null;
  owner_name: string | null;
  facts: string; // short crew-facing profile summary (no prices)
  gate_code: string | null; // only populated for TODAY's jobs (rule 3)
  photo_count: number;
}

/** Is the signed-in user a vendor? Returns their vendor id, or null. */
export async function getMyVendorId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("vendors").select("id").eq("user_id", user.id).maybeSingle();
  return (data?.id as string) ?? null;
}

function factsFor(row: {
  service_name: string | null;
  pier_sections: number | null;
  boat_lifts: number | null;
  pwc_lifts: number | null;
  jet_skis: number | null;
  lawn_band: string | null;
}): string {
  const n = row.service_name ?? "";
  if (/pier/i.test(n)) return `${row.pier_sections ?? 0} pier sections`;
  if (/boat lift/i.test(n)) return `${row.boat_lifts ?? 0} boat lift(s)`;
  if (/pwc|jet ski/i.test(n)) return `${row.jet_skis ?? 0} jet ski(s), ${row.pwc_lifts ?? 0} PWC lift(s)`;
  if (/lawn|mow/i.test(n)) return `${row.lawn_band ?? "medium"} lawn`;
  return "";
}

/**
 * The vendor's stops for a given day (default: today), in drive order.
 * Gate codes are decrypted and attached ONLY for jobs dated today (rule 3);
 * any other day returns gate_code = null.
 */
export async function getVendorDay(dateISO?: string): Promise<{ date: string; stops: VendorStop[] } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const vendorId = await getMyVendorId();
  if (!vendorId) return null;

  const today = todayLakeDate();
  const date = dateISO ?? today;

  // Price-free crew view, scoped by RLS to this vendor's own jobs.
  const { data: jobs } = await supabase
    .from("vendor_jobs")
    .select("*")
    .eq("date", date)
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  const rows = jobs ?? [];
  if (rows.length === 0) return { date, stops: [] };

  // Photo counts per job.
  const admin = createServiceClient();
  const jobIds = rows.map((r) => r.id);
  const { data: photos } = await admin.from("job_photos").select("job_id").in("job_id", jobIds);
  const counts = new Map<string, number>();
  for (const p of photos ?? []) counts.set(p.job_id, (counts.get(p.job_id) ?? 0) + 1);

  // Gate codes: only for TODAY, and only decrypted server-side here.
  const gateByProp = new Map<string, string | null>();
  if (date === today) {
    const propIds = [...new Set(rows.map((r) => r.property_id))];
    const { data: props } = await admin
      .from("properties")
      .select("id, gate_code_encrypted")
      .in("id", propIds);
    for (const p of props ?? []) {
      try {
        gateByProp.set(p.id, decryptGate(p.gate_code_encrypted as unknown as string));
      } catch {
        gateByProp.set(p.id, null);
      }
    }
  }

  const stops: VendorStop[] = rows.map((r) => ({
    id: r.id,
    service_name: r.service_name,
    min_photos: r.min_photos ?? 0,
    date: r.date,
    status: r.status,
    sequence: r.sequence,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    lake_name: r.lake_name,
    owner_name: r.owner_name,
    facts: factsFor(r),
    gate_code: date === today ? gateByProp.get(r.property_id) ?? null : null,
    photo_count: counts.get(r.id) ?? 0,
  }));

  return { date, stops };
}
