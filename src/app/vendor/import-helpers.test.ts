import { describe, it, expect } from "vitest";
import { parseCustomers } from "./import-helpers";

describe("parseCustomers", () => {
  it("parses a clean CSV line into name/email/address/phone", () => {
    const r = parseCustomers("Jane Doe, jane@doe.com, 4521 Lakeview Dr, (260) 555-0100");
    expect(r.invalid).toHaveLength(0);
    expect(r.valid[0]).toMatchObject({ name: "Jane Doe", email: "jane@doe.com", address: "4521 Lakeview Dr", phone: "(260) 555-0100" });
  });

  it("requires an email — a line without one is invalid", () => {
    const r = parseCustomers("Bob Smith, 123 Main St, 260-555-1000");
    expect(r.valid).toHaveLength(0);
    expect(r.invalid[0].reason).toBe("no email found");
  });

  it("de-dupes by email (first wins)", () => {
    const r = parseCustomers("Jane, jane@x.com\nJane again, jane@x.com");
    expect(r.valid).toHaveLength(1);
    expect(r.invalid[0].reason).toBe("duplicate email in list");
  });

  it("handles tab-separated (spreadsheet) paste", () => {
    const r = parseCustomers("Mike Jones\tmike@jones.com\t88 Shore Rd\t2605559999");
    expect(r.valid[0]).toMatchObject({ name: "Mike Jones", email: "mike@jones.com", address: "88 Shore Rd" });
    expect(r.valid[0].phone).toMatch(/2605559999/);
  });

  it("email-only line still parses (email is all that's required)", () => {
    const r = parseCustomers("solo@customer.com");
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0].email).toBe("solo@customer.com");
    expect(r.valid[0].name).toBe("");
  });

  it("lowercases email and trims fields", () => {
    const r = parseCustomers("  Ann , ANN@Example.COM , 700 Dock Ln ");
    expect(r.valid[0].email).toBe("ann@example.com");
    expect(r.valid[0].name).toBe("Ann");
  });

  it("skips blank lines", () => {
    const r = parseCustomers("\n\na@b.com\n\n");
    expect(r.valid).toHaveLength(1);
  });

  it("doesn't mistake a phone for an address or vice versa", () => {
    const r = parseCustomers("Pat, pat@lake.com, 12 Bay St, +1 260 555 0000");
    expect(r.valid[0].address).toBe("12 Bay St");
    expect(r.valid[0].phone).toContain("260");
  });
});
