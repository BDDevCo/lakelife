import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ParkReadiness } from "./ParkReadiness";
import type { ReadinessRow } from "@/app/park/readiness";

/**
 * THE LIST ON SCREEN: three glyphs, a door on every next step that has one,
 * and no door on the row nobody but LakeLife can act on.
 */
const rows: ReadinessRow[] = [
  { key: "lots", done: false, optional: false, label: "No lots yet", next: "Add your lots — under Lots & rates", href: "/park/lots" },
  { key: "fees", done: false, optional: true, label: "No fees — fine if you don't charge any", next: "'Add a fee' under Costs & fees if you do", href: "/park/costs" },
  { key: "households", done: true, optional: false, label: "18 of 21 live lots have a household on them — 11 still lack an email or a number the office can ring", next: "Add their email and phone from their row on the rent roll", href: "/park" },
  { key: "map", done: false, optional: false, label: "The park's lake isn't set — that's ours to fix; get in touch.", next: null, href: null },
  { key: "rent_due", done: true, optional: false, label: "Rent is due on the 1st", next: null, href: "/park/setup" },
];

const html = renderToStaticMarkup(<ParkReadiness headline="Getting Cedar Hollow ready" sub="2 of 4 done." rows={rows} />);

describe("ParkReadiness", () => {
  it("prints the headline and the sub", () => {
    expect(html).toContain("Getting Cedar Hollow ready");
    expect(html).toContain("2 of 4 done.");
  });

  it("✓ for done, ☐ for required-undone, – for optional-undone", () => {
    const glyphs = [...html.matchAll(/<span style="width:18px">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(glyphs).toEqual(["☐", "–", "✓", "☐", "✓"]);
  });

  it("a not-done row with a door links its next step", () => {
    expect(html).toContain('<a href="/park/lots">Add your lots — under Lots &amp; rates</a>');
    expect(html).toContain('<a href="/park/costs">');
  });

  it("a DONE row that still has a next (households missing a contact) links it too", () => {
    expect(html).toContain('<a href="/park">Add their email and phone from their row on the rent roll</a>');
  });

  it("the map row has no link at all — nothing the owner can press", () => {
    const mapRow = html.slice(html.indexOf("The park&#x27;s lake"), html.indexOf("Rent is due"));
    expect(mapRow).not.toContain("<a ");
  });

  it("a done row's label is muted; an undone one is not", () => {
    expect(html).toContain('<span class="mut">Rent is due on the 1st</span>');
    expect(html).toContain("<span>No lots yet</span>");
  });

  it("carries no h1 (page titles are the page's), and the file has no 'use client'", () => {
    expect(html).not.toContain("<h1");
    const src = readFileSync(fileURLToPath(new URL("./ParkReadiness.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toContain('"use client"');
    expect(src).toContain("export function ParkReadiness");
  });
});
