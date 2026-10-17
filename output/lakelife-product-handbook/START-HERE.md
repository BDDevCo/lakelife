# LakeLife product design handoff

This package contains a 49-page design/behavior handbook, a searchable Markdown version, a clickable UI reference, structured tokens and screen contracts, the actual route inventory, Mermaid flows, and an acceptance checklist. Prepared 17 October 2026 from repository snapshot `dbca1fa`.

## Read in this order
1. Repository `AGENTS.md` and `CLAUDE.md`.
2. `lakelife.html` for original visual intent, and `lakelife-beta-launch-plan.md` for core constraints.
3. `LakeLife-Product-Design-Handbook.md` and the current source files it names.
4. Open `reference/index.html` in a browser. Choose a screen, toggle its states and compare desktop/phone widths. The example dialog and service journey are interactive.
5. Use `acceptance-checklist.csv` during implementation; record actual outcomes and evidence.

## What is authoritative
Current product-owner instructions and non-negotiable rules govern. The original prototype governs visual identity; current code and migrations govern the implemented routes and guards. Record a conflict instead of silently erasing a current improvement or weakening an invariant. This package is a reference, not another runtime theme or schema.

## Important observed gap
`approveFlag` in `src/app/approvals/actions.ts` commits the profile/approved flag through `apply_flag_change` before repricing jobs separately. Its retry path acknowledges partial progress. The broader atomic profile-and-repricing rule in AGENTS.md is therefore not established by that implementation. The handbook flags this for a dedicated repair and failure/concurrency tests. No application fix was performed in this documentation task.

## Files
- `LakeLife-Product-Design-Handbook.html`: editable print source. Letter, background graphics on, margins off.
- `LakeLife-Product-Design-Handbook.md`: searchable builder reference.
- `reference/index.html`: 10 synthetic screen compositions and 35 selectable state examples; no network writes or live actions.
- `reference/screens/`: rendered references plus the labeled original-prototype capture.
- `design-tokens.json` / `.css`: snapshots from globals.css; do not import as a competing app theme.
- `route-inventory.csv`: current page routes and source files, captured from the repository.
- `screen-contracts.json`: purpose, source, audience, states and forbidden data for each reference screen.
- `diagrams/*.mmd`: editable conceptual flows, including the current atomicity gap versus required outcome.
- `acceptance-checklist.csv`: 18 scenarios; not marked passed by this task.
- `CLAUDE-CODE-PROMPT.md`: ready-to-paste instruction for the builder.
- `assets/`: original mark/waves/service artwork and bundled webfonts. Keep relative paths intact.

## Scope and limitations
This is a source review and documentation package. Reference screens are design compositions, not captures of authenticated production pages. Dollar amounts, names, counts and dates are synthetic. No live payment, deployment, customer message or production access test was performed. The current app still owns all authorization, state transitions and real prices.

## Builder prompt
You are continuing the existing LakeLife app, not designing a replacement. Read AGENTS.md and CLAUDE.md, then lakelife.html, lakelife-beta-launch-plan.md, and this handoff's START-HERE.md and Product Design Handbook. Use the current repository for actual routes, components, schema and business rules. Preserve the original LakeLife palette, Bricolage Grotesque + Manrope, sun-and-wave mark, card/control language and approved stack.

Start by comparing the current screens and behavior with the handbook. Identify high-impact gaps with source references. Distinguish current behavior, required invariants and proposed refinements. Do not treat synthetic screen data as real prices or copy a prototype role switcher into production. Do not add every historical feature proposal.

Prioritize a small, reviewable phase: improve the selected role flow using existing shared tokens and components, with loading, empty, busy, blocked, failure and success states. Audit phone and desktop layouts and keyboard access. For the approval flow, inspect the documented gap: profile/flag updates currently commit before separate repricing; the project requires an atomic profile-and-price outcome. Do not report that invariant as satisfied until direct failure/concurrency tests prove it.

Keep customer price and margin out of crew data at the API/RLS boundary. Enforce required photos before completion and payout eligibility. Keep access codes encrypted and limited to the assigned vendor's valid scheduled day. Use hosted payment tokenization, real capability gates, explicit in-flight/settled/returned money states, and verified deduplicated provider events. Park access is membership-based; do not invent new account role values. A failed read must not render as zero or empty success.

After each working phase, provide a plain-English summary, exact browser review steps, phone/desktop evidence, actual relevant test results and remaining limitations. Commit the milestone. Ask before product scope or stack changes. Do not deploy, enable live payments, publish or send notices without the applicable authorization. Begin with the baseline comparison and a concrete first implementation phase.


## Artifact checks
See `HANDOFF-CHECKS.md` for documentation checks and their scope. The PDF is in the sibling `pdf/` folder. Open `index.html` for the visual handoff hub.
