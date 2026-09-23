import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CrewRateNote } from "./JobBoard";
import { MarginTable } from "./MarginTable";
import type { ActiveVendor, MarginRow } from "@/app/ops/data";

/**
 * A NUMBER NOBODY CHARGED, PRINTED WHERE A PRICE GOES.
 *
 * Three different answers to "what does LakeLife take" sat in one viewport:
 * the ops header pill said "30% platform margin", MarginTable's footer said
 * "the 30% platform fee", and the total ten pixels under that footer read
 * 33.9%. There is no 30% anywhere in this product. The only enforced dial was
 * `margin_floor` at 0.20 — a circuit breaker, not a target — and 0174 replaced
 * the idea entirely with two published percentages at 12% each.
 *
 * The third shape is the expensive one: both override modals opened the box
 * that sets a contractor's pay pre-filled with `round(customer_price × 0.7)`,
 * labelled "Suggested $423 (30% margin)". `assignAndSchedule` consults no rate
 * card — it writes whatever is in that box to `jobs.vendor_cost` — so the hour
 * the first real crew goes active, a figure this product invented is the
 * default answer to "what do we pay this contractor". That is LakeLife setting
 * a crew's price, which is the exact thing the owner abolished.
 *
 * These are source scans where the defect is an initializer or a string
 * literal, and renders where a person reads a sentence. Comments are stripped
 * first — this file quotes the old copy in prose, and so do the files it reads.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const opsPage = strip(read("../../app/ops/page.tsx"));
const marginTable = strip(read("./MarginTable.tsx"));
const jobBoard = strip(read("./JobBoard.tsx"));
const jobFile = strip(read("./JobFile.tsx"));

const FILES: Array<[string, string]> = [
  ["ops/page.tsx", opsPage],
  ["MarginTable.tsx", marginTable],
  ["JobBoard.tsx", jobBoard],
  ["JobFile.tsx", jobFile],
];

describe("the files this scan reads", () => {
  it("found all four with their comments removed — a scan of an empty string passes everything", () => {
    for (const [name, src] of FILES) {
      expect(src.length, `${name} came back empty`).toBeGreaterThan(1500);
    }
    // The prose above quotes the defect; the stripped source must not.
    expect(strip("// 30% platform margin\nconst x = 1;")).not.toContain("30%");
    expect(jobBoard).toContain("AssignModal");
    expect(jobFile).toContain("AssignModal");
  });
});

describe("no screen states a platform take that is not read from a dial", () => {
  it("nobody says 30% any more — there is no such column", () => {
    for (const [name, src] of FILES) {
      expect(src, `${name} still prints an invented platform percentage`).not.toMatch(/30\s*%/);
    }
  });

  it("nobody derives a crew's pay from the customer price", () => {
    // `× 0.7` was the prefill AND the label under it. Both doorways.
    for (const [name, src] of FILES) {
      expect(src, `${name} still computes a crew cost from the customer price`).not.toMatch(
        /price\s*\*\s*0?\.7|0?\.7\s*\*\s*price/,
      );
    }
  });

  it("the header's percentages are read from platform_settings, by name", () => {
    // The dials the page already loads: `s` is getPlatformSettings(). A copy
    // figure has to name the column it came from or it is somebody's memory.
    expect(opsPage).toMatch(/pct\(s\.platformFeeCustomerPct\)/);
    expect(opsPage).toMatch(/pct\(s\.platformFeeCrewPct\)/);
    expect(opsPage).toMatch(/pct\(s\.marginFloor\)/);
    // And it says they are dials, not a fact about any particular job — the
    // two models can both be live at once (services.crew_priced).
    expect(opsPage).toContain("Live dials");
  });

  it("the blended KPI is not printed over an empty set", () => {
    // A blended rate is a rate ACROSS jobs. With the fixture rows fenced out of
    // the figures, a quiet week is normal — and "0% blended" under $0 would be
    // the same defect in miniature.
    expect(opsPage).toMatch(/summary\.jobsThisWeek > 0 \? `\$\{summary\.weekMarginPct\}% blended`/);
    expect(opsPage).toContain("no jobs this week yet");
  });

  it("the header no longer claims a fee is hidden by quoting a number for it", () => {
    // The true half — this console is the only place crew cost and our share
    // appear at all (rule 1) — never needed a percentage, and is true under
    // both the menu-margin model and the crew-quote one.
    expect(opsPage).toContain("shown nowhere else");
    expect(opsPage).not.toMatch(/platform margin/);
  });
});

/** One service line: $500 of customer money, $350 to the crew, $150 left. */
const row = (over: Partial<MarginRow> = {}): MarginRow => ({
  service_name: "Weekly mow",
  jobs: 1,
  customer_total: 500,
  vendor_total: 350,
  margin_total: 150,
  margin_pct: 30,
  customer_booked: 500,
  vendor_booked: 350,
  margin_booked: 150,
  refunded_total: 0,
  clawback_total: 0,
  ...over,
});

