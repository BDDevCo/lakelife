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
  active_properties: 12, is_fixture: false, season_confirmed: true, provisional: false, ...over,
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

describe("ops can see which lake is still a guess", () => {
  it("says nothing for a lake whose dates a human confirmed", () => {
    const html = renderToStaticMarkup(<LakeConditions lakes={[lake({})]} />);
    expect(html).not.toContain("Still provisional");
  });

  it("flags a lake whose dates were rolled from a past season", () => {
    // season_confirmed is still true — the confirmation just went stale when
    // the year turned. This is the case that goes live on 1 Jan 2027.
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({ provisional: true, season_confirmed: true })]} />,
    );
    expect(html).toContain("Still provisional");
    expect(html).toContain("rolled from a past season");
    expect(html).not.toContain("copied from a neighbouring lake");
  });

  it("flags a lake nobody ever confirmed, and says that instead", () => {
    // Born from "my lake isn't listed", wearing a neighbour's dates. Different
    // cause, different fix, so it must not read the same.
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({ provisional: true, season_confirmed: false })]} />,
    );
    expect(html).toContain("copied from a neighbouring lake");
    expect(html).not.toContain("rolled from a past season");
  });

  it("does not nag about a test lake — it isn't selling anything", () => {
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({ is_fixture: true, provisional: true, season_confirmed: false })]} />,
    );
    expect(html).toContain("Test lake");
    expect(html).not.toContain("Still provisional");
  });
})
