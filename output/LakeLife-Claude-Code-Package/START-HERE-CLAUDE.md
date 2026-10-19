# LakeLife — complete Claude Code integration handoff

Prepared for the product owner on **18 October 2026**. This is the main task brief for the accompanying `LakeLife-Claude-Code-Package` folder.

## 1. Your assignment

Integrate the approved LakeLife visual direction into the **existing LakeLife application**, locally and in small, reviewable phases. Improve the public homepage/hero, public entry, park-owner marketing landing experience and supporting mini-site, park-owner portal, renter portal, and homeowner portal. Keep the original LakeLife identity and the approved mobile-home, RV, and seasonal-pier imagery.

The owner wants simple, welcoming, easy-to-understand screens. Park owners lead the recruitment story; residents and lake homeowners must also understand where they belong and what to do next. Make the next step clear without making promises the platform cannot keep.

**Integrate with the platform that exists. Do not rebuild it from the preview.** Preserve working features, existing data, routes, security controls, pricing decisions, and payment architecture. The static preview supplies visual direction and examples; it is not production application logic.

This brief authorizes ordinary local UI integration, reuse of existing application actions, necessary presentation adapters, and relevant verification when the owner gives it to you as an implementation task. Do the intake in section 4, explain the approach briefly, then continue with work that is within that scope. Do not repeatedly ask permission for routine component, spacing, responsive, or data-binding choices. If the owner asks only for review, stay in review mode.

**Local work only:** do not upload, publish, push, merge, deploy, open a remote pull request, enable live processors, send real customer messages, run real charges/refunds, or mutate production data. Use existing authorized local/test infrastructure. Make local commits at working milestones, following the repository's instructions and available permissions. A successful design review or test does not authorize release.

### What success looks like

- The six principal experiences look like the approved preview and use the exact approved artwork.
- Every retained destination and permitted action still works through the existing application contracts.
- Real data, pending states, failures, permissions, and less-common records remain understandable.
- No old pricing rule, deleted feature, invented promise, demo role switcher, or sample record enters production behavior.
- The owner receives a working local result, a simple browser review path, actual verification results, and a clear list of any remaining integration decisions.

## 2. Open this package correctly

All paths in this document are relative to **the folder containing this Markdown file**, unless explicitly labeled as application source paths. Keep the package folders together. The application repository may be elsewhere; locate it separately. This package is a reference bundle, not a replacement app or a new repository.

Do not overwrite the application's `CLAUDE.md`, `AGENTS.md`, configuration, database, or source tree with this folder. Do not copy the whole package into the web application's public directory: it contains internal planning and commercial information. Copy only approved runtime assets and implement the needed UI in the existing project structure.

Start with these files:

| Read/view | Purpose |
| --- | --- |
| [This complete handoff](START-HERE-CLAUDE.md) | Current task, integration discretion, boundaries, and acceptance criteria. |
| [No-regression contract](lakelife-product-handbook/NO-REGRESSION-CONTRACT.md) | Preserve the platform's decisions and protected behavior. |
| [Claims audit](lakelife-product-handbook/CLAIMS-AUDIT.md) and [claims register](lakelife-product-handbook/claims-register.csv) | Source-backed wording and known limits, recorded at the audit date. Revalidate affected claims against current source. |
| [Current visual preview](lakelife-ui-preview/LakeLife-UI-Preview.html) | The approved public, marketing, and portal design direction. Open locally using a supported tool. |
| [Preview source](lakelife-ui-preview/dist/index.html), `dist/styles.css`, `dist/public.js`, `dist/portals.js` | Inspect layout and composition; do not transplant the demo controller or fixtures. |
| [Approved artwork rules](lakelife-ui-preview/APPROVED-ARTWORK.md) and [artwork board](lakelife-ui-preview/approved-artwork.png) | Correct mobile-home/RV usage and current hero. |
| [Asset inventory](ASSET-INVENTORY.md) and [visual asset library](lakelife-product-handbook/brand-assets/index.html) | Exact reusable logo, illustrations, PNGs, fonts, and decorative assets. |
| [Product handbook Markdown](lakelife-product-handbook/LakeLife-Product-Design-Handbook.md) | Detailed design, components, system flows, and screen guidance. |
| [Product handbook PDF](pdf/LakeLife-Product-Design-Handbook.pdf) and [brand PDF](pdf/LakeLife-Brand-Guide.pdf) | Readable visual references; the approved-artwork appendices contain the latest audience image guidance. |

Then read the current application's own instructions, relevant source, migrations, helpers, and tests. Consult the remaining PDFs as needed for audience and messaging. You do not need to extract behavior from a PDF when the current source and supplied text already establish it.

### Existing documents that need context