describe("the margin table's footer quotes the table above it, or nothing", () => {
  it("names the figure it just computed, as earnings rather than as a rate", () => {
    const html = renderToStaticMarkup(
      <MarginTable rows={[row()]} total={row({ service_name: "Total", margin_pct: 33.9 })} />,
    );
    expect(html).toContain("33.9%");
    expect(html).toContain("not a rate we charge");
    expect(html).not.toContain("30% platform fee");
  });

  it("moves with the table — the sentence cannot drift from the row it describes", () => {
    const html = renderToStaticMarkup(
      <MarginTable rows={[row()]} total={row({ service_name: "Total", margin_pct: 21.4 })} />,
    );
    expect(html).toContain("21.4%");
    expect(html).not.toContain("33.9%");
  });

  it("says NO percentage when there are no jobs — 0% is a claim about an empty set", () => {
    const html = renderToStaticMarkup(
      <MarginTable rows={[]} total={row({ service_name: "Total", jobs: 0, margin_pct: 0 })} />,
    );
    expect(html).toContain("No priced jobs yet");
    expect(html).not.toMatch(/\d+(\.\d+)?%/);
    // The confidentiality half still stands — it was never the untrue part.
    expect(html).toContain("here and nowhere else");
  });
});

/** The initializer of the crew-cost box, as written. */
const costInitializer = (src: string): string => {
  const m = src.match(/const \[cost, setCost\] = useState<string>\(([\s\S]*?)\);/);
  return m ? m[1] : "";
};

describe("the box that sets a contractor's pay proposes nothing", () => {
  it("found the box in both doorways — this scan is not passing on a miss", () => {
    expect(costInitializer(jobBoard).length).toBeGreaterThan(0);
    expect(costInitializer(jobFile).length).toBeGreaterThan(0);
  });

  it("has no computed default in either doorway", () => {
    for (const [name, src] of [["JobBoard.tsx", jobBoard], ["JobFile.tsx", jobFile]] as const) {
      const init = costInitializer(src);
      expect(init, `${name} still derives an opening crew cost`).not.toMatch(/price|\*|Math\./);
      // What it MAY do is carry a cost already on the job — that is a number
      // somebody actually agreed, not one this product invented.
      expect(init).toMatch(/vendorCost|vendor_cost/);
      expect(init).toMatch(/""/);
    }
  });

  it("an EMPTY box is not zero — Number(\"\") is 0 and would pay a crew nothing", () => {
    for (const [name, src] of [["JobBoard.tsx", jobBoard], ["JobFile.tsx", jobFile]] as const) {
      expect(src, `${name} would call an untouched field valid`).toMatch(
        /const costValid = typed !== ""/,
      );
      expect(src, `${name} reads the raw box instead of the trimmed text`).toMatch(
        /const typed = cost\.trim\(\)/,
      );
    }
  });

  it("keeps the manual path — ops must still record a number that WAS negotiated", () => {
    // The instruction was to stop proposing a figure, not to remove the ability
    // to enter one. Deleting the doorway would be its own defect.
    for (const [name, src] of [["JobBoard.tsx", jobBoard], ["JobFile.tsx", jobFile]] as const) {
      expect(src, `${name} lost the cost input`).toMatch(/value=\{cost\}/);
      expect(src, `${name} lost the assign call`).toContain("assignAndSchedule(");
    }
  });

  it("both doorways import the ONE note rather than re-typing it", () => {
    expect(jobBoard).toContain("export function CrewRateNote");
    expect(jobFile).toMatch(/import \{ CrewRateNote \} from "@\/components\/ops\/JobBoard";/);
    expect(jobFile).not.toContain("function CrewRateNote");
    for (const src of [jobBoard, jobFile]) {
      expect(src).toMatch(/<CrewRateNote/);
    }
  });
});

