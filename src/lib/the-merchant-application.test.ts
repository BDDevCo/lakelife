import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE MERCHANT APPLICATION, AND A PARK'S SHARE OF SERVICE MONEY.
 *
 * Brendon, 29 October 2026, after meeting US Card Solutions on the 28th. Park
 * owners become merchants with them; renters pay rent by card or ACH straight
 * into the owner's existing bank account through "a one-click touch approval
 * application and API into their backend"; rent never touches us. For
 * services LakeLife is the only merchant — money comes to us and goes back out
 * to park owners for ancillary services or to crews — and "the crew members or
 * any subcontractors would not be merchants".
 *
 * THREE THINGS THAT CONFIRMED, ALREADY BUILT, so nobody re-opens them:
 *   - a park owner is a merchant settling to their own bank (0196)
 *   - a crew is never a merchant (0200, decided 20 Oct for our own reasons —
 *     the processor conversation independently reached the same answer)
 *   - LakeLife is merchant of record for services (charge-gate.ts does no
 *     per-recipient merchant lookup at all)
 *
 * TWO GAPS, both proven against production on 29 Oct BEFORE the migration:
 *
 *   payout_batches.kind allowed only 'early','monthly','referral', so a park
 *   owner's share of an ancillary service had NO KIND and the database
 *   refused it outright — a missing state, not a missing screen. Meanwhile
 *   payout_accounts has been keyed by user_id since 0039, whose comment says
 *   "crew users AND HOA users": the destination side was built for this on day
 *   one and the batch side never caught up.
 *
 *   processor_accounts held provider, merchant id, status, capabilities and
 *   settlement_last4 — every one a record of what the PROCESSOR said, and not
 *   one field an underwriter needs. `startProcessorSetup` inserts
 *   { park_id, provider }, so "one-click submit" would have posted an empty
 *   envelope.
 */

