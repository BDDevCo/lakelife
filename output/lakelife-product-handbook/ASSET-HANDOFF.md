# Preserve the LakeLife visual identity

Start by opening `brand-assets/index.html`. Compare it with the two unchanged marketing examples included there. This visual library is part of the required design handoff.

## Reuse these assets
- Full logo: `assets/lakelife-logo.svg` and transparent PNG. It combines the original sun-and-wave mark with the existing Bricolage Grotesque 800 wordmark. Keep white Lake and gold Life on ink; `lakelife-logo-on-ink` includes a dark backing.
- In the app, keep `Logo`, `TopBar`, and `Waves` from `src/components/Brand.tsx` as the shared implementation. Do not paste a new version into each screen.
- Illustration family: house, snow, pier, lift, boat, toys, mow, clean. Every SVG preserves the original prototype geometry and colors. Use `brand-asset-manifest.json` for filenames, original art backgrounds and hashes. PNGs are 4x browser exports for non-SVG tools.
- Six illustrations were already used in the earlier brand pack; snow and toys complete the eight-item prototype family. Do not treat an illustration as authorization to add a new service.
- Waves: `lakelife-waves.svg` is the existing layered border; `lakelife-wave-divider.svg` is the prototype's small repeating separator.
- Emojis: `emoji-map.json` records exact Unicode sequences, source files and meanings. Use the existing service/category choices. Preserve the camera photo cue, location pin and occasional wave/celebration cue in appropriate copy.

## Apply it consistently
Use the full logo in the shared dark header; preserve the mark when space is constrained and the name is already present. Give the logo at least one sun diameter of clear space around its outer bounds. Reuse the soft service backgrounds and use object-fit: contain so the artwork is never cropped or stretched. Keep illustrations with their service label.

Carry the small artwork into service discovery, onboarding and relevant empty states. Use restrained wave decoration at major boundaries. Keep busy office tables, money states, alerts and operational actions readable. Do not introduce random emoji, generic icon packs, alternate wordmarks or AI-redrawn versions as replacements for these supplied assets.

Unicode emojis are not fixed vector artwork and may look different by operating system. Keep a text label; use aria-hidden for a decorative glyph beside equivalent text. If a new icon-only control is required, give it an accessible name and verify its keyboard/touch behavior. A celebratory glyph never overrides the actual completion/payment state.

## Export compatibility
The full-logo SVG embeds the existing webfont and remains editable text. Some design editors ignore embedded SVG webfonts; use the bundled PNG there, or install the supplied Bricolage font before editing. The original mark and all eight service SVGs use vector shapes and do not need fonts. Do not substitute a different font if an editor cannot load the logo.

## Handoff check
Compare the built app's header, a service card, an onboarding selection and a photo requirement with the visual board. Verify actual source-file hashes for unchanged assets. Check 390 px and desktop widths. This is a documentation correction; no application code changed.

## Approved artwork update — 18 October 2026

Read `APPROVED-ARTWORK.md`. The approved mobile-home and RV illustrations, combined park-audience SVG, PNG exports and seasonal aluminum-pier scene are now included in the asset library. Current local materials use those images consistently. Product behavior and audited claims are unchanged.