Some enclosed handoff notes say “design review only” or ask the builder to stop after a comparison. Those describe the earlier artifact-creation task. **For an owner-assigned integration task, use the scope in section 1 of this master brief.** Their security, money, evidence, and truthfulness constraints still apply. This does not expand scope into unrelated backend repairs or new products.

The older handbook reference screenshots are useful for states and components, but the newer `lakelife-ui-preview/` and approved-artwork files govern the current visual composition. Do not restore rejected images from an older screenshot. Historical verification counts and commit IDs are provenance, not a command to reset the checkout or proof that today's code is tested.

## 3. Resolve sources without regressing the product

Use the latest explicit owner instructions for scope and product decisions. For implemented behavior, reconcile the **current** code, migrations, tests, and recorded later owner decisions. Preserve repository instructions and the required security, evidence, and money boundaries. If current code violates an invariant, identify the defect with evidence; do not silently treat the defect as intended behavior.

For visual identity, retain the original `lakelife.html` logo, waves, fonts, palette, and illustration language, together with the owner's later approved image and UI refinements in this package. Prototype prices, sample states, role switching, and old automation wording are not behavior to restore.

The PDFs, social graphics, business plan, market study, forecasts, and mockups explain the intended story. They are not migrations, seed data, fee settings, service-capacity guarantees, or evidence of live integration. A feature can exist in code while remaining unavailable in the deployed environment.

### Specific historical conflicts already identified

1. **Universal 30% margin:** older `AGENTS.md`, `CLAUDE.md`, and planning prose mention 30%. The recorded later crew-pricing decision (`ad26455`, migration 0174, and audited implementation) superseded that universal rule for crew-priced work. Menu-priced, negotiated park, and crew-priced paths coexist. Recheck current helpers; do not restore a universal margin or remove valid menu-path protections.
2. **Profile approval atomicity:** the earlier audit found `approveFlag` in `src/app/approvals/actions.ts` applying the profile/flag change through `apply_flag_change` before a separate repricing operation. The broad atomic profile-plus-price guarantee was not established. Recheck whether the current application has since repaired this. Preserve authorized approval and existing protections; do not claim atomicity without evidence, remove the working approval action, or undertake an unrequested backend repair as styling work.
3. **Business-plan operating costs:** on 18 October 2026 the owner confirmed $0 LakeLife-paid operating costs and removal of the invented fixed costs, setup allowance, processing reserve, and rework reserve. The corrected illustrative first-year model shows $33,768 before tax. Read [the financial-model correction](FINANCIAL-MODEL-CORRECTION.md); do not restore those expense assumptions from historical reports. Sales volumes and fee rates remain illustrative and must not become runtime defaults. Crew payouts are still excluded from LakeLife income.

Historical snapshots in the supporting documents include `fe9e145` and `0bd00db`; the approved-artwork rollout was recorded at `3d082d6`. These are reference points only. **Never reset the application to one of them to match a mockup.**

## 4. Intake: reconcile the materials with the actual application

“Intake” here first means understanding and safely integrating this design package. Public lead/contact intake is addressed separately in section 10.

Before editing application code:

1. Locate the actual application and this package. Record the application branch, starting commit, and dirty files. Preserve the owner's uncommitted work. Follow applicable repository instructions; do not reset or clean the checkout.
2. Inventory the supplied files and any additional PDFs the owner attaches. Note their dates and authority. Newer PDF formatting alone is not approval for a product behavior change. Identify contradictions explicitly.
3. Inspect the current homepage, public router, park navigation, resident and owner components, shared brand components, styles, and relevant server actions. Read the associated status types, loaders, pricing helpers, payment capabilities, and scoped authorization checks.
4. Trace each visible action from UI to handler and backend result. Identify which preview actions already exist, which are demonstration-only, and which need a product decision. Look beyond the visible primary screen for secondary routes and less-common records.
5. Discover actual build, lint, typecheck, and test commands from the repository. Use its package manager and lockfile. Check baseline failures before attributing them to this work. Do not invent script names or install a replacement framework.
6. Create a short integration record in the repo's established documentation location. Record: affected screen, existing route/component, existing data/action, visual change, preserved states, source evidence, test coverage, and any open decision. This record is your map, not a new runtime schema.
7. Summarize the safe first phase in plain English and proceed. Ask only when a decision changes product behavior, permissions, money, public promises, infrastructure, or a materially ambiguous new route. Continue independent work while that decision is pending.

If the application source is unavailable, perform the package intake and identify the exact missing repository access. Do not pretend the preview is the app or declare integration complete.

### Fixed, adaptable, and decision-dependent

