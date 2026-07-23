# ToS v2 adoption — app-side implementation checklist

The counsel draft (docs/user-agreement-counsel-draft-v2.txt) was audited
against the production system on 2026-07-23. Every operational mechanic in
it matches the machine as built (acceptance flow, all-in pricing, charge on
photo-verified completion, offer-only price changes, autopilot confirm-
per-visit, credits-as-rebates, monthly/early payouts, cancellation windows
shown before confirm, day-of gate codes, crew-side bailment, per-diem,
posted-price claims, doc-lapse auto-pause, single-level referrals,
email-only marketing). Three commitments in the draft are ahead of the
code and must ship WITH the version bump when the attorney returns final
text:

1. **Acceptance UX (§1 + memo).** Add an affirmative CHECKBOX to the agree
   modal (today: scroll + one Agree button), and render the arbitration /
   class-waiver / automatic-charge acknowledgment (§25) immediately above
   the acceptance control.

2. **Acceptance evidence ledger (memo "Clickwrap implementation").** New
   append-only `tos_acceptances` table: user id, version id, SHA-256 hash
   of the rendered text, timestamp, checkbox state, IP + user-agent.
   Today we store only users.tos_version + tos_accepted_at — keep those as
   the fast gate, add the ledger as the evidence record. One migration +
   ensureTos/tos-actions update.

3. **COI limits capture (§11.3).** The draft specifies insurance minimums
   ($1M/$2M CGL, $1M auto, statutory WC + $500K EL, custody coverage ≥
   max property value in custody). Today the platform checks presence +
   expiry only. Add limit fields to the COI upload form (crew attests,
   ops spot-checks) — enforcement stays facial review per §11.4, but the
   attested numbers should be on file.

Noted, no action needed now:
- §7.6 reserves/offsets/negative balances — rights reserved in contract;
  machinery lands with the real processor integration.
- §10.3 storage customer warranties — consider a lienholder/personal-
  property checkbox in the storage wizard if counsel wants it evidenced.
- §13 reward reversal for abuse — void state exists on earnings; tooling
  when needed.
- §20 service-specific disclosures — attorney will say which categories
  (home improvement, marine, pesticide) need booking-flow disclosures.
- STOP/HELP SMS keywords — handled at the Twilio carrier level.

Placeholders the owner fills before adoption: [COUNTY], [STREET ADDRESS],
[CITY/ZIP], [SUPPORT EMAIL], [LEGAL EMAIL], [PHONE], processor name,
operating states, storage custody value limits.
