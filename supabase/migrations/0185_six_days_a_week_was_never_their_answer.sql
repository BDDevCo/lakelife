-- 0185_six_days_a_week_was_never_their_answer.sql
--
-- SIX DAYS A WEEK WAS NEVER THEIR ANSWER.
--
-- `vendors.work_days` has carried a default of Mon-Sat since 0010, and the
-- crew's onboarding wizard never asked the question. `isEligible` and
-- `canClaim` both gate on exactly this column -- `c.workDays.includes(weekday)`,
-- blocker 'off_day' -- so a crew who told us on the phone they don't work
-- Saturdays went live claiming six days a week, and a Saturday job routed to
-- them with nothing on either screen to explain it. A crew who DOES work
-- Sundays was invisible to every Sunday job for the same reason.
--
-- This is the seeded `daily_capacity` of 1 all over again (see the comment in
-- app/ops/crews-invite.ts): a value nobody chose SATISFYING the gate that
-- exists to ask for it. Same two rules, same fix. A default is what is TRUE on
-- day one, and on day one we do not know which days they work -- so the default
-- becomes the empty week, the wizard grows a step that asks, and
-- `activationGaps` refuses an empty one.

alter table public.vendors
  alter column work_days set default '{}'::text[];

-- AND A DAY THE ROUTER CANNOT MATCH IS NOT A DAY.
--
-- `isEligible` matches three-letter, Sunday-first abbreviations. Both code
-- doorways already whitelist against that vocabulary (`isWorkDay` in
-- app/vendor/availability/actions.ts, `cleanWorkDays` in lib/crew-setup.ts) --
-- this is the third, the one that still holds when a future action forgets or
-- somebody writes the column from the SQL editor. It is also what makes the
-- emptiness test in `activationGaps` sound: after this, an empty array is the
-- ONLY way to be un-routable, rather than one of several unmatchable spellings.
--
-- Verified before writing: all three rows in production hold subsets of this
-- list, so the constraint validates immediately and needs no NOT VALID.

alter table public.vendors
  add constraint vendors_work_days_known
  check (work_days <@ array['Sun','Mon','Tue','Wed','Thu','Fri','Sat']::text[]);

-- EXISTING ROWS ARE LEFT ALONE, ON PURPOSE. The only three `vendors` rows in
-- production are fixtures (users.is_fixture = true) and every one of them is
-- 'active'. Emptying their week would make every fixture crew unroutable and
-- break the demo paths that depend on them. No real crew exists yet; the first
-- one comes through the new wizard step.
--
-- NO GRANT CHANGE IS NEEDED. 0013 and 0017 granted `update (work_days)` to
-- `authenticated`; 0100 took every client write on `vendors` away and the three
-- writers are all service-role actions scoped by a session-derived vendor id.