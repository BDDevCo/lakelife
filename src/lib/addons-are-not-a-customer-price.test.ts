import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * RULE 1, ON THE ONE TABLE THAT PUTS BOTH NUMBERS ON THE SAME ROW.
 *
 * `job_addons` holds `customer_price` beside `crew_quote`, because an extra
 * has to be re-derivable years later and a row that carries only one end is
 * half a record. That makes it the first table in this product where a single
 * SELECT could hand a crew the customer's figure.
 *
 * Two fences, and this file asserts both:
 *
 *   THE DATABASE. 0180 grants the crew no select policy at all — reads are for
 *   the property owner and ops. A crew's own JWT gets nothing.
 *
 *   THE COLUMN LIST. Our own service-role code could still project it, so the
 *   crew's loader and the crew's actions name an explicit list that does not
 *   include it — the shape `assertVendorJob` already uses.
 *
 * A published 12% makes the arithmetic itself unhideable (0174 says so in
 * plain words): a crew who knows their card is $40 can work out the customer
 * paid $44.80. What must never happen is us PRINTING it for them.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const data = strip(read("../app/addons/data.ts"));
const actions = strip(read("../app/addons/actions.ts"));
const panel = strip(read("../components/CrewAddonPanel.tsx"));
const migration = read("../../supabase/migrations/0180_the_extra_they_asked_for.sql");

/** Everything between the marker and the end of that select's string literal. */
function selectAt(src: string, marker: string): string {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  return src.slice(i, src.indexOf(";", i));
}

/**
 * ONE FUNCTION, NOT "FROM HERE TO THE END OF THE FILE".
 *
 * `src.slice(indexOf(fn))` passed only because `getAddonsForCrewJob` happened
 * to be the last thing in the file that mentioned a customer column. Adding a
 * loader below it turned a rule-1 assertion into a statement about file
 * ordering — the fence moved when somebody typed, which is the one thing a
 * fence must not do. This stops at the next top-level declaration.
 */
function fnBody(src: string, name: string): string {
  const i = src.indexOf(name);
  if (i < 0) return "";
  const rest = src.slice(i + name.length);
  const nextDecl = rest.search(/\n(?:export )?(?:async )?function |\n(?:export )?(?:const|interface|type) /);
  return name + (nextDecl < 0 ? rest : rest.slice(0, nextDecl));
}

describe("the scanner found the crew path", () => {
  it("there is a crew column list and a crew loader", () => {
    expect(data).toContain("const CREW_COLS");
    expect(data).toContain("export async function getAddonsForCrewJob");
    expect(actions).toContain("async function crewAddon");
  });

  it("and the customer path really does carry the number, or there is nothing to fence", () => {
    // The mirror half: a fence around nothing passes every test below.
    expect(data).toContain("const CUSTOMER_COLS");
    expect(selectAt(data, "const CUSTOMER_COLS")).toContain("customer_price");
  });
});

