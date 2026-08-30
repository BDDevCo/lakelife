import { describe, it, expect } from "vitest";
import { normalizeBusinessName, checkNamedInsured } from "./named-insured";

/**
 * The owner's rule: the certificate has to belong to the business that sent
 * it. Every case here is one a real crew would hit.
 */

describe("folding a business name to the part that identifies it", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeBusinessName("NORTHSHORE DOCKS")).toBe("northshore docks");
    expect(normalizeBusinessName("  Northshore   Docks  ")).toBe("northshore docks");
    expect(normalizeBusinessName("N.D. Marine")).toBe("nd marine");
  });

  it("treats & and 'and' as the same word", () => {
    expect(normalizeBusinessName("Pier & Lift Co")).toBe(normalizeBusinessName("Pier and Lift"));
  });

  it("strips the legal suffix, which is the whole reason this exists", () => {
    const plain = normalizeBusinessName("Northshore Docks");
    for (const suffixed of [
      "Northshore Docks LLC",
      "Northshore Docks, L.L.C.",
      "NORTHSHORE DOCKS, LLC.",
      "Northshore Docks Inc",
      "Northshore Docks, Inc.",
      "Northshore Docks Incorporated",
      "Northshore Docks Corp",
      "Northshore Docks Ltd",
      "Northshore Docks LLP",
      "Northshore Docks Company",
    ]) {
      expect(normalizeBusinessName(suffixed), `${suffixed} should fold to the plain name`).toBe(plain);
    }
  });

  it("rejoins a dotted initialism before looking for a suffix", () => {
    // Dropping punctuation turns "L.L.C." into "l l c", which matches no
    // suffix — so the form a certificate is most likely to print would have
    // been read as three words of identity. This test failed first.
    expect(normalizeBusinessName("Northshore Docks, L.L.C.")).toBe("northshore docks");
    expect(normalizeBusinessName("N.D. Marine")).toBe("nd marine");
    expect(normalizeBusinessName("A.B.C. Piers Inc.")).toBe("abc piers");
  });

  it("strips more than one suffix, because 'Docks LLC Co' is a real thing", () => {
    expect(normalizeBusinessName("Northshore Docks LLC Co")).toBe("northshore docks");
  });

  it("never strips a name down to nothing", () => {
    // "The Company" is a business name, not a suffix with nothing in front.
    expect(normalizeBusinessName("Company")).toBe("company");
    expect(normalizeBusinessName("LLC")).toBe("llc");
  });

  it("is empty only for genuinely empty input", () => {
    expect(normalizeBusinessName("")).toBe("");
    expect(normalizeBusinessName(null)).toBe("");
    expect(normalizeBusinessName(undefined)).toBe("");
    expect(normalizeBusinessName("   ")).toBe("");
    expect(normalizeBusinessName(",.-")).toBe("");
  });
});

describe("does this certificate belong to this business", () => {
  it("accepts the ordinary case: trading name signs up, legal name on the policy", () => {
    expect(checkNamedInsured("Northshore Docks, LLC", "Northshore Docks")).toEqual({ ok: true });
    expect(checkNamedInsured("northshore docks", "NORTHSHORE DOCKS INC.")).toEqual({ ok: true });
  });

  it("refuses somebody else's certificate", () => {
    const v = checkNamedInsured("Timber Marine LLC", "Northshore Docks");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("mismatch");
  });

  it("names BOTH businesses in the refusal, because the account is often the wrong one", () => {
    const v = checkNamedInsured("Timber Marine LLC", "Northshore Docks");
    expect(v.ok === false && v.message).toContain("Timber Marine LLC");
    expect(v.ok === false && v.message).toContain("Northshore Docks");
  });

  it("does NOT accept a certificate merely because the name contains theirs", () => {
    // The whole reason there is no substring match: this is a different
    // company, and a containment rule would file its policy against ours.
    const v = checkNamedInsured("Northshore Docks Holdings of Indiana", "Northshore Docks");
    expect(v.ok).toBe(false);
    const w = checkNamedInsured("Docks", "Northshore Docks");
    expect(w.ok).toBe(false);
  });

  it("asks for the name when the crew left it blank", () => {
    const v = checkNamedInsured("", "Northshore Docks");
    expect(v.ok === false && v.reason).toBe("missing");
    expect(v.ok === false && v.message).toMatch(/exactly as it appears/i);
  });

  it("blames the account, not the certificate, when the business name is missing", () => {
    // Telling a crew their certificate is wrong when the gap is their own
    // profile sends them hunting through the wrong paperwork.
    const v = checkNamedInsured("Northshore Docks LLC", "");
    expect(v.ok === false && v.reason).toBe("missing");
    expect(v.ok === false && v.message).toMatch(/no business name/i);
  });

  it("treats whitespace-only as missing, not as a match", () => {
    // Two blanks normalise identically, and an equality check written without
    // this would call that a match and pass the gate.
    expect(checkNamedInsured("   ", "   ").ok).toBe(false);
    expect(checkNamedInsured(null, null).ok).toBe(false);
  });
});
