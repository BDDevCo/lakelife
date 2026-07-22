/**
 * Storage-package quote engine — PURE, no I/O, importable from client
 * and server alike. The server prices each component against the real
 * property profile and hands the wizard a PackageView; the wizard calls
 * validateSelection on every tap for instant honest totals; the booking
 * action re-runs the SAME function server-side, so the client can never
 * invent a price (rule 1's cousin: never trust the browser with money).
 *
 * Legality rules live here — not in UI — so the wizard, the action and
 * the tests can never disagree:
 *  - required components are always in (auto-added, never removable)
 *  - at most ONE storage tier; storage_only demands exactly one
 *  - we_haul with NO storage must return the boat in fall (it cannot
 *    sleep at the shop unstored); WITH storage it must NOT fall-return
 *  - a spring-only transport leg without any spring work is fine
 *    (deliver-and-splash for home-stored boats)
 */

export interface PackageComponentView {
  serviceId: string;
  name: string;
  phase: "fall" | "spring";
  required: boolean;
  defaultOn: boolean;
  kind: "component" | "addon";
  pricingModel: string;
  /** Customer price for THIS property (server-computed). */
  price: number;
  /** seasonal_plus_perdiem rows form the mutually-exclusive tier group. */
  isStorageTier: boolean;
}

export interface PackageView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  components: PackageComponentView[];
}

export interface SelectionResult {
  ok: boolean;
  error?: string;
  /** serviceIds per visit, required components included. */
  fall: string[];
  spring: string[];
  fallTotal: number;
  springTotal: number;
  total: number;
  storageTierId: string | null;
}

const FALL_RETURN = "Boat return & splash"; // the home-storage fall leg

/** Key for a component row (a service can appear in both phases). */
const ckey = (c: Pick<PackageComponentView, "serviceId" | "phase">) => `${c.serviceId}|${c.phase}`;

/**
 * Normalize + validate a selection against a package recipe.
 * `selectedKeys` may contain serviceIds (legacy) or "serviceId|phase"
 * keys — ids alone select that service in EVERY phase it appears.
 */
export function validateSelection(pkg: PackageView, selectedKeys: string[]): SelectionResult {
  const sel = new Set<string>();
  for (const k of selectedKeys) {
    if (k.includes("|")) sel.add(k);
    else for (const c of pkg.components) if (c.serviceId === k) sel.add(ckey(c));
  }
  // Required components are non-negotiable.
  for (const c of pkg.components) if (c.required) sel.add(ckey(c));

  const chosen = pkg.components.filter((c) => sel.has(ckey(c)));

  const tiers = chosen.filter((c) => c.isStorageTier);
  if (tiers.length > 1) {
    return fail("Pick one storage option — outdoor or indoor, not both.");
  }
  if (pkg.code === "storage_only" && tiers.length === 0) {
    return fail("Storage-only needs a storage option — pick outdoor or indoor.");
  }
  const storing = tiers.length === 1;

  if (pkg.code === "we_haul") {
    const fallReturn = chosen.some((c) => c.phase === "fall" && c.name === FALL_RETURN);
    if (!storing && !fallReturn) {
      return fail("No storage picked — add the fall return trip so your boat comes home for the winter.");
    }
    if (storing && fallReturn) {
      return fail("Storing with us means the boat stays — drop the fall return trip.");
    }
  }

  const fall = chosen.filter((c) => c.phase === "fall");
  const spring = chosen.filter((c) => c.phase === "spring");
  const sum = (list: PackageComponentView[]) => Math.round(list.reduce((s, c) => s + (Number(c.price) || 0), 0));
  const fallTotal = sum(fall);
  const springTotal = sum(spring);

  return {
    ok: true,
    fall: fall.map((c) => c.serviceId),
    spring: spring.map((c) => c.serviceId),
    fallTotal,
    springTotal,
    total: fallTotal + springTotal,
    storageTierId: storing ? tiers[0].serviceId : null,
  };

  function fail(error: string): SelectionResult {
    return { ok: false, error, fall: [], spring: [], fallTotal: 0, springTotal: 0, total: 0, storageTierId: null };
  }
}

/** The default selection (defaultOn + required) — what a tile quotes. */
export function defaultSelection(pkg: PackageView): string[] {
  return pkg.components.filter((c) => c.required || c.defaultOn).map(ckey);
}

/**
 * The primary service for a visit job (jobs.service_id): the piece a
 * crew would name if you asked what the visit IS. Winterize-type work
 * outranks storage intake, which outranks transport, which outranks
 * add-ons. Deterministic so re-quotes never flip the anchor.
 */
export function anchorServiceId(pkg: PackageView, phase: "fall" | "spring", ids: string[]): string | null {
  const inPhase = pkg.components.filter((c) => c.phase === phase && ids.includes(c.serviceId));
  if (inPhase.length === 0) return null;
  const rank = (c: PackageComponentView) =>
    c.kind === "addon" ? 3 :
    c.isStorageTier ? 1 :
    c.pricingModel === "flat" ? 2 : 0; // per_foot components (winterize/de-winterize) first
  return [...inPhase].sort((a, b) => rank(a) - rank(b))[0].serviceId;
}
