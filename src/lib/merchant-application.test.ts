import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_FIELDS, STORED_FIELD_IDS, ENTITY_TYPES, PARK_MCC,
  splitAddress, deriveApplication, applicationGaps, readyToSubmit,
  submitSentence, taxIdLast4, type ParkFacts,
} from "./merchant-application";

/**
 * UPLOAD -> EXTRACT -> PREFILL -> ASK ONLY WHAT IS MISSING -> ONE TAP.
 *
 * His directive, 29 Oct 2026. This file pins the middle three, and the two
 * rules that make them safe:
 *
 *   A DERIVED VALUE IS A SUGGESTION, NEVER A STATEMENT. An underwriting
 *   application is a document a park owner is ASSERTING things in. This
 *   codebase has already paid for the opposite — a pre-ticked "they signed"
 *   wrote nineteen leases nobody signed.
 *
 *   A HALF-PARSED ANSWER IS WORSE THAN NO ANSWER, because no answer gets
 *   asked about and a wrong one gets submitted.
 */

const HAVEN: ParkFacts = {
  // The real values, read off production on 29 Oct 2026.
  name: "The Haven",
  address: "9085 E 500 S, Wolcottville, IN 46795",
  ratedLots: 21,
  monthlyRentTotal: 8400,
  ownerName: "Brendon Lochert",
  ownerEmail: "owner@example.com",
  ownerPhone: "+12605550134",
};

describe("the field list is one editable list, because the real form is coming", () => {
  it("every stored field has a column in 0201", () => {
    // The whole point of keeping the spec in one array is that swapping in US
    // Card Solutions' real form is editing a list. That only holds if the list
    // and the migration cannot drift apart.
    const sql = readFileSync(
      fileURLToPath(new URL("../../supabase/migrations/0201_the_merchant_application_and_the_parks_own_share.sql", import.meta.url)),
      "utf8");
    for (const id of STORED_FIELD_IDS) {
      expect(sql, `0201 has no column for "${id}"`).toMatch(new RegExp(`add column if not exists ${id}\\b`));
    }
  });

  it("and the write-only one is NOT stored", () => {
    // The full EIN or SSN goes to the processor and nowhere else. 0201's
    // post-condition fails the migration on a column even named like it.
    expect(STORED_FIELD_IDS).not.toContain("tax_id");
    expect(APPLICATION_FIELDS.find((f) => f.id === "tax_id")?.writeOnly).toBe(true);
  });

  it("the entity types match the ones the database will accept", () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../../supabase/migrations/0201_the_merchant_application_and_the_parks_own_share.sql", import.meta.url)),
      "utf8");
    for (const t of ENTITY_TYPES) {
      expect(sql, `the database refuses entity_type "${t.value}"`).toContain(`'${t.value}'`);
    }
  });

  it("there are fields at all, so nothing below passes over an empty list", () => {
    expect(APPLICATION_FIELDS.length).toBeGreaterThanOrEqual(10);
    expect(APPLICATION_FIELDS.filter((f) => f.required).length).toBeGreaterThanOrEqual(8);
  });
});

describe("an address that does not split cleanly yields NOTHING", () => {
  it("splits the real one", () => {
    expect(splitAddress("9085 E 500 S, Wolcottville, IN 46795")).toEqual({
      line1: "9085 E 500 S", city: "Wolcottville", state: "IN", postal: "46795",
    });
  });

  it("keeps a street that itself contains a comma", () => {
    expect(splitAddress("Unit 4, 12 Lake Road, Angola, IN 46703").line1).toBe("Unit 4, 12 Lake Road");
  });

  it("AND REFUSES TO GUESS at anything else", () => {
    // A half-parsed address on an underwriting application is worse than an
    // empty one: the empty one gets asked about.
    for (const bad of [
      "9085 E 500 S Wolcottville IN 46795",   // no commas at all
      "Wolcottville, IN",                      // no street
      "9085 E 500 S, Wolcottville, Indiana",   // state spelled out, no ZIP
      "9085 E 500 S, Wolcottville, IN 4679",   // four-digit ZIP
      "", "   ",
    ]) {
      expect(splitAddress(bad), JSON.stringify(bad)).toEqual({
        line1: null, city: null, state: null, postal: null,
      });
    }
    expect(splitAddress(null)).toEqual({ line1: null, city: null, state: null, postal: null });
  });

  it("takes ZIP+4 but stores the five", () => {
    expect(splitAddress("1 A St, Angola, IN 46703-1234").postal).toBe("46703");
  });
});