| Preserve | You may adapt during local integration | Requires a specific product/technical decision |
| --- | --- | --- |
| Exact approved logo and illustration geometry; recognizable identity | Asset placement, responsive sizing, image delivery format derived from a retained master, safe crops for the hero | Replacing or redrawing identity artwork or introducing a new visual direction |
| Existing URLs, role routing, permissions, and working destinations | Shared components, navigation presentation, mapping a demo section onto the existing equivalent route | Removing/renaming routes, new access roles, a new campaign URL without an existing approved destination |
| Existing source of truth for data and actions | View models, formatting, grouping, loading/error states, existing action bindings | New database models, money writers, pricing rules, status machines, or external services |
| Brand clarity and accurate claims | Shorter labels, readable help text, truthful state-specific wording | New guarantees, commercial terms, features, service areas, or payment readiness claims |
| All retained functions and data states | Extra rows, additional detail panels, longer pages, links to existing secondary screens | Removing a function because the preview did not depict it |

Prefer the smallest compatible implementation. If the app has a newer correct component than the reference, carry the visual treatment into that component. Preserve the owner's latest product decisions. Do not force literal HTML structure, sample content, or screenshot dimensions onto real data.

## 5. Visual foundation and exact assets

LakeLife should feel simple, local, warm, and practical. Use clear headings, ordinary language, generous but purposeful spacing, restrained cards, and obvious actions. Avoid glossy effects, dense decoration, generic dashboards, or invented visual themes. Follow the approved preview rather than redesigning the brand again.

### Typography and colors

- Headings: **Bricolage Grotesque**. Body and interface: **Manrope**. Supplied WOFF2 files are in `lakelife-product-handbook/assets/`. Preserve intended weights and use the current app's font loading conventions.
- Ink `#0A2430`; deep blue `#0F3648`; teal `#137A8C`; teal dark `#0E5E6D`; sun `#E9B44C`; aqua `#BFE3E8`; wave `#7FB8C4`; mist `#F3F8F9`; line `#DCE9EC`; white `#FFFFFF`.
- The latest preview uses muted body text `#5B747F`. Older token snapshots contain `#5D7681`; use the newer accessible treatment where appropriate and check the actual rendered background/contrast. Do not assume every historical token combination is accessible.
- Reconcile changes into the existing canonical tokens. Do not import a second global theme or overwrite all application CSS with the preview stylesheet. Preserve operational success/warning/error semantics.

### Asset selection

All filenames below are under `lakelife-product-handbook/assets/` unless noted. The [asset inventory](ASSET-INVENTORY.md) links every master/export and records dimensions and hashes.

| Context | Use | Rules |
| --- | --- | --- |
| Main brand/header | `lakelife-logo.svg`; `lakelife-logo-on-ink.svg` where a backing is needed | Original sun/waves and wordmark. Keep the white/gold logo readable on ink. No retyped substitute. |
| Compact brand | `lakelife-mark.svg` | Use where the LakeLife name is otherwise clear; accessible naming still required. |
| General park owners and renters/residents | `park-homes.svg` | Approved mobile home **and** RV together. Do not imply all park residents use one dwelling type. |
| A known mobile-home context | `mobile-home.svg` | Long low home, shallow roof, skirting and steps; no wheels or hitch. |
| A known RV context | `rv.svg` | Approved trailer with wheels and hitch. |
| Lake homeowner or home care | `house.svg` | Original house art. Do not use this as the generic park-renter identity. |
| Service categories | `house.svg`, `snow.svg`, `pier.svg`, `lift.svg`, `boat.svg`, `toys.svg`, `mow.svg`, `clean.svg` | Preserve original service meanings and text labels. `clean.svg` means housekeeping, not renters. Artwork does not authorize a new service. |
| Hero/property illustration | `lake-morning.png` | Approved warm-sun scene with a removable seasonal aluminum pier. Preserve the simple shoreline and keep the pier visible when practical. |
| Decorative boundaries | `lakelife-waves.svg`, `lakelife-wave-divider.svg` | Use sparingly; do not interfere with controls, errors, or records. |

`lakelife-ui-preview/dist/assets/renter.svg` is a legacy byte-identical RV alias, **not** the generic resident icon. Prefer clearly named `rv.svg` for a known RV and `park-homes.svg` for a mixed or unknown park audience. Never infer dwelling type, account role, or permission from artwork. Do not add a new housing-type field just to choose an illustration.

SVG is preferred for web illustrations. Matching PNG exports are supplied where available. Preserve aspect ratios; use contain behavior for illustrations. Do not crop, recolor, stretch, redraw, or round-trip SVG masters through a tool that changes their geometry. If producing optimized raster formats, retain the original and verify the rendered result. Full-logo SVGs contain the original wordmark font; use the provided PNG where a renderer cannot handle that font. Do not silently substitute another typeface.

Use existing `Logo`, `TopBar`, and `Waves` in the application's `src/components/Brand.tsx` when present. Integrate assets into shared components instead of pasting a different logo implementation into each screen. Give the logo at least one sun diameter of clear space.

### Image honesty and emoji