describe("no crew-facing surface carries a customer number", () => {
  it("the crew column list does not name one", () => {
    const cols = selectAt(data, "const CREW_COLS");
    expect(cols.length).toBeGreaterThan(40);
    for (const col of ["customer_price", "margin", "fee_customer_pct"]) {
      expect(cols, `CREW_COLS projects ${col} to a crew`).not.toContain(col);
    }
    // It DOES carry the crew's own number, or the panel has nothing to show.
    expect(cols).toContain("crew_quote");
  });

  it("the crew loader selects that list and nothing else", () => {
    const fn = fnBody(data, "export async function getAddonsForCrewJob");
    // The scanner has to have found something, or every assertion below is
    // about an empty string.
    expect(fn.length).toBeGreaterThan(300);
    expect(fn).toMatch(/\.select\(CREW_COLS\)/);
    expect(fn).not.toContain("customer_price");
    // And it is scoped to THAT crew, so another crew's job id returns nothing.
    expect(fn).toMatch(/\.eq\("vendor_id", vendorId\)/);
  });

  it("a failed read on the crew's screen is told apart from an empty one", () => {
    // This is the ONE loader here that does not throw, because the crew's job
    // screen also carries the gate code, the navigation and the photo upload.
    // Degrading is right; degrading SILENTLY would tell a crew this owner
    // asked for nothing.
    const fn = fnBody(data, "export async function getAddonsForCrewJob");
    expect(fn.length).toBeGreaterThan(300);
    expect(fn).toMatch(/softRead\(/);
    expect(fn).toMatch(/failed,/);
    expect(panel, "the crew panel renders a failed read as 'there are none'")
      .toMatch(/if \(failed\)/);
  });

  it("the crew's own action gate selects no customer column either", () => {
    const fn = actions.slice(actions.indexOf("async function crewAddon"), actions.indexOf("async function crewContact"));
    expect(fn.length).toBeGreaterThan(300);
    for (const col of ["customer_price", "margin", "fee_customer_pct"]) {
      expect(fn, `the crew's gate selects ${col}`).not.toContain(col);
    }
  });

  it("every message that goes TO a crew names the crew's two numbers and no third one", () => {
    // THE MONEY SWEEP, PINNED. Six notify blocks in this feature; three of
    // them are addressed to a crew. `m.customerPrice` in one of those is the
    // customer's figure arriving on a contractor's phone, and no column list
    // or RLS policy can stop a template.
    const blocks = actions.split("await notify(").slice(1);
    expect(blocks.length, "the scanner found no notify blocks at all").toBeGreaterThanOrEqual(5);
    let toCrew = 0;
    for (const b of blocks) {
      const end = b.indexOf("\n    );");
      const block = b.slice(0, end >= 0 ? end : 2000);
      // The audience is the FIRST argument, which sits on its own line under
      // the call. Reading it off `b.indexOf("\n")` read an empty string and
      // matched nothing — which the vacuity check below caught.
      const audience = block.slice(0, 120);
      if (!/the crew that/.test(audience)) continue;
      toCrew += 1;
      expect(block, `a crew message quotes the customer's price: ${audience.trim()}`)
        .not.toContain("customerPrice");
      expect(block, `a crew message quotes a margin: ${audience.trim()}`)
        .not.toContain("margin");
    }
    // The mirror half: a loop that matched nothing passes every assertion in it.
    expect(toCrew, "no crew-addressed message was found — the scan is vacuous").toBeGreaterThanOrEqual(3);
  });

  it("and the one that goes TO an owner quotes the customer's price, not the crew's", () => {
    const blocks = actions.split("await notify(").slice(1);
    const priced = blocks.find((b) => /the owner that their crew has priced/.test(b.slice(0, 120)));
    expect(priced, "the quote notification is gone or renamed").toBeTruthy();
    expect(priced as string).toContain("money(m.customerPrice)");
    expect(priced as string, "an owner is shown the crew's own number").not.toContain("crewPayout");
  });

  it("the crew's pay statement names an extra rather than quietly including it", () => {
    // `payouts.amount` is `jobs.vendor_cost` and an accepted extra is folded
    // into it, so the fee sentence explained the booked job while the figure
    // beside it covered the booked job plus the extra. RULE 1 holds: the line
    // is built from `crew_payout`, and `customer_price` is not selected on
    // either crew path that feeds it.
    const helpers = strip(readFileSync(fileURLToPath(new URL("../app/vendor/earnings-helpers.ts", import.meta.url)), "utf8"));
    expect(helpers).toMatch(/Your quote for the booked job was/);
    expect(helpers).toMatch(/Extras the owner agreed on the visit add/);
    for (const rel of ["../app/vendor/earnings-data.ts", "../app/vendor/job-detail-data.ts"]) {
      const src = strip(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
      const q = src.slice(src.indexOf('from("job_addons")'));
      expect(q.slice(0, 300), `${rel} selects a customer number off job_addons`).not.toContain("customer_price");
      expect(q.slice(0, 300)).toContain("crew_payout");
    }
  });

  it("the crew's screen renders no customer figure", () => {
    for (const bad of ["customerPrice", "customer_price", "offeredPrice"]) {
      expect(panel, `the crew panel reaches for ${bad}`).not.toContain(bad);
    }
    // What it DOES show is both of the crew's own numbers, in words.
    expect(panel).toContain("crewPayout");
  });

  it("the database gives a crew no way in either", () => {
    const policy = migration.slice(migration.indexOf("create policy job_addons_read"), migration.indexOf("revoke all on public.job_addons"));
    expect(policy.length).toBeGreaterThan(100);
    expect(policy).toContain("properties");
    expect(policy).toContain("owner_id = auth.uid()");
    expect(policy, "the read policy admits a vendor").not.toContain("vendors");
    // And nobody but the service role writes.
    expect(migration).toMatch(/revoke insert, update, delete, truncate, references, trigger\s*\n\s*on public\.job_addons from authenticated;/);
  });
});

describe("the crew is never quietly short-paid", () => {
  it("the panel says the quote AND the take-home before they send it", () => {
    expect(panel).toMatch(/You quote \$\{|You quote \${money/);
    expect(panel).toContain("platform fee");
  });

  it("and it uses the shared arithmetic rather than a second copy", () => {
    expect(panel).toMatch(/import \{ crewPayout \} from "@\/lib\/platform-fee"/);
    expect(panel, "the crew panel computes a take-home by hand")
      .not.toMatch(/\*\s*\(1\s*-\s*crewPct\)/);
  });
});
