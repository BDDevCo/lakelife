import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A PARK OWNER'S FIRST SIGN-IN LANDS ON /welcome, which told him to set up a
 * lake house. Ops creates the park against an account that already exists,
 * so the owner reaches this page before he has ever seen his park. Both
 * front doors now ask the one helper (park/data isParkMember) and send a
 * park member to /park — /welcome before it lists properties, /portal
 * before claimCrewInvite can rewrite his role.
 */
const strip = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("/welcome", () => {
  const src = strip("./page.tsx");
  it("asks isParkMember BEFORE listing properties, and redirects to /park", () => {
    expect(src).toMatch(/import \{ isParkMember \} from "@\/app\/park\/data"/);
    const check = src.indexOf('if (await isParkMember(user.id)) redirect("/park");');
    const props = src.indexOf("listProperties()");
    expect(check).toBeGreaterThan(-1);
    expect(props).toBeGreaterThan(-1);
    expect(check).toBeLessThan(props);
    // Inside the signed-in branch: nothing redirects a stranger.
    expect(check).toBeGreaterThan(src.indexOf("if (user) {"));
  });
  it("keeps no private park_members read", () => {
    expect(src).not.toContain('from("park_members")');
  });
});

describe("/portal", () => {
  const src = strip("../portal/page.tsx");
  it("uses the same helper, still before claimCrewInvite, and no longer reads the table itself", () => {
    expect(src).toMatch(/import \{ isParkMember \} from "@\/app\/park\/data"/);
    const check = src.indexOf('if (await isParkMember(user.id)) redirect("/park");');
    const claim = src.indexOf("claimCrewInvite(user.id");
    expect(check).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(check).toBeLessThan(claim);
    expect(src).not.toContain('from("park_members")');
    // Still the portal: the scan is reading code.
    expect(src).toContain('from("park_renters")');
  });
});

describe("the helper itself lives beside getMyPark", () => {
  it("in park/data.ts, through mustRead", () => {
    const src = strip("../park/data.ts");
    const fn = src.match(/export async function isParkMember[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).toMatch(/mustRead\(\s*"whether you own or manage a park",\s*await admin\s*\.from\("park_members"\)/);
    expect(fn).toContain("return membership != null;");
  });
});