The hero is a generated **illustrative** lake scene. It is not a photograph of a specific lake, customer property, completed service, or testimonial. Preserve its illustrative identification in context; never place it in job evidence, before/after results, or a customer gallery as a real photograph. The earlier fixed wooden-pier scene was rejected. Do not revive it from history.

Use the exact existing sequences and purposes in [emoji-map.json](lakelife-product-handbook/emoji-map.json). Keep text labels. Decorative emoji beside equivalent text should be hidden from assistive technology; icon-only actions need accessible names. A wave or celebration never proves payment, delivery, or completion. Do not replace the approved small illustrations with a generic icon pack.

## 6. Experience and route mapping

The preview has 31 **hash-based demonstration views**. These are not instructions to create 31 new production routes. The application source paths below were recorded in the previous audit; verify them against the current repository and follow renamed equivalents where appropriate.

| Experience | Existing application anchor | Integration requirement |
| --- | --- | --- |
| Public homepage/hero | `src/app/page.tsx` | Apply the approved hero, clear primary action, audience paths, service illustrations, and explanatory rhythm. Preserve actual sign-in, account, lake, booking, and availability paths. |
| GP/public entry | `src/app/portal/page.tsx` | **GP is provisionally general public**, not a new role. Preserve the server router, memberships, invite ordering, claims, and redirects. A pre-sign-in informational chooser is not authorization. |
| Park-owner marketing | `src/app/for-parks/page.tsx` | Lead with park-owner clarity and include resident benefits. Reuse the existing approved destination; the separate marketing preview is a composition variant, not automatic permission for a new URL. |
| Supporting mini-site | `/`, `/lakes`, `/lakes/[slug]`, `/book`, and current public pages | Connect service, park, process, FAQ, and next-step content through existing suitable routes/sections. Keep current lake pages and deep links. Flag genuinely missing destinations rather than creating duplicates silently. |
| Park Today | `src/app/park/today/page.tsx` | Task-first presentation using real records/statuses. Preserve the current default landing behavior unless the owner changes it. |
| Park Renters group | `/park`, `/park/onboard`, `/park/documents` | Keep rent roll, resident onboarding, occupancy/person records, and documents. Demo `#/park/renters` maps to existing `/park`. |
| Park Money group | `/park/rent`, `/park/costs`, `/park/statements` | Keep ledger sources, corrections, allocations, charges, statements, and exports. No sample totals become calculations. |
| Park On site group | `/park/visits`, `/park/services` | Preserve crew validation and separate park-purchased work from household optional services. |
| Park Lots & rates group | `/park/lots`, `/park/amenities` | Preserve inventory, actual rates, and reservation behavior. No fictional rates become defaults. |
| Park Setup group | `/park/setup`, `/park/import`, `/park/people` | Retain importer access after setup and all invitation/access controls. |
| Shared park controls | `ParkNav.tsx`, `TakePayment.tsx` in `src/components/` | Retain all six groups, secondary destinations, the Take a payment workflow, publication status, and notice holds. Use existing action contracts. |
| Renter portal | `src/app/parks/my/page.tsx`, `src/components/RenterHome.tsx` | Use real resident/tenancy scope and retain the full money/history state set in section 11. Use the mixed park-home/RV illustration by default. |
| Homeowner overview | `/book`; `OwnerHeader.tsx`, `OwnerNav.tsx`, `AutopilotCard.tsx` | Preserve booking entry, property switcher, account routing, and explicit seasonal book/skip decision. |
| Homeowner details | `/requests`, `/approvals`, `/messages`, `/profile`, `/billing` | Keep current detail actions, agreements, contact preferences, `/book/crew`, and `/book/storage`, including flows not fully drawn in the preview. |
| Walkthrough/contact | Inspect current app; preview form has no endpoint | Use section 10. Never claim a demo draft was submitted. |

If GP is later clarified to mean a different audience, record that decision before building a new role-specific experience. The current public interpretation is enough to proceed with the existing public entry and the other authorized work.

### Public and marketing pages

Use one obvious primary next step per section. Keep park-owner and resident language distinct, then link to relevant supporting detail. Use `LakeLife.ai` as the owner-supplied public website; do not invent an email, phone number, booking calendar, or response-time promise. “Ask for a LakeLife walkthrough” is an appropriate label only when its destination/action is correctly implemented or its draft status is explicit.

Preserve “Your LakeLife, Automated.” with truthful context: Seasonal Autopilot suggests a visit and the homeowner chooses whether to book or skip. Do not imply unattended bookings or payments. Do not invent testimonials, adoption counts, savings percentages, guaranteed availability, instant onboarding, trial terms, or universally fixed prices.

The mini-site must have useful content and working relevant destinations. It should not become a set of decorative buttons or a duplicate authenticated app. Avoid exposing internal business economics in public copy or downloadable assets.

### Portal presentation

