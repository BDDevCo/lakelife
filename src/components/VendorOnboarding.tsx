"use client";

/**
 * The crew's onboarding checklist — shown whenever a vendor isn't 'active' yet.
 * Simple, tap-first steps (insurance, W-9, work, lakes, daily capacity, and an
 * optional home base). There is NO human approval gate anymore: the moment the
 * required steps clear, the crew flips THEMSELVES live with one button. Big tap
 * targets for wet gloves.
 */

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Stepper, ToggleChips } from "@/components/wizard-controls";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { toast } from "@/components/Toast";
import { TosAgreeModal } from "@/components/TosAgreeModal";
import { LAKE_GATE_SENTENCE, parkClause } from "@/lib/lake-gate";
import {
  uploadVendorDoc,
  setServiceTypes,
  setDailyCapacity,
  setServiceLakes,
  setBaseLocation,
  finishOnboarding,
} from "@/app/vendor/onboarding-actions";
import { setPayoutAccount } from "@/app/vendor/bank-actions";
import { activationGaps } from "@/app/vendor/onboarding-helpers";
import type { MyVendor } from "@/app/vendor/data";

function prettyDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Today (YYYY-MM-DD) in lake time — the yardstick for COI expiry. */
function lakeToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }).format(new Date());
}

/** Shared step number/checkmark badge, matching the existing step cards. */
function StepBadge({ num, done }: { num: number; done: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 26, height: 26, borderRadius: 999, flex: "0 0 auto",
        display: "grid", placeItems: "center", fontSize: 14, fontWeight: 800,
        background: done ? "var(--teal)" : "var(--line)",
        color: done ? "#fff" : "var(--sub)",
      }}
    >
      {done ? "✓" : num}
    </span>
  );
}

/** A bookable service, and whether it is a PARK's shared ground rather than
 *  somebody's lake house. The flag is why the chips are in two groups. */
export interface CrewService { name: string; parkOnly: boolean }

