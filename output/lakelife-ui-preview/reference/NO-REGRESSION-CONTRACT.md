# LakeLife: preserve the platform

Audited 17 October 2026 against repository baseline `fe9e145`. This is a documentation correction, not an implementation order.

## Authority and scope

The latest explicit product-owner instruction comes first. For existing behavior, reconcile current executable code, database migrations, regression tests and recorded later owner decisions. Preserve the approved stack and non-negotiable access, evidence and money boundaries. A historical brief or screenshot cannot silently override a later implemented decision. If current code appears to violate a required invariant, report that conflict with evidence; do not label the defect a product decision or quietly redesign the system.

`lakelife.html` governs original visual identity: logo, waves, type, color and illustration language. Its rates, role switcher, automatic-payment labels, sample data and old flows are NOT a specification to restore. The brand books, synthetic reference screens and forecasts are guidance, never runtime defaults, seed data or authorization to enable a feature.

The 30% margin sentence in AGENTS.md / CLAUDE.md and older plans is historical pricing context, superseded for crew-priced work by the owner decision recorded in `ad26455`, migration 0174 and current implementation. Do not use that old sentence to reverse the newer behavior. This reconciliation does not change the access or evidence rules in those files.

## Behaviors the builder must preserve

1. **Pricing modes coexist.** Preserve menu-priced services, negotiated park rates and crew-priced work. Use current eligibility and park-rate precedence helpers; a park can buy crew-priced ordinary work where no negotiated rate overrides it. Do not interpret “park” as a blanket ban on crew pricing.
2. **The crew sets its quote.** For crew-priced work, customer total = round2(quote × (1 + customer fee)); crew payout = round2(quote × (1 - crew fee)). Platform share is the difference of those rounded ends. Percentages come from settings and are frozen onto the job. No universal 30% margin, no new rate hardcoding and no repricing sold work from today's settings.
3. **Preserve routing differences.** Do not restore menu-path margin floors, scarcity adjustments or higher-margin-first ranking on crew-priced work. Do not remove those existing menu-path protections just because the crew-priced path differs. Keep customer crew-choice and existing eligibility checks.
4. **An unpriced request remains unpriced.** An available crew offer may supply a price; another request can legitimately have `customer_price = null`. Render pending quote, never $0, an invented estimate or a “full total before booking” guarantee. Requested, crew selected and confirmed date remain distinct.
5. **Seasonal Autopilot needs a tap.** It proposes the next visit; the customer books or skips. Do not restore autonomous booking or payment promises because the public headline says “Automated.” Keep the approved headline in its current context.
6. **Money belongs to the right recipient.** Architecture A uses each park owner's / crew's own receiving account. Do not introduce pooled rent, an FBO balance, LakeLife-originated ACH files or a second payment model. Existing legacy account fields do not authorize returning to that model.
7. **Keep payment gates closed unless properly enabled.** Charging/refunding and tokenization include mock implementations. Preserve global readiness, per-park receiving account status, park switch, method-specific capability, idempotency and signed/deduplicated events. Never flip a live flag, seed fake success, weaken a gate or claim collection works merely to make a demo look complete.
8. **A payment attempt is not settled money.** Keep reported/offline, confirmed, processing, settled, returned, refunded and uncertain outcomes distinct. Preserve provisional ACH handling and the current ledger correction rules. Park rent, LakeLife platform fees and household optional service charges are separate streams.
9. **Keep role boundaries on the server.** Account roles remain owner/vendor/ops; park membership and resident links grant scoped access. Crew sees its own quote, deduction and net payout, never customer price or platform margin. Park office must not gain household optional-service prices. Do not add authorization via a visual role switcher.
10. **Keep completion and access gates.** Required service/package evidence, held work and valid job day remain server/database decisions. Codes stay encrypted and limited to the assigned vendor's permitted day. Completing a job or releasing payout eligibility is not proof that money arrived.
11. **Approvals protect the agreed record.** A proposed correction changes nothing until authorized homeowner approval. Preserve accepted extras, frozen fees, negotiated/agreed prices and existing repricing exceptions. The broader all-or-nothing profile-plus-price guarantee is not currently established: the profile RPC and repricing are separate. Report this gap; repair only within a specifically authorized backend task and prove failure/concurrency behavior.
12. **Keep delivery and availability truthful.** Accepted notification ≠ delivered notification. Preserve consent, holds and actual receipts; no guaranteed text, photo attachment or payout clock. Service illustrations are categories, not proof of local capacity. No instant park setup, guaranteed dates, savings, free trial or broad replacement promise without current evidence and agreed terms.

## Before and after any authorized implementation

- Record the starting commit, clean/dirty work and the requested scope. Read the current routes, actions, migrations, helpers and tests for that scope.
- List observable behavior that must stay the same. Identify intentional changes separately. Do not convert a design suggestion or known gap into extra work without scope authorization.
- Reuse existing components, tokens and authoritative helpers. Preserve logo/illustration/emoji assets. Do not create parallel calculators, money writers, status enums, access paths or schema versions.
- Run relevant existing tests. Add meaningful boundary tests only for behavior actually being changed. Never remove, skip or weaken a regression assertion to fit a screenshot.
- Review the affected role flows on phone and desktop with failures, pending data and blocked states. Verify direct server boundaries for any affected security or money behavior.
- Review the diff for unintended runtime/config/schema changes, summarize what changed and how to review it, record actual test results, and commit the authorized milestone. A guide revision never authorizes deployment, payment activation or customer notices.

## Claim publication rule

Every product claim needs a current source and the conditions under which it is true. Use the ledger in `claims-register.csv`. Code evidence means implemented, not deployed, activated or commercially offered. Before a new live claim is published, confirm the relevant deployed revision, actual feature settings, park/merchant readiness, service capacity and successful real workflow. Pending evidence means use the narrower approved wording or hold that claim.
