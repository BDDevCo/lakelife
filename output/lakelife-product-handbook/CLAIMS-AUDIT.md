# LakeLife claims and regression audit

17 October 2026 • Baseline `fe9e145` • Internal owner / builder record

## Result

The earlier materials did contain unsupported or outdated statements. They have been corrected in the brand and product books, recruitment pitch, social captions and artwork, business model and the rebuilt handoff archives. The original visual identity is preserved. No application source, database migration, deployed setting or production data was changed.

The largest corrections are the universal “total before booking” promise and the old 30% margin model. Current code supports menu prices, negotiated park rates and crew-priced work; some requests legitimately have no price yet. Crew-priced work uses the crew's quote plus configurable fees, with the percentages frozen on each job. The forecast now uses explicitly illustrative 12% / 12% fees rather than presenting a 30% margin as current platform economics.

## How evidence was judged

Current executable behavior, existing regression tests, database migrations and recorded owner decisions were compared with the delivered materials. A commit message helped explain intent; a comment or an old readiness report was not accepted as proof of today's deployment. This audit did not inspect secrets, connect to production, run live payments, send notifications, deploy changes or verify real crew capacity. Market-study external research remains dated to its own source review and was not re-researched in this code audit.

The book's “CURRENT” label means observed in this source snapshot. “REQUIRED” can describe a guard or target, not proof it passes in production. “REFERENCE” means synthetic design example. Use the explicit gap register and the capability conditions here when interpreting those labels.

## Corrections and claim decisions

### P01 · Fixed 30% platform margin on all work

**Finding:** Superseded for crew-priced work.

**Use:** Crew-priced work uses the crew quote and configurable fees. Existing menu and negotiated park rules remain.

**Evidence:** src/lib/platform-fee.ts; src/lib/dispatch.ts; src/lib/crew-priced-eligibility.ts; migration 0174; ad26455.

**Action:** Corrected business plan, market example and builder pricing rules.

### P02 · Full total before every booking

**Finding:** Contradicted by supported pending-price path.

**Use:** See the price before anything is charged. Some requests await a crew quote.

**Evidence:** src/app/book/actions.ts; src/app/book/page.tsx; src/app/book/an-unpriced-visit-says-so.test.ts.

**Action:** Corrected books, social copy/art, pitch and synthetic booking views.

### P03 · Crew amount is a single undisclosed net rate

**Finding:** Incomplete for crew-priced work.

**Use:** Crew sees its own quote, fee deduction and payout; customer price and platform margin remain private.

**Evidence:** src/lib/platform-fee.ts; src/app/vendor/the-crew-is-told-what-they-are-paid.test.ts.

**Action:** Corrected reference fixture and role contract.

### P04 · Changing settings can reprice sold work

**Finding:** Prohibited by current snapshots.

**Use:** Use the job’s frozen fee percentages and existing agreed-price protections.

**Evidence:** src/app/approvals/the-frozen-percentages.test.ts; src/app/book/actions.ts.

**Action:** Added explicit preservation rule.

### P05 · Automatic seasonal booking

**Finding:** Removed from current public promise.

**Use:** LakeLife proposes the next visit; the customer taps to book or skips.

**Evidence:** src/app/page.tsx; src/lib/autopilot.ts; src/lib/autopilot.test.ts.

**Action:** Historical prototype explicitly excluded as behavior authority.

### P06 · Payments work because a screen or live switch exists

**Finding:** Not established; mock implementation remains.

**Use:** Use only payment methods actually enabled for the park; otherwise follow office instructions.

**Evidence:** src/lib/payments.ts; src/lib/payments-server.ts; src/lib/charge-gate.ts; src/app/parks/rent-capability.ts.

**Action:** Kept live collection conditional; no activation performed.

### P07 · ACH submission means rent is settled

**Finding:** Contradicted by provisional handling.

**Use:** A bank payment can be processing, settled or returned; report the actual record.

**Evidence:** src/app/parks/pay-actions.ts; migration 0191; migration 0197.

