import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LakeCondition } from "@/app/ops/data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/ops/actions", () => ({ updateLakeConditions: async () => ({ ok: true }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));

const { LakeConditions } = await import("./LakeConditions");

const lake = (over: Partial<LakeCondition>): LakeCondition => ({
  id: "l1", name: "Big Long Lake",
  ice_out_actual: "2026-03-21", hard_freeze_est: "2026-11-22", pull_deadline: "2026-11-14",
  active_properties: 12, is_fixture: false, ...over,
});

describe("the ops season editor marks a test lake", () => {
  it("says nothing extra about a real lake", () => {
    const html = renderToStaticMarkup(<LakeConditions lakes={[lake({})]} />);
    expect(html).toContain("Big Long Lake");
    expect(html).not.toContain("Test lake");
    expect(html).not.toContain("Not a real lake");
  });

  it("badges a fixture, and says what the badge means", () => {
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({ id: "l2", name: "zz-scratch season lake", is_fixture: true })]} />,
    );
    expect(html).toContain("Test lake");
    expect(html).toContain("Not a real lake");
  });

  it("a fixture still gets its date fields — ops is the one place they belong", () => {
    // Hiding them would leave a scratch lake with no way to set its season at
    // all, which is why 0124 deliberately left fixtures on this screen.
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({ is_fixture: true })]} />,
    );
    expect(html).toContain("Ice-out (actual)");
    expect(html).toContain("Est. hard freeze");
  });

  it("in a mixed list only the fixture carries the badge", () => {
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({}), lake({ id: "l2", name: "zz-scratch", is_fixture: true })]} />,
    );
    expect(html.match(/Test lake/g)?.length).toBe(1);
  });
});