Use concise greetings, prioritized next actions, readable records, and restrained art. Separate money summaries from unrelated service actions. Keep pending/blocked/error states visible. Do not hide important information to make a screenshot cleaner.

On desktop, use bounded content and coherent grouped navigation. On mobile, retain access to secondary pages and actions when navigation becomes compact. Long tables may scroll inside a labeled container; the whole page should not overflow horizontally. Use real-length names, multiple properties, multiple parks, empty records, and large balances to check layout.

## 7. Integration architecture: adapt the presentation, reuse the system

Keep the approved stack: **Next.js App Router + Tailwind; Supabase Postgres/Auth/Storage/Edge Functions; Twilio Verify/Messaging; Resend; Google Maps JS/Directions; installable PWA; Vercel as the existing deployment environment.** Do not substitute tools or deploy during this task.

Use current shared components and canonical tokens. Keep server components, loaders, server actions, and client boundaries appropriate to the existing application. Do not move privileged queries, secrets, or money calculations into client components for convenience. Do not send fields to the client that the role must never see and then merely hide them with CSS.

Build presentation adapters when the existing data shape differs from the mockup. Map current fields/statuses to truthful labels and layouts. Do not invent new statuses, parallel calculators, shadow storage, duplicate payment APIs, or a second source of truth. Preserve current rounding/currency/time-zone/date helpers. Do not turn null or unavailable values into zero, success, or confirmed dates.

The preview's `dist/app.js`, fictional records, in-memory receipt changes, reset button, role selector, hash router, and draft forms are demonstration code. Do not install them as the app's state or workflow layer. Its single-file content policy and embedded assets support offline review; do not paste that policy over the production app or weaken production security headers to match it.

For every real control, establish:

1. Who may see and invoke it, including direct server enforcement.
2. The existing action/endpoint and required scope/inputs.
3. Validation, prerequisites, and the difference between a request and a completed effect.
4. Loading, disabled, error, retry, empty, and success presentation, using actual results.
5. Duplicate-click/concurrent-update behavior where relevant, preserving existing idempotency.
6. Any audit trail, confirmation, consent, or capability gate that must remain.

An omitted preview action does not authorize removing a live one. An illustrated action does not prove a backend exists. Implement the safe visual portions around an unresolved integration, document the exact missing contract, and keep dependent controls truthful. Do not fill gaps with fake success.

## 8. Accessibility, responsive behavior, and performance

- Use semantic headings, links, buttons, tables, forms, and visible text labels. Give each screen a clear primary heading.
- Support keyboard operation, visible focus, sensible tab order, dialog focus management and return, and a keyboard-accessible menu. Respect reduced motion.
- Keep status meaning in text, not only color or an emoji. Make validation understandable and connected to its field. Expose changing status appropriately to assistive technology.
- Use useful alt text for informative images; use empty alt text for purely decorative images beside equivalent content. Never write alt text that presents the illustrative scene as a real customer property.
- Preserve touch-friendly controls, readable type, zoom, and sufficient contrast on actual backgrounds. Check logo contrast, hero text contrast, and disabled/selected/error states.
- Review at 320, 390, 768, and 1440 CSS pixels, plus long content and zoom. Do not treat those four widths as proof of every device/browser.
- Set image dimensions/aspect ratios to prevent layout shifts. Use the application's supported image/font pipeline. Prioritize the hero only where needed; lazy-load lower-page imagery. Keep SVG masters and avoid shipping embedded base64 copies of the entire reference package to every app route.
- Preserve PWA/camera and navigation behavior. Do not introduce a new dependency solely for a simple visual effect.

## 9. Preserve pricing, scheduling, and approval behavior

These are integration boundaries, not instructions to rewrite business logic.

- Menu-priced, negotiated park, and crew-priced work coexist. Use current eligibility and park-rate precedence helpers. A park is not automatically excluded from crew-priced work where that path is valid.
- For crew pricing, audited behavior uses the crew quote and configurable customer/crew fees frozen onto the job: customer total = round2(quote × (1 + customer fee)); crew payout = round2(quote × (1 − crew fee)); platform share = the difference between those rounded amounts. **Reuse existing helpers/tests rather than implementing these formulas in the UI.** Do not take sample percentages from the PDFs.
- Preserve accepted extras, agreed/negotiated prices, frozen fees, and current repricing exceptions. Do not reprice sold work using today's settings.
- Preserve menu-path margin floors, scarcity adjustments, and ranking where they apply. Do not introduce them into crew pricing where the later product decision removed them.
- A request may legitimately have `customer_price = null`. Show “Price pending,” not $0 or an invented estimate. Preserve price-before-charge protections; do not claim every service has its final price before a request can be submitted.
- Requested date, selected crew, and confirmed appointment are different states. Use actual scheduling results and existing time-zone/date rules.
- Seasonal Autopilot needs an explicit customer book/skip decision. No autonomous booking, quote acceptance, or payment.
- Preserve server-side per-lake ice-out and pull-deadline rules, including the existing hard-freeze-minus-eight-days rule where applicable.
- Pricing configuration remains in the existing authoritative database/settings and helpers. Preserve applicable flat, per-section, per-foot, lawn-band, and housekeeping-area-band models; do not hardcode a new price table.
- Proposed vendor corrections change nothing and bill nothing until authorized homeowner approval. Preserve the actual approval workflow and protections. Revalidate the previously documented atomicity gap before describing it; repairing it requires explicit backend scope and meaningful failure/concurrency verification.

