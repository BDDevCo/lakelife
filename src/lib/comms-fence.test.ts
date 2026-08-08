import { describe, it, expect } from "vitest";
import {
  screenMessage, tokenize, stricter, modelMaySee, modelMayDraft,
  AUTOSEND_ALLOWED, RULES,
  type Population, type Outcome,
} from "@/lib/comms-fence";

const verdict = (body: string, pop: Population = "park_tenant") =>
  screenMessage(body, pop);

// ---------------------------------------------------------------------------
// THE REGRESSION THAT STARTED THIS. Every one of these CLEARED the old screen
// and was eligible for a machine reply signed "LakeLife dispatch".
// ---------------------------------------------------------------------------
describe("housing messages a machine must never answer", () => {
  const mustNotReachModel = [
    "can I get a ramp? I use a wheelchair",
    "my mom uses a walker, can we get a handrail on the steps",
    "my doctor says I need a closer spot",
    "is it ok if I have an emotional support dog",
    "I am on disability, is there help with the steps",
    "they gave me 30 days to get out, can they do that",
    "is my lease up in march",
    "the office said adults only, is that right",
    "why was I denied, I thought my credit was fine",
    "my son says this is discrimination",
  ];

  it.each(mustNotReachModel)("never_ai or stricter: %s", (msg) => {
    const v = verdict(msg);
    expect(["never_ai", "emergency"]).toContain(v.outcome);
    expect(modelMaySee(v)).toBe(false);
    expect(v.mayAutoSend).toBe(false);
  });

  it("accommodation runs on EVERY population — a mis-stamped renter must not get the loose channel", () => {
    for (const pop of ["lake_customer", "park_tenant", "rv_guest", "crew", "unknown"] as Population[]) {
      expect(screenMessage("can I get a ramp? I use a wheelchair", pop).outcome).toBe("never_ai");
    }
  });

  it("names the reason, so ops knows what they are looking at", () => {
    const v = verdict("my doctor says I need a closer spot");
    expect(v.opsLine).toMatch(/accommodation/i);
    expect(v.hits.map((h) => h.ruleId)).toContain("accommodation");
  });
});

