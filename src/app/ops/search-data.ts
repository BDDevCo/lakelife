import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { sanitizeSearchTerm, isSearchable } from "@/lib/job-view";

/**
 * OPS SEARCH (owner ask, 2026-07-26): at scale you cannot find one dock job by
 * clicking through months of calendar. Type a customer name, an address, a
 * property nickname, a service or a crew and get the jobs.
 *
 * HOW IT'S SHAPED — and why it isn't one big joined ILIKE: PostgREST can't
 * filter a parent table on an ILIKE against an embedded child, so we resolve
 * the needle to id sets on the four indexed columns FIRST (migration 0046 put
 * pg_trgm GIN indexes on exactly those: properties.address,
 * properties.nickname, users.name, vendors.company, services.name) and then
 * pull jobs by id. Every leading-wildcard ILIKE therefore lands on a trigram
 * index instead of a sequential scan.
 *
 * SAFETY: every needle goes through sanitizeSearchTerm (src/lib/job-view.ts)
 * before it touches the database — it strips LIKE wildcards AND the PostgREST
 * filter-grammar characters that would otherwise let a name like "Smith, John"
 * corrupt the whole filter string. The only values we ever interpolate into an
 * `.or(...)` list beyond that are UUIDs that came back FROM the database.
 *
 * Ops-only (assertOps) — the result rows carry customer_price, so this must
 * never be reached from a crew or customer surface (rule 1).
 */

/** Hits shown at once. Deliberately small: search is a jump-to, not a report. */
export const JOB_SEARCH_LIMIT = 25;

/** Ceiling on the id sets we resolve the needle to before hitting jobs. */
const ID_FANOUT_LIMIT = 200;

export interface JobSearchHit {
  id: string;
  status: string;
  date: string | null;
  serviceName: string | null;
  address: string | null;
  nickname: string | null;
  lakeName: string | null;
  customerName: string | null;
  crewCompany: string | null;
  customerPrice: number | null;
}

export interface JobSearchResult {
  ok: boolean;
  error?: string;
  /** The needle as it was actually run (post-sanitize) — shown back to ops. */
  term: string;
  rows: JobSearchHit[];
  /** True when more jobs matched than we're showing. */
  truncated: boolean;
}

type Embed<T> = T | T[] | null;
const first = <T,>(x: Embed<T> | undefined): T | null =>
  x == null ? null : Array.isArray(x) ? (x[0] ?? null) : x;

const EMPTY = (term: string): JobSearchResult => ({ ok: true, term, rows: [], truncated: false });

/**
 * A failed read here is NOT "no jobs match".
 *
 * The needle is resolved to id sets first (see the header), and each of those
 * reads is silent about failing: `data: null` collapses to an empty id set,
 * every clause vanishes, and the function returns the same `ok: true, rows: []`
 * that a genuine miss returns. Ops types a customer's name, is told there are no
 * jobs, and goes looking somewhere else — for a customer with a full season
 * booked. A PARTIAL failure is worse still: the address hits land, the
 * customer-name hits are lost, and the short list looks like the whole answer.
 *
 * NOT a throw. `searchOpsJobs` is called from job-detail-actions.ts, which
 * carries "use server" and hands this straight back to a client component — so
 * this returns the failure in the shape that component already renders.
 */
const READ_FAILED = (term: string, what: string, error: unknown): JobSearchResult => {
  console.error(`[read failed] ${what}:`, error);
  return { ok: false, error: "Search failed — try again.", term, rows: [], truncated: false };
};

export async function searchOpsJobs(raw: string): Promise<JobSearchResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only.", term: "", rows: [], truncated: false };

  const term = sanitizeSearchTerm(raw);
  if (!isSearchable(term)) return EMPTY(term);

  const admin = createServiceClient();
  const pattern = `*${term}*`; // PostgREST ilike wildcard form
  const like = `%${term}%`;

  const [propRes, userRes, svcRes, vendRes] = await Promise.all([
    admin
      .from("properties")
      .select("id")
      .or(`address.ilike.${pattern},nickname.ilike.${pattern}`)
      .limit(ID_FANOUT_LIMIT),
    admin.from("users").select("id").ilike("name", like).limit(ID_FANOUT_LIMIT),
    admin.from("services").select("id").ilike("name", like).limit(50),
    admin.from("vendors").select("id").ilike("company", like).limit(50),
  ]);

  if (propRes.error) return READ_FAILED(term, "the properties matching that search", propRes.error);
  if (userRes.error) return READ_FAILED(term, "the customers matching that search", userRes.error);
  if (svcRes.error) return READ_FAILED(term, "the services matching that search", svcRes.error);
  if (vendRes.error) return READ_FAILED(term, "the crews matching that search", vendRes.error);

  const propertyIds = new Set(((propRes.data ?? []) as { id: string }[]).map((r) => r.id));
  const ownerIds = ((userRes.data ?? []) as { id: string }[]).map((r) => r.id);
  const serviceIds = ((svcRes.data ?? []) as { id: string }[]).map((r) => r.id);
  const vendorIds = ((vendRes.data ?? []) as { id: string }[]).map((r) => r.id);

  // A customer-name hit means "every property that person owns".
  if (ownerIds.length) {
    const ownedRes = await admin
      .from("properties")
      .select("id")
      .in("owner_id", ownerIds)
      .limit(ID_FANOUT_LIMIT);
    // We already know a person matched. Losing their properties turns a real hit
    // into "no jobs match" — the exact wrong answer for a name search.
    if (ownedRes.error) return READ_FAILED(term, "the properties that customer owns", ownedRes.error);
    for (const p of (ownedRes.data ?? []) as { id: string }[]) propertyIds.add(p.id);
  }

  const clauses: string[] = [];
  if (propertyIds.size) clauses.push(`property_id.in.(${[...propertyIds].join(",")})`);
  if (serviceIds.length) clauses.push(`service_id.in.(${serviceIds.join(",")})`);
  if (vendorIds.length) clauses.push(`vendor_id.in.(${vendorIds.join(",")})`);
  if (clauses.length === 0) return EMPTY(term);

  const { data, error } = await admin
    .from("jobs")
    .select(
      "id, status, date, customer_price, services(name), vendors(company), " +
        "properties(address, nickname, lakes(name), users(name))",
    )
    .or(clauses.join(","))
    .order("date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(JOB_SEARCH_LIMIT + 1); // one extra row = "there are more"

  if (error) return READ_FAILED(term, "the jobs matching that search", error);

  const raws = (data ?? []) as unknown as {
    id: string;
    status: string;
    date: string | null;
    customer_price: number | null;
    services: Embed<{ name: string | null }>;
    vendors: Embed<{ company: string | null }>;
    properties: Embed<{ address: string | null; nickname: string | null; lakes: Embed<{ name: string | null }>; users: Embed<{ name: string | null }> }>;
  }[];

  const truncated = raws.length > JOB_SEARCH_LIMIT;
  const rows: JobSearchHit[] = raws.slice(0, JOB_SEARCH_LIMIT).map((r) => {
    const prop = first(r.properties);
    return {
      id: r.id,
      status: r.status,
      date: r.date,
      serviceName: first(r.services)?.name ?? null,
      address: prop?.address ?? null,
      nickname: prop?.nickname ?? null,
      lakeName: first(prop?.lakes)?.name ?? null,
      customerName: first(prop?.users)?.name ?? null,
      crewCompany: first(r.vendors)?.company ?? null,
      customerPrice: r.customer_price == null ? null : Number(r.customer_price),
    };
  });

  return { ok: true, term, rows, truncated };
}
