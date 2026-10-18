# LakeLife UI handoff — preserve the platform

**Design review only. Baseline `0bd00db`, 17 October 2026.**

The owner requested an improved public-facing hero, GP entry, park-owner, renter and homeowner portals, plus a park-owner marketing landing page and supporting mini-site. They explicitly prohibited uploading, pushing and merging. This package does not authorize a deployment, backend rewrite, new payment model or feature removal.

Read the enclosed `reference/NO-REGRESSION-CONTRACT.md` (also in `../lakelife-product-handbook/`) and the current `AGENTS.md` before any implementation. Reconcile this preview with the current application revision: do not reset the repository to the baseline recorded here.

## What this package changes

The proposal improves hierarchy, spacing, page rhythm, mobile navigation, next-step visibility and audience-specific language. Original logo geometry, waves, colors, fonts and service illustrations are retained. The approved homepage headline, “Your LakeLife, Automated.”, remains in context: Seasonal Autopilot suggests a visit and the customer chooses whether to book or skip.

The public experience has two entry stories: the broad lake-life homepage and the park-owner campaign landing page. Both lead to substantive service, park, process and walkthrough pages. No fake customer testimonials, adoption figures, savings percentages, uptime claims or trial offers appear.

All 31 preview routes are hash routes so the package opens offline. They are **not a new production route plan**. Preserve existing URLs and deep links unless the owner separately agrees to a route change.

## Existing application map

| Preview area | Existing source / route | Implementation instruction |
| --- | --- | --- |
| Hero / homepage | `src/app/page.tsx` | Retain current sign-in, account and role-aware controls. Apply the visual treatment without removing existing destinations or approved copy context. |
| GP / public entry | `src/app/portal/page.tsx` | GP currently means general public by assumption. The real `/portal` is a server-controlled router, not a role-picker page. Keep its membership checks, invite ordering, claims and redirects. A public chooser may only be an informational entry before sign-in. |
| Park-owner marketing | `src/app/for-parks/page.tsx` | Proposed campaign composition and wording. The separate marketing landing view is a design variant; agree its destination before adding a live route. |
| Services / process mini-site | `src/app/page.tsx`, `src/app/lakes/page.tsx`, `src/app/lakes/[slug]/page.tsx`, `src/app/book/page.tsx` | Public views are proposals. Preserve all existing lake, booking and availability paths. Verify actual services and capacity before publishing claims. |
| Park Today | `src/app/park/today/page.tsx` | Task-first view, using existing records and status meaning. Do not change the app's default landing behavior merely because the preview opens Today. |
| Renters group | `/park`, `/park/onboard`, `/park/documents` | Retain rent roll, “Who lives here” and documents. Preview `#/park/renters` maps to current `/park`, not a requested new URL. |
| Money group | `/park/rent`, `/park/costs`, `/park/statements` | Preserve ledger sources, charge allocation, statements, exports and corrections. Sample totals are not calculation code to adopt. |
| On site group | `/park/visits`, `/park/services` | Keep crew validation and park-purchased services distinct from household optional services. |
| Lots & rates group | `/park/lots`, `/park/amenities` | Preserve actual rate, reservation and inventory workflows. No sample rate is a default. |
| Park setup group | `/park/setup`, `/park/import`, `/park/people` | Retain importer access after initial setup and all existing invitation/access controls. |
| Park navigation | `src/components/ParkNav.tsx`, `src/components/TakePayment.tsx` | Keep all six groups and secondary destinations. Preserve the always-available “Take a payment” workflow, publication status and notice-hold banners. The preview shows the payment entry point but does not reproduce the actual payment recorder. |
| Renter portal | `src/app/parks/my/page.tsx`, `src/components/RenterHome.tsx` | Proposed information hierarchy, not replacement ledger logic. Keep tenant-specific authorization and all money states listed below. |
| Homeowner overview | `/book`, `src/components/OwnerHeader.tsx`, `src/components/OwnerNav.tsx`, `src/components/AutopilotCard.tsx` | The overview is a composition proposal. Preserve the booking entry, property switcher and existing account routing. Do not replace `/book` with a new backend model. |
| Homeowner detail views | `/requests`, `/approvals`, `/messages`, `/profile`, `/billing` | Keep actual request detail, messaging, approval, property and billing behavior. Preserve `/book/crew`, `/book/storage`, agreements and notification settings even though they are not fully illustrated here. |
| Walkthrough form | Local design only | No endpoint is connected. Use the real approved destination, consent and delivery behavior when authorized. Never relabel a local draft as a sent request. |

## Behaviors that cannot be inferred from this UI

