import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE BATCH PAGE'S GUARD, SPLIT.
 *
 * `!park || !batch` used to share one card with no strip, so an owner
 * following a stale link lost the six-tab strip and the ⊕ — the way off the
 * screen — even though his park was known. The park-less card and the
 * batch-less card are now two branches, and only the second wears the strip.
 *
 * The real page, with its two loaders faked at their module boundary.
 */

let park: { id: string; name: string } | null = { id: "park-haven", name: "The Haven" };
let batch: Record<string, unknown> | null = null;

const someBatch = () => ({
  id: "batch-1", parkName: "The Haven", linesTotal: 2, linesRead: 2, rawText: "x",
  committedAt: null, undoneAt: null,
  plan: { rows: [], ready: 0, needsYou: 0, lotsToCreate: [], monthlyTotal: 0, namelessRoll: false, rates: {} },
  others: [], blockQuestions: [], counts: null, statedTotal: null, refusedColumns: [], reconciliation: null,
});

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/components/Brand", () => ({ TopBar: () => <i>topbar</i> }));
vi.mock("@/components/ParkNav", () => ({ ParkNav: ({ park }: { park: { name: string } }) => <i>nav:{park.name}</i> }));
vi.mock("@/components/ParkImportRead", () => ({ ParkImportRead: () => <i>read</i> }));
vi.mock("@/lib/env", () => ({ hasSupabaseEnv: () => true }));
vi.mock("@/app/park/data", () => ({ getMyPark: async () => park }));
vi.mock("@/app/park/import-actions", () => ({ loadBatch: async () => batch }));

const { default: ParkImportBatchPage } = await import("./page");

const render = async () =>
  renderToStaticMarkup(await ParkImportBatchPage({ params: Promise.resolve({ batchId: "batch-1" }) }))
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  park = { id: "park-haven", name: "The Haven" };
  batch = null;
});

describe("the batch page keeps the strip whenever the park is known", () => {
  it("no park: the park-owners card, no strip, a door to the portal", async () => {
    park = null;
    const w = await render();
    expect(w).toMatch(/Park owners only/);
    expect(w).toMatch(/Go to my portal/);
    expect(w).not.toMatch(/nav:/);
    expect(w).not.toMatch(/That import isn/);
  });

  it("park known, batch not: the strip is on the card, and the card blames the link, not an undo", async () => {
    const w = await render();
    expect(w).toMatch(/nav:The Haven/);
    expect(w).toMatch(/That import isn&#x27;t here/);
    expect(w).toMatch(/That link is stale, or the import belongs to another park/);
    expect(w).toMatch(/Start a new one/);
    // An undone batch still LOADS (undone_at is stamped, not the row deleted),
    // so this card must never claim one was undone.
    expect(w).not.toMatch(/undone/);
    expect(w).not.toMatch(/Park owners only/);
  });

  it("park and batch both known: the strip and the import", async () => {
    batch = someBatch();
    const w = await render();
    expect(w).toMatch(/topbar nav:The Haven read/);
    expect(w).not.toMatch(/That import isn/);
  });
});