export function VendorOnboarding({
  vendor,
  activeServices,
  lakes = [],
  unpriced,
  parksByLake,
  bankOnFile,
}: {
  vendor: MyVendor;
  activeServices: CrewService[];
  lakes?: { id: string; name: string }[];
  /**
   * Work they ticked and never priced. `null` means WE COULD NOT CHECK — and
   * the Go-live card is required to word that differently, because "everything
   * is priced" is the sentence that keeps a crew sitting at home.
   */
  unpriced: string[] | null;
  /** Park names keyed by lake id, derived from the parks table. `null` = read failed. */
  parksByLake: Record<string, string[]> | null;
  /** Have they told us where the money lands? `null` = we could not check. */
  bankOnFile: boolean | null;
}) {
  const router = useRouter();

  // Paused accounts get one message and nothing to do.
  if (vendor.status === "suspended") {
    return (
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 480 }}>
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <span className="ll-pill slate">Paused</span>
          <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>Your crew account is paused</h2>
          {/* THIS CARD IS THE WHOLE SCREEN — VendorOnboarding returns early for
              a suspended crew, so there is no other link, button or address on
              it. Its one instruction was "call dispatch", and LakeLife
              publishes no number anywhere: no tel: link exists in the tree.
              A crew whose income has just stopped was given a dead end.
              bank-actions.ts already made this exact call for the payout-change
              alert ("CALL US IMMEDIATELY" NAMED NO NUMBER) and pointed at email
              instead. The second sentence is true and stays — isEligible's
              first line is `if (c.status !== "active") return false`. */}
          <p className="mut" style={{ fontSize: 15 }}>
            Email <a href="mailto:hello@lakelife.ai">hello@lakelife.ai</a> and we&apos;ll get
            you sorted — a human reads it. No jobs will route while your account is paused.
          </p>
        </div>
      </div>
    );
  }

  const coiDone = !!vendor.coi_url;
  const w9Done = !!vendor.w9_url;
  const servicesDone = vendor.service_types.length > 0;
  const lakesDone = vendor.service_lakes.length > 0;
  const capacityDone = vendor.daily_capacity >= 1;
  const baseDone = vendor.base_lat != null;

  const today = lakeToday();
  const gaps = activationGaps(
    {
      coi_url: vendor.coi_url,
      coi_named_insured: vendor.coi_named_insured,
      company: vendor.company,
      coi_expiry: vendor.coi_expiry,
      w9_url: vendor.w9_url,
      service_types: vendor.service_types,
      service_lakes: vendor.service_lakes,
      daily_capacity: vendor.daily_capacity,
    },
    today,
  );
  const readyToGoLive = gaps.length === 0;
  const coiFlagged = gaps.some((g) => /insurance|COI/i.test(g));

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 560 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>
        {vendor.company ? `Welcome, ${vendor.company}` : "Welcome to LakeLife"}
      </h1>
      <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
        A few quick things and you can flip yourself live. Do them in any order.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        <DocStep
          num={1}
          title="Insurance (COI)"
          kind="coi"
          done={coiDone}
          doneNote={vendor.coi_expiry ? `Expires ${prettyDate(vendor.coi_expiry)}` : undefined}
          onDone={() => router.refresh()}
        />
        <DocStep
          num={2}
          title="W-9"
          kind="w9"
          done={w9Done}
          onDone={() => router.refresh()}
        />
        <ServiceStep
          num={3}
          done={servicesDone}
          activeServices={activeServices}
          selected={vendor.service_types}
          onDone={() => router.refresh()}
        />
        <LakeStep
          num={4}
          done={lakesDone}
          lakes={lakes}
          parksByLake={parksByLake}
          selectedIds={vendor.service_lakes}
          onDone={() => router.refresh()}
        />
        <CapacityStep
          num={5}
          done={capacityDone}
          initial={vendor.daily_capacity}
          onDone={() => router.refresh()}
        />
        <BaseStep
          num={6}
          done={baseDone}
          onDone={() => router.refresh()}
        />
        {/* WHERE THE MONEY LANDS — asked BEFORE the first payout, not after.
            Nothing on this platform used to ask a crew for a bank account at
            all: the only door was a card on the Earnings screen, which a crew
            has no reason to open until they are owed something. Meanwhile
            `runMonthlyPayoutBatches` skips a crew with no `payout_accounts`
            row entirely (`if (!acct) continue`), so the first they would learn
            of it is a month-end that came and went.
            NOT in activationGaps, on purpose and for the same reason rates
            are not: the go-live gate is mechanical, and a bank account is a
            business decision a crew may reasonably make on their own clock. */}
        <BankStep
          num={7}
          onFile={bankOnFile}
          onDone={() => router.refresh()}
        />
      </div>

      <div style={{ marginTop: 18 }}>
        {readyToGoLive ? (
          <GoLiveCard unpriced={unpriced} onDone={() => router.refresh()} />
        ) : (
          <div className="ll-card ll-card-pad">
            <span className="ll-pill warn">Almost there</span>
            <p style={{ fontSize: 16, fontWeight: 700, margin: "10px 0 2px" }}>
              A few things left before you can go live
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 8 }}>
              {gaps.map((g) => (
                <li key={g} style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 14 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 20, height: 20, borderRadius: 999, flex: "0 0 auto", marginTop: 1,
                      border: "1.5px solid var(--line)", background: "#fff",
                    }}
                  />
                  <span>{g}</span>
                </li>
              ))}
            </ul>
            {coiFlagged && (
              <p style={{ fontSize: 13, fontWeight: 700, color: "var(--warn)", margin: "12px 0 0" }}>
                No insurance on file, no jobs — it&apos;s how we keep every dock covered.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DocStep({
  num,
  title,
  kind,
  done,
  doneNote,
  onDone,
}: {
  num: number;
  title: string;
  kind: "coi" | "w9";
  done: boolean;
  doneNote?: string;
  onDone: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [expiry, setExpiry] = useState("");
  const [insured, setInsured] = useState("");
  const [pending, startTransition] = useTransition();

  function submit() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast("Pick a file first.");
      return;
    }
    if (kind === "coi" && !expiry) {
      toast("Add the COI's expiry date.");
      return;
    }
    if (kind === "coi" && !insured.trim()) {
      toast("Add the insured business name off the certificate.");
      return;
    }
    const form = new FormData();
    form.set("file", file);
    if (kind === "coi") { form.set("expiry", expiry); form.set("named_insured", insured.trim()); }
    startTransition(async () => {
      const res = await uploadVendorDoc(kind, form);
      if (!res.ok) {
        toast.err(res.error ?? "Upload failed.");
        return;
      }
      toast(`${title} saved.`);
      if (fileRef.current) fileRef.current.value = "";
      setExpiry("");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          aria-hidden
          style={{
            width: 26, height: 26, borderRadius: 999, flex: "0 0 auto",
            display: "grid", placeItems: "center", fontSize: 14, fontWeight: 800,
            background: done ? "var(--teal)" : "var(--line)",
            color: done ? "#fff" : "var(--sub)",
          }}
        >
          {done ? "✓" : num}
        </span>
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>{title}</h3>
        {done && <span className="ll-pill ok">On file ✓</span>}
      </div>

      {done && doneNote && (
        <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>{doneNote}</p>
      )}

      <label className="ll-field" style={{ display: "block" }}>
        <span className="mut" style={{ fontSize: 13 }}>
          {done ? "Replace file (PDF or photo)" : "Upload file (PDF or photo)"}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
          style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
        />
      </label>

      {kind === "coi" && (
        <>
          <label className="ll-field" style={{ display: "block", marginTop: 10 }}>
            <span className="mut" style={{ fontSize: 13 }}>Expiry date</span>
            <input
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
            />
          </label>
          {/* 0152 — the name we compare against their business name. */}
          <label className="ll-field" style={{ display: "block", marginTop: 10 }}>
            <span className="mut" style={{ fontSize: 13 }}>Insured business name, exactly as printed</span>
            <input
              value={insured}
              onChange={(e) => setInsured(e.target.value)}
              placeholder="e.g. Northshore Docks, LLC"
              maxLength={200}
              style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
            />
          </label>
        </>
      )}

      <button
        className="ll-btn gold"
        onClick={submit}
        disabled={pending}
        style={{ marginTop: 12, width: "100%", minHeight: 48 }}
      >
        {pending ? "Uploading…" : done ? "Replace file" : "Upload"}
      </button>
    </div>
  );
}

function ServiceStep({
  num,
  done,
  activeServices,
  selected,
  onDone,
}: {
  num: number;
  done: boolean;
  activeServices: CrewService[];
  selected: string[];
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const [pending, startTransition] = useTransition();

  const lakeHomeWork = activeServices.filter((s) => !s.parkOnly).map((s) => s.name);
  const parkWork = activeServices.filter((s) => s.parkOnly).map((s) => s.name);

  function toggle(name: string) {
    setPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function save() {
    if (picked.length === 0) {
      toast("Tap at least one kind of work.");
      return;
    }
    startTransition(async () => {
      const res = await setServiceTypes(picked);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't save.");
        return;
      }
      toast("Work types saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          aria-hidden
          style={{
            width: 26, height: 26, borderRadius: 999, flex: "0 0 auto",
            display: "grid", placeItems: "center", fontSize: 14, fontWeight: 800,
            background: done ? "var(--teal)" : "var(--line)",
            color: done ? "#fff" : "var(--sub)",
          }}
        >
          {done ? "✓" : num}
        </span>
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>What work do you do?</h3>
        {done && <span className="ll-pill ok">Saved ✓</span>}
      </div>

      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>
        Tap everything your crew handles.
      </p>

      {activeServices.length === 0 ? (
        <p className="mut" style={{ fontSize: 14 }}>No services set up yet — email hello@lakelife.ai.</p>
      ) : (
        <>
          {/* PARK WORK IS SPLIT OUT, and this is the SAME fix MyServicesEditor
              already carries — whose own comment describes this bug in the
              past tense ("Onboarding drew them as adjacent chips in one flat
              list") while onboarding went on drawing them that way.
              It was fixed on the screen a LIVE crew edits and not on the first
              door a new one walks through, which is the only door that matters
              for a crew being recruited to mow The Haven in January.
              "Lawn mowing & trim" and "Park grounds mowing & trim" differ by
              one word, are two different jobs at two different prices, and sat
              three chips apart in one alphabetical grid. `isEligible` and
              `canClaim` both match on exact membership, so tapping the wrong
              one makes a crew invisible to every park mow — with no error, on
              either side. The heading is the whole fix: a crew who does parks
              knows they do parks. */}
          {lakeHomeWork.length > 0 && (
            <>
              <p style={{ fontSize: 12.5, fontWeight: 800, margin: "0 0 6px" }}>Lake homes</p>
              <ToggleChips options={lakeHomeWork} selected={picked} onToggle={toggle} />
            </>
          )}
          {parkWork.length > 0 && (
            <>
              <p style={{ fontSize: 12.5, fontWeight: 800, margin: "14px 0 6px" }}>
                Parks &mdash; a park&apos;s shared ground, priced per lot
              </p>
              <ToggleChips options={parkWork} selected={picked} onToggle={toggle} />
            </>
          )}
        </>
      )}

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 12, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/**
 * "PRETTY LAKE INCLUDES THE HAVEN" — and every sentence like it, derived.
 *
 * THE COPY MOVED TO lib/lake-gate, because this was not the only lake door:
 * /vendor/availability is where a crew who has already gone live changes the
 * answer, and it kept the old sentence. Re-exported here so the name and the
 * tests that pin it do not move.
 */
export { parkNote } from "@/lib/lake-gate";

function LakeStep({
  num,
  done,
  lakes,
  parksByLake,
  selectedIds,
  onDone,
}: {
  num: number;
  done: boolean;
  lakes: { id: string; name: string }[];
  parksByLake: Record<string, string[]> | null;
  selectedIds: string[];
  onDone: () => void;
}) {
  const nameById = new Map(lakes.map((l) => [l.id, l.name]));
  const idByName = new Map(lakes.map((l) => [l.name, l.id]));
  const initialNames = selectedIds
    .map((id) => nameById.get(id))
    .filter((n): n is string => !!n);

  const [picked, setPicked] = useState<string[]>(initialNames);
  const [pending, startTransition] = useTransition();
  const parks = parkClause(lakes, parksByLake);

  function toggle(name: string) {
    setPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function save() {
    if (picked.length === 0) {
      toast("Tap at least one lake you service.");
      return;
    }
    const ids = picked
      .map((n) => idByName.get(n))
      .filter((id): id is string => !!id);
    startTransition(async () => {
      const res = await setServiceLakes(ids);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't save.");
        return;
      }
      toast("Lakes saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <StepBadge num={num} done={done} />
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>Which lakes do you service?</h3>
        {done && <span className="ll-pill ok">Saved ✓</span>}
      </div>

      {/* THE COPY IS THE OTHER HALF OF THE GATE. "Tap every lake your crew
          works" reads as a preference; it is a filter on every job offer you
          will ever see, and a lake left untapped fails silently. */}
      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.5 }}>
        Tap every lake your crew works. {LAKE_GATE_SENTENCE}
        {parks && <>{" "}{parks}</>}
      </p>

      {lakes.length === 0 ? (
        <p className="mut" style={{ fontSize: 14 }}>No lakes set up yet — email hello@lakelife.ai.</p>
      ) : (
        <ToggleChips options={lakes.map((l) => l.name)} selected={picked} onToggle={toggle} />
      )}

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 12, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function CapacityStep({
  num,
  done,
  initial,
  onDone,
}: {
  num: number;
  done: boolean;
  initial: number;
  onDone: () => void;
}) {
  const [n, setN] = useState<number>(initial >= 1 ? initial : 1);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await setDailyCapacity(n);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't save.");
        return;
      }
      toast("Daily capacity saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <StepBadge num={num} done={done} />
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>How many jobs a day?</h3>
        {done && <span className="ll-pill ok">Saved ✓</span>}
      </div>

      <Stepper
        label="Jobs per day"
        value={n}
        onChange={setN}
        min={1}
        max={20}
        hint="The most stops we'll route to your crew in one day."
      />

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 4, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function BaseStep({
  num,
  done,
  onDone,
}: {
  num: number;
  done: boolean;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSelect(sel: { address: string; lat: number | null; lng: number | null; placeId: string | null }) {
    const { lat, lng } = sel;
    if (lat == null || lng == null) return;
    startTransition(async () => {
      const res = await setBaseLocation(lat, lng);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't save your home base.");
        return;
      }
      toast("Home base saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <StepBadge num={num} done={done} />
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>Where&apos;s home base?</h3>
        {done ? (
          <span className="ll-pill ok">Saved ✓</span>
        ) : (
          <span className="ll-pill slate">Optional</span>
        )}
      </div>

      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>
        Optional — sharpens which nearby jobs reach you. You can add it later. {pending ? "Saving…" : "🌊"}
      </p>

      <AddressAutocomplete value={value} onChange={setValue} onSelect={handleSelect} />
    </div>
  );
}

/**
 * WHERE SHOULD THE MONEY LAND?
 *
 * Nothing asked a crew this until they went looking on their own Earnings
 * screen — which a crew has no reason to open before they are owed something.
 * By then a month-end may already have passed them over: the batch runner
 * reads `payout_accounts` and does `if (!acct) continue`.
 *
 * DELIBERATELY NOT A GO-LIVE GATE (it is absent from `activationGaps`). Rates
 * are not one either, for the same stated reason: the gate is mechanical. The
 * cure for a missing bank account is a sentence on the screen they already
 * open, not a locked door.
 *
 * Its own small form rather than a reuse of VendorPayouts' BankCard, because
 * that card is wrapped in the released/ready/early-pull money furniture a crew
 * with zero completed jobs has no business reading.
 */
function BankStep({
  num,
  onFile,
  onDone,
}: {
  num: number;
  /** null = we could not check. Never render that as "no bank on file". */
  onFile: boolean | null;
  onDone: () => void;
}) {
  const [bankName, setBankName] = useState("");
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await setPayoutAccount({ bankName, routing, account });
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't save that bank info.");
        return;
      }
      setBankName(""); setRouting(""); setAccount("");
      setOpen(false);
      toast("Bank on file — encrypted and ready. 🌊");
      onDone();
    });
  }

  const editing = open || onFile === false;

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <StepBadge num={num} done={onFile === true} />
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>Where should the money land?</h3>
        {onFile === true ? (
          <span className="ll-pill ok">On file ✓</span>
        ) : (
          <span className="ll-pill slate">Optional</span>
        )}
      </div>

      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.5 }}>
        {onFile === null
          ? "We couldn't check whether we have your bank details just now. Payouts only go out to an account on file, so it's worth a look on your Earnings screen."
          : onFile
            ? "Your payouts go here. Encrypted at rest — we only ever show the last 4. You can change it any time on your Earnings screen."
            : "Optional now, but a payout can only go to an account on file — a month-end skips a crew who hasn't added one. Encrypted at rest; we only ever show the last 4."}
      </p>

      {onFile === true && !open && (
        <button className="ll-btn ghost sm" onClick={() => setOpen(true)} style={{ minHeight: 44 }}>
          Change
        </button>
      )}

      {editing && (
        <>
          <div style={{ display: "grid", gap: 10 }}>
            <label className="ll-field" style={{ display: "block" }}>
              <span className="mut" style={{ fontSize: 13 }}>Bank name</span>
              <input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="Lake Community Bank"
                style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
              />
            </label>
            <label className="ll-field" style={{ display: "block" }}>
              <span className="mut" style={{ fontSize: 13 }}>Routing number (9 digits)</span>
              <input
                inputMode="numeric"
                value={routing}
                onChange={(e) => setRouting(e.target.value)}
                placeholder="•••••••••"
                maxLength={9}
                style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
              />
            </label>
            <label className="ll-field" style={{ display: "block" }}>
              <span className="mut" style={{ fontSize: 13 }}>Account number</span>
              <input
                inputMode="numeric"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="••••••••"
                style={{ display: "block", marginTop: 6, minHeight: 44, width: "100%" }}
              />
            </label>
          </div>
          <button
            className="ll-btn gold"
            onClick={save}
            disabled={pending}
            style={{ marginTop: 12, width: "100%", minHeight: 48 }}
          >
            {pending ? "Saving…" : "Save bank info"}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * THE SENTENCE BEFORE THE BUTTON, AND WHAT MAKES IT TRUE.
 *
 * "Flip yourself on and jobs start routing to your crew" was told to a crew
 * who will be offered nothing. Go-live never asks for a rate; `decideDispatch`
 * refuses a crew with no positive rate (`no_qualifying_rate`) and `canClaim`
 * refuses with `no_rate`, so a crew who finishes all six cards and flips
 * themselves on is offered zero work and every board card refuses them. Under
 * crew pricing it is sharper still: the crew's own card IS the price, so a
 * crew with no card cannot even be listed for a buyer to choose.
 *
 * Exported and pure so a test can collapse the count both ways and require the
 * copy to change — the paragraph IS the fix, and a test that only checks the
 * all-priced branch pins nothing.
 */
export function goLiveLine(unpriced: string[] | null): string {
  if (unpriced === null) {
    // A FAILED READ MUST NOT RENDER AS "EVERYTHING IS PRICED". That sentence
    // is the reassuring one, and it is the one that keeps a crew at home.
    return (
      "We couldn't check your rates just now. We never offer you work you haven't " +
      "priced, and a card you saved blank counts as unpriced — so take a look at My " +
      "rates after you flip on."
    );
  }
  if (unpriced.length === 0) {
    return "Flip yourself on and jobs for the work you've priced start reaching you — no waiting on us.";
  }
  const list = unpriced.join(", ");
  return unpriced.length === 1
    ? `You can flip yourself on now — but you haven't set a rate for ${list}, and we never offer you work you haven't priced. Set it on My rates, before or after you go live.`
    : `You can flip yourself on now — but you haven't set a rate for ${list}, and we never offer you work you haven't priced. Set them on My rates, before or after you go live.`;
}

function GoLiveCard({ unpriced, onDone }: { unpriced: string[] | null; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [tosOpen, setTosOpen] = useState(false);
  const everythingPriced = unpriced !== null && unpriced.length === 0;

  function go(tosAccepted?: boolean) {
    startTransition(async () => {
      const res = await finishOnboarding(tosAccepted);
      if (res.needsTos) {
        setTosOpen(true);
        return;
      }
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't go live — try again.");
        return;
      }
      setTosOpen(false);
      onDone();
    });
  }

  return (
    <div
      className="ll-card ll-card-pad"
      style={{ textAlign: "center", borderColor: "var(--teal)" }}
    >
      <span className="ll-pill ok">Ready</span>
      <p style={{ fontSize: 18, fontWeight: 800, margin: "10px 0 4px" }}>
        You&apos;re ready to go live 🌊
      </p>
      <p className="mut" style={{ fontSize: 14, marginBottom: everythingPriced ? 14 : 10, lineHeight: 1.5 }}>
        {goLiveLine(unpriced)}
      </p>
      {!everythingPriced && (
        <p style={{ marginBottom: 14 }}>
          <Link className="ll-btn ghost sm" href="/vendor/rates">Set my rates</Link>
        </p>
      )}
      <button
        className="ll-btn gold"
        onClick={() => go()}
        disabled={pending}
        style={{ width: "100%", minHeight: 48 }}
      >
        {pending ? "Going live…" : "Go live — start getting jobs"}
      </button>

      <TosAgreeModal
        open={tosOpen}
        busy={pending}
        onAgree={() => go(true)}
        onClose={() => setTosOpen(false)}
        agreeLabel="I agree — go live 🌊"
      />
    </div>
  );
}
