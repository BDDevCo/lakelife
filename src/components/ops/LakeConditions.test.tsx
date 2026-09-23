import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { LakeCondition } from "@/app/ops/data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/ops/actions", () => ({
  updateLakeConditions: async () => ({ ok: true }),
  promoteLakeToServed: async () => ({ ok: true }),
}));
// Widened: the bare `() => {}` had no `.ok` and no `.err`, so nothing in this
// file could drive save() at all without throwing — which is how the swallowed
// season warning went unnoticed while a test in season-roll.test.ts was named
// "saves a freeze-only row but says out loud that water work stays shut".
vi.mock("@/components/Toast", () => {
  const toast = Object.assign(() => {}, { ok: () => {}, err: () => {}, info: () => {} });
  return { toast };
});

const { LakeConditions, saveOutcome } = await import("./LakeConditions");

const lake = (over: Partial<LakeCondition>): LakeCondition => ({
  id: "l1", name: "Big Long Lake",
  ice_out_actual: "2026-03-21", hard_freeze_est: "2026-11-22", pull_deadline: "2026-11-14",
  active_properties: 12, is_fixture: false, season_confirmed: true, provisional: false,
  // The default is a lake ops themselves added — the only kind that was ever
  // meant to be on the public site.
  source: "ops", served: true, awaiting_promotion: false, days_waiting: 400, ...over,
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

/**
 * A LAKE NOBODY AT LAKELIFE HAS ANSWERED.
 *
 * A customer typing "my lake isn't listed" creates the row, their set-up
 * completes, and every public surface now correctly refuses to advertise it
 * (lib/lake-visibility.ts). That gate is only half a fix: without a line on
 * this screen nobody here ever learns a market asked for us, and without a
 * button nobody can do anything about it.
 */
describe("ops is told which lakes are waiting, and can say yes", () => {
  const waiting = (over: Partial<LakeCondition> = {}) =>
    lake({ id: "l9", name: "Adams Lake", source: "customer", served: false,
           awaiting_promotion: true, days_waiting: 4, active_properties: 2, ...over });

  it("says nothing at all when every lake is already served", () => {
    const html = renderToStaticMarkup(<LakeConditions lakes={[lake({})]} />);
    expect(html).not.toContain("waiting on you");
    expect(html).not.toContain("Not on the public site");
    expect(html).not.toContain("we serve this lake");
  });

  it("names the lake at the top of the screen, with its homes and its wait", () => {
    const html = renderToStaticMarkup(<LakeConditions lakes={[lake({}), waiting()]} />);
    expect(html).toContain("1 lake is waiting on you");
    expect(html).toContain("Adams Lake");
    expect(html).toContain("from a customer");
    expect(html).toContain("2 homes");
    expect(html).toContain("waiting 4 days");
  });

  it("counts several, and does not count the lakes already served", () => {
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({}), waiting(), waiting({ id: "l10", name: "Witmer Lake", source: "crew" })]} />,
    );
    expect(html).toContain("2 lakes are waiting on you");
    expect(html).not.toContain("3 lakes");
  });

  it("puts the control on the card, and says what is and is not affected", () => {
    const html = renderToStaticMarkup(<LakeConditions lakes={[waiting()]} />);
    expect(html).toContain("Not on the public site");
    expect(html).toContain("Yes — we serve this lake");
    // The customer is fine. Without this sentence ops reads the notice as a
    // breakage and goes hunting for one.
    expect(html).toContain("book and get their season dates either way");
  });

  it("says which door it came through, because the two are different news", () => {
    const customer = renderToStaticMarkup(<LakeConditions lakes={[waiting()]} />);
    expect(customer).toContain("A customer named this lake when they set up");
    const crew = renderToStaticMarkup(<LakeConditions lakes={[waiting({ source: "crew" })]} />);
    expect(crew).toContain("A crew added this lake to their service area");
    expect(crew).not.toContain("A customer named this lake");
  });

  it("never offers to publish a fixture", () => {
    // isAwaitingPromotion already refuses one; this is the screen half of the
    // same rule, so a fixture cannot be promoted by a click either.
    const html = renderToStaticMarkup(
      <LakeConditions lakes={[lake({ is_fixture: true, source: "customer", served: false, awaiting_promotion: false })]} />,
    );
    expect(html).toContain("Test lake");
    expect(html).not.toContain("we serve this lake");
    expect(html).not.toContain("waiting on you");
  });

  it("a wait it could not work out is never rendered as no wait at all", () => {
    const html = renderToStaticMarkup(<LakeConditions lakes={[waiting({ days_waiting: null })]} />);
    expect(html).toContain("couldn&#x27;t work out how long");
    expect(html).not.toContain("waiting 0 days");
  });
});

/**
 * SAVING THE SEASON DATES SWALLOWED THE ONE WARNING THAT SAVE CAN PRODUCE.
 *
 * `updateLakeConditions` returns `{ ok: true, warning }` and has exactly one
 * warning to give: a hard freeze on file with no ice-out leaves the lake CLOSED
 * for water work for the whole spring (rule 7 — dayStatus fails closed the
 * moment either date is missing). save() never read `res.warning`, so the save
 * that shuts a lake's spring calendar reported a flat success with a tick.
 *
 * Collapsed both ways below: remove the warning arm and the second case fails;
 * remove the plain-success arm and the first one does. The source scan is what
 * ties the helper to the caller, because a helper nothing calls would pass
 * every assertion above it.
 */
describe("what a season save is allowed to say", () => {
  it("earns the tick when there is nothing to warn about", () => {
    expect(saveOutcome({ ok: true })).toEqual({
      kind: "ok",
      message: "Saved — the booking calendar will reflect these dates.",
    });
  });

  it("shows the warning instead, and without a tick", () => {
    const warning =
      "Saved — but with no ice-out on file this lake stays CLOSED for water work (rule 7). Add the ice-out date to open the spring calendar.";
    const out = saveOutcome({ ok: true, warning });
    expect(out.message).toBe(warning);
    // `toast.ok` is what draws the tick (Toast.tsx). A sentence saying the
    // spring calendar is shut is true, and it is not a success.
    expect(out.kind).toBe("plain");
    expect(out.kind).not.toBe("ok");
  });

  it("still says the refusal in the crew's own words when the save failed", () => {
    expect(saveOutcome({ ok: false, error: "Ops only." })).toEqual({ kind: "err", message: "Ops only." });
    expect(saveOutcome({ ok: false }).message).toBe("Couldn't save.");
  });

  it("is the function save() actually calls", () => {
    // Strip comments first: every sentence quoted here also appears in prose
    // above the code, and a scan that reads comments proves nothing.
    const src = readFileSync(new URL("./LakeConditions.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src.length).toBeGreaterThan(500); // the scanner found the file
    expect(src).toMatch(/const out = saveOutcome\(res\)/);
    // The success sentence lives in ONE place — the helper. A second copy in
    // save() is how the warning arm gets quietly stepped over again.
    expect(src.split("Saved — the booking calendar").length - 1).toBe(1);
  });
});