const sql = (n: string) => readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${n}`, import.meta.url)), "utf8");
const m0201 = sql("0201_the_merchant_application_and_the_parks_own_share.sql");
const m0200 = sql("0200_a_crew_is_paid_it_is_never_a_merchant.sql");
const m0196 = sql("0196_who_the_money_settles_to.sql");

describe("a park's own share of service money can be recorded", () => {
  it("park_services joins the kinds a payout batch may be", () => {
    expect(m0201).toMatch(/check \(kind in \('early', 'monthly', 'referral', 'park_services'\)\)/);
  });

  it("AND IT NAMES NO VENDOR, because it is not a crew's money", () => {
    expect(m0201).toMatch(/check \(kind <> 'park_services' or vendor_id is null\)/);
  });

  it("the column comment says what each kind MEANS, including that this is never rent", () => {
    // Rent never reaches a LakeLife account, so a park payout can only ever be
    // the park's share of something we sold as merchant of record. Getting
    // that wrong is the one way this feature could launder rent through us.
    expect(m0201).toMatch(/never rent, which never touches a LakeLife account at all/);
  });
});

describe("the application holds what an underwriter needs — and nothing it must not", () => {
  it("collects the fields a boarding application actually asks for", () => {
    for (const col of [
      "legal_name", "dba_name", "entity_type", "tax_id_last4",
      "address_line1", "address_city", "address_state", "address_postal",
      "contact_phone", "contact_email", "mcc",
      "expected_monthly_cents", "average_ticket_cents",
      "control_person_name", "control_person_title", "application_ready_at",
    ]) {
      expect(m0201, `the application lost ${col}`).toMatch(new RegExp(`add column if not exists ${col}\\b`));
    }
  });

  it("NO FULL TAX ID, AND THE MIGRATION FAILS IF SOMEBODY ADDS ONE", () => {
    // Same posture 0197 took for a resident's bank account. An underwriting
    // application is the richest identity document in this product, and the
    // reason to collect it is to hand it to the party regulated to hold it.
    expect(m0201).toMatch(/check \(tax_id_last4 is null or tax_id_last4 ~ '\^\[0-9\]\{4\}\$'\)/);
    expect(m0201).toMatch(/named like a full credential/);
    // the post-condition's own scan, including the subtle one: a column called
    // `tax_id` would pass a naive check that only looks for ssn/ein.
    expect(m0201).toMatch(/column_name ~\* 'tax_id' and column_name !~\* 'last4'/);
  });

  it("and the no-credential scan RAISES, so it fails the migration rather than noticing", () => {
    const at = m0201.indexOf("grew a column named like a full credential");
    expect(at).toBeGreaterThan(-1);
    expect(m0201.slice(Math.max(0, at - 120), at)).toMatch(/raise exception/);
  });
});

describe("one-click means the state is right BEFORE the click", () => {
  it("A SUBMITTED APPLICATION WAS COMPLETE WHEN IT WENT", () => {
    expect(m0201).toMatch(/check \(submitted_at is null or application_ready_at is not null\)/);
  });

  it("editing a ready application makes it UN-ready", () => {
    // Otherwise `application_ready_at` is a column that is true once and then
    // lies: change the legal name and it stays "ready" with a name nobody
    // checked. The trigger nulls it on any application-field change.
    expect(m0201).toMatch(/new\.application_ready_at := null;/);
    // and it compares the WHOLE row tuple, not one field
    expect(m0201).toMatch(/new\.control_person_title\)\s*\n?\s*is distinct from/);
  });

  it("and after it has gone, editing is REFUSED rather than silently useless", () => {
    expect(m0201).toMatch(/would not reach them/);
  });

  it("the un-ready clause does not fire on the update that SETS ready", () => {
    // Without this guard the clause would null the very stamp it is being
    // asked to set, and an application could never become ready at all.
    expect(m0201).toMatch(/new\.application_ready_at is not distinct from old\.application_ready_at/);
  });
});

describe("0201 REPLACED guard_processor_account and must not have eaten a clause", () => {
  /**
   * The same discipline 0200 carries, one migration later and now with more to
   * lose: this function holds 0196's immutability guards AND 0200's crew rule.
   * A rewrite from memory that dropped either would still pass every other
   * test in this suite.
   */
  const clausesIn = (src: string) => {
    const start = src.indexOf("create or replace function public.guard_processor_account");
    expect(start, "guard_processor_account is gone").toBeGreaterThan(-1);
    return [...src.slice(start).matchAll(/raise exception '(processor_accounts: [^']*(?:''[^']*)*)'/g)].map((m) => m[1]);
  };

  const before = clausesIn(m0200);
  const after = clausesIn(m0201);

  it("0200 had clauses to preserve — or this proves nothing", () => {
    expect(before.length).toBeGreaterThanOrEqual(10);
  });

  it("EVERY CLAUSE 0200 CARRIED IS STILL THERE", () => {
    for (const c of before) {
      expect(after, `0201 dropped: "${c.slice(0, 64)}…"`).toContain(c);
    }
  });

  it("including 0196's own, which 0200 had already preserved once", () => {
    // Belt and braces: assert against the ORIGINAL source rather than only
    // against 0200, so a drop that happened in 0200 and was copied forward
    // would still be caught here.
    for (const c of clausesIn(m0196)) {
      expect(after, `0201 dropped one of 0196's: "${c.slice(0, 64)}…"`).toContain(c);
    }
  });

  it("and 0201 added exactly one of its own", () => {
    const added = after.filter((c) => !before.includes(c));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/already gone to the processor/);
  });
});

describe("the post-conditions prove it, and fail the migration if they cannot", () => {
  const post = m0201.slice(m0201.indexOf("POST-CONDITIONS"));

  it("every check RAISES rather than noticing", () => {
    const fails = [...post.matchAll(/0201 FAILED/g)];
    expect(fails.length).toBeGreaterThanOrEqual(7);
    for (const f of fails) {
      const line = post.slice(post.lastIndexOf("\n", f.index ?? 0), f.index ?? 0);
      expect(line, "a 0201 FAILED that only notices").toMatch(/raise exception/);
    }
  });

  it("it re-proves 0200's crew guard, not just its own additions", () => {
    expect(post).toMatch(/0200''s crew guard did not survive the rewrite/);
    expect(post).toMatch(/receives money, it never accepts it/);
  });

  it("and the probe rows roll back rather than being deleted by hand", () => {
    expect(post).toMatch(/0201 PROVEN/);
    expect(post).toMatch(/exception when others then\s*\n\s*if sqlerrm like '%0201 PROVEN%'/);
  });
});
