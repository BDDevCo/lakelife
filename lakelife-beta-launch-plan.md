# LakeLife — From Prototype to Live Beta
**Working spec & launch plan** · Prepared for Brendon / BD DevCo · July 2026

Target: live closed beta for **fall winterization season (Oct–Nov 2026)** on Big Long, Pretty, and Big Turkey Lakes, with 10–15 known homeowners and 4–6 invited vendors. Full public launch: **spring openings 2027**.

---

## 1. What exists and what's missing

The prototype (lakelife.html) is a complete front-end specification: every screen, flow, pricing rule, and interaction for all three roles is defined and clickable. What it lacks is everything behind the glass — a database that remembers, user accounts that persist, a scheduler that actually runs nightly, payments that actually charge, and texts that actually send. The build job is therefore not "design an app"; it's "put a real engine behind a finished cockpit." That distinction cuts the timeline roughly in half, because the prototype *is* the spec a developer would otherwise spend weeks extracting from your head.

## 2. Business & legal setup (start this week — it has the longest lead times)

Stand up a dedicated entity for LakeLife (an LLC under your existing structure is fine) with its own EIN and bank account. The payment processor underwrites this entity, payouts land in this account, and vendor agreements and customer terms sit under it — keeping platform liability walled off from your development and lending entities.

Documents you need drafted before the first real customer:

**Customer Terms of Service & Privacy Policy.** Must cover: autopay authorization (card charged on service completion), the vendor-flag approval mechanic (customer approves changes before billing — this is your dispute shield), photo storage and use, gate/door code handling, and a liability framework making clear LakeLife coordinates services performed by insured independent vendors. Privacy policy is also a hard requirement for payment processor underwriting and for Apple/Google sign-in approval.