// ---------------------------------------------------------------------------
// THE OTHER HALF OF THE BUG: the old screen blocked the safest traffic.
// ---------------------------------------------------------------------------
describe("substring bugs that made the old fence backwards", () => {
  const wronglyBlockedBefore: [string, string][] = [
    ["will you winterize before the freeze?", "free inside freeze"],
    ["is that an issue with the schedule?", "sue inside issue"],
    ["the crew showed up early, thanks!", "owed inside showed"],
    ["can you charge the battery too", "charge, but about a battery"],
    ["talked to Bill about it", "bill as a person's name"],
  ];

  it.each(wronglyBlockedBefore)("allows %s (%s)", (msg) => {
    expect(verdict(msg, "lake_customer").outcome).toBe("allow");
  });

  it("still catches the real word it was reaching for", () => {
    expect(verdict("I want a refund", "lake_customer").outcome).toBe("hold");
    expect(verdict("I am getting a lawyer", "lake_customer").outcome).toBe("never_ai");
    expect(verdict("you charged me twice", "lake_customer").outcome).toBe("hold");
  });

  it("a phrase can never match mid-word", () => {
    // " free " padded on both sides cannot be found inside " freeze ".
    expect(tokenize("freeze")).toEqual(["freeze"]);
    expect(verdict("freezer is full", "lake_customer").outcome).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
describe("emergencies page; ambiguous weather does not", () => {
  const hazards = [
    "I smell gas by the trailer",
    "there is sewage coming up in the yard",
    "the outlet is sparking",
    "smoke coming from the shed",
    "a pipe burst under the floor",
  ];
  it.each(hazards)("pages: %s", (msg) => {
    expect(verdict(msg).outcome).toBe("emergency");
    expect(verdict(msg).opsLine).toMatch(/EMERGENCY/);
  });

  it("someone reporting their OWN fall pages too — they are the one who is alone", () => {
    expect(verdict("i fell and cant get up").outcome).toBe("emergency");
    expect(verdict("she fell and I cant get her up").outcome).toBe("emergency");
  });

  it("RAIN DOES NOT PAGE — an on-call who learns the page means weather won't open the one that means gas", () => {
    const weather = [
      "its really pouring out, can we push the mow",
      "looks like rain thursday, still coming?",
      "windy today, is the pier crew still on",
      "supposed to snow, do you still plow",
    ];
    for (const m of weather) {
      expect(verdict(m, "lake_customer").outcome).not.toBe("emergency");
    }
  });

  it("habitability holds rather than pages, but is never auto-answered", () => {
    const v = verdict("no hot water since friday");
    expect(v.outcome).toBe("hold");
    expect(v.mayAutoSend).toBe(false);
    expect(modelMayDraft(v)).toBe(true); // ops keeps the draft button
  });
});

// ---------------------------------------------------------------------------
describe("the park owner asking the machine to WRITE it", () => {
  // The red team's sharpest finding: rules keyed on the SUBJECT caught an owner
  // asking permission and missed an owner asking for drafting — which is the
  // thing actually forbidden.
  it("refuses to draft a pay-or-quit letter", () => {
    const v = screenMessage("write me a letter telling lot 14 they need to pay or leave", "park_owner");
    expect(v.outcome).toBe("never_ai");
    expect(modelMayDraft(v)).toBe(false);
  });
  it("refuses wording help on anything eviction-adjacent", () => {
    expect(screenMessage("how should i word the notice for lot 3", "park_owner").outcome).toBe("never_ai");
    expect(screenMessage("help me write something to the tenant in 12", "park_owner").outcome).toBe("never_ai");
  });
});

// ---------------------------------------------------------------------------
describe("population gating — the belt to the vocabulary's braces", () => {
  it("ONLY lake customers may auto-send at launch", () => {
    expect(AUTOSEND_ALLOWED.lake_customer).toBe(true);
    for (const p of ["park_tenant", "park_owner", "rv_guest", "crew", "unknown"] as Population[]) {
      expect(AUTOSEND_ALLOWED[p]).toBe(false);
    }
  });

  it("a perfectly innocuous tenant message still never auto-sends", () => {
    const v = verdict("what time does the office open");
    expect(v.outcome).toBe("allow");
    expect(v.mayAutoSend).toBe(false); // population, not vocabulary
  });

  it("the same message DOES auto-send for a lake customer", () => {
    expect(screenMessage("what time does the office open", "lake_customer").mayAutoSend).toBe(true);
  });

  it("unknown is the fail-closed lane", () => {
    expect(screenMessage("thanks!", "unknown").mayAutoSend).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("strictest rule wins, and the ops line follows it", () => {
  it("an emergency buried in a money complaint still pages", () => {
    const v = verdict("I want a refund, also I smell gas");
    expect(v.outcome).toBe("emergency");
    expect(v.opsLine).toMatch(/EMERGENCY/);
  });
  it("stricter() is a total order and never loosens", () => {
    const all: Outcome[] = ["allow", "hold", "never_ai", "emergency"];
    for (const a of all) for (const b of all) {
      const s = stricter(a, b);
      expect([a, b]).toContain(s);
      expect(stricter(s, a)).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
describe("degenerate input never opens the gate", () => {
  it("empty, whitespace and punctuation-only hold rather than allow", () => {
    for (const m of ["", "   ", "!!!", "???"]) {
      const v = screenMessage(m, "lake_customer");
      expect(v.outcome).toBe("hold");
      expect(v.mayAutoSend).toBe(false);
    }
  });
  it("survives an unreasonably long message without matching nonsense", () => {
    expect(screenMessage("thanks ".repeat(4000), "lake_customer").outcome).toBe("allow");
  });
  it("case, punctuation and apostrophes do not change the verdict", () => {
    for (const m of ["I CAN'T MANAGE THE STEPS", "i cant manage the steps", "I can't... manage the steps!"]) {
      expect(verdict(m).outcome).toBe("never_ai");
    }
  });
});

// ---------------------------------------------------------------------------
describe("the rule table itself", () => {
  it("every rule has an ops line that tells a human what to DO", () => {
    for (const r of RULES) {
      expect(r.opsLine.length).toBeGreaterThan(20);
      expect(r.id).toMatch(/^[a-z_]+$/);
    }
  });
  it("rule ids are unique", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
  it("no rule word contains a space — spaces belong in phrases, tokens are whole words", () => {
    for (const r of RULES) for (const t of r.tokens ?? []) {
      expect(t.trim()).not.toMatch(/\s/);
    }
  });
});