## 10. Connect public intake honestly

The preview's walkthrough and message forms create **local drafts only**. They do not send a request, create a lead, reserve a service, or notify anyone. Do not mistake this for the production intake implementation.

If the application already has an approved contact/walkthrough/intake path, reuse it. Preserve its fields, validation, consent, retention, authorization, and delivery semantics. Adapt the presentation and map inputs to the existing server contract. Collect only what that workflow needs; a marketing enquiry does not need payment details or property access codes.

Keep the states accurate: draft, submitting, accepted/saved, queued for delivery, delivered, or failed must reflect actual supported results. Do not promise receipt or delivery merely because a client handler ran. Do not clear useful entered information on failure, and preserve existing duplicate-submission protection.

If no approved backend/destination exists, identify the specific missing choice: where requests should be stored, who receives them, and what consent/delivery contract applies. Do not invent a mailbox, add a CRM, create a new table or automation, or show “Request sent.” Complete the page and safe local form presentation; clearly label any local draft or unconnected state in the review and ask for the remaining product/infrastructure decision. Do not leave the whole UI project idle because this one endpoint is unresolved.

Booking, resident onboarding, park imports, and account verification already have their own intake workflows. Preserve and integrate with them. Do not collapse them into a generic marketing form or move a resident/park record into a new model just to simplify the screen.

## 11. Preserve money, identity, evidence, and delivery boundaries

### Money and payments

- Preserve Architecture A: park owners/crews receive money through their own receiving accounts. Do not introduce pooled rent, FBO balances, LakeLife-originated ACH files, or a second money writer.
- Keep park rent, LakeLife platform fees, and optional household service charges separate. The park office must not gain visibility into household optional-service prices.
- Reported/offline payment, confirmed receipt, processing, provisional ACH, settlement, return, refund, and uncertain outcome remain distinct. Preserve supporting evidence/notes, allocations, audit history, correction rules, concurrency controls, and idempotency.
- The preview's example payment adjustment and whole-dollar input limits are not production ledger logic, rounding rules, or payment limits.
- Preserve global readiness, receiving-account status, park switches, method-specific capability, and signed/deduplicated processor events. Do not flip flags, fake a receipt, or enable a processor because the page looks finished.
- Card data never enters the database. Retain hosted tokenization and the existing mock payment interface where live readiness is absent; the historical interface shape is `window.LakeLifePayments.tokenize()`. Reconcile the current implementation rather than adding a second interface.
- A completed job or payout-eligible status does not mean funds arrived. Labels must match actual evidence.

### Resident records that must remain accessible as currently permitted

Retain current and older unpaid bills; processing/provisional payments; bank returns; taken-back payments; allocations against cancelled bills; on-account funds and credits; payment-claim answers; deposits; agreements; and ended-tenancy history/access. Preserve all applicable states even if the preview shows only four example rows. Do not silently filter away difficult records to make the balance look cleaner.

### Identity and role access

- Existing account roles are owner/vendor/ops, with scoped park memberships and resident links. Preserve current role names in code even when customer-facing labels differ. Do not add a GP role.
- Preserve login/account routing, invitations, membership and claim checks, property/park switching, and existing deep links. No demo role selector or artwork becomes an access mechanism.
- Vendors see their own quote, applicable deduction, and net payout; never the customer's total or platform margin. Enforce this at API/RLS/data boundaries, not just rendering.
- Keep the working-email and SMS-verified-mobile requirement before first booking. Do not confuse this booking requirement with a new sign-in requirement for browsing public marketing pages.

### Evidence and access codes

- Server/database rules must still prevent job completion and payout release/eligibility without the required minimum service/package photos and applicable holds being satisfied.
- Preserve upload/error/retry behavior and actual evidence counts. An image placeholder or generated image never satisfies an evidence gate.
- Gate/door codes remain encrypted at rest and visible only to the assigned vendor on that vendor's permitted scheduled job day. Do not preload them into the client or show them in decorative examples.

### Notices and honest promises

Keep consent/preferences, notice holds, publication state, and actual delivery receipts visible where relevant. Saved, queued, provider-accepted, delivered, and failed are different outcomes. No guaranteed text, photo attachment delivery, response window, appointment, savings, crew capacity, or payout timeline may be invented.

