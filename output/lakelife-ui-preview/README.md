# LakeLife — local UI preview

Prepared 17 October 2026. Review baseline: `0bd00db`.

A working visual preview of the updated hero, public mini-site, park-owner marketing landing page and audience portals. All names, amounts, dates and records are examples. The real platform has not been edited.

## Open the preview

Open **`LakeLife-UI-Preview.html`** in a browser. Everything is embedded in this single file, including the original fonts and illustrations. No installation, server or account is needed.

The editable source is also available in `dist/`. Its `index.html` works offline if that folder stays together.

Use the **Preview screen** selector at the top to move between:

1. Hero / homepage
2. Marketing landing page
3. GP / public entry
4. Park-owner portal
5. Renter portal
6. Homeowner portal
7. Services, For park owners, How it works and Get started

**GP is provisionally interpreted as “general public.”** It is a public entry page, not a new account role. If GP means a service provider or general partner, that audience still needs a separate design decision.

The selector belongs to the review environment. It must not become a production role switcher or replace account permissions.

## A five-minute walkthrough

- Start on the homepage. Follow the service and park-owner routes. Open the FAQs and the walkthrough form. The form produces an on-screen draft and sends nothing.
- Choose **Marketing landing page** to see the park-owner recruitment story and its supporting mini-site.
- Choose **Park-owner portal**. Search the rent roll and filter for balances or payment reports. Explore the six existing navigation groups and their secondary pages.
- Review the example $100 payment report and choose **Confirm example receipt**. The park's outstanding balance changes from $640 to $540.
- Choose **Renter portal**. Alex's bill now shows $315 instead of $415. Report another example payment: the balance stays unchanged until the office confirms it.
- Choose **Homeowner portal**. Review or skip the seasonal suggestion. Create an example service request and see “Price pending” and “Date not confirmed” together.
- Try a narrow browser window. Portal navigation moves to the bottom, public navigation collapses behind Menu, and wide rent tables scroll inside their frame.
- Use **Reset demo** or refresh the page to restore all initial records. Nothing persists.

## What is included

- 31 connected local views, with six principal design screens.
- Original LakeLife logo, wave motifs, service illustrations and font files.
- Separate RV and mobile-home illustrations in the existing LakeLife colors and wave style. See `renter-icon-preview.png` for the RV and `mobile-home-icon-preview.png` for the mobile home. General park-owner and renter placements now show both together using `park-homes.svg`. Use a single housing illustration only when the actual housing type is known. Lake homeowners keep the original house illustration.
- One generated illustrative lake scene, revised to show a seasonal aluminum pier and warm sunlight; it is not a photograph of a real customer or completed job.
- `approved-artwork.png` shows the current illustration family. Earlier browser screenshots have been removed from the active handoff because they contained superseded artwork; they remain recoverable in local Git history. Open the HTML preview for the current pages.
- `CLAUDE-HANDOFF.md`: implementation boundaries, route mapping and what must remain intact.
- `ASSET-PROVENANCE.md`: original artwork verification and the exact scene prompt.
- `qa-results.json`: earlier baseline of 271 passed local browser checks across 1440, 768, 390 and 320 px widths.
- `verification/browser-checks.cjs`: the browser verification script.
- `offline-check.json`: earlier single-file verification with loaded fonts, artwork, example receipt flow, no console errors and no external requests.

## Review boundaries

This is presentation code with in-memory sample state. It has no application imports, backend calls, credentials, analytics, storage, email delivery or payment integration. Network connections and form submissions are blocked by its content policy. The walkthrough and message forms only prepare local drafts.

Some supporting pages are intentionally read-only examples or honest empty states. They are not instructions to remove the existing importer, documents, statements, payment entry, account controls or other working features. The correction review intentionally stops before approval because this design task must not conceal or repair the earlier audited profile/repricing gap.

The browser checks cover the preview only; they do not establish production security, payment readiness, accessibility conformance or deployed feature availability. Chromium was used for the completed checks. Safari and other browsers were not separately tested.

No upload, publication, push, merge or deployment was performed. The temporary localhost review server is not needed to open the final files.

## Artwork refresh — 18 October 2026

The approved mobile home and RV now appear together across general park and resident views, including the public audience cards, portal entry, park marketing, park snapshot and renter greeting. The original homeowner and service images retain their meanings. No application behavior or product promises changed.

Current verification is recorded in `artwork-refresh-checks.json`. Browser access to the local file URL was unavailable for this revision; prior browser passes are historical, and the new layout has not been recaptured in a browser. Refresh the existing preview tab to review it.
