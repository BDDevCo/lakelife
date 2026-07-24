import { describe, it, expect } from "vitest";
import { normalizeLakeName } from "./lake-name";

describe("normalizeLakeName — user-typed lake names become one canonical form", () => {
  it("title-cases and appends the Lake suffix", () => {
    expect(normalizeLakeName("big long")).toBe("Big Long Lake");
    expect(normalizeLakeName("  adams   lake ")).toBe("Adams Lake");
    expect(normalizeLakeName("CLEARWATER")).toBe("Clearwater Lake");
  });
  it("keeps an existing Lake word anywhere in the name", () => {
    expect(normalizeLakeName("lake of the woods")).toBe("Lake Of The Woods");
  });
  it("rejects unusable input", () => {
    expect(normalizeLakeName("")).toBeNull();
    expect(normalizeLakeName("ab")).toBeNull();
    expect(normalizeLakeName("12345")).toBeNull();
    expect(normalizeLakeName("zz-sneaky")).toBeNull(); // reserved test prefix
    expect(normalizeLakeName("x".repeat(61))).toBeNull();
  });
});
