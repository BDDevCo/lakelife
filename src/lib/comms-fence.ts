/**
 * THE AI SAFETY FENCE — what a machine may say, and to whom.
 *
 * PURE. No I/O, no database, no API key, fully unit-testable. Spec and the
 * full reasoning: docs/ai-safety-fence.md.
 *
 * WHY THIS EXISTS. The screen it replaces was twenty words — refund, money,
 * angry, lawyer, sue — written for lake homeowners asking about pontoons. It
 * had NO housing vocabulary at all, and parks are about to add tenants, for
 * whom fair-housing duties are real. Measured against the old screen:
 *
 *   "can I get a ramp? I use a wheelchair"     -> CLEARED, auto-reply eligible
 *   "my pipes are gonna burst its 10 degrees"  -> CLEARED
 *   "she fell and I cant get her up"           -> CLEARED
 *   "will you winterize before the freeze?"    -> BLOCKED  ("free" in "freeze")
 *   "the crew showed up early, thanks!"        -> BLOCKED  ("owed" in "showed")
 *
 * Fifteen of fifteen housing messages cleared; five of five ordinary ones were
 * blocked. It was precisely backwards: it stopped the safe traffic and passed
 * the dangerous traffic.
 *
 * THE WORD LIST IS THE WEAKEST LAYER HERE, on purpose. Above it sit population
 * gating (no tenant, owner, crew or RV message auto-sends at all at launch) and
 * the structural rules in docs/ai-safety-fence.md §5. A gap in the vocabulary
 * should cost a delay, never a machine-authored artefact.
 */

// ------------------------------------------------------------ outcomes -----

/**
 * Four outcomes, ordered. A message's verdict is the STRICTEST rule that fired,
 * which is what makes this table safe to edit by someone who has not read the
 * whole file: adding a rule can only ever tighten, never loosen.
 */
export type Outcome = "allow" | "hold" | "never_ai" | "emergency";

const STRICTNESS: Record<Outcome, number> = {
  allow: 0,
  hold: 1,
  never_ai: 2,
  emergency: 3,
};

/** `allow` the model may classify and draft. `hold` — no model classification,
 *  but ops keeps the draft button (today's behaviour for money and anger).
 *  `never_ai` — the model does not see the message at all and the button is
 *  gone; this is the rung the owner's constraint requires. `emergency` — that,
 *  plus a human is paged out of band. */
