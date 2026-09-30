import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE REDIRECT WE WRITE OURSELVES.
 *
 * Every other destination in the sign-in flow goes through safeNext before it
 * reaches a Supabase `redirectTo`. This route reads `next` off its own query
 * string and puts it in a Location header, and it was doing that raw:
 * `${origin}${next}` with next = "@evil.com" is "https://lakelife.ai@evil.com",
 * whose host is evil.com.
 *
 * `//evil.com` is NOT the dangerous shape here — concatenation keeps it on our
 * host — which is exactly why a hand-rolled double-slash check would have
 * looked sufficient and caught none of the three that work. It is asserted
 * below anyway, because the guard should refuse it whatever the mechanism.
 *
 * The token_hash branch is stateless, so a stranger holding one valid hash — a
 * recovery link for an account they own — can fire this at anybody.
 */

let exchangeError: { message: string } | null = null;
let verifyError: { message: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: exchangeError }),
      verifyOtp: async () => ({ error: verifyError }),
    },
  }),
}));

const { GET } = await import("./route");

const ORIGIN = "https://lakelife.ai";

async function landsAt(qs: string) {
  const res = await GET(new Request(`${ORIGIN}/auth/callback?${qs}`));
  const loc = res.headers.get("location");
  expect(loc, "the callback answered with no Location at all").toBeTruthy();
  return new URL(loc as string);
}

beforeEach(() => {
  exchangeError = null;
  verifyError = null;
});

describe("the sign-in callback cannot send you off the site", () => {
  it("still carries a real destination — so the refusals below mean something", async () => {
    // Collapse it the other way: a route that ignored `next` entirely, or one
    // that sent everything to "/", would pass every hostile case below and
    // fail right here.
    expect((await landsAt("token_hash=t&type=recovery&next=%2Freset-password")).href)
      .toBe(`${ORIGIN}/reset-password`);
    expect((await landsAt("code=abc&next=%2Fparks%2Fclaim%3Fpark%3Dthe-haven")).href)
      .toBe(`${ORIGIN}/parks/claim?park=the-haven`);
  });

  it("refuses every shape that fuses onto the hostname", async () => {
    // Each of these built a URL on somebody else's host before safeNext.
    // The first three genuinely shipped; the last two are the ones a cheap
    // check would have caught, kept here so the guard is not narrowed later.
    for (const hostile of ["@evil.com", ".evil.com", ":@evil.com", "//evil.com", "/\\evil.com"]) {
      const url = await landsAt(`code=abc&next=${encodeURIComponent(hostile)}`);
      expect(url.host, `next=${hostile} escaped to ${url.host}`).toBe("lakelife.ai");
    }
  });

  it("refuses them on the stateless token branch too, which is the reachable one", async () => {
    // A recovery hash for an account the attacker owns turns this into a link
    // they can send anybody, with no session of ours required first.
    for (const hostile of ["@evil.com", ".evil.com", ":@evil.com"]) {
      const url = await landsAt(
        `token_hash=t&type=recovery&next=${encodeURIComponent(hostile)}`,
      );
      expect(url.host, `next=${hostile} escaped to ${url.host}`).toBe("lakelife.ai");
    }
  });

  it("keeps the failure path on the site as well", async () => {
    exchangeError = { message: "bad code" };
    const url = await landsAt("code=abc&next=%2F%2Fevil.com");
    expect(url.host).toBe("lakelife.ai");
    expect(url.searchParams.get("auth_error")).toBe("1");
  });

  it("falls back to /verify when the destination is refused, rather than erroring", async () => {
    // A refused `next` must not 500 or strand somebody mid-sign-in — it lands
    // them at the same place a link with no destination would.
    const url = await landsAt("code=abc&next=%40evil.com");
    expect(url.href).toBe(`${ORIGIN}/verify`);
  });
});
