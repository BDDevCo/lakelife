import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NO_LAKE_LINE, NO_PIN_LINE, NO_LAKE_OR_PIN_LINE } from "./readiness";

/**
 * THE PUBLISH GATE'S REFUSAL IS A FACT NAMING WHO FIXES IT.
 *
 * "Set the park's lake first" was said to a person with no screen that sets
 * a lake — only ops writes lake_id, lat and lng (NewPark). The gate and the
 * readiness map row now print one sentence from one constant, and the ops
 * copy that told a new park owner to publish from /park/setup names the
 * Rent roll, where the button is.
 */
const strip = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("setParkLive", () => {
  const src = strip("./actions.ts");
  const fn = src.slice(src.indexOf("export async function setParkLive"));
  const body = fn.slice(0, fn.indexOf("export async function", 10));
  it("refuses with the shared constants, imported from readiness", () => {
    expect(body.length).toBeGreaterThan(400);
    expect(body).toMatch(/return \{ ok: false, error: NO_LAKE_LINE \}/);
    expect(body).toMatch(/return \{ ok: false, error: NO_PIN_LINE \}/);
    expect(body).not.toContain("Set the park's");
    expect(src).toMatch(/import \{ NO_LAKE_LINE, NO_PIN_LINE \} from "\.\/readiness"/);
  });
  it("the constants are facts that name us", () => {
    for (const line of [NO_LAKE_LINE, NO_PIN_LINE, NO_LAKE_OR_PIN_LINE]) {
      expect(line).toMatch(/that's ours to fix; get in touch\.$/);
      expect(line).not.toMatch(/^Set /);
    }
  });
});

describe("the ops copy on a new park", () => {
  it("says publishing is on the Rent roll, never /park/setup", () => {
    const src = strip("../../components/ops/NewPark.tsx");
    expect(src).not.toContain("/park/setup");
    expect(src).toContain("Rent roll");
    expect(src).toContain("nothing goes public from here");
  });
});