describe("what we can work out for him, and where it came from", () => {
  const d = deriveApplication(HAVEN);

  it("fills the park's own details from the park", () => {
    expect(d.dba_name).toEqual({ value: "The Haven", source: "park" });
    expect(d.address_city?.value).toBe("Wolcottville");
    expect(d.address_state?.value).toBe("IN");
  });

  it("and the contact from the owner's own account", () => {
    expect(d.contact_email?.source).toBe("owner");
    expect(d.control_person_name?.source).toBe("owner");
  });

  it("proposes the park merchant category", () => {
    expect(d.mcc?.value).toBe(PARK_MCC);
    expect(d.mcc?.source).toBe("default");
  });

  it("COMPUTES THE VOLUME FROM THE RENT ROLL — the question applicants guess at", () => {
    // 21 lots x $400 = $8,400, read off production.
    expect(d.expected_monthly_cents?.value).toBe(840000);
    expect(d.average_ticket_cents?.value).toBe(40000);
    expect(d.expected_monthly_cents?.source).toBe("rent-roll");
  });

  it("AND SHOWS ITS WORKINGS, so he can correct it rather than trust it", () => {
    // The number is defensible and still probably wrong for THIS park: from
    // 1 Jan each lot is billed $542.53, and most of January is hand-keyed cash
    // that never touches a processor. Only he can say what will run over their
    // rails, so the arithmetic is on screen beside the number.
    expect(d.expected_monthly_cents?.workings).toMatch(/21 lots priced/);
    expect(d.expected_monthly_cents?.workings).toMatch(/\$8,400\.00 a month/);
    expect(d.expected_monthly_cents?.workings, "does not tell him he can lower it")
      .toMatch(/Lower it if some residents will keep paying cash/);
    expect(d.average_ticket_cents?.workings).toMatch(/across 21 lots/);
  });

  it("every derived value carries a source — none is silently a fact", () => {
    for (const [id, v] of Object.entries(d)) {
      expect(v.source, `${id} has no source`).not.toBeNull();
      expect(["park", "owner", "rent-roll", "default", "typed"]).toContain(v.source);
    }
  });

  it("NEVER invents a legal name or a tax id", () => {
    // The park's trading name is not its legal entity, and nothing in this
    // product knows the EIN. Both must be asked for.
    expect(d.legal_name).toBeUndefined();
    expect(d.tax_id).toBeUndefined();
    expect(d.entity_type).toBeUndefined();
  });

  it("and a park with no rates proposes no volume at all", () => {
    const bare = deriveApplication({ ...HAVEN, ratedLots: 0, monthlyRentTotal: null });
    expect(bare.expected_monthly_cents).toBeUndefined();
    expect(bare.average_ticket_cents).toBeUndefined();
    // but still knows where the park is
    expect(bare.address_city?.value).toBe("Wolcottville");
  });

  it("a failed read is not an empty park", () => {
    // Every ParkFacts field is nullable because the loader may not have been
    // able to read it. Nothing should throw, and nothing should be invented.
    const nothing = deriveApplication({
      name: null, address: null, ratedLots: 0, monthlyRentTotal: null,
      ownerName: null, ownerEmail: null, ownerPhone: null,
    });
    expect(nothing.mcc?.value).toBe(PARK_MCC);   // the only safe default
    expect(Object.keys(nothing)).toEqual(["mcc"]);
  });
});

