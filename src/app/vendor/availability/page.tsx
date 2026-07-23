import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyVendorId } from "@/app/vendor/data";
import { todayLakeDate, toISODate } from "@/lib/booking";
import { AvailabilityGrid, type DayRow, type SlotStatus } from "./AvailabilityGrid";
import { SLOT_TIMES } from "./slots";
import { WorkDayChips } from "./WorkDayChips";
import { MyLakesEditor } from "@/components/MyLakesEditor";
import { VendorStorage } from "@/components/VendorStorage";
import { MyTrucks } from "@/components/MyTrucks";
import { getMyTrucks } from "@/app/vendor/trucks-data";

// getDay() index -> the 3-letter form stored in vendors.work_days.
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function VendorAvailabilityPage() {
  if (!hasSupabaseEnv()) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div>
      </>
    );
  }

  const vendorId = await getMyVendorId();
  if (!vendorId) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Crews only</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>This is the vendor area</h3>
            <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
              Availability is where LakeLife crews set the days and slots they work.
            </p>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const supabase = await createClient();
  const { data: vendor } = await supabase
    .from("vendors")
    .select("work_days, service_lakes, storage_capacity_feet, storage_types, garagekeepers_url, garagekeepers_expiry")
    .eq("id", vendorId)
    .maybeSingle();
  const workDays: string[] = (vendor?.work_days as string[] | null) ?? [];
  const serviceLakes: string[] = (vendor?.service_lakes as string[] | null) ?? [];
  const storageCapacityFeet: number = (vendor?.storage_capacity_feet as number | null) ?? 0;
  const storageTypes: string[] = (vendor?.storage_types as string[] | null) ?? [];
  const garagekeepersUrl: string | null = (vendor?.garagekeepers_url as string | null) ?? null;
  const garagekeepersExpiry: string | null = (vendor?.garagekeepers_expiry as string | null) ?? null;

  // All lakes on the platform, for the "Lakes I service" editor.
  const admin = createServiceClient();
  const { data: lakeRows } = await admin.from("lakes").select("id, name").order("name");
  const lakes = (lakeRows ?? []).map((l) => ({ id: l.id as string, name: l.name as string }));

  // The next 5 days the vendor actually works, starting today (lake time).
  const today = todayLakeDate();
  const cursor = new Date(today + "T12:00:00"); // noon avoids any timezone day-flip
  const workingDays: { date: string; label: string }[] = [];
  for (let guard = 0; workingDays.length < 5 && guard < 60; guard++) {
    const wd = WEEKDAY[cursor.getDay()];
    if (workDays.includes(wd)) {
      workingDays.push({ date: toISODate(cursor), label: `${wd} ${cursor.getDate()}` });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // Existing rows for those days -> lookup; absence of a row means "open".
  const statusByKey = new Map<string, SlotStatus>();
  if (workingDays.length > 0) {
    const { data: avail } = await supabase
      .from("vendor_availability")
      .select("date, slot, status")
      .eq("vendor_id", vendorId)
      .in("date", workingDays.map((d) => d.date));
    for (const r of avail ?? []) {
      statusByKey.set(`${r.date}|${r.slot}`, r.status as SlotStatus);
    }
  }

  // This crew's fleet (crew_units) — empty for the vast majority of vendors
  // today; the legacy single-route path is untouched either way.
  const trucks = await getMyTrucks();

  const rows: DayRow[] = workingDays.map((d) => ({
    date: d.date,
    label: d.label,
    slots: Object.fromEntries(
      SLOT_TIMES.map((s) => [s, statusByKey.get(`${d.date}|${s}`) ?? "open"]),
    ) as Record<string, SlotStatus>,
  }));

  return (
    <>
      <TopBar />
      <VendorNav />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>My availability</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 22, maxWidth: 540 }}>
          The LakeLife scheduler only books your open slots. Tap any open slot to block it — tap again to reopen.
        </p>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>Days I work</h2>
          <WorkDayChips workDays={workDays} />
        </section>

        <section>
          <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>Next 5 working days</h2>
          {rows.length === 0 ? (
            <div className="ll-card ll-card-pad">
              <p className="mut" style={{ fontSize: 14 }}>
                Pick the days you work above and they&apos;ll show up here.
              </p>
            </div>
          ) : (
            <AvailabilityGrid days={rows} />
          )}
        </section>

        <section style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>Lakes I service</h2>
          <div className="ll-card ll-card-pad">
            <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>
              Tap the lakes your crew works. New lakes take effect on tomorrow&apos;s dispatch.
            </p>
            <MyLakesEditor lakes={lakes} selectedIds={serviceLakes} />
          </div>
        </section>

        <section style={{ marginTop: 28 }}>
          <VendorStorage
            capacityFeet={storageCapacityFeet}
            storageTypes={storageTypes}
            garagekeepersUrl={garagekeepersUrl}
            garagekeepersExpiry={garagekeepersExpiry}
          />
        </section>

        <section style={{ marginTop: 28, marginBottom: 28 }}>
          <MyTrucks trucks={trucks} />
        </section>
      </div>
    </>
  );
}