**Action:** Preserved in-flight and return semantics; no live bank proof claimed.

### P08 · LakeLife collects pooled rent then sends it to owners

**Finding:** Rejected payment architecture.

**Use:** Rent is the park owner’s money; Architecture A uses their own receiving account.

**Evidence:** docs/processor-questions.md; migration 0196; commit 3497c17.

**Action:** Added explicit no-regression constraint.

### P09 · A completion immediately pays the crew

**Finding:** Unsupported timing promise.

**Use:** Required evidence permits completion and payout eligibility; actual payout status is separate.

**Evidence:** src/app/vendor/actions.ts; src/lib/what-we-tell-a-crew.test.ts.

**Action:** Retained evidence promise without a payout clock.

### P10 · A proposed profile correction changes the bill by itself

**Finding:** Forbidden.

**Use:** The homeowner approves a proposed correction before it changes the profile or pricing.

**Evidence:** src/app/approvals/actions.ts; migration 0159.

**Action:** Kept narrow approval statement; no automatic guarantee for all changes.

### P11 · Profile and every price always update in one transaction

**Finding:** Not established; existing gap.

**Use:** Current profile/flag RPC commits before separate repricing. Do not claim full atomicity or repair it as a branding change.

**Evidence:** src/app/approvals/actions.ts; migration 0159.

**Action:** Qualified builder instructions, diagrams and known-gap register.

### P12 · Every job reprices the same way on approval

**Finding:** False; deliberate exceptions.

**Use:** Preserve negotiated prices, accepted add-ons, frozen fees, margin holds and package exceptions.

**Evidence:** src/app/approvals/actions.ts; src/app/approvals/reprice.test.ts.

**Action:** Corrected approval contract.

### P13 · Texts always arrive or carry completion photos

**Finding:** Unsupported delivery claim.

**Use:** See work photos in the job record; actual notification delivery depends on provider receipts and preferences.

**Evidence:** src/lib/notifications.ts; src/lib/sms-receipts.ts; src/app/public-pages-claim-only-what-is-built.test.ts.

**Action:** Preserved current narrower copy; no SMS promise added.

### P14 · All advertised services available at every lake/park

**Finding:** Unverified live capacity.

**Use:** Ask about service availability for your property; dates depend on crew, service and lake conditions.

**Evidence:** src/app/for-parks/page.tsx; src/lib/lake-gate.ts; src/lib/dispatch.ts.

**Action:** Qualified service illustrations and recruitment copy.

### P15 · Instant park signup or guaranteed setup time

**Finding:** Not current offer.

**Use:** Ask for a guided walkthrough and agree the setup scope.

**Evidence:** src/app/for-parks/page.tsx.

**Action:** Preserved guided-start wording.

### P16 · $8 per lot is a universal customer offer

**Finding:** Configurable/internal assumption.

**Use:** The written proposal confirms eligible lots, rate, billing start and included support.

**Evidence:** src/lib/park-platform-fee.ts; src/lib/settings.ts.

**Action:** Kept $8 only as labeled planning input; code fallback $0.

### P17 · Payment report transfers money or confirms receipt

**Finding:** False.

**Use:** Reporting an offline payment sends no money; the office reviews the record.

**Evidence:** src/app/parks/pay-actions.ts; src/app/park/money-actions.ts.

**Action:** Preserved separate reporting/confirmation wording.

### P18 · Shared-cost record includes an uploaded source bill

**Finding:** Not supported by the cited flow.

**Use:** Record the cost, source note and applicable allocation.

**Evidence:** src/app/park/cost-actions.ts; src/components/ParkCosts.tsx; src/app/for-parks/page.tsx.

**Action:** Kept source-note wording; no attachment promise.

### P19 · Photo requirement proves satisfaction/quality

**Finding:** Unsupported inference.

**Use:** The job requires its completion evidence; photos provide a record of work.

**Evidence:** src/app/vendor/actions.ts; src/app/vendor/photo-evidence.test.ts; migration 0050.

**Action:** Kept evidence promise; no guaranteed quality claim.

