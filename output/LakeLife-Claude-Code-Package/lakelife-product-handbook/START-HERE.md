# Current integration entry point

Read [START-HERE-CLAUDE.md](../START-HERE-CLAUDE.md) first. It is the complete current integration task brief. The material below records the earlier handbook handoff; its preservation rules remain relevant.

---

# LakeLife product design handoff

This package contains a 56-page design/behavior handbook (55 original pages plus the approved-artwork appendix), a searchable Markdown version, a clickable UI reference, structured tokens and screen contracts, the actual route inventory, Mermaid flows, and an acceptance checklist. Prepared 17 October 2026 from repository snapshot `fe9e145`.

## Read in this order
0. `NO-REGRESSION-CONTRACT.md`, `CLAIMS-AUDIT.md` and `claims-register.csv`. Current behavior and later decisions override stale prose.
1. Repository `AGENTS.md` and `CLAUDE.md`.
2. `lakelife.html` for original visual intent, and `lakelife-beta-launch-plan.md` for core constraints.
3. `brand-assets/index.html` and `ASSET-HANDOFF.md` for the original logo, illustrations, waves and emoji vocabulary; then `LakeLife-Product-Design-Handbook.md` and the current source files it names.
4. Open `reference/index.html` in a browser. Choose a screen, toggle its states and compare desktop/phone widths. The example dialog and service journey are interactive.
5. Use `acceptance-checklist.csv` during implementation; record actual outcomes and evidence.

## What is authoritative
Current product-owner instructions and non-negotiable rules govern. The original prototype governs visual identity; current code and migrations govern the implemented routes and guards. Record a conflict instead of silently erasing a current improvement or weakening an invariant. This package is a reference, not another runtime theme or schema.

## Important observed gap
`approveFlag` in `src/app/approvals/actions.ts` commits the profile/approved flag through `apply_flag_change` before repricing jobs separately. Its retry path acknowledges partial progress. The broader atomic profile-and-repricing rule in AGENTS.md is therefore not established by that implementation. The handbook records the gap for a separately authorized backend task and failure/concurrency tests. No application fix was performed in this documentation task.

## Files
- `brand-assets/index.html`: visible logo/illustration/emoji library with downloadable files and original marketing examples.
- `ASSET-HANDOFF.md`: implementation rules for carrying the brand artwork into the product.
- `brand-asset-manifest.json` / `emoji-map.json`: exact artwork mapping, background colors, hashes, Unicode and source references.
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
- `assets/`: full-logo SVG/PNG exports, original mark/waves, all eight service illustrations in SVG/PNG, and bundled webfonts. Keep relative paths intact.

## Scope and limitations
This is a source review and documentation package. Reference screens are design compositions, not captures of authenticated production pages. Dollar amounts, names, counts and dates are synthetic. No live payment, deployment, customer message or production access test was performed. The current app still owns all authorization, state transitions and real prices.

## Builder prompt

Use `CLAUDE-CODE-PROMPT.md` together with the exact implementation task you authorize. It begins with an audit and explicitly protects current behavior; this handbook does not assign extra backend or feature work.

## Audited revision
The audited copy corrects pricing promises and replaces old 30% economics. It preserves original artwork and does not change the app. Read `HANDOFF-CHECKS.md` for verification and limitations.

## Approved artwork update — 18 October 2026

Read `APPROVED-ARTWORK.md`. The approved mobile-home and RV illustrations, combined park-audience SVG, PNG exports and seasonal aluminum-pier scene are now included in the asset library. Current local materials use those images consistently. Product behavior and audited claims are unchanged.