export function stricter(a: Outcome, b: Outcome): Outcome {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

// ---------------------------------------------------------- populations ----

export type Population =
  | "lake_customer"
  | "park_tenant"
  | "park_owner"
  | "rv_guest"
  | "crew"
  | "unknown";

/**
 * May a reply to this population EVER auto-send, before any rule runs?
 *
 * Only lake customers, at launch. This is the belt to the vocabulary's braces:
 * a tenant message can still be held, drafted and read, but a machine will not
 * answer one unattended no matter how innocuous it looks. `unknown` is the
 * fail-closed lane and gets the strictest treatment — see whichPopulation's
 * note about a mis-stamped renter.
 */
export const AUTOSEND_ALLOWED: Record<Population, boolean> = {
  lake_customer: true,
  park_tenant: false,
  park_owner: false,
  rv_guest: false,
  crew: false,
  unknown: false,
};

// ---------------------------------------------------------- normalising ----

/**
 * ONE normaliser, applied to the message AND to every rule's own words at
 * module load. If the two sides ever normalise differently a rule silently
 * stops matching, which is the quietest way a fence can fail.
 *
 * Apostrophes are dropped rather than split, so "can't" -> "cant" and a rule
 * may spell it either way. Everything else non-alphanumeric becomes a space.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** The padded haystack a phrase is matched against. Padding both sides means
 *  `" free "` can never be found inside `" freeze "`, and a phrase can never
 *  match mid-word. This is the fix for the whole class of bug that made "sue"
 *  match "issue" and "owed" match "showed". */
function haystack(tokens: string[]): string {
  return ` ${tokens.join(" ")} `;
}

// ---------------------------------------------------------------- rules ----

export interface FenceRule {
  id: string;
  /** Plain-English category, shown to ops. */
  category: string;
  outcome: Outcome;
  /** Populations this rule applies to. Empty = every population. */
  populations?: Population[];
  /** Whole tokens. Matched against a Set — there is no wildcard to write, which
   *  is why the "free"/"freeze" bug cannot be reintroduced carelessly. */
  tokens?: string[];
  /** Contiguous word sequences. */
  phrases?: string[];
  /** The one line ops reads on the board. Say what to do, not what tripped. */
  opsLine: string;
}

/**
 * THE RULES.
 *
 * Housing categories run on EVERY population, deliberately, including
 * lake_customer: a mis-stamped renter must not be handed the one channel where
 * housing rules are off. Money/anger rules stay scoped to where they mean
 * something.
 */
export const RULES: FenceRule[] = [
  // ---- ACCOMMODATION AND DISABILITY -- every population, no exceptions ----
  // Nobody says "reasonable accommodation". They say "my mom uses a walker".
  {
    id: "accommodation",
    category: "Possible accommodation request",
    outcome: "never_ai",
    tokens: [
      "wheelchair", "walker", "handicap", "handicapped", "disabled", "disability",
      "accessible", "accessibility", "ramp", "grab", "handrail", "crutches",
      "oxygen", "dialysis", "caregiver", "adhd", "autistic", "blind", "deaf",
    ],
    phrases: [
      "service animal", "service dog", "emotional support", "support animal",
      "my doctor", "doctors note", "note from my doctor", "medically necessary",
      "cant manage the steps", "cant do the stairs", "hard time with the steps",
      "closer spot", "closer space", "reasonable accommodation", "special needs",
      "mobility issues", "gets around with", "uses a cane",
    ],
    opsLine:
      "This may be a disability accommodation request. Answer it yourself — a machine reply here can start a clock we do not control.",
  },

  // ---- FAIR HOUSING -------------------------------------------------------
  // Both directions: a tenant reporting discrimination, and an owner stating a
  // policy that must never be echoed back as if confirmed.
  {
    id: "fair_housing",
    category: "Fair-housing sensitive",
    outcome: "never_ai",
    tokens: [
      "discriminate", "discrimination", "discriminated", "hud", "racist",
      "religion", "nationality", "immigrant", "disabled",
    ],
    phrases: [
      "fair housing", "adults only", "no kids", "no children", "not for kids",
      "families with children", "too many people", "single people only",
      "because im", "because i am", "people like me", "wont rent to",
      "dont rent to", "not allowed to have", "civil rights",
    ],
    opsLine:
      "This touches fair housing. Do not let a machine near it — an automated reply can create the record.",
  },

  // ---- TENANCY, EVICTION, LEASE ------------------------------------------
  {
    id: "tenancy",
    category: "Tenancy or eviction",
    outcome: "never_ai",
    tokens: ["evict", "eviction", "evicted", "evicting", "lease", "tenant", "landlord"],
    phrases: [
      "notice to quit", "30 days", "thirty days", "kicking me out", "kick me out",
      "make me leave", "made me leave", "throw me out", "move out", "moving out",
      "my rights", "is that legal", "lease is up",
      "renew my lease", "end of my lease", "quiet enjoyment",
      // "can they do that" was here and the load-time guard rejected it: every
      // word is high-frequency English, so it fires on "the crew is coming
      // Tuesday, can they do that early?" — an ordinary scheduling question.
      // The eviction wording above already catches the message it was for.
    ],
    opsLine:
      "Tenancy or eviction. This is the park owner's and their attorney's call, never ours and never a machine's.",
  },

  // ---- RENT, DEPOSIT, LEDGER (tenants and owners only) -------------------
  {
    id: "tenant_money",
    category: "Rent or deposit",
    outcome: "never_ai",
    populations: ["park_tenant", "park_owner", "unknown"],
    tokens: ["rent", "deposit", "late", "eviction", "arrears"],
    phrases: [
      "behind on", "catch up", "payment plan", "security deposit", "my ledger",
      "what do i owe", "how much do i owe", "took out of my deposit",
    ],
    opsLine:
      "A tenant's rent or deposit. Rent is a pass-through we never mark up, and never a thing a machine explains.",
  },

  // ---- THE PARK OWNER ASKING THE MACHINE TO WRITE IT ---------------------
  // The red team's sharpest finding: every earlier draft keyed on the SUBJECT,
  // so an owner asking permission was caught and an owner asking for DRAFTING
  // sailed through. Drafting is exactly what the owner's constraint forbids.
  {
    id: "drafting_request",
    category: "Asking us to write something",
    outcome: "never_ai",
    populations: ["park_owner", "unknown"],
    phrases: [
      "write me a letter", "write a letter", "draft a letter", "draft me",
      "write up a notice", "write a notice", "send them a notice",
      "word this", "how should i word", "help me write", "put together a letter",
      "write something", "compose a",
    ],
    opsLine:
      "A park owner is asking us to draft something. We never write a notice, a decline, or a reason on their behalf.",
  },

  // ---- APPLICATION AND SCREENING -----------------------------------------
  {
    id: "application",
    category: "Application or screening",
    outcome: "never_ai",
    phrases: [
      "my application", "the application", "background check", "credit check",
      "did i get approved", "was i approved", "why was i denied", "why did you deny",
      "turned me down", "denied my", "my credit", "my score",
    ],
    opsLine:
      "An application or screening. We never make, explain, or assist a housing decision — hand this to the park owner.",
  },

  // ---- EMERGENCIES: unambiguous hazards page on their own ----------------
  {
    id: "hazard",
    category: "EMERGENCY — hazard",
    outcome: "emergency",
    tokens: ["fire", "smoke", "sparking", "sparks", "gas", "propane", "electrocuted"],
    phrases: [
      "smell gas", "smells like gas", "gas leak", "carbon monoxide", "co detector",
      "on fire", "smoke coming", "sewage", "raw sewage", "sewer backup",
      "pipe burst", "pipes burst", "burst pipe", "water everywhere",
      "live wire", "shocked me",
    ],
    opsLine: "EMERGENCY — possible hazard. Call them now.",
  },

  // ---- EMERGENCIES: person in trouble ------------------------------------
  // "she fell" paged and "i fell" did not, in an earlier draft. The person
  // reporting their OWN fall is the one who is alone.
  {
    id: "person_at_risk",
    category: "EMERGENCY — someone may be hurt",
    outcome: "emergency",
    phrases: [
      "she fell", "he fell", "they fell", "i fell", "ive fallen", "i have fallen",
      "fell down", "fell and", "not breathing", "cant breathe", "chest pain",
      "call an ambulance", "called 911", "havent seen", "welfare check",
      "hurt myself", "unconscious", "passed out", "bleeding",
      // "cant get up" / "cant get her up" / "cant get him up" were here and the
      // load-time guard rejected all three: every word is high-frequency
      // English, and on a lake "cant get her up" is a sentence about a BOAT
      // ("the lift cant get her up out of the water"). The fall words above
      // carry these messages — "i fell and cant get up" matches on "i fell" —
      // and they carry a distinguishing word, which is the whole point.
    ],
    opsLine: "EMERGENCY — someone may be hurt or alone. Call them now.",
  },

  // ---- HABITABILITY: ambiguous, needs a dwelling anchor ------------------
  // Split out deliberately. Paging on every "no heat" put the on-call at 7
  // pages a week, 6 of them rain — and an on-call who learns the page means
  // weather will not open the one that means gas.
  {
    id: "habitability",
    category: "Habitability — no heat, water or sewer",
    outcome: "hold",
    tokens: ["furnace", "heater", "mold", "mould", "leaking", "flooded"],
    phrases: [
      "no heat", "no hot water", "no water", "wont heat", "not heating",
      "acting up", "smells funny", "smells bad", "toilet wont", "backing up",
      "roof leak", "ceiling is", "no power", "power is out",
    ],
    opsLine:
      "Possible habitability problem. Read it now — if it is heat, water or sewer, it may not wait.",
  },

  // ---- MONEY AND ANGER: today's behaviour, kept, and fixed ---------------
  // Same intent as the old list, but as whole tokens: "sue" no longer matches
  // "issue", "owed" no longer matches "showed", "bill" no longer matches a
  // person named Bill... and "free" no longer matches "freeze", which is the
  // single most important question a park renter can ask.
  {
    id: "money",
    category: "Money",
    outcome: "hold",
    // NOTE what is NOT a token here: bare "charge" and "charged". This is a
    // boat business — "can you charge the battery too" is a service request,
    // and Battery care is literally a row in the services table. The money
    // signal is the PRONOUN, not the verb: money messages say charged ME.
    // Whole-token matching fixed the "sue"/"issue" class of bug but cannot
    // resolve a genuinely ambiguous word, so that one moves to phrases.
    tokens: [
      "refund", "refunded", "overcharged", "invoice",
      "credit", "discount", "waive", "waived", "owed", "owe", "billing",
      "dispute", "disputed", "chargeback",
    ],
    phrases: [
      "my money", "the money", "too much", "double charged", "charge me",
      "charged me", "charged us", "you charged", "charged my", "charged twice",
      "still charged", "why was i charged", "charge my card",
    ],
    opsLine: "Money. Ops answers this one — the machine never negotiates.",
  },
  {
    id: "anger",
    category: "Unhappy customer",
    outcome: "hold",
    tokens: ["angry", "furious", "terrible", "awful", "unacceptable", "complaint", "ridiculous"],
    phrases: ["fed up", "had enough", "last straw", "never again", "very disappointed"],
    opsLine: "They are unhappy. A person should answer this.",
  },
  {
    id: "legal",
    category: "Legal",
    outcome: "never_ai",
    tokens: ["lawyer", "attorney", "sue", "suing", "lawsuit", "court", "subpoena", "liable"],
    phrases: ["legal action", "my rights", "attorney general", "small claims", "code enforcement"],
    opsLine: "Legal exposure. Nothing automated goes anywhere near this.",
  },
  {
    id: "commitment",
    category: "Asking us to confirm a deal",
    outcome: "hold",
    phrases: [
      "your guy said", "your guy promised", "you promised", "was promised",
      "confirming that", "just confirming", "as we discussed", "like we agreed",
      "throw in", "no charge", "for free",
    ],
    opsLine: "They are asking us to ratify a deal. Only a person can confirm what was promised.",
  },
];

// ------------------------------------------------------ compiled rules -----

interface Compiled extends FenceRule {
  tokenSet: Set<string>;
  paddedPhrases: string[];
}

/** Rules are normalised ONCE, at module load, through the SAME tokenizer the
 *  message goes through. */
const COMPILED: Compiled[] = RULES.map((r) => ({
  ...r,
  tokenSet: new Set((r.tokens ?? []).flatMap((t) => tokenize(t))),
  paddedPhrases: (r.phrases ?? []).map((p) => ` ${tokenize(p).join(" ")} `),
}));

/**
 * LOAD-TIME GUARD. A `never_ai` or `emergency` phrase built entirely from
 * high-frequency English will fire on ordinary sentences — "on fire" inside
 * "turn the pump on. Fire ring is by the shed". Those tiers must carry at
 * least one distinguishing word. Throwing at import is deliberate: a fence
 * that mis-fires at the top tier is worse than one that is briefly missing,
 * because it teaches everyone to ignore it.
 */
const COMMON = new Set([
  "a", "am", "and", "are", "as", "at", "be", "but", "by", "can", "cant", "did",
  "do", "for", "from", "get", "go", "had", "has", "have", "he", "her", "him",
  "his", "i", "if", "in", "is", "it", "its", "just", "me", "my", "no", "not",
  "of", "on", "or", "our", "out", "she", "so", "that", "the", "them", "they",
  "this", "to", "up", "was", "we", "what", "when", "who", "why", "will", "with",
  "you", "your", "im", "ive", "us", "there", "here", "how", "some", "any",
]);

for (const rule of COMPILED) {
  if (rule.outcome !== "never_ai" && rule.outcome !== "emergency") continue;
  for (const padded of rule.paddedPhrases) {
    const words = padded.trim().split(" ");
    if (words.every((w) => COMMON.has(w))) {
      throw new Error(
        `comms-fence: rule "${rule.id}" has a ${rule.outcome} phrase built only from ` +
        `common words ("${words.join(" ")}"). It will fire on ordinary sentences. ` +
        `Top-tier phrases must carry at least one distinguishing word.`,
      );
    }
  }
}

// --------------------------------------------------------------- screen ----

export interface FenceHit {
  ruleId: string;
  category: string;
  outcome: Outcome;
  /** What actually matched, so ops can see why and we can tune it. */
  matched: string;
  opsLine: string;
}

export interface FenceVerdict {
  outcome: Outcome;
  hits: FenceHit[];
  /** May a reply be sent unattended? Requires `allow` AND a population whose
   *  autonomy is on. Never true for a tenant, owner, crew or RV guest today. */
  mayAutoSend: boolean;
  /** The single line ops reads. Null when nothing fired. */
  opsLine: string | null;
}

/**
 * Screen one message. The verdict is the STRICTEST rule that fired.
 *
 * A blank or unreadable message is `hold`, not `allow` — we have no idea what
 * it says, and "no idea" is not a reason to let a machine answer.
 */
export function screenMessage(body: string, population: Population): FenceVerdict {
  const tokens = tokenize(body ?? "");
  if (tokens.length === 0) {
    return {
      outcome: "hold",
      hits: [],
      mayAutoSend: false,
      opsLine: "Empty or unreadable message — a person should look.",
    };
  }

  const tokenSet = new Set(tokens);
  const hay = haystack(tokens);

  let outcome: Outcome = "allow";
  const hits: FenceHit[] = [];

  for (const rule of COMPILED) {
    if (rule.populations && !rule.populations.includes(population)) continue;

    let matched: string | null = null;
    for (const t of rule.tokenSet) {
      if (tokenSet.has(t)) { matched = t; break; }
    }
    if (matched == null) {
      for (const p of rule.paddedPhrases) {
        if (hay.includes(p)) { matched = p.trim(); break; }
      }
    }
    if (matched == null) continue;

    hits.push({
      ruleId: rule.id,
      category: rule.category,
      outcome: rule.outcome,
      matched,
      opsLine: rule.opsLine,
    });
    outcome = stricter(outcome, rule.outcome);
  }

  // The line ops reads is the STRICTEST hit's line, not the first — otherwise
  // a "money" match would bury an emergency underneath it.
  const worst = hits.reduce<FenceHit | null>(
    (acc, h) => (acc == null || STRICTNESS[h.outcome] > STRICTNESS[acc.outcome] ? h : acc),
    null,
  );

  return {
    outcome,
    hits,
    mayAutoSend: outcome === "allow" && AUTOSEND_ALLOWED[population],
    opsLine: worst?.opsLine ?? null,
  };
}

/** Convenience for the classifier: may the MODEL see this message at all? */
export function modelMaySee(v: FenceVerdict): boolean {
  return v.outcome === "allow";
}

/** Convenience for ops: may the model draft a suggestion a human will read? */
export function modelMayDraft(v: FenceVerdict): boolean {
  return v.outcome === "allow" || v.outcome === "hold";
}