**Vendor Agreement.** Independent contractor status, insurance requirements (COI naming LakeLife as additional insured — no COI on file, no jobs routed), the rate sheet (their cost basis; customer pricing and your 30% are never disclosed to vendors), photo-required completion as a payment condition, payout timing, and non-circumvention (they don't take LakeLife customers direct).

**Insurance for LakeLife itself.** General liability plus, once the app handles scheduling and payments, cyber/E&O. Your commercial agent can quote this in a week; budget roughly $2–5K/year at beta scale.

## 3. Payment processor — the exact handshake

You give them: entity docs (formation, EIN), the LakeLife bank account, owner ID for KYC, expected volume (be honest: beta season maybe $50–100K), and a live URL with the ToS/privacy posted. You do **not** give them access to your systems.

They give you: a **publishable API key** (front end), a **secret API key** (backend only, stored as an environment variable, never in code), and a **webhook signing secret** so your app can verify "payment succeeded / failed / disputed" events actually came from them.

The integration point already exists in the prototype: `window.LakeLifePayments.tokenize()` gets replaced by their hosted-fields SDK. Card data flows browser → processor, you store only the vault token. That keeps you in **PCI SAQ-A**, the lightest compliance tier — a questionnaire, not an audit.

**The one make-or-break question for your buddy's rails:** does his platform support *marketplace split payments* (sub-merchant onboarding and automated payout splitting, the Stripe Connect / Adyen for Platforms model)? Customer pays $700 → vendor receives $490 → LakeLife keeps $210, automatically, triggered by photo-verified completion. If yes, wire it in. If no, you can still run beta — charge customers on his rails and pay vendors by weekly ACH batch from the LakeLife account — but know that manual payouts stop scaling around 15–20 vendors, and plan the migration. Do not let this question slide on friendship; get the answer in writing before the build starts.

Also required regardless of processor: **ACH/bank-debit support** for customers who prefer it (already in the prototype's payment modal), and **card-account-updater** so expired cards refresh automatically — autopay businesses live and die on this.

## 4. Technical build

**Recommended stack** (boring, proven, cheap, and any competent developer knows it):

| Layer | Choice | Why |
|---|---|---|
| Front end | Next.js (React) + Tailwind, deployed on Vercel | The prototype translates almost 1:1; Vercel is push-to-deploy |
| Backend & DB | Supabase (managed Postgres + Auth + Storage + Edge Functions) | Auth includes Apple/Google SSO out of the box; Storage handles job photos; daily backups + point-in-time recovery built in |
| SMS | Twilio (Verify for signup codes, Messaging for alerts) | ~1¢/text; the verification flow in the prototype maps directly to Twilio Verify |
| Email | Resend or Postmark | Receipts, welcome-recap email, seasonal reminders |
| Maps | Google Maps Platform (JS SDK + Directions API) | Replaces the Leaflet prototype layer; Directions gives real drive times to feed the router; free monthly credit covers beta scale |
| Payments | Your buddy's rails via hosted fields, per §3 | Token vault only |
| Distribution | PWA — installable web app, one link | No app stores for beta; crews "Add to Home Screen"; camera access works for photo capture |

**Delivery model:** one URL (e.g. `app.golakelife.com`), three roles behind login — homeowner, vendor, ops — exactly as the prototype's role switcher works today. You provide a link; nobody downloads anything.

**Sensitive-data rules for the developer:** gate/door codes encrypted at rest (Postgres `pgcrypto` or app-level encryption) and shown to vendors only on the day of a scheduled job; photos in private storage buckets with signed URLs; card data never touches your database (tokens only); role-based access so vendors see only their own routes and never see customer pricing.

## 5. Data schema (hand this to the developer as-is)

Core tables, with the relationships that matter:

| Table | Key fields | Notes |
|---|---|---|
| `users` | id, role (owner/vendor/ops), name, email (verified), phone (verified), auth_provider | SSO or email; both email + SMS verification required before booking |
| `properties` | id, owner_id, lake, address, lat/lng, sqft, beds, baths, gate_code (encrypted) | One owner can hold multiple properties |
| `property_profile` | property_id, pier_sections, ladder, bumpers, boat_lifts, canopy, toy_lifts, lawn_band | The pricing source of truth |
| `boats` | id, property_id, type, length_ft | Per-foot pricing: rate × length_ft |
| `toys` | id, property_id, name | Storage count feeds toy-prep pricing |
| `profile_photos` | id, property_id, url, uploaded_by | Owner-uploaded at signup + crew job photos |
| `services` | id, name, pricing_model (flat / per_section / per_foot / band / per_sqft_band), base, unit_rate, frequency_options | Pricing rules live in data, not code — you edit rates from Ops |
| `vendors` | id, user_id, company, service_types[], daily_capacity, coi_url, coi_expiry, w9_url, payout_token, status | No valid COI ⇒ router skips them |
| `vendor_availability` | vendor_id, date, slot, status (open/blocked/booked) | The tap-to-block grid |
| `jobs` | id, property_id, service_id, vendor_id, date, slot, status, customer_price, vendor_cost, margin, route_id, sequence | status: requested → scheduled → in_progress → complete → paid |
| `job_photos` | id, job_id, url, taken_at | ≥ min_photos (per-service setting) required before status can reach complete |
| `routes` | id, vendor_id, date, stops_order, drive_minutes, map_url | Rebuilt nightly at 8 pm |
| `flags` | id, job_id, vendor_id, type, note, proposed_change (json), status (pending/approved/declined) | Approval updates `property_profile` and reprices |
| `messages` | id, property_id, from, body, created_at | The dispatch message board |
| `invoices` / `payments` / `payouts` | amounts, processor refs, status | Payout releases on photo-verified completion |
| `lakes` | id, name, ice_out_actual, hard_freeze_est, pull_deadline | Pull deadline = freeze − 8 days; drives calendar blocking |
| `notification_prefs` | user_id, type, channel, enabled | Receipts locked always-on |

**The nightly router (v1 — don't over-engineer):** at 8 pm, for each vendor and next-day confirmed jobs: filter to open slots and valid COI → cluster by lake, then shore segment → order stops by drive direction (Google Directions for real times) → cap at daily capacity, overflow to next open day → pair pier + lift crews on shared addresses → write `routes`, text each vendor the map link. That's a few hundred lines of code, not machine learning. Save the fancy optimizer for year two.

**Notification triggers:** booking confirmed (text+email) · night-before service reminder (text) · crew en route, optional (text) · job complete with photo links (text+email) · vendor flag needs approval (text) · receipt on charge (email, always on) · card expiring / payment failed (email+text) · seasonal "book your fall pull before freeze" (email, per-lake dates).

## 6. Who builds it, and the beta timeline

Three viable paths: a freelance full-stack developer (~$15–30K for this scope, 6–8 weeks), a small agency (2–3×, slower, more polish), or **you driving Claude Code with the prototype + this document as the spec** — realistic for a working beta given the front end is already designed, with a developer on call for payment-integration review and a pre-launch security pass (worth every dollar of the ~$2–3K that review costs).

Week-by-week to an October beta:

| Weeks | Track |
|---|---|
| 1–2 | Entity + bank account; processor underwriting starts; ToS/privacy/vendor agreement drafted; domain + Twilio + Supabase accounts; confirm split-payment answer in writing |
| 2–5 | Core build: auth + verification, property profiles & wizard, pricing engine, booking calendar with lake/freeze blocking, vendor availability, ops dashboard |
| 5–7 | Router v1, photo-gated completion, notifications, payments end-to-end in processor test mode |
| 7–8 | Vendor onboarding (COI/W-9/payout), seed the three lakes' data, internal dry run — you play all three roles for a week and break things |
| 8–9 | Load your real vendors; each runs one practice job start-to-finish on a test property |
| Late Sept | Invite 10–15 homeowners personally; help each through signup on their phone (watch where they stumble — that's your UX punch list) |
| Oct–Nov | **Live beta: fall winterization season.** Every property needs pier out, lift out, boat stored, house winterized — a real deadline-driven workload that exercises every feature |
| Dec | Debrief: vendor throughput actuals vs. rated capacity, margin per service line, support-call themes; fix list for spring |

## 7. Beta success metrics (decide these now, not after)

Judge the beta on: **completion integrity** (100% of jobs closed with photos — the gate should make this automatic), **schedule reliability** (>90% of jobs done on the promised day), **payment cleanliness** (zero disputes; autopay failures caught and retried), **vendor honesty on availability** (blocked slots used, not no-shows), **router value** (drive time per job vs. how vendors routed themselves), and **the human signal** — do homeowners forward the "service complete" text with photos to their family? If that text gets shared, you have product-market fit on three lakes and a template for thirty.

## 8. Running costs at beta scale

| Item | Monthly ballpark |
|---|---|
| Vercel + Supabase | $45–75 |
| Twilio (verify + ~1,500 texts) | $20–40 |
| Email service | $10–20 |
| Google Maps | $0 (inside free credit) |
| Domain, misc | $5 |
| **Software total** | **~$80–140/mo** |
| Payment processing | ~2.9% + 30¢ per card charge (ACH far cheaper — nudge big-ticket winterization invoices toward ACH) |
| Insurance | ~$200–400/mo equivalent |

Software is a rounding error. The real costs are the developer (one-time), insurance, and processing — and processing is priced into your 30%.

## 9. Your personal punch list (the parts only you can do)

1. Form the LakeLife entity, open the bank account, start processor underwriting — this week.
2. Get the split-payments answer from your buddy in writing.
3. Engage your attorney on the three documents (§2).
4. Lock the real rate sheet: vendor cost per service per lake, customer price = cost ÷ 0.70. The prototype's numbers are placeholders — yours come from what DockRight, TrueNorth-equivalents, and your mow crews actually charge.
5. List your 10–15 beta homeowners and your 4–6 vendors; make the calls in September.
6. Choose the build path (§6) and hand over the prototype + this doc as the spec.

---
*Companion file: `lakelife.html` (interactive prototype — the front-end spec). Together these two files are the complete handoff package.*
