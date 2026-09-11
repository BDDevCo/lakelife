import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  declineMeans, completionBlock, arrivalFlagRefusal, arrivalNoteMessage,
} from "@/lib/arrival";

/**
 * THREE THINGS THE CREW COULD NOT SAY, AND ONE SCREEN THAT SAID TWO OPPOSITE
 * THINGS AT ONCE.
 *
 * All three are the arrival moment — the crew is in the driveway, the engine
 * is off, and the first tap of the visit decides what happens next.
 *
 *   1. THE ONLY WAY TO SAY "IT'S DIFFERENT" WAS A NUMBER. The sheet offers
 *      three answers and calls them "the only three that exist". They are not.
 *      The pier is already out. A car is parked across the whole lawn. The
 *      address is somebody else's house. None of those is a count, and
 *      `submitFlag` REFUSES an at-arrival flag with no proposed change — so a
 *      crew who picked "it's different" had to invent a number, which the
 *      owner then approves and which is written to their profile as a fact.
 *      Rule 6: approval updates the profile. The made-up number sticks.
 *
 *   2. ONE SCREEN, TWO OPPOSITE INSTRUCTIONS. Choose "No — I can't do this job
 *      without the change" and the sheet says "you pack up and go" in the
 *      field helper and "If they say no, do the job as it was booked" in the
 *      banner twenty lines below. Both visible at once. The owner's side has
 *      had `declineMeans` for exactly this since 0088; the crew's side was
 *      hardcoded to one of the two outcomes.
 *
 *   3. THE JOB PAGE COULD NOT SHOW A HELD, NO-SHOW OR STOOD-DOWN VISIT. The
 *      route card reads `completionBlock` and draws a banner. The job page —
 *      the one reachable from a text message — never loaded the three columns,
 *      so it offered "Mark complete" on a job the database will refuse, with
 *      nothing on screen saying why. The rule in one doorway of two.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/vendor/actions", () => ({
  submitFlag: async () => ({ ok: true }),
  recordNoShow: async () => ({ ok: true }),
  completeJob: async () => ({ ok: true }),
  uploadJobPhoto: async () => ({ ok: true }),
  getJobPhotoUrls: async () => ({ ok: true, urls: [] }),
}));
vi.mock("@/app/vendor/job-detail-actions", () => ({ crewCureJob: async () => ({ ok: true }) }));
vi.mock("@/app/approvals/actions", () => ({
  approveFlag: async () => ({ ok: true }),
  declineFlag: async () => ({ ok: true }),
}));

const { ArrivalSheet, WhatHappensNext } = await import("./ArrivalSheet");
const { CrewJobActions } = await import("./VendorJobPanel");
const { ApprovalCard } = await import("./ApprovalCard");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------- 1. the door

describe("a crew who found something that isn't a number", () => {
  const sheet = () =>
    renderToStaticMarkup(
      <ArrivalSheet
        jobId="j1"
        serviceName="Pier removal"
        address="1414 Lane Rd"
        needsInteriorAccess={false}
        needsRelease={false}
        onClose={() => {}}
        onHeld={() => {}}
        onNoShow={() => {}}
      />,
    );

  it("has a door that isn't a count and isn't a lie", () => {
    // The three that existed: yes / it's a different COUNT / nobody answered.
    // A crew whose problem is none of those had to pick one anyway.
    expect(sheet()).toMatch(/Something else/i);
  });

  it("stacks the two-line buttons instead of splitting them into columns", () => {
    // `.ll-btn` is display:inline-flex with align-items:center, so a
    // `display: block` span under the label becomes a second FLEX ITEM sitting
    // beside it — "It's different from the profile" wrapped into a four-line
    // column an inch wide at 375px, with its own explainer alongside. Measured
    // in the browser at 375×667, not reasoned about.
    const html = sheet();
    const twoLiners = html.match(/<button[^>]*flex-direction:column[^>]*>/g) ?? [];
    expect(twoLiners.length, "the arrival buttons are back to a row").toBeGreaterThanOrEqual(4);
  });

  it("still offers the three it always had", () => {
    // The other half of the mutation: a fourth door must not have replaced one.
    const html = sheet();
    expect(html).toMatch(/it all matches/i);
    expect(html).toMatch(/different from the profile/i);
    expect(html).toMatch(/Nobody&#x27;s answering|Nobody's answering/);
  });
});

describe("what an at-arrival flag must carry before it can stop a job", () => {
  // The guard `submitFlag` applies, lifted out so both halves are provable.
  // It used to be "there must be a proposed change", full stop.
  it("takes a count with no words", () => {
    expect(arrivalFlagRefusal({ pier_sections: 12 }, "")).toBeNull();
  });

  it("now takes words with no count — that is the whole fix", () => {
    expect(arrivalFlagRefusal(null, "The pier is already out of the water.")).toBeNull();
  });

  it("still refuses a stop sign with nothing written on it", () => {
    // A hold nobody can explain is a crew standing in a driveway and an owner
    // being asked to approve a blank.
    expect(arrivalFlagRefusal(null, "")).toBeTruthy();
    expect(arrivalFlagRefusal(null, "   ")).toBeTruthy();
    expect(arrivalFlagRefusal({}, "")).toBeTruthy();
  });

  it("refuses a note too short to mean anything", () => {
    expect(arrivalFlagRefusal(null, "no")).toBeTruthy();
  });
});

describe("the guard is the one submitFlag actually calls", () => {
  const actions = strip(read("../app/vendor/actions.ts"));

  it("calls it rather than keeping its own copy of the rule", () => {
    expect(actions).toMatch(/arrivalFlagRefusal\s*\(/);
  });

  it("no longer refuses every at-arrival flag that has no proposed change", () => {
    // The refusal this replaces, matched by its own sentence rather than by
    // its condition — `atArrival && !proposed` is now a legitimate branch (it
    // chooses which message the owner gets), so matching the condition would
    // fail on the fix itself. Leaving the old refusal in place would make the
    // new door render fine and fail on send.
    expect(actions).not.toContain("the counts are what the owner approves");
  });
});

describe("what reaches the owner when the flag carries no numbers", () => {
  const msg = arrivalNoteMessage({
    note: "  The pier is   already out of the water.  ",
    where: "1414 Lane Rd",
    serviceName: "Pier removal",
  });

  it("sends the crew's own words — they are the only fact there is", () => {
    expect(msg).toContain("The pier is already out of the water.");
  });

  it("does not claim a profile mismatch there isn't one of", () => {
    // The generic fallback beside it says the crew "found something that
    // doesn't match your profile", which is exactly what this door is not for.
    expect(msg).not.toMatch(/match your profile/i);
  });

  it("says why they are stopped and that it costs nothing to wait", () => {
    expect(msg).toMatch(/can&apos;t start|can't start/);
    expect(msg).toMatch(/Nothing is charged/i);
  });

  it("carries no money — rule 1, and there is nothing to price", () => {
    expect(msg).not.toMatch(/\$/);
  });

  it("fits a text message", () => {
    const long = arrivalNoteMessage({
      note: "x".repeat(900), where: "a place", serviceName: "a service",
    });
    expect(long.length).toBeLessThan(320);
  });

  it("is what submitFlag sends", () => {
    expect(strip(read("../app/vendor/actions.ts"))).toMatch(/arrivalNoteMessage\s*\(/);
  });
});

// ------------------------------------------------- 2. one screen, one outcome

describe("what the crew is told a 'no' will mean", () => {
  const canProceed = declineMeans({ crew_can_proceed: true }, { serviceName: "Mowing" });
  const cannot = declineMeans(
    { crew_can_proceed: false, crew_cannot_reason: "leaving 4 in the water would wreck them" },
    { serviceName: "Pier removal" },
  );

  it("says do it as booked when the crew said they could", () => {
    expect(canProceed.crewDetail).toMatch(/as (it was )?booked/i);
    expect(canProceed.crewDetail).not.toMatch(/pack up/i);
  });

  it("says pack up when the crew said they couldn't", () => {
    // THE CONTRADICTION. This sentence and the owner-facing one must land on
    // the same outcome, because the crew and the owner are reading the two
    // halves of a single decision.
    expect(cannot.crewDetail).toMatch(/pack up/i);
    expect(cannot.crewDetail).not.toMatch(/as booked/i);
  });

  it("never lets the two audiences drift onto different outcomes", () => {
    // One function, two readers. A second hardcoded sentence is what put two
    // opposite instructions on one screen in the first place.
    for (const m of [canProceed, cannot]) {
      const packUp = /pack up/i.test(m.detail);
      expect(/pack up/i.test(m.crewDetail)).toBe(packUp);
    }
  });

  it("is what the arrival sheet actually renders — both ways", () => {
    const yes = renderToStaticMarkup(
      <WhatHappensNext canProceed={true} cannotReason="" serviceName="Mowing" />,
    );
    const no = renderToStaticMarkup(
      <WhatHappensNext canProceed={false} cannotReason="ice will wreck them" serviceName="Pier removal" />,
    );
    expect(yes).toMatch(/as it was booked|as booked/i);
    expect(yes).not.toMatch(/pack up/i);
    expect(no).toMatch(/pack up/i);
    expect(no).not.toMatch(/as booked/i);
    // The half that is true either way, and the reason the sheet exists.
    for (const html of [yes, no]) expect(html).toMatch(/Don&#x27;t start|Don't start/);
  });
});

describe("the sheet has no second copy of the rule", () => {
  const src = strip(read("./ArrivalSheet.tsx"));

  it("does not still hardcode one of the two outcomes", () => {
    // The literal that contradicted the field helper twenty lines above it.
    expect(src).not.toMatch(/If they say no, do the job as/i);
  });

  it("gets its words from declineMeans", () => {
    expect(src).toMatch(/declineMeans\s*\(/);
  });
});

// --------------------------------------------- 3. the job page's missing state

describe("a held, no-showed or stood-down visit on the job page", () => {
  const panel = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      <CrewJobActions
        jobId="j1"
        address="1414 Lane Rd"
        photoCount={4}
        minPhotos={2}
        photoSlots={[]}
        shotSlots={[]}
        status="scheduled"
        isCorrection={false}
        heldAt={null}
        noShowAt={null}
        stoodDownAt={null}
        {...extra}
      />,
    );

  it("says the job is waiting on the owner, and takes Complete away", () => {
    const html = panel({ heldAt: "2026-09-10T12:00:00Z" });
    expect(html).toMatch(/Waiting on the owner/i);
    expect(html).not.toMatch(/Mark complete/i);
  });

  it("says a no-show can't be completed", () => {
    const html = panel({ noShowAt: "2026-09-10T12:00:00Z" });
    expect(html).toMatch(/no-show/i);
    expect(html).not.toMatch(/Mark complete/i);
  });

  it("says a stood-down visit is over", () => {
    const html = panel({ stoodDownAt: "2026-09-10T12:00:00Z" });
    expect(html).toMatch(/pack up/i);
    expect(html).not.toMatch(/Mark complete/i);
  });

  it("leaves an ordinary visit exactly as it was", () => {
    // The other half: the banner must not appear on every job. Checking only
    // for its WORDS is not enough — dropping the `blocked &&` guard renders an
    // empty box holding nothing but the hourglass, which reads as a stuck job
    // on every ordinary visit. So the marker is checked too.
    const html = panel({});
    expect(html).toMatch(/Mark complete/i);
    expect(html).not.toMatch(/Waiting on the owner/i);
    expect(html).not.toMatch(/no-show/i);
    expect(html).not.toContain("⏳");
    expect(html).not.toContain("🚪");
    expect(html).not.toContain("🛑");
  });

  it("uses the same three sentences the route card uses", () => {
    // completionBlock is the shared source. A second set of words on the job
    // page is the defect this fixes, wearing a new hat. (React escapes the
    // apostrophes on the way out, so the comparison escapes them too — the
    // sentence is compared whole, not by keyword.)
    const esc = (s: string | null) => (s ?? "").replace(/'/g, "&#x27;");
    expect(panel({ heldAt: "x" })).toContain(esc(completionBlock({ held_at: "x" })));
    expect(panel({ noShowAt: "x" })).toContain(esc(completionBlock({ no_show_at: "x" })));
    expect(panel({ stoodDownAt: "x" })).toContain(esc(completionBlock({ stood_down_at: "x" })));
  });
});

// ------------------------------- 4. the owner's half of the door just opened

describe("approving a flag that proposed nothing", () => {
  const base = {
    id: "f1", type: "other", status: "pending",
    created_at: "2026-09-10T12:00:00Z",
    service_name: "Pier removal", address: "1414 Lane Rd",
    at_arrival: true, crew_can_proceed: false,
    crew_cannot_reason: "leaving 4 in the water would wreck them",
    correction: null,
  };
  const card = (over: Record<string, unknown>) =>
    renderToStaticMarkup(
      <ApprovalCard
        flag={{ ...base, note: "The pier is already out of the water.", proposed_change: null, ...over } as never}
      />,
    );

  it("shows the crew's words — they are the whole of what was sent", () => {
    expect(card({})).toContain("The pier is already out of the water.");
  });

  it("does not promise a profile update that cannot happen", () => {
    // "Approving updates your profile and re-prices future visits" is this
    // codebase's copy-that-lies class: there is no proposed change, so
    // apply_flag_change applies nothing and no price moves.
    const html = card({});
    expect(html).not.toMatch(/updates your profile/i);
    expect(html).not.toMatch(/re-prices future visits/i);
  });

  it("still says it when there IS something to update", () => {
    // The other half of the mutation: the sentence is true of the ordinary
    // correction and must survive for it.
    const html = card({ type: "pier", proposed_change: { pier_sections: 12 } });
    expect(html).toMatch(/updates your profile/i);
  });

  it("still asks the question — approve and decline both stay", () => {
    const html = card({});
    expect(html).toMatch(/Approve/);
    // Declining a stand-down keeps its own plain-words label (0088).
    expect(html).toMatch(/can&#x27;t do it today|can't do it today/);
  });
});

describe("nothing is repriced off a flag that changed nothing", () => {
  const actions = strip(read("../app/approvals/actions.ts"));

  it("skips the reprice loop when no change was proposed", () => {
    // Otherwise approving a note-only flag rewrites customer_price and
    // vendor_cost on every open job at that property — from an unchanged
    // profile, so it should be a no-op, and "should be a no-op" is not a thing
    // to run across somebody's money.
    expect(actions).toMatch(/hasProposal/);
    expect(actions).toMatch(/ctx\.propertyId\s*&&\s*hasProposal/);
  });
});

describe("the job page loads the three columns it now reads", () => {
  const loader = strip(read("../app/vendor/job-detail-data.ts"));

  it("selects them — a field with no writer renders nothing forever", () => {
    const select = loader.match(/\.select\("id, status, vendor_id[^"]*"\)/);
    expect(select, "the crew job select is gone or renamed").toBeTruthy();
    expect(select![0]).toContain("held_at");
    expect(select![0]).toContain("no_show_at");
    expect(select![0]).toContain("stood_down_at");
  });

  it("still refuses to carry a price into the crew's browser (rule 1)", () => {
    expect(loader).not.toMatch(/\.select\("[^"]*customer_price/);
    expect(loader).not.toMatch(/\.select\("[^"]*\bmargin\b/);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE REVIEW CAUGHT, AFTER THIS SHIPPED.
//
// Nine confirmed findings against the two commits above, clustering into three
// defects — two of them mine, introduced by the very fixes in this file.
//
//   A. I FIXED THE CONTRADICTION ON THE CREW'S SCREEN AND REBUILT IT ON THE
//      OWNER'S. The `nothingProposed` branch said "declining tells them to
//      stop. Nothing bills either way." That is false whenever the crew said
//      they COULD proceed — which is the DEFAULT on the new door — and it sat
//      two lines under a banner saying "You'll be charged the original price",
//      above a button reading "No — just do what I booked". Three
//      contradictory statements on one card, at the money moment.
//
//      `nothingProposed` and "what does no mean" are orthogonal facts. The
//      banner already states the decline outcome in full, from declineMeans.
//      So the paragraph stops repeating it and says only what approve does.
//
//   B. WIDENING THE GUARD SILENTLY SWALLOWED A NUMBER. `arrivalFlagRefusal`
//      was handed the SANITIZED proposal. A crew typing 120 sections (over
//      COUNT_MAX 99) or "twelve" has their count dropped by sanitizeProposed —
//      and with any note at all, the flag then filed as a words-only hold with
//      the number GONE. Before this change it was correctly refused.
//      A count we threw away is not a count nobody sent.
//
//   C. BOTH SIDES WERE PROMISED A RECORD NOBODY WROTE. declineMeans tells the
//      owner "we'll note on the job what was and wasn't done" and now tells
//      the crew the same. declineFlag only wrote that note when the flag
//      carried a proposal.
// ---------------------------------------------------------------------------

describe("B. a count we threw away is not a count nobody sent", () => {
  it("refuses a count the sanitizer dropped, however long the note is", () => {
    // THE REGRESSION. 120 is over COUNT_MAX, so sanitizeProposed returns null.
    // With a note beside it the widened guard let it through as a note-only
    // flag — the owner approves a card showing no count, the profile stays
    // wrong, and the crew does the bigger job for the smaller money.
    expect(
      arrivalFlagRefusal(null, "counted from the seawall", { pier_sections: 120 }),
      "an out-of-range count filed as a note, with the number gone",
    ).toBeTruthy();
    expect(arrivalFlagRefusal(null, "counted from the seawall", { pier_sections: NaN })).toBeTruthy();
  });

  it("says the number is the problem, not that they said nothing", () => {
    // "Say what you found" to somebody who just typed 120 into a box teaches
    // them nothing — they DID say what they found.
    const msg = arrivalFlagRefusal(null, "a long enough note", { pier_sections: 120 }) ?? "";
    expect(msg).toMatch(/number/i);
  });

  it("still lets words through when no count was attempted", () => {
    // The whole point of the fourth door: nothing was sent, nothing was lost.
    expect(arrivalFlagRefusal(null, "The pier is already out of the water.", null)).toBeNull();
    expect(arrivalFlagRefusal(null, "The pier is already out of the water.", {})).toBeNull();
  });

  it("still lets a good count through", () => {
    expect(arrivalFlagRefusal({ pier_sections: 12 }, "", { pier_sections: 12 })).toBeNull();
  });

  it("is called with what the crew SENT, not only what survived", () => {
    // A guard that cannot see the attempt cannot tell the two apart. Matching
    // the call shape, not the mention.
    const actions = strip(read("../app/vendor/actions.ts"));
    expect(actions).toMatch(/arrivalFlagRefusal\(\s*proposed\s*,\s*note\s*,\s*proposedChange\s*\)/);
  });
});

describe("A. the owner's card never contradicts its own banner", () => {
  const base = {
    id: "f1", type: "other", status: "pending",
    created_at: "2026-09-10T12:00:00Z",
    service_name: "Mowing", address: "1414 Lane Rd",
    note: "A car is parked across the whole lawn.",
    proposed_change: null, correction: null,
  };
  const card = (over: Record<string, unknown>) =>
    renderToStaticMarkup(<ApprovalCard flag={{ ...base, ...over } as never} />);

  // THE DEFAULT PATH OF THE DOOR THIS COMMIT ADDED. canProceed starts at Yes.
  const proceeds = { at_arrival: true, crew_can_proceed: true, crew_cannot_reason: null };
  const standsDown = { at_arrival: true, crew_can_proceed: false, crew_cannot_reason: "nothing to remove" };
  const filedLater = { at_arrival: false, crew_can_proceed: null, crew_cannot_reason: null };

  it("does not claim nothing bills when the visit goes ahead and bills", () => {
    const html = card(proceeds);
    expect(html).not.toMatch(/Nothing bills either way/i);
    expect(html).not.toMatch(/declining tells them to stop/i);
  });

  it("keeps the banner's own account of what a 'no' means", () => {
    // The banner is the single source (declineMeans). It must survive.
    expect(card(proceeds)).toMatch(/charged the original price/i);
    expect(card(standsDown)).toMatch(/pack up/i);
  });

  it("never says 'nothing bills' on a card whose banner says they'll be charged", () => {
    // The contradiction itself, asserted directly: these two cannot co-occur.
    for (const shape of [proceeds, standsDown, filedLater]) {
      const html = card(shape);
      if (/charged the original price/i.test(html)) {
        expect(html, "the card promises a charge and denies one").not.toMatch(/[Nn]othing bills/);
      }
    }
  });

  it("tells an at-arrival card what approving does, and never denies the bill", () => {
    // Pinning the branch positively as well as negatively. Collapsing this to
    // the non-arrival wording puts "Nothing here moves your profile or your
    // bill" on a visit that goes ahead and bills — a different sentence, the
    // same lie, which the absence-checks above sail straight past.
    for (const shape of [proceeds, standsDown]) {
      const html = card(shape);
      expect(html).toMatch(/tells the crew to go ahead/i);
      expect(html).not.toMatch(/moves your profile or your bill/i);
    }
  });

  it("does not say a crew is waiting on a flag filed away from site", () => {
    // FlagModal's "other" type also has a null proposed_change, and nothing is
    // held. Asserting somebody is standing in their driveway is a lie.
    const html = card(filedLater);
    expect(html).not.toMatch(/crew is waiting/i);
    expect(html).not.toMatch(/crew is at your place/i);
    // Nor that approving releases anybody: nothing is held, and the crew who
    // filed this from a finished job left hours ago.
    expect(html).not.toMatch(/go ahead/i);
    expect(html).toMatch(/note for your records/i);
  });

  it("still tells an ordinary correction what approving does", () => {
    // The other half: the true sentence must survive for the flag it is true of.
    expect(
      card({ ...filedLater, type: "pier", proposed_change: { pier_sections: 12 } }),
    ).toMatch(/updates your profile/i);
  });
});

describe("C. the note both sides were promised gets written", () => {
  const actions = strip(read("../app/approvals/actions.ts"));

  it("builds the scope note even when the flag carried no counts", () => {
    // declineMeans promises BOTH the owner and (since this commit) the crew
    // "we'll note on the job what was and wasn't done". scopeNoteFor already
    // handles an empty diff; only the guard in front of it refused.
    expect(actions).not.toMatch(/if\s*\(proposed\s*&&\s*svcId\s*&&\s*ctx\.propertyId\)/);
    expect(actions).toMatch(/scopeNoteFor\s*\(/);
  });
});