- **Pricing remains authoritative in the current app/database.** Menu, negotiated park and crew-priced paths coexist. Crew-priced work uses frozen, configurable customer and crew fees. Do not restore the historic universal 30% margin or copy the demonstration arithmetic into production.
- **Unknown is not zero.** An unpriced request shows “Price pending.” An intended date stays requested until actual scheduling confirms it. The preview's $360 customer total, dates and all other values are fictional.
- **Seasonal suggestions require a customer decision.** No unattended booking, quote acceptance or charge. Lake ice-out and pull-deadline checks remain server-owned.
- **Park money remains separate.** Rent belongs to the park’s receiving account, not a pooled LakeLife balance. Platform fees and optional household service charges remain separate streams. The office must not gain access to household optional-service pricing.
- **Reported is not received.** The interactive example only changes an in-memory receipt after an explicit office review. In production retain required evidence/notes, allocation rules, idempotency, concurrency controls and ledger actions. Its bounded whole-dollar form is a demonstration constraint, not a new payment limit or rounding rule.
- **Payments remain gated.** Global readiness, receiving-account readiness, park switches, method-specific capability and signed/deduplicated events stay intact. No card data in the database. Do not activate a processor or substitute mock success because the visual design is ready.
- **Preserve all renter money states.** Current and older unpaid bills, provisional/processing payments, bank returns, taken-back payments, cancelled-bill allocations, on-account funds, credits, payment-claim answers, deposits, agreement records and ended-tenancy access must survive the redesign. The four-row example is not comprehensive coverage of those states.
- **Keep notification and hold states visible.** Consent, queued/failed/delivered distinctions, notice holds, contact preferences and actual delivery receipts remain authoritative. Preserve the existing hold banner across park screens. No same-day reply or guaranteed delivery claim is added.
- **Authorization stays on the server.** Existing account roles remain owner/vendor/ops, with park memberships and resident links. No new GP role. The review selector and fictional account initials must never become an authorization mechanism. Keep property switching and park scoping.
- **Crew boundaries remain unchanged.** This package does not redesign the crew portal. A crew sees its quote, fee deduction and net payout, never the customer total or platform margin. Preserve assigned-day access-code rules and encrypted storage.
- **Evidence still gates completion.** Required photos, holds, completion and payout eligibility use the current server/database checks. The generated scene is decorative and must never appear as job evidence.
- **Correction review stops short of a claim the app cannot keep.** Current profile update and repricing are separate operations. The preview deliberately offers review only. Do not remove the real approval action, invent an “atomic” guarantee, or fix this backend gap under a styling task. A backend repair needs its own authorized scope and failure/concurrency tests.

## Visual implementation notes

Use the existing Next.js App Router and Tailwind stack. The static files in `dist/` exist to make this review portable; do not replace the actual app with them or import their sample state.

- Heading font: Bricolage Grotesque. Body/UI font: Manrope. Preserve original font files and weights.
- Ink: `#0A2430`; deep blue: `#0F3648`; teal: `#137A8C`; teal dark: `#0E5E6D`; sun: `#E9B44C`; aqua: `#BFE3E8`; mist: `#F3F8F9`; line: `#DCE9EC`. Muted body text uses `#5B747F` to maintain at least 4.5:1 contrast against mist and white.
- Use the exact logo SVGs, not retyped text or redrawn marks. The included original service artwork remains unmodified.
- Use `assets/park-homes.svg` (the approved mobile home and RV together) for general park-owner and renter placements. Use `assets/mobile-home.svg` or `assets/rv.svg` alone only when the actual housing type is known. `renter.svg` is a legacy alias of the RV; do not use it as the default for all renters. Keep `house.svg` for lake homeowners and `clean.svg` for housekeeping. No illustration assigns a role, housing type or permission.
- Public layout: strong photograph-led hero, single clear primary action, warm audience pathways, service illustrations, explanatory sections and FAQs.
- Portal layout: concise greeting, next-action panel, separate money summary, readable records, restrained illustration. Never use decoration to obscure errors or pending states.
- Desktop: bounded content width, persistent grouped sidebar. Mobile: stacked sections, compact bottom navigation, secondary park page links and internally scrolling data tables.
- The prototype is not an accessibility certificate. Preserve visible focus, semantic controls, labeled fields, keyboard dialogs, text status labels and reduced-motion behavior; audit actual components with real data, zoom, assistive technology and longer names.

## Suggested implementation sequence, when authorized

1. Record the actual current revision and dirty files. Inventory retained routes, controls and relevant tests. Keep this task’s no-upload/no-push/no-merge restriction unless the owner changes it.
2. Bring over the visual tokens, verified original assets and public composition. Keep authentication entry points and all existing links working.
3. Restyle park components around their existing data and actions. Reuse the current navigation configuration, payment recorder and hold/status components.
4. Restyle renter and homeowner components. Exercise the non-happy-path money states, unpriced requests, expired/ended access and multiple-property routing before treating a screen as complete.
5. Run relevant existing tests for pricing, evidence gates, role access and any modified workflow. Do not weaken tests to match the preview. Add tests only for new behavior or a newly exposed boundary.
6. Review on phone and desktop with real-shaped data, record omissions or uncertain claims, and produce a local reviewable milestone. Deploy only under separate owner authorization.

## Earlier preview verification

31 routes × four widths: 1440, 768, 390 and 320 px. No outer horizontal overflow; one main heading per route. Tested search/filter, pending-versus-confirmed receipts, cross-view balance updates, skipped seasonal suggestions, unpriced/unconfirmed requests, household example separation, draft-only forms, escaped input, Escape/focus return, mobile navigation and offline loading. No runtime JavaScript errors or external network requests were observed. See `qa-results.json` for the 271 individual assertions.

This verifies the local presentation only. The application's tests were not rerun because no runtime source, schema, configuration, dependencies or existing product behavior changed.

## Current artwork verification

18 October 2026: native SVG validity, asset references, approved-file hashes, script syntax, embedded-image content and content-policy hash were checked. Public/portal HTML was checked without a browser. Browser access to the file URL is unavailable, so current responsive artwork placements need a browser review before implementation. The earlier 271 browser checks are not a claim that this artwork refresh was browser-tested.