const crew = (over: Partial<ActiveVendor> = {}): ActiveVendor => ({
  id: "v1",
  company: "GreenEdge Lawn Co.",
  coi_ok: true,
  coi_expiry: "2027-01-01",
  service_types: ["mow"],
  daily_capacity: 6,
  rate_cards: [],
  ...over,
});

describe("what sits beside the box is the crew's own card", () => {
  it("with nobody chosen, it asks rather than answers", () => {
    const html = renderToStaticMarkup(<CrewRateNote crew={null} serviceName="Weekly mow" />);
    expect(html).toContain("Choose a crew");
    expect(html).not.toMatch(/\$/);
  });

  it("prints their number, to the cent, and calls it theirs", () => {
    const html = renderToStaticMarkup(
      <CrewRateNote
        crew={crew({
          rate_cards: [{
            service_name: "Pier install",
            pricing_model: "per_section",
            base: 180,
            unit_rate: 48.5,
            band_pricing: null,
            priced: true,
          }],
        })}
        serviceName="Pier install"
      />,
    );
    expect(html).toContain("$180.00 base");
    // To the cent: the whole-dollar formatter would print $49 and put a number
    // on screen that is not on their card.
    expect(html).toContain("$48.50 per section");
    expect(html).toContain("GreenEdge Lawn Co.");
    // And it does not pretend to be this job's total — the section count does
    // that, and this component has never seen the property.
    expect(html).toContain("not this job");
  });

  it("says plainly when the crew has priced nothing, and never fills the gap", () => {
    const html = renderToStaticMarkup(
      <CrewRateNote crew={crew()} serviceName="Weekly mow" />,
    );
    expect(html).toContain("no rate on file");
    expect(html).toContain("LakeLife doesn");
    // An unpriced service is the SAFE state. No figure may appear here.
    expect(html).not.toMatch(/\$\d/);
  });

  it("a saved row of zeroes is not a rate", () => {
    // getCrewCoverage's own test (0162): `priced` false, and the words come out
    // empty even if it were true, so both halves have to fail before a crew
    // with no number reads as priced.
    const zeroes = {
      service_name: "Weekly mow",
      pricing_model: "flat",
      base: 0,
      unit_rate: 0,
      band_pricing: null,
      priced: false,
    };
    const html = renderToStaticMarkup(
      <CrewRateNote crew={crew({ rate_cards: [zeroes] })} serviceName="Weekly mow" />,
    );
    expect(html).toContain("no rate on file");
    expect(html).toMatch(/Weekly mow/);
  });

  it("a card for a DIFFERENT service is not this service's rate", () => {
    const html = renderToStaticMarkup(
      <CrewRateNote
        crew={crew({
          rate_cards: [{
            service_name: "Weekly mow",
            pricing_model: "flat",
            base: 125,
            unit_rate: 0,
            band_pricing: null,
            priced: true,
          }],
        })}
        serviceName="Pier install"
      />,
    );
    expect(html).toContain("no rate on file");
    expect(html).not.toContain("$125");
  });

  it("names the bands a band-priced crew actually set", () => {
    const html = renderToStaticMarkup(
      <CrewRateNote
        crew={crew({
          rate_cards: [{
            service_name: "Weekly mow",
            pricing_model: "band",
            base: 0,
            unit_rate: 0,
            band_pricing: { small: 45, medium: 65, large: 90 },
            priced: true,
          }],
        })}
        serviceName="Weekly mow"
      />,
    );
    expect(html).toContain("small $45.00");
    expect(html).toContain("medium $65.00");
    expect(html).toContain("large $90.00");
  });
});