Use the claims register as an audit aid, then check the current source for changed behavior. A code path alone does not establish live readiness or commercially available service. Narrow the wording or flag missing evidence when it is not established. Publishing new claims or enabling features is outside this local task.

## 12. Work in phases without unnecessary stops

### Phase A — intake and shared visual foundation

Record the starting state and integration map. Reconcile instructions and known conflicts. Bring in exact assets and use canonical tokens/brand components. Verify the shared header, a service card, the park audience pair, font loading, and focus/contrast before widespread changes.

### Phase B — public and marketing experience

Integrate the hero, audience paths, park-owner story, and supporting mini-site content into existing destinations. Preserve authentication/routing and truthful CTA behavior. Connect existing intake where available; isolate any unresolved endpoint decision accurately.

### Phase C — park-owner portal

Restyle the existing shell and all six navigation groups. Preserve secondary screens, Take a payment, importer, statements, documents, permissions, notice holds, and publication status. Verify scoped data, calculations from existing helpers, and payment-report versus confirmed-receipt presentation.

### Phase D — renter and homeowner portals

Apply the approved layouts to current components. Exercise renter money/history states and ended-tenancy access; homeowner multiple-property routing, pending price/date, seasonal book/skip, approvals, messages, agreements, preferences, and all booking paths. Keep routes and non-preview functionality intact.

### Phase E — verification and local delivery

Run the relevant existing checks and review affected screens with real-shaped test data. Inspect the diff for unintended behavioral, configuration, schema, or dependency changes. Deliver a local reviewable result and accurate evidence. Commit working milestones as required by the repository; preserve unrelated user work and do not push.

After each working phase, briefly tell the owner what changed, how to view/test it in the browser, and any remaining limitation. Continue the next authorized phase unless a material decision blocks it. Do not make the owner approve routine implementation choices one at a time.

## 13. Verification matrix

Use the actual app's tests and existing local fixtures. Do not make real transactions or send real communications. Test protected behavior at the appropriate server/data boundary when affected; a hidden button is not an access test. Do not remove, skip, weaken, or rewrite assertions simply to match the mockup.

| Area | Required evidence for the affected scope |
| --- | --- |
| Build quality | Actual relevant lint/typecheck/build results using the repository's established tooling; distinguish baseline failures and environment blockers. |
| Brand/assets | Approved master files or verified derivatives, no broken references, correct pair/single-house meanings, original logo/fonts/waves. |
| Responsive/accessibility | Phone/tablet/desktop layouts; long content; keyboard and focus; dialogs/menu; labels and validation; contrast/zoom; no unintended page overflow. |
| Routes/navigation | Existing public/authenticated URLs, secondary destinations, account router, invites, role/park/property scope, back/deep-link behavior. |
| Pricing | Relevant existing menu, negotiated park, crew quote/frozen-fee, rounding, unpriced request, accepted-extra/agreed-price, and repricing tests still pass. |
| Photo/access gates | Existing minimum-photo/completion/payout gating and assigned-day encrypted-access tests still pass; direct bypass attempts remain blocked in the authorized test environment. |
| Role boundaries | Existing access/privacy tests, including vendor pricing privacy and household optional-service price isolation, still pass. |
| Payments/ledger | Applicable readiness/method gates, report-versus-receipt, provisional/processing/settled/returned/refunded states, allocation/correction, duplicate and concurrent action tests. |
| Resident history | Current/old bills, credits/on-account funds, cancelled-bill allocations, claims, deposits, agreements, ended tenancies; appropriate data remains accessible. |
| Scheduling/approvals | Pending versus confirmed states, seasonal customer decision, date helpers, approval protections and existing failure handling. |
| Intake/notices | Existing validation/consent, truthful draft/accepted/delivery/error presentation, hold states, failure/retry, duplicate protection. |
| Diff/scope | No unrelated rewrite, data migration, feature removal, processor activation, secret exposure, deployment, upload, push, or merge. |

Keep required existing pricing, photo-gate, and role-access coverage. Add meaningful tests for new adapters or changed boundaries where the existing suite does not cover them. Avoid tests that only repeat CSS implementation details. If a test cannot run, report the exact reason and what remains unverified. Never label an unrun end-to-end or live system check “passed.”

### What the packaged evidence already proves—and what it does not

- The audit documents an earlier local run of **27 files / 666 tests**. Those were unit/mocked/source-scan checks at a recorded snapshot, not a current integration test or live security/payment certification.
- The earlier UI preview records **271 browser assertions** across 31 views and four widths. Those predate the most recent artwork rollout and verify the synthetic preview only.
- The latest artwork rollout checked source references, asset hashes, SVGs, embedded resources, unchanged demo interaction code, PDF text/layout, slide text/layout, and archive integrity. It did not run a fresh browser layout pass because the review tool could not access the local file URL.
- Current artwork review images show the approved assets; older superseded UI captures were removed from the active preview handoff. The handbook's earlier reference screens remain labeled reference material.
- This package does not establish production deployment, live payment readiness, settlement, real notification delivery, service capacity, or completed app integration.

