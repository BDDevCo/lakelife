import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRetryingFetch } from "./retrying-fetch";

/**
 * The whole safety argument is "reads retry, writes never do". A retried POST
 * could double-charge a card or pay a crew twice — the exact bugs the rest of
 * this work removed — so that boundary is what these tests defend.
 */

const res = (status: number) =>
  new Response(status === 204 ? null : "{}", { status });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reads", () => {
  it("retries a 502 and returns the good response", async () => {
    const under = vi.fn()
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const f = createRetryingFetch(under as unknown as typeof fetch);
    const out = await f("https://x.supabase.co/rest/v1/park_renters?select=id");
    expect(out.status).toBe(200);
    expect(under).toHaveBeenCalledTimes(2);
  });

  it("retries a thrown network error", async () => {
    const under = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(res(200));
    const f = createRetryingFetch(under as unknown as typeof fetch);
    expect((await f("https://x.supabase.co/rest/v1/parks")).status).toBe(200);
    expect(under).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts and returns the last response", async () => {
    // It must not loop forever behind a page render.
    const under = vi.fn().mockResolvedValue(res(502));
    const f = createRetryingFetch(under as unknown as typeof fetch);
    expect((await f("https://x.supabase.co/rest/v1/parks")).status).toBe(502);
    expect(under).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a real answer — 4xx or 500", async () => {
    // 4xx is the origin answering. 500 means it ran and failed; asking again
    // just fails again, more slowly.
    for (const status of [400, 401, 404, 409, 500]) {
      const under = vi.fn().mockResolvedValue(res(status));
      const f = createRetryingFetch(under as unknown as typeof fetch);
      expect((await f("https://x.supabase.co/rest/v1/parks")).status).toBe(status);
      expect(under, `status ${status} must not retry`).toHaveBeenCalledTimes(1);
    }
  });

  it("retries a HEAD, which is how a `{ count, head: true }` read goes out", async () => {
    const under = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const f = createRetryingFetch(under as unknown as typeof fetch);
    await f("https://x.supabase.co/rest/v1/payment_methods", { method: "HEAD" });
    expect(under).toHaveBeenCalledTimes(2);
  });
});

describe("writes are never retried", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "%s is sent exactly once even on a 502",
    async (method) => {
      // A write that fails in transit MAY HAVE LANDED — only the response went
      // missing. Retrying is how one payment becomes two.
      const under = vi.fn().mockResolvedValue(res(502));
      const f = createRetryingFetch(under as unknown as typeof fetch);
      expect((await f("https://x.supabase.co/rest/v1/park_payments", { method })).status).toBe(502);
      expect(under).toHaveBeenCalledTimes(1);
    },
  );

  it("a thrown error on a write propagates immediately", async () => {
    const under = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const f = createRetryingFetch(under as unknown as typeof fetch);
    await expect(f("https://x.supabase.co/rest/v1/payments", { method: "POST" })).rejects.toThrow();
    expect(under).toHaveBeenCalledTimes(1);
  });

  it("an RPC is a POST and therefore is not retried — a function can write", async () => {
    const under = vi.fn().mockResolvedValue(res(502));
    const f = createRetryingFetch(under as unknown as typeof fetch);
    await f("https://x.supabase.co/rest/v1/rpc/claim_park_file", { method: "POST" });
    expect(under).toHaveBeenCalledTimes(1);
  });
});

describe("it does not leak", () => {
  it("logs the path but never the query string", async () => {
    // A Supabase URL carries filters, and filters carry data — an email, a
    // token, a renter id. The log line gets the path only.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const under = vi.fn().mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200));
    const f = createRetryingFetch(under as unknown as typeof fetch);
    await f("https://x.supabase.co/rest/v1/park_renters?email=eq.someone%40example.com");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("/rest/v1/park_renters");
    expect(logged).not.toContain("example.com");
    expect(logged).not.toContain("email=");
  });
});
