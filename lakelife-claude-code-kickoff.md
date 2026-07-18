# LakeLife × Claude Code — Kickoff Kit

This is your operator's manual for driving the real build. Three parts: **(1)** one-time setup, **(2)** the `CLAUDE.md` project brief you'll save into the repo (Claude Code reads it automatically on every session), and **(3)** the phase-by-phase prompts you paste in, in order. You steer and approve; Claude Code writes the code.

---

## Part 1 — One-time setup (about an hour, mostly account signups)

**Install Claude Code.** Easiest path: Claude Desktop app → Code tab. (Terminal version works the same if you prefer.)

**Create the project folder** and put both handoff files in it:

```
lakelife/
├── lakelife.html                  ← the prototype (front-end spec)
├── lakelife-beta-launch-plan.md   ← the build spec
└── CLAUDE.md                      ← Part 2 of this doc, saved as its own file
```

**Create these accounts before the first prompt** (Claude Code will wire them in, but only you can sign up and grab keys):

| Account | What to grab | Used for |
|---|---|---|
| GitHub | repo access | Version control — every change tracked, nothing lost |
| Supabase (free tier) | Project URL, anon key, service-role key | Database, logins, photo storage |
| Vercel (free tier) | Connect it to the GitHub repo | Hosting — push code, site updates |
| Twilio | Account SID, auth token, a phone number, a Verify service | SMS codes + service texts |
| Resend (free tier) | API key | Receipts + welcome emails |
| Google Cloud | Maps JavaScript + Directions API key | Real maps + drive times |
| Domain registrar | e.g. `golakelife.com` | Your link |

Put every key in a `.env.local` file (Claude Code will create the template and add it to `.gitignore` so secrets never land in the repo). **Never paste the Supabase service-role key, Twilio auth token, or any payment secret key into a front-end file** — if you're unsure where a key goes, ask Claude Code before pasting.

Payment processor keys come later (Phase 6) — underwriting on your buddy's rails can run in parallel with Phases 1–5.

---

## Part 2 — `CLAUDE.md` (save this exact content as `CLAUDE.md` in the project root)

```markdown
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
```

---

## Part 3 — The build prompts (paste in order, one phase at a time)

Run a phase, click through what it built, then move on. Don't stack phases in one prompt — small bites keep quality high and let you catch drift early.

**Phase 1 — Scaffold + sign-in.**
> Read CLAUDE.md, lakelife.html, and lakelife-beta-launch-plan.md fully. Then scaffold the Next.js + Supabase project: repo structure, env template, Supabase schema from §5 of the plan (all tables, with row-level security enforcing the three roles), and the design system pulled from the prototype (colors, fonts, wave motif, cards, pills, buttons). Build sign-in: Apple, Google, and email signup; required email; Twilio Verify SMS code on the mobile number, matching the prototype's flow. Seed the three lakes with their ice-out/freeze dates. Tell me how to run it locally and what to click.

**Phase 2 — Property profiles + pricing engine.**
> Build the guided property wizard exactly as in the prototype: house → pier sections → waterfront photos → lifts → boats (dynamic add/remove, per-foot) → toys (dynamic) → lawn band, ending in the warm recap screen, which also sends as the welcome email via Resend. Build the pricing engine reading rules from the services table, with unit tests proving: pier = base + rate × sections, boat = rate × total feet, lawn/housekeeping bands. The Property Profile page shows contact-on-file, notification toggles, and the fact cards.

**Phase 3 — Booking + calendars.**
> Build the service grid with profile-driven prices and the booking modal: frequency options per service, availability calendar that greys out crew-at-capacity days (from vendor capacity + existing jobs) and blocks water work outside each lake's season window. Confirming creates a job in `requested` status and fires the booking-confirmed text + email. Build My Requests and the Billing page with invoice history against the mock payment interface.

**Phase 4 — Vendor portal.**
> Build the vendor side: today's route in drive order with per-stop Navigate (device-aware Apple/Google Maps links from the prototype), photo capture with the server-enforced minimum before Mark Complete, completion triggering the owner's "service complete + photos" text, the Flag Item flow feeding the homeowner's Messages & Approvals board (approve = atomic profile update + reprice; decline = notify), and the availability manager: workday toggles + tap-to-block slot grid.

**Phase 5 — Ops dashboard + nightly router.**
> Build ops: master calendar across lakes, per-vendor calendars, performance metrics (throughput vs. rated capacity, on-time %, time vs. estimate), revenue view (customer price / vendor cost / margin), lake conditions editor, and the vendor onboarding flow (invite link, COI + W-9 upload with expiry tracking — no valid COI, no routing). Then the 8pm router as a scheduled Edge Function per §5 of the plan: cluster by lake → shore segment → drive order via Google Directions → capacity caps → pier/lift pairing → write routes and text vendors the map link.

**Phase 6 — Real payments** (once processor keys are in hand).
> Replace the mock payment interface with [processor]'s hosted-fields SDK: card + ACH vaulting, autopay charge on job completion, receipt email, webhook handling with signature verification, card-updater, failed-payment retry + alert text. If split payouts are supported, wire vendor payout release to photo-verified completion; if not, build the weekly ACH payout report for me to run manually. Walk me through every step you need me to do in the processor dashboard.

**Phase 7 — Polish + deploy.**
> Make it a PWA (installable, offline-tolerant route view for crews, camera access), run an accessibility and mobile pass against the prototype's quality bar, add the remaining notification triggers from the plan (night-before reminder, seasonal freeze reminders, card-expiring), then deploy to Vercel on golakelife.com with separate staging and production environments. Give me a pre-beta smoke-test checklist covering one full journey per role.

---

## Part 4 — How to be a good product owner to an AI developer

Test in the browser after every phase — you clicking around for ten minutes catches more than any test suite. When something's off, describe it like you'd tell a contractor: "on my phone the pier calendar lets me pick a date past the pull deadline" beats "it's broken." Ask "why" freely — *explain like I'm a developer's client, not a developer* is a legitimate prompt. Before Phase 6 goes live, spend the ~$2–3K on an independent security review of auth + payments; tell the reviewer rules 1–5 in CLAUDE.md are the audit checklist. And commit + push at every milestone — GitHub is your undo button for the whole project.

Realistic pace at a few focused sessions per week: Phases 1–5 in 3–5 weeks, Phase 6 gated on underwriting, Phase 7 in a few days. That lands comfortably inside the late-September vendor-onboarding window from the launch plan.

First move: install Claude Code, make the folder, save `CLAUDE.md`, paste Phase 1. Welcome to the build. 🌊