The enclosed preview verification scripts were written for their original repository and tooling context. Inspect their paths, dependencies, and baseline assumptions before using them. They are supporting evidence and examples, not a replacement for the current application's test suite or a requirement to recreate an old checkout.

Run new app-specific verification in your own supported environment. Respect tool permissions; do not bypass a denied browser surface. The previous environment limitation is a verification gap to address, not a product requirement or a ban on otherwise authorized local testing.

## 14. Required final delivery to the owner

Provide a short plain-English report with:

1. What is now implemented and where to open it locally, including a simple phone/desktop review path.
2. The significant files/components changed, with links where supported.
3. Which existing actions and intake paths are connected; any remaining drafts or unavailable integrations must be explicit.
4. Confirmation of retained routes, features, pricing paths, authorization, evidence gates, and money states, supported by actual checks rather than a blanket assurance.
5. Actual test commands/results, manual/browser review results, and any unrun checks or known baseline failures.
6. Any product decision or separately scoped backend work still needed, with the exact reason and effect on the UI. Revalidate historical gaps before reporting them as current.
7. Local commit identifiers where available and confirmation that nothing was uploaded, pushed, merged, published, or deployed.

Do not say “complete” while real actions are still simulated or important states have been dropped. It is acceptable to finish the authorized visual work and clearly report a narrowly blocked integration; it is not acceptable to conceal the gap with success copy.

## 15. Package map and PDF intake

```text
LakeLife-Claude-Code-Package/
  START-HERE-CLAUDE.md               Complete integration task brief (this file)
  README.md                         Short instructions for the product owner
  ASSET-INVENTORY.md                 Direct image/font links, dimensions, hashes
  PACKAGE-MANIFEST.json              File inventory and checksums
  PACKAGE-VERIFICATION.json          Verification of this delivery package
  MATERIALS-UPDATE.md                Previous artwork-rollout notes
  ARTWORK-REFRESH-CHECKS.json         Previous source/artifact checks
  FINANCIAL-MODEL-CORRECTION.md       Owner-confirmed zero-operating-cost model
  FINANCIAL-MODEL-CHECKS.json         Corrected arithmetic and document checks
  lakelife-ui-preview/               Current offline preview, editable demo source, images
  lakelife-product-handbook/         Detailed MD/HTML, asset library, contracts, claims audit
  lakelife-brand-guide/              Brand guide HTML and supporting assets
  lakelife-launch-kit/               Audience, business, marketing, social sources and graphics
  pdf/                              Nine existing PDFs listed below
  presentations/                    Editable three-slide recruitment PowerPoint
```

| PDF | How to use it |
| --- | --- |
| [Product Design Handbook](pdf/LakeLife-Product-Design-Handbook.pdf) | Detailed visual/system reference; 56 pages including current artwork appendix. |
| [Brand Guide](pdf/LakeLife-Brand-Guide.pdf) | Brand identity and voice; 13 pages including current artwork appendix. |
| [Recruitment Pitch](pdf/LakeLife-Recruitment-Pitch.pdf) | Three-page public recruitment story; do not invent stronger claims. |
| [Park Owner Guide](pdf/LakeLife-Park-Owner-Guide.pdf) | Park-owner messaging and benefits; 7 pages. |
| [Renter Welcome Guide](pdf/LakeLife-Renter-Welcome-Guide.pdf) | Resident-facing explanations; 3 pages. |
| [Business Plan](pdf/LakeLife-Business-Plan.pdf) | Internal assumptions and economics; 10 pages. Never publish wholesale or seed prices from it. |
| [Audience and Market Study](pdf/LakeLife-Audience-and-Market-Study.pdf) | Internal audience/research context; 8 pages. Research date and sources matter. |
| [90-Day Marketing Rollout](pdf/LakeLife-90-Day-Marketing-Rollout.pdf) | Draft campaign plan; 8 pages. Not authorization to launch campaigns. |
| [Social Media Playbook](pdf/LakeLife-Social-Media-Playbook.pdf) | Draft voice/content/artwork guidance; 12 pages. Not authorization to post. |

The owner may attach additional or revised PDFs. Inventory them, identify meaningful changes, and reconcile them with this brief and current source before applying them. Do not let an attachment silently erase working functionality, restore a superseded promise, or override an explicit newer owner decision. If it changes only visual details within the agreed brand, integrate it with normal implementation judgment. If it changes product behavior, call out the exact difference and resolve that decision while continuing unaffected work.

**Begin with the current repository intake, then implement the approved local UI in safe phases. Keep LakeLife recognizable, straightforward, and faithful to what the platform can actually do.**
