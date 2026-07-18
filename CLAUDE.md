# LakeLife — Project Brief for Claude Code

## What this is
LakeLife is a coordination & scheduling platform for lake-home services
(seasonal opening/closing, pier & boat-lift install/removal, boat & toy
winterization/storage, weekly mow-and-blow, housekeeping) on Big Long,
Pretty, and Big Turkey Lakes in Indiana. Three roles: homeowner, vendor,
ops (admin). Customers see ONE all-in price; vendor cost + LakeLife's 30%
margin exist only on the ops side.

## Source of truth
- `lakelife.html` — the interactive prototype. Every screen, flow, copy
  tone, and visual convention (colors, type, wave motif) comes from here.
  Match it closely; do not redesign.
- `lakelife-beta-launch-plan.md` — data schema (§5), stack (§4),
  notification triggers, router logic, and constraints. Build to it.

## Stack (do not substitute without asking)
Next.js (App Router) + Tailwind on Vercel · Supabase (Postgres, Auth,
Storage, Edge Functions) · Twilio Verify + Messaging · Resend email ·
Google Maps JS SDK + Directions API · PWA (installable, camera access).

## Non-negotiable rules
1. Vendors NEVER see customer prices or margin. Enforce at the API/RLS
   level, not just the UI.
2. A job cannot reach status `complete` — and payout cannot release —
   without >= the service's minimum photo count uploaded. Server-enforced.
3. Gate/door codes: encrypted at rest; visible to a vendor only on the
   day of that vendor's scheduled job at that property.
4. Card data never touches our database. Hosted-fields tokenization only.
   Until processor keys exist, build against a mock payment interface
   with the same shape as `window.LakeLifePayments.tokenize()`.
5. Every account requires a working email AND an SMS-verified mobile
   before first booking.
6. Vendor flags (profile corrections) change nothing and bill nothing
   until the homeowner approves. Approval updates the profile and
   reprices atomically.
7. Water-work scheduling respects per-lake ice-out and pull-deadline
   dates (pull deadline = est. hard freeze minus 8 days).
8. All pricing rules live in the database (services table), not in code.
   Pricing models: flat, per_section (pier), per_foot (boats),
   band (lawn), sqft_band (housekeeping).

## Ways of working
- Work in small phases; after each phase, give me a plain-English summary
  of what changed and how to test it in the browser.
- Write tests for pricing math, the photo gate, and role access.
- Commit after every working milestone with clear messages.
- I am the product owner, not a developer. Explain tradeoffs simply and
  ask before adding anything not in the spec.