### P20 · Park office can see household service prices

**Finding:** Forbidden exposure.

**Use:** Office may see permitted visit/service/timing; household optional-service prices remain private.

**Evidence:** src/app/park/data.ts; src/app/parks/my-data.ts; src/lib/addons-are-not-a-customer-price.test.ts.

**Action:** Preserved role boundary.

### P21 · Five product experiences require five account roles

**Finding:** Incorrect implementation instruction.

**Use:** Keep owner/vendor/ops and current park memberships/resident links.

**Evidence:** src/app/portal/page.tsx; src/app/park/data.ts; src/app/vendor/data.ts.

**Action:** Explicit preservation rule.

### P22 · Projections, targets, competitor claims prove traction or guaranteed savings

**Finding:** Unsupported inference.

**Use:** Plans are assumptions; current research is context; no sales, interviews, adoption or savings are implied.

**Evidence:** output/lakelife-launch-kit/business-model.csv; Audience and Market Study source register.

**Action:** Forecast recalculated; external research not reverified in this code audit.

### P23 · Approval state in demo proves current all-or-nothing implementation

**Finding:** Synthetic target only.

**Use:** The reference labels its target behavior and partial-update state; current implementation gap remains open.

**Evidence:** output/lakelife-product-handbook/reference/index.html; src/app/approvals/actions.ts.

**Action:** Kept gap visible; no backend change.

### P24 · Brand imagery or old prototype authorizes removed functionality

**Finding:** No authority.

**Use:** Preserve original visual assets while using current behavior and existing guards.

**Evidence:** lakelife.html; src/components/Brand.tsx; NO-REGRESSION-CONTRACT.md.

**Action:** Retained original logo, illustrations, waves and emoji.

## Remaining limits

- The code still includes mock charging/refunding and bank tokenization. Global and park-specific capability checks exist. Neither a flag nor passing unit tests proves real collection, receiving-account routing, refund or settlement works. Advertise live payment methods only after the actual deployed workflow is verified.
- `approveFlag` commits profile/flag changes before separate job repricing. The broader atomic profile-plus-price invariant remains an identified implementation gap. This audit does not fix it or promise it is already satisfied.
- Notification acceptance is not carrier delivery. This audit provides no new delivered-SMS evidence. Keep channel promises narrow.
- Current crew capacity, service availability, park agreements, pricing settings and customer support commitments need operating evidence before being offered.
- No documentation-only audit can guarantee future implementation has no regressions. The prevention mechanism is the supplied behavior-preservation contract, existing tests and review of each authorized change.

## Verification record

The combined focused runs passed **27 test files / 666 tests** covering pricing, crew selection, frozen fees, approvals, photo evidence, access-code handling, payment gates, bank-payment records, public claims and design tokens. These are local tests (including mocked and source-scanning tests), not a live database or production end-to-end certification. Boundary results, artifact checks and byte-for-byte platform preservation are recorded in `HANDOFF-CHECKS.md`.

The 18 broader implementation scenarios in `acceptance-checklist.csv` remain unrun as end-to-end checks; the focused unit suite does not silently mark them passed.

## Using this package

Read `NO-REGRESSION-CONTRACT.md` before asking Claude Code to change anything. Give it the whole handoff archive and the current repository, not just a screenshot or PDF. Use the updated `CLAUDE-CODE-PROMPT.md` with the exact task you authorize. Old downloaded copies should be replaced with the audited package; retained historical artwork does not restore its obsolete copy or behavior.


## Financial-planning correction — 18 October 2026

The owner confirmed no LakeLife-paid operating costs and removal of the previously assumed processing/rework reserves. The current business plan removes invented fixed costs, founder pay, setup allowance, and funding cushion. Unchanged illustrative rates and volumes now yield $33,768 in first-year surplus before tax. Crew payouts remain excluded from LakeLife income; resident rent remains park money. See `../FINANCIAL-MODEL-CORRECTION.md`. This supersedes earlier financial projections, not the pricing, security, payment-readiness, or claim boundaries in this audit.