describe("what is still missing, and when the tap may be offered", () => {
  const filled = () => {
    const out: Record<string, unknown> = {};
    for (const f of APPLICATION_FIELDS) {
      if (!f.required) continue;
      out[f.id] = f.kind === "money" ? 100_000 : "x";
    }
    return out;
  };

  it("names the gaps by their LABEL, because a person reads this", () => {
    const gaps = applicationGaps({});
    expect(gaps).toContain("Legal business name");
    expect(gaps).toContain("EIN or SSN");
    expect(gaps.length).toBe(APPLICATION_FIELDS.filter((f) => f.required).length);
  });

  it("an optional field missing is not a gap", () => {
    const d = filled();
    expect(applicationGaps(d)).toEqual([]);
    expect(APPLICATION_FIELDS.some((f) => !f.required)).toBe(true);
  });

  it("A BLANK STRING IS A GAP, not an answer", () => {
    expect(applicationGaps({ ...filled(), legal_name: "   " })).toEqual(["Legal business name"]);
  });

  it("AND A ZERO VOLUME IS A GAP — it is what an unfilled number column holds", () => {
    // 0201 also refuses a negative, but zero is the one that reads as answered
    // and would be submitted as "we expect to process nothing".
    expect(applicationGaps({ ...filled(), expected_monthly_cents: 0 }))
      .toEqual(["Expected monthly card and ACH volume"]);
  });

  it("the tap is offered only when nothing is missing", () => {
    expect(readyToSubmit(filled(), null)).toBe(true);
    expect(readyToSubmit({}, null)).toBe(false);
  });

  it("AND NEVER TWICE", () => {
    // 0196 makes a submitted account immutable and 0201 refuses an edit after
    // it has gone, so offering the tap again offers an action the database
    // will refuse.
    expect(readyToSubmit(filled(), "2026-10-29T12:00:00Z")).toBe(false);
  });
});

describe("the sentence above the tap", () => {
  it("says who decides, and that it can come back no", () => {
    // A one-tap action whose consequence is not on the screen is not consent.
    // And "one-click approval" is right about the EFFORT; it cannot promise
    // the OUTCOME, because underwriting can decline.
    const s = submitSentence("The Haven", "US Card Solutions");
    expect(s).toContain("The Haven");
    expect(s).toContain("US Card Solutions");
    expect(s).toMatch(/They decide, not us/);
    expect(s).toMatch(/approved or declined/);
    expect(s, "does not say rent is unaffected until approval").toMatch(/Nothing about rent changes/);
  });

  it("works for a park with no name yet", () => {
    expect(submitSentence(null, "US Card Solutions")).toContain("this park");
    expect(submitSentence("   ", "US Card Solutions")).toContain("this park");
  });
});

describe("the tax id we keep is four digits of a real one", () => {
  it("takes an EIN with or without its dash", () => {
    expect(taxIdLast4("12-3456789")).toBe("6789");
    expect(taxIdLast4("123456789")).toBe("6789");
  });

  it("AND REFUSES ANYTHING THAT IS NOT NINE DIGITS", () => {
    // A typo submitted to an underwriter comes back as a rejection, and under
    // 0196 a rejection means opening a whole new account rather than fixing a
    // field. Cheaper to refuse it here.
    for (const bad of ["1234", "12345678", "1234567890", "", "   ", "EIN pending", null, undefined]) {
      expect(taxIdLast4(bad as string | null), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("a derived value does not say the same thing twice", () => {
  it("the merchant category has a source but NO workings", () => {
    // Rendered, these sat one line apart: "From 6513 — rentals of residential
    // property" directly above the field's own help, "6513 is the code for
    // rentals of residential property". Caught by looking at the screen at
    // 375px, not by a test — `workings` is for arithmetic a person could not
    // otherwise check, never for restating the label.
    const d = deriveApplication(HAVEN);
    expect(d.mcc?.source).toBe("default");
    expect(d.mcc?.workings, "the merchant category restates its own help").toBeUndefined();
  });

  it("but the two computed numbers DO carry theirs, because they are arithmetic", () => {
    const d = deriveApplication(HAVEN);
    expect(d.expected_monthly_cents?.workings).toBeTruthy();
    expect(d.average_ticket_cents?.workings).toBeTruthy();
  });

  it("and every workings reads correctly after the screen's \"From \" prefix", () => {
    // The screen renders `From {workings}`. "From your rent roll: …" reads;
    // "From 6513 — …" did not, which is how the duplicate was spotted.
    const d = deriveApplication(HAVEN);
    for (const [id, v] of Object.entries(d)) {
      if (!v.workings) continue;
      expect(v.workings[0], `${id}'s workings starts with a capital, so "From ${v.workings}" misreads`)
        .toBe(v.workings[0].toLowerCase());
    }
  });
});
