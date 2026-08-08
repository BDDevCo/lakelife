# The AI safety fence — what a machine may say, and to whom

**Status:** design, final. Nothing built. Written 2026-08-08 after a
ground-truth read of the live comms path, two competing fence designs, and four
adversarial reviews (accommodation, fair housing, emergency/habitability,
tenancy/eviction) plus a false-positive volume study.

**Scope:** this document is the complete specification for `src/lib/comms-fence.ts`
and the structural changes around it. Section 2 is the literal content of the
rule table. Section 6 is the literal content of the test file. Nothing here has
been coded into the repo yet.

---

## 1. The problem, in one paragraph

Today, when a customer sends a message, LakeLife runs it past a list of twenty
words — *refund, money, angry, lawyer, sue, damage, cancel* and so on. If none
of those words appear, the message can be answered automatically by a machine,
signed "LakeLife dispatch," with no human ever seeing it. That list was written
when every customer was a lake homeowner asking about a pontoon. It contains no
housing vocabulary at all. So *"can I get a ramp? I use a wheelchair"* clears it
and is eligible for an automated reply — that is a disability-accommodation
request from a tenant, answered by software, with a timestamp on it. Meanwhile
the word *"free"* matches inside *"freeze"*, so *"will you winterize before the
freeze?"* is blocked as risky. The fence stops the safe traffic and passes the
dangerous traffic. Park renters are tenants, not customers; messages about
eviction, repairs, deposits, discrimination and accommodations carry legal
weight that a service business's word list was never built for. This document
replaces that list with a screen that knows the difference, and — more
importantly — with structure that does not depend on the word list being
complete.

**The single most important design fact:** the word list is the *weakest* layer
here, not the fence. The fence is (a) no park data ever reaches a model, (b) no
park screen may import an AI module, (c) no message from a tenant, a park owner
or a crew member may ever be answered unattended, and (d) every model call goes
through one door that refuses by default. The vocabulary reduces how often a
human has to read something they didn't need to. It is not what keeps a machine
out of a housing matter.

---

## 2. The final rule set

### 2.1 The five populations, and how a thread gets one

A thread is stamped **at creation, from the row that created it**. The message
body never votes — a body-derived population is trivially spoofable and wrong in
exactly the ambiguous cases.

| Creating row | Population |
|---|---|
| `properties.owner_id`, and the person has **no** `park_renters` or `lot_reservations` row | `lake_customer` |
| `park_members` | `park_owner` |
| `lot_reservations` + `park_renters`, term ≥ the park's threshold | `park_tenant` |
| `lot_reservations`, term < threshold | `rv_guest` |
| `vendors` | `crew` |
| anything else, including a person who is both a homeowner and a renter | `unknown` |

Three rules that make this safe rather than a loophole:

1. **`unknown` runs every rule.** So does any population string the code does
   not recognise. This is the opposite of how the first draft behaved and it is
   the most important three lines in the module — see §4.
2. **A person with two relationships gets two threads.** Never one merged inbox.
3. **Mis-stampable people get `unknown`, not `lake_customer`.** The repo today
   routes a park applicant who has no `park_members` row to `/book`, the
   homeowner product. If we let that person's thread be stamped `lake_customer`,
   every park-scoped rule switches off *and* auto-send switches on. So the stamp
   query checks for a `park_renters` or `lot_reservations` row first, and
   downgrades to `unknown` if it finds one. That is one join, once per thread.

**Scope groups used below:**

- `ALL` — every population.
- `PARK_RESIDENTIAL` — `park_tenant`, `park_owner`. **Not `rv_guest`.**
- `PARK_ANY` — `park_tenant`, `park_owner`, `rv_guest`.
- `OWNER_ONLY` — `park_owner`.
- `unknown` is implicit in every group.

**Why `rv_guest` is not residential.** A two-night RV guest asking *"can we get
a site closer to the office"* or *"what time do we have to be out"* or *"how
much is the deposit to hold site 14"* is not making a housing request. Running
the tenancy vocabulary there fired on 30% of all RV traffic in the volume study
and permanently killed those threads. The RV channel gets the *unambiguous*
housing terms (accommodation core, discrimination, occupancy limits) and nothing
else — and, critically, **`rv_guest` cannot auto-send**, so a miss costs a human
read, not a machine reply.

### 2.2 The four outcomes

| Outcome | Model may classify | Model may draft for ops | Auto-send | Pages a human | Sticky to thread |
|---|---|---|---|---|---|
| `allow` | yes | yes | if population permits | no | no |
| `hold` | no | **yes** | no | no | no |
| `never_ai` | no | **no** | no | no | **yes** |
| `emergency` | no | no | no | **yes, out of band** | yes |

A message's outcome is the **strictest** rule that fired. A rule can only ever
make the outcome stricter — that is what makes the table safe to edit by someone
who has not read the whole file.

`hold` is the current product's accepted behaviour for money and anger: no
auto-send, ops keeps the "✨ Draft reply" button. `never_ai` means the model does
not see the message at all — not for classification, not for a draft, and the
button is gone. That is the rung the owner's constraint requires.

**Auto-send permission, by population, at launch:**

```
lake_customer  yes
rv_guest       NO      (flip only after a season of shadow data)
park_tenant    NO
park_owner     NO
crew           NO
unknown        NO
```

This is the belt to the vocabulary's braces. **No tenant, owner, crew or RV
message auto-sends at all**, which is why every residual gap in §2.3 costs a
delay rather than a machine-authored artefact. Do not flip `rv_guest` or
`park_tenant` as a side effect of adding words to the table.

### 2.3 The rules

Notation: **T** = token, matched as a whole word. **P** = phrase, matched as a
contiguous whole-token sequence. Every entry below is normalised the same way
the message is (lowercase, apostrophes stripped, non-alphanumerics collapsed to
spaces), so `doctor's note` and `doctors note` are the same needle and
`smells like gas!!` matches `smells like gas`.

---

#### E1 · `life_safety_hard` — **emergency**, ALL

*Why a machine must not answer:* a branded, cheerful, wave-signed auto-reply to
"my ex is outside and I'm scared" is the worst output this system can produce.
Some of these need a human in minutes.

**T:** `suicide` `narcan` `overdose` `unresponsive` `stalking` `assault`

**P:** `kill myself` · `killing myself` · `hurt myself` · `end my life` ·
`end it all` · `call 911` · `called 911` · `calling 911` · `dial 911` ·
`call an ambulance` · `need an ambulance` · `domestic violence` ·
`restraining order` · `order of protection` · `protective order` ·
`no contact order` · `he hit me` · `she hit me` · `he has a gun` ·
`has a gun` · `pointed a gun` · `threatened to kill` · `threatened me` ·
`im bleeding` · `cant breathe` · `chest pain` · `chest hurts` ·
`heart attack` · `not breathing` · `wont wake up` · `passed out and` ·
`he found me` · `afraid to go home` · `dont feel safe` ·
`i fell on` · `i fell down` · `ive fallen` · `i fell and` ·
`she fell and` · `he fell and` · `mom fell` · `dad fell` ·
`cant get her up` · `cant get him up` · `cant get up off` ·
`found her on the floor` · `found him on the floor`

> `911` is **only** matched inside `call 911` / `called 911` / `calling 911` /
> `dial 911`. As a bare token it fires on Indiana phone numbers and on
> `911 Lakeshore Drive`.
> `she fell` and `he fell` as bare phrases are **out** — they fire on *"he fell
> behind on his lot rent"* and *"she fell in love with the new deck."*
> `i fell on` is in, `i fell` is not — *"i fell behind on the rent"* must not page.
> The first-person forms matter: in the first draft, `she fell on the steps`
> paged and `i fell on the steps` did not. The person reporting their own fall
> is the person who is alone.

---

#### E2 · `welfare_check` — **emergency**, ALL

**P:** `welfare check` · `wellness check` · `nobody has seen` ·
`no one has seen` · `havent seen her` · `havent seen him` ·
`hasnt come out` · `hasnt been out` · `mail is piling` ·
`papers are piling` · `car hasnt moved` · `lights have been off` ·
`lives alone and` · `worried about her` · `worried about him` ·
`she lives alone and` · `he lives alone and`

> `check on her` / `check on him` as bare phrases are **out** — *"can you check
> on her boat cover while you're there"* and *"can you check on him about the
> invoice for lot 8"* are ordinary business English.

---

#### E3 · `habitability_hard` — **emergency**, ALL

*Why:* these do not wait for the nightly digest. Note that the freeze phrases
belong on the lake channel too — a burst pipe in an unoccupied cottage is rule 7
failing.

**P — gas and odour:** `smell gas` · `smells like gas` · `smell the gas` ·
`gas smell` · `smells of gas` · `smelling gas` · `gas leak` · `leaking gas` ·
`propane leak` · `smell propane` · `like propane` · `rotten eggs` ·
`rotten egg` · `smells like sulfur` · `tank is hissing` · `hissing sound` ·
`hissing noise` · `gas company`

**P — combustion, CO, electrical:** `carbon monoxide` · `co detector` ·
`co alarm` · `smell smoke` · `smells like smoke` · `burning smell` ·
`smells like burning` · `something is burning` · `sparks came` ·
`sparks out of` · `is sparking` · `was sparking` · `arcing` · `live wire` ·
`exposed wire` · `wires are exposed` · `got shocked` · `shocked me` ·
`outlet is hot` · `breaker is hot` · `plug is hot` · `cord is hot` ·
`hot to the touch`

**P — water, sewage, structure:** `raw sewage` · `sewage in` ·
`sewage coming` · `sewage backing` · `sewage on the` · `sewer backing up` ·
`drain is backing up` · `toilet backing up` · `septic is full` ·
`septic is backing` · `poop coming up` · `coming up in the tub` ·
`coming up in the shower` · `toilet is overflowing` · `overflowing onto` ·
`pipes froze` · `pipes are frozen` · `pipe burst` · `burst pipe` ·
`line is frozen` · `water line froze` · `water line is frozen` ·
`ceiling is falling` · `ceiling is sagging` · `floor gave way` ·
`fell through the floor` · `coming through the light` ·
`coming through the ceiling`

Plus the named detector **`looksLikeHazardOdor`** (§3.4): a sense word
(`smell` `smells` `smelling` `smelled`) within five tokens of a hazard word
(`tank` `propane` `gas` `furnace` `heater` `burner` `stove` `pilot` `vent`
`breaker` `wiring`). This is what catches *"it smells funny by the tank out
back"* — the message the brief flagged and no phrase list reaches.

---

#### E4 · `habitability_soft` — **emergency if anchored, otherwise `hold`**, ALL

*Why the split.* These phrases are genuinely dangerous in a dwelling in January
and genuinely meaningless on a lake in July. In the volume study, `pouring out`
alone produced five false pages a week — Midwest for heavy rain. `no heat` fired
on *"there's no heat on out there yet, we shut it down in October"*, which is
the winterization business describing itself. An on-call who learns in ten days
that the page means rain will not open the one that means gas. **Precision
failures in this tier become recall failures in practice**, which is why this is
the only conditional rule in the table.

**P — the trigger set:** `no heat` · `heat is out` · `heats not working` ·
`heat isnt working` · `havent had heat` · `no heat since` · `heat quit` ·
`furnace is out` · `furnace quit` · `furnace died` · `furnace went out` ·
`furnace wont` · `water everywhere` · `water pouring` · `pouring out` ·
`gushing` · `flooding` · `flooded` · `alarm going off` ·
`detector going off` · `keeps chirping` · `detector chirping` ·
`alarm is beeping` · `on fire` · `no water` · `out of the tap` ·
`nothing coming out of the tap` · `freezing in here` · `we are freezing` ·
`is freezing` · `are freezing` · `freezing up` · `its freezing`

**Anchors — any one promotes the match to `emergency`:** `degrees` ·
`in here` · `inside` · `all night` · `last night` · `overnight` ·
`still no` · `my trailer` · `the trailer` · `under the trailer` ·
`under the house` · `my home` · `my house` · `in the house` ·
`the bedroom` · `the bathroom` · `the kitchen` · `the furnace` ·
`the breaker` · `the baby` · `my kids` · `my mom` · `my dad` · `elderly` ·
`cant sleep` · `three days` · `two days` · `3 days` · `2 days` ·
`all week` · `got cold` · `cold snap` · `since friday` · `since saturday` ·
`since sunday` · `since monday` · `since tuesday` · `since wednesday` ·
`since thursday`

Plus the named detector **`looksLikeColdTemp`**: a bare number ≤ 32 immediately
followed by `out`, `outside`, `degrees`, or `inside`. This is what promotes
*"the cottage furnace won't kick on and it's 5 out."*

**Plus a seasonal promotion.** Inside a lake's freeze window (the per-lake
ice-out / pull-deadline dates rule 7 already stores), any `habitability_soft` or
`habitability_routine` match whose text also contains `heat` `furnace` `water`
`pipe` `line` `boiler` `propane` or `tank` is promoted to `emergency` regardless
of anchors. This is the single highest-leverage change in the emergency lane: it
makes *"the furnace is acting up"* dangerous in January and routine in July
without asking a word list to know the difference.

---

#### N1 · `accommodation_core` — **never_ai**, ALL

*Why a machine must not answer:* a disability-related request starts a process
with duties attached and creates a dated record of what the landlord's system
said. An automated *"sure, no problem!"* and an automated *"that's not something
we do"* are both damaging, in opposite directions. **This rule runs on every
population**, including lake and crew, because none of these terms has an
innocent reading in this business and because a mis-stamped renter is the single
likeliest failure in the whole design.

**T:** `wheelchair` `wheelchairs` `wheelchair` `handicap` `handicapped`
`disability` `disabilities` `disabled` `handrail` `crutches` `dialysis`
`prosthetic` `hospice` `oxygen` `concentrator` `nebulizer` `autistic`
`paraplegic` `quadriplegic` `wheelchiar` `handycap` `handycapped` `disabilty`

**P:** `reasonable accommodation` · `reasonable modification` ·
`accommodation request` · `request an accommodation` · `grab bar` ·
`grab bars` · `shower chair` · `lift chair` · `walk in shower` ·
`hand rail` · `wheel chair` · `mobility scooter` · `home health` ·
`my caregiver` · `visiting nurse` · `hard of hearing` · `im deaf` ·
`legally blind` · `im blind` · `low vision` · `large print` ·
`medically necessary` · `for medical reasons` · `im disabled` ·
`on disability` · `doctors note` · `note from my doctor` ·
`my doctor says` · `my doctor wants` · `doctor wrote` ·
`service animal` · `service dog` · `support animal` · `emotional support` ·
`assistance animal` · `therapy dog` · `guide dog` · `seeing eye` ·
`companion animal` · `alert dog` · `medical alert` · `alerts me` ·
`hes not a pet` · `shes not a pet` · `not a regular pet` ·
`not just a pet` · `ada request` · `under the ada` · `ada compliant`

> **`ada` as a bare token is out.** Ada is a common first name in exactly this
> demographic and a `never_ai` match is not name-suppressible, so it would kill
> a woman's thread permanently with an "accommodation request" chip on it.
> **`my doctor` as a bare phrase is out** — *"my doctor appointment is Tuesday,
> can you come Wednesday"* is a reschedule.
> **`not a pet` as a bare phrase is out** — it is swallowed by *"is that not a
> pet friendly loop."*
> **`walker` as a bare token is out** — surname, and "dog walker."

---

#### N2 · `accommodation_contextual` — **never_ai**, PARK_RESIDENTIAL

The park-only half. Every term here is unaffordable on the lake channel
(`ramp` = boat ramp) or the RV channel (`closer to the office` = site
preference).

**P — ramps and rails:** `put a ramp` · `get a ramp` · `build a ramp` ·
`built a ramp` · `ramp built` · `install a ramp` · `put in a ramp` ·
`add a ramp` · `a ramp at` · `a ramp on` · `a ramp in` · `a ramp to` ·
`ramp installed` · `ramp put` · `needs a ramp` · `need a ramp` ·
`wants a ramp` · `a rail on my` · `a rail on her` · `a rail on his` ·
`rail by the` · `something to hold` · `hold onto` · `hold on to` ·
`bar in the shower` · `bar in the tub`

**P — steps and mobility:** `cant do stairs` · `cant do the stairs` ·
`cant do steps` · `cant do the steps` · `cant manage the steps` ·
`trouble with the steps` · `cant get up the steps` ·
`cant get up the stairs` · `hard time with the stairs` · `too steep` ·
`hard for me to step` · `difficult for me to step` · `get in easier` ·
`get in and out` · `level with the road` · `uses a walker` ·
`uses a cane` · `uses a scooter` · `her walker` · `his walker` ·
`moms walker` · `walker wont fit` · `her cane` · `his cane` ·
`cant get around` · `not walking good` · `cant walk` · `in a chair` ·
`since the surgery` · `since my surgery` · `my knees are` · `my hips are`

**P — placement and modification:** `closer to the office` ·
`closer parking` · `park closer` · `closer to the door` ·
`close to the door` · `assigned parking` · `near the mailboxes` ·
`long way for me` · `not walking far` · `widen the door` ·
`widen the doorway` · `lower the counter` · `my aide` · `picks me up` ·
`quieter one` · `ptsd`

---

#### N3 · `fair_housing_complaint` — **never_ai**, ALL

*Why:* a bland machine reply to a discrimination complaint reads as dismissal,
and the record shows the complaint was made and machine-answered.

**T:** `discriminate` `discriminated` `discriminating` `discrimination`
`discriminatory` `racist` `racism` `redlining` `retaliation` `retaliatory`
`retaliating`

**P:** `fair housing` · `housing discrimination` · `hud complaint` ·
`civil rights` · `protected class` · `familial status` ·
`source of income` · `discriminated against` · `because of my race` ·
`because of my religion` · `because of my disability` ·
`because of where` · `because of who` · `because i have kids` ·
`because we have kids` · `treated different` · `treating me different` ·
`singled out` · `singling me out` · `picking on me` ·
`other tenants dont` · `other tenants get to` · `you let them but` ·
`but never off` · `but nobody else` · `everybody else gets` ·
`only ever knocks` · `only ever comes` · `our row but` ·
`steering me` · `steering us`

> **`other tenants` as a bare phrase is out** — *"other tenants said the water
> was going off Tuesday"* is neighbourly gossip, and `never_ai` is sticky.
> **`because im` is out** — *"because I'm out of town Thursday."*

---

#### N4 · `fair_housing_owner_side` — **never_ai**, OWNER_ONLY

*Why this is separate and why it is owner-only:* the industry's everyday
shorthand is discriminatory on its face, and a machine that helpfully drafts on
top of it is producing the evidence. But *"no kids this trip, just the two of
us"* from a lake homeowner is a weekend plan, and a chip reading **"Fair
housing"** next to their name is both wrong and alarming. So the owner-side
vocabulary runs only on the owner channel.

**P:** `no kids` · `no children` · `adults only` · `we dont rent to` ·
`dont rent to` · `dont want that kind` · `not our kind` ·
`keep them out` · `make sure they dont` · `single women` ·
`too many people in` · `an accent` · `speak english` ·
`speaks english` · `that crowd` · `those people` · `the older folks` ·
`keep the back row` · `quiet park` · `mostly retirees` ·
`no felons` · `no section 8` · `no vouchers` ·
`children are not allowed` · `kids are not allowed` ·
`that kind of tenant` · `careful who` · `who we put` · `who i put` ·
`who to put` · `neighborhood is changing` · `for prayer` ·
`their church` · `religious`

> `we dont rent to` is written as `dont rent to` so it matches *"I don't rent
> to,"* *"they don't rent to,"* and *"we don't rent to"* alike. The
> first-person-plural lock in the first draft was the single cheapest miss in
> the whole review.
> **A hold here is not a finding that anything unlawful happened.** The ops
> line is worded so it cannot read like one — see §2.4.

---

#### N5 · `tenancy_termination` — **never_ai**, PARK_RESIDENTIAL

*Why:* these messages sit on clocks. An automated reply can restate a deadline
wrongly, appear to waive one, or appear to start one. **This rule is written in
plain English on purpose.** A tenant who knows the phrase "notice to quit" has
already talked to someone; the ones who haven't are the ones we need to catch.

**T:** `evict` `evicts` `evicted` `evicting` `eviction` `evictions`
`vacate` `vacating` `vacated` `lockout` `holdover` `nonrenewal` `lease`
`leases` `tenancy` `landlord` `detainer`

**P — the instrument:** `notice to quit` · `notice to vacate` ·
`eviction notice` · `notice of termination` · `notice of violation` ·
`lease violation` · `cure or quit` · `pay or quit` · `pay or leave` ·
`pay rent or quit` · `unlawful detainer` · `writ of possession` ·
`writ of restitution` · `non renewal` · `not renewing` · `wont renew` ·
`isnt being renewed` · `terminate my` · `terminate the` ·
`terminate your` · `end my tenancy` · `end your tenancy` ·
`notice on my door` · `taped to my door` · `paper taped` ·
`under my door` · `letter under` · `posted on my door` ·
`paper they gave` · `papers this morning` · `came with papers` ·
`got served` · `served with` · `process server`

**P — the clock:** `30 days` · `thirty days` · `60 days` · `sixty days` ·
`10 day notice` · `5 day notice` · `3 day notice` ·
`how long do i have` · `last day i can` · `start the process` ·
`goes to court`

**P — plain English:** `kicking me out` · `kick me out` ·
`throwing me out` · `put me out` · `make me leave` · `make me move` ·
`want me gone` · `not welcome` · `have to move out` · `move out by` ·
`moving out` · `move out early` · `when do i have to be out` ·
`do i have to leave` · `just stay` · `changed the locks` ·
`locked me out` · `push us out` · `push me out` · `lose anything` ·
`month to month` · `who do i pay` · `park sold` · `agreement ends` ·
`agreement is done` · `last month here` · `their last month`

**P — the home-versus-lot problem** (a lake platform has no instinct for this;
the tenant usually owns the home and rents only the pad, which turns an ordinary
property question into a tenancy question): `move my trailer` ·
`move my home` · `towed my home` · `sell my home` · `sell the trailer` ·
`title to the home` · `lien on the home` · `abandoned home` ·
`i own the home`

> **`got a notice` is out** — *"I got a notice from the county about my
> mailbox."* The door phrasings carry it.
> **`have to be out` is out on the RV channel by scope** — it is checkout time,
> the single most common RV question there is.
> **`have to go` is out** — *"I have to go pick up my kid."*

---

#### N6 · `housing_decision` — **never_ai**, ALL

*The absolute bright line.* LakeLife is never a Consumer Reporting Agency;
screening is a handoff to a licensed provider and we record only the human's
decision. The AI must never touch an application, a decline, a decline reason,
or an adverse-action notice. **Every phrase here is anchored** — the first draft
matched bare `declined` and therefore killed a thread every time a customer's
credit card expired.

**T:** `applicant` `applicants` `screening` `adverse` `prescreen`

**P:** `rental application` · `housing application` · `lot application` ·
`background check` · `run a background` · `criminal background` ·
`criminal record` · `credit check` · `run a credit` · `credit report` ·
`consumer report` · `screening report` · `tenant screening` ·
`eviction history` · `adverse action` · `application denied` ·
`application declined` · `denied the application` ·
`declined the application` · `deny the application` ·
`decline the application` · `denying the application` ·
`declining the application` · `denied his application` ·
`denied her application` · `turned down for` · `reason for the decline` ·
`reason for denial` · `denial reason` · `why the decline` ·
`say decline` · `said decline` · `report say` · `approve the applicant` ·
`reject the applicant` · `take this guy` · `take this person` ·
`should i take him` · `should i take her` · `should i take them` ·
`run a report on him` · `run a report on her` · `run a report on them` ·
`run a check on`

> **`declined` and `denied` as bare tokens are out.** *"My card was declined,
> can you try the other one"* is a monthly event.
> **`should i take` bare is out** — *"should I take the cover off before you get
> here."*
> **`run a report on` bare is out** — *"can you run a report on last season's
> occupancy"* is the owner's core use of the product.

---

#### N7 · `owner_drafting_request` — **never_ai**, OWNER_ONLY

*The rule the first draft missed entirely, and the sharpest single failure in
the review.* `landlord_advice` was built out of *interrogative* phrases — an
owner who asks **permission** gets caught. An owner who asks for **drafting**
did not, and drafting is exactly what the owner constraint forbids. *"Write me a
letter telling lot 14 they need to pay or leave"* cleared both proposed screens.

This rule is keyed on the **verb and the recipient**, not the subject matter.

**T:** `tenant` `tenants` `resident` `residents`

**P:** `write me a` · `write up something` · `write something for` ·
`draft something` · `draft a note` · `draft a letter` ·
`make me a letter` · `put together something` · `how do i word` ·
`how should i word` · `whats the wording` · `how do i say it` ·
`nicest way to tell` · `best way to tell` · `what should i say to` ·
`doesnt sound like` · `send everyone a notice` · `notify everyone that` ·
`send everyone` · `text everyone` · `tell everyone` · `send lot` ·
`text lot` · `message lot` · `havent paid` · `who is behind` ·
`is behind on` · `days behind` · `behind on rent` · `enough warning` ·
`enough notice`

> `tenant` as a bare token is affordable only because this rule is owner-only.
> Cost: an owner asking *"add a tenant to lot 43"* gets a human. That is fine —
> park owners have no auto-send anyway, so the only loss is a draft button.

---

#### N8 · `landlord_advice` — **never_ai**, OWNER_ONLY

*Descoped from tenants.* In the first draft this rule ran on tenants too, so
*"can I keep my fishing boat on the lot over winter"* and *"how much notice do
you need to schedule a mow"* were permanently machine-dead, and the ops board
printed the sentence *"The park is asking what they may do to a tenant"* about a
message from a tenant. A confidently wrong headline is worse than none.

**P:** `can i charge` · `can i evict` · `can i keep` · `can i refuse` ·
`can i deny` · `can i raise the` · `can i tell` · `can i make them` ·
`can i stop` · `can i say no` · `can i get rid of` · `am i allowed to` ·
`am i required` · `do i have to give` · `do i have to let` ·
`do i have to allow` · `what do i do about him` ·
`what do i do about her` · `what do i do about them` ·
`what do i do about the tenant` · `how much notice do i` ·
`how much notice is` · `is that legal`

---

#### N9 · `deposit_and_statutory_money` — **never_ai**, PARK_RESIDENTIAL

*Why this is not the same as an invoice question.* An invoice question is about
a service that was performed. A tenant's ledger question can be the opening move
in rent withholding, repair-and-deduct, a late-fee dispute or a deposit claim.
The owner's constraint names deposit-deduction justification explicitly.

**P — deposits:** `security deposit` · `damage deposit` ·
`deposit deduction` · `deposit deductions` · `deduct from the deposit` ·
`deducted from the deposit` · `out of my deposit` · `took it out of` ·
`took out of my` · `took out for` · `out for cleaning` ·
`keeping my deposit` · `keeping the deposit` · `keep the deposit` ·
`return my deposit` · `return the deposit` · `get my deposit` ·
`my deposit back` · `deposit back` · `get it back when` ·
`back when i leave` · `back when i move` · `charged me for cleaning` ·
`charged for cleaning` · `itemized deductions`

**P — withholding and increases:** `escrow` · `rent escrow` ·
`withhold rent` · `withholding rent` · `hold my rent` ·
`hold my payment` · `stop paying until` · `until they fix` ·
`repair and deduct` · `take it off what i` · `off my rent` ·
`rent increase` · `raising the rent` · `raise the rent` · `raise rent` ·
`rent went up` · `late fee` · `late fees` · `back rent` · `arrears` ·
`pay to stay` · `payment plan` · `who do i give rent to`

> **`deposit` as a bare token is out, and this rule is off the RV channel** —
> *"how much is the deposit to hold site 14"* is a booking FAQ.

---

#### N10a · `occupancy_limit` — **never_ai**, ALL

**P:** `occupancy limit` · `max people on` · `max occupancy` ·
`people can live` · `count as an occupant` · `add to the lease` ·
`on the lease` · `guest policy` · `overnight guest`

> `how many people can` is deliberately **out** of the ALL set — *"how many
> people can the pontoon hold"* is a lake question. It lives in N10b.

#### N10b · `household_composition` — **never_ai**, PARK_RESIDENTIAL

**T:** `custody` `guardian` `truant`

**P:** `move in with me` · `moving in with` · `move in with us` ·
`coming to live with me` · `coming to live with us` · `stay with us` ·
`stay with me` · `staying with me` · `staying with us` ·
`is staying with` · `add him to the lease` · `add her to the lease` ·
`how many people can` · `how many people are allowed` ·
`too many people in` · `how many kids` · `foster care` ·
`child protective` · `my son and` · `my daughter and` · `my son is` ·
`my daughter is` · `my grandkids` · `my grandson` · `my granddaughter`

> **`my kids` as a bare phrase is out** — *"my kids left their bikes by the
> road, sorry"* is an apology, and it appeared in the anchor list for E4 instead,
> where it correctly signals an occupied home.
> `my son` and `my daughter` were **missing entirely** from the first draft
> while `my grandson` was present. That is the clearest kind of vocabulary
> defect and the reason §5.3's cross-rule example test exists.

---

#### N11 · `legal_process` — **never_ai**, ALL

**T:** `subpoena` `subpoenas` `deposition` `summons` `lawyer` `lawyers`
`attorney` `attorneys` `sued` `suing` `litigation` `ombudsman`

**P:** `legal aid` · `legal services` · `tenants union` · `tenant rights` ·
`code enforcement` · `code officer` · `building inspector` ·
`health department` · `board of health` · `fire marshal` ·
`attorney general` · `consumer protection` · `small claims` ·
`court date` · `my lawyer` · `get a lawyer` · `ill sue` · `sue you` ·
`sue us` · `get sued` · `i know my rights` · `thats illegal` ·
`against the law` · `not legal` · `you cant legally` ·
`filed a complaint` · `reported you to` · `im reporting` ·
`the inspector is coming` · `legal notice` · `notice of default`

> **`sue` as a bare token is out.** Sue is over-represented in a mobile-home
> park's tenant roll, and the substring bug that made *"there is an issue with
> my water heater"* read as a legal threat is the most-cited failure of the old
> screen.

---

#### H1 · `access_credential` — **hold** + set `redactBeforeModel`, ALL

*Why `hold` and not `never_ai`.* Rule 3 encrypts `properties.gate_code_encrypted`
and shows it to a vendor only on the day of their job. But `comms-draft.ts`
interpolates the last six raw message bodies into the prompt, and the drafting
system prompt's *"use only facts present in the provided context"* **licenses**
repeating a code that is already in the thread. A message thread has no job and
no date, so it has no day-of window to honour. This is a structural rule-3
bypass. `hold` plus redaction kills the unattended path — which is the actual
risk — without killing the ops draft button on every lake message containing the
word "code."

**P:** `gate code` · `door code` · `keypad code` · `lock code` ·
`lockbox code` · `access code` · `entry code` · `alarm code` ·
`garage code` · `the combination` · `combo is` · `passcode` ·
`pin code` · `my pin` · `wifi password` · `the password` · `code is` ·
`code for the gate` · `code for the door` · `code isnt working` ·
`code doesnt work` · `code to get in`

Plus the named detector **`looksLikeCredential`**: an access word
(`gate` `gates` `door` `keypad` `lockbox` `garage` `entry` `alarm` `combo`
`combination` `passcode` `password` `code` `codes`) within three tokens of a
3–8 digit run, **excluding** runs that are a year (`19xx`/`20xx`), a valid clock
time (`730`, `1145`), followed within three tokens by a cardinal direction or a
street suffix (Indiana rural addressing is numeric — *"out on 200 west"*), or
preceded by `part` `serial` `model` `invoice` `order` `lot` `site` `unit`.

> Bare `pin` and bare `lock` are **out** of the access-word list. Hitch pins,
> lynch pins and cotter pins are standard pier-and-lift kit.

**Also, and separately from this rule:** drop `access_info_ack` and
`receipt_request` from the auto-send whitelist in `comms-classify.ts`. Keep them
as classifier labels so they can be routed and measured; make them
un-auto-sendable. `access_info_ack` is the one intent whose natural reply
restates the access fact — maximum echo probability, near-zero value. A rent
receipt is a legal record, not a service invoice.

---

#### H2 · `money_commitment` — **hold**, ALL

The old twenty words, rebuilt so they stop eating scheduling. Every ambiguous
word is now phrase-gated.

**T:** `refund` `refunded` `refunds` `dispute` `disputed` `complaint`
`complaints` `waive` `waiver` `waived` `owed` `angry` `furious` `terrible`
`awful` `unacceptable` `overcharged` `chargeback`

**P:** `for free` · `free of charge` · `no charge` · `on the house` ·
`charge me` · `charged me` · `charge my card` · `extra charge` ·
`the charge on` · `credit my account` · `store credit` ·
`account credit` · `my bill` · `the bill` · `bill me` · `billed me` ·
`i owe` · `you owe` · `owe me` · `my money` · `money back` ·
`cancel my account` · `cancel the contract` · `cancel everything` ·
`cancel and refund` · `you broke` · `they broke` · `broke my` ·
`broke it` · `storm damage` · `damage to my` · `damaged my` ·
`you damaged` · `promised me` · `you promised` · `was promised` ·
`a discount` · `give me a discount` · `not paying` · `wont pay`

Every bare token that caused a documented false positive is gone: `free`
(*"are you free Thursday"*), `cancel` (*"we need to cancel Saturday and do it
the week after"* — a reschedule, the highest-volume automatable intent there
is), `charge` (*"charge the boat battery"*), `credit` (*"the credit card on
file"*), `bill` (*"Bill next door"*), `broke` (*"the string trimmer broke"*),
`money` (*"I left a money order in the office slot"* — the park's actual rent
instrument), `sue`, `damage` (*"no damage on the lift"*), `promise`
(*"compromise"*), `discount` (*"Discount Tire on 20"*).

Marked **name-suppressible** (§3.5).

---

#### H3 · `service_complaint` — **hold**, ALL

**T:** `unhappy` `upset` `ridiculous` `disappointed` `unprofessional`
`negligent`

**P:** `never showed` · `didnt show` · `no one showed` ·
`nobody showed` · `still hasnt` · `still no one` · `third time` ·
`fed up` · `sick of` · `last straw` · `done with this` ·
`want a manager` · `speak to the owner` · `this is unacceptable`

---

#### H4 · `habitability_routine` — **hold**, PARK_ANY

**T:** `mold` `mildew` `asbestos` `radon` `roaches` `cockroach`
`cockroaches` `bedbugs` `infestation` `vermin` `rodents` `exterminator`
`condemned`

**P:** `black mold` · `bed bugs` · `lead paint` · `no hot water` ·
`water is brown` · `brown water` · `bad water` · `boil order` ·
`roof leak` · `leaking roof` · `leak in the ceiling` · `leaking into` ·
`broken window` · `door wont lock` · `no smoke detector` ·
`not up to code` · `code violation` · `tree is going to fall` ·
`road washed out` · `wont flush` · `toilet wont` · `skirting is` ·
`steps are rotten` · `porch is rotten` · `floor is soft`

---

#### H5 · `equipment_understatement` — **hold**, ALL

*The category no word list can reach, held at the cheapest possible rung.* Its
job is to guarantee that a human, not a machine, decides whether *"the furnace
is acting up again, can someone look when you're around"* is a nuisance or a
precursor. It will never distinguish the two. The seasonal promotion in E4 is
what gives it teeth in January.

**P:** `acting up` · `not right` · `somethings wrong` ·
`something is wrong` · `smells funny` · `smells weird` ·
`is it normal` · `popping noise` · `banging noise` ·
`doesnt sound right` · `sounds funny` · `keeps tripping` ·
`keeps shutting off` · `wont stay on` · `seems off`

---

#### H6 · `rent_ledger` — **hold**, PARK_RESIDENTIAL

**P:** `lot rent` · `site rent` · `pad rent` · `my rent` · `rent is due` ·
`rent due` · `paid my rent` · `i already paid` ·
`never gave me a receipt` · `no receipt` · `utility allowance` ·
`submetered` · `rent assistance` · `rental assistance` ·
`township trustee` · `past due` · `behind this month`

> Bare `rent` is out on every channel. On the lake channel it is *"rent a
> boat," "the renters come Friday."* On the owner channel it is *"send me the
> rent roll for the bank."*

### 2.4 The ops line each rule prints

The fence's product is not a boolean, it is a sentence a dispatcher can act on.
These strings are part of the spec because a wrong headline is worse than a
blank one — in the first draft an eviction message reached ops labelled *"Money,
a commitment or a promise is in play."*

| Rule | Ops line |
|---|---|
| `life_safety_hard` | **URGENT** — someone may be in danger. A person needs to read this now. |
| `welfare_check` | **URGENT** — someone may need checking on. A person needs to read this now. |
| `habitability_hard` | **URGENT** — possible gas, fire, electrical, sewage or freeze emergency at the home. |
| `habitability_soft` | Possible heat, water or alarm problem at an occupied home. |
| `accommodation_core` / `accommodation_contextual` | Not for AI — possible accommodation or disability-related request. A named person must answer. |
| `fair_housing_complaint` | Not for AI — the message describes being treated differently. Route to a named person; do not draft. |
| `fair_housing_owner_side` | Not for AI — wording here needs a person, not a machine. *(Deliberately does not say anything happened.)* |
| `tenancy_termination` | Not for AI — notice, eviction or end-of-tenancy question. Statutory clocks may be running. |
| `housing_decision` | Not for AI — application, screening or decline question. The AI must not touch this at all. |
| `owner_drafting_request` | Not for AI — the park is asking for wording to send a resident. A person writes that. |
| `landlord_advice` | Not for AI — the park is asking what they may do to a resident. |
| `deposit_and_statutory_money` | Not for AI — a deposit, withholding or rent-increase question. |
| `occupancy_limit` / `household_composition` | Not for AI — who lives in the home. Familial status and occupancy are not machine territory. |
| `legal_process` | Not for AI — a lawyer, regulator or court process is involved. |
| `access_credential` | Held — access codes are in this thread. Do not let a machine repeat them. |
| `money_commitment` | Held — money, a commitment or a promise is in play. A person should read it. |
| `service_complaint` | Held — the person sounds unhappy. An auto-reply would land badly. |
| `habitability_routine` | Held — repair or habitability request from a park. A person should answer and log it. |
| `equipment_understatement` | Held — something may be wrong with equipment. A person should judge how urgent. |
| `rent_ledger` | Held — rent or ledger question from a park. Money with statutory edges. |

**All reasons are surfaced, not just the strictest.** A message that is both an
emergency and a rent dispute must say both.

---

## 3. Matching strategy

### 3.1 The bug being fixed

The current screen calls `lower.includes(word)`. That is a substring test, so
`free` matches inside `freeze`, `freezer`, `antifreeze` and `Freeman`; `sue`
matches inside `issue`, `tissue` and `pursue`; `owed` matches inside `showed`;
`bill` inside `billboard`; `broke` inside `brokerage`; `promise` inside
`compromise`; `charge` inside `surcharge`. The comment in the file says the
`free`/`freeze` collision is acceptable because "a false positive here is just a
human reading." That was true for a second-home owner asking about a pontoon. It
is not true for a tenant whose water line is under a trailer in January.

### 3.2 The fix: tokenise, then match whole tokens and whole phrases

One normaliser, applied to the message **and to every rule's own words at
definition time**. If the two sides ever normalise differently, a rule silently
stops matching — the quietest way a fence can fail.

Tokens are matched against a `Set`. Phrases are matched as a contiguous
substring of `" " + tokens.join(" ") + " "` with the needle padded the same way,
so `" free "` cannot be a substring of `" freeze "` and a phrase can never match
mid-word.

### 3.3 Why not `\bfree\b`

Three reasons, and the third is the real one:

1. You still enumerate inflections by hand (`evict|eviction|evicted|evicting`).
   The regex only adds somewhere to hide a wildcard, and a tested
   `\bword\w{0,3}\b` still eats *freezer, billing, freedom, Freeman, Charger,
   Broker*.
2. `Set.has()` returns the exact token that matched, which is what the ops line
   needs. A combined regex returns a match nobody can trace to a rule.
3. **A `Set<string>` has no wildcard to write.** The fix is structural, not
   disciplinary — the next person cannot reintroduce the bug even carelessly.

### 3.4 What phrase matching does *not* fix, and the two named detectors

Padding stops a needle matching inside a *token*. It does not stop one matching
inside a longer *phrase*, and punctuation is stripped so a needle can join
across a comma. Two consequences, both handled:

- **Guard rule (enforced at module load, §5.3):** no `never_ai` or `emergency`
  phrase may consist entirely of high-frequency English. This is what stops
  `on fire` joining *"turn the pump on. Fire ring is by the shed,"* and
  `no one has seen` behaving unpredictably. Phrases in those tiers must carry at
  least one distinguishing word.
- **Named detectors** for the three things a phrase list genuinely cannot
  express: `looksLikeCredential`, `looksLikeHazardOdor`, `looksLikeColdTemp`.
  These live **outside** the rule table on purpose. The moment a rule can carry
  a `detect()` callback, the "pure data" property of the table evaporates and
  nobody can review it any more.

### 3.5 Names

Suppress a match when the matched token equals a known contact name on that
thread. We already hold `users.name` and the `park_renters` name columns, so
this is cheap. Two constraints:

- **Only on `hold` rules.** `defineRule` refuses `suppressibleByName` on
  anything stricter, so a housing or safety term is never suppressed.
- **It does not solve the real case, and we should say so.** The common
  collision is a *neighbour* — *"Bill next door keeps parking on my lot,"* *"Sue
  in 12 said you were coming Friday."* Neither is on the thread. The actual fix
  for those is the phrase-gating in H2 (`my bill`, `ill sue`), and name
  suppression is a second line only.
- `knownNames` is operator-typed free text (`park_renters.display_name`). Cap
  each entry at 40 characters and 3 tokens so a display name of
  `"Lot 12 — refund"` cannot disable a rule.

### 3.6 What we do not do here

**No negation handling.** *"No damage, looks great"* trips H2 and that is
accepted. A cheap negation check is fragile, gameable (*"I'm not saying I'll
sue, but…"*), and turns a deterministic screen into something nobody can reason
about. If polarity belongs anywhere it belongs in the model tier, which is
already reading the sentence.

---

## 4. The code

```ts
/**
 * comms-fence.ts — the one screen every inbound message passes through.
 *
 * PURE. No server-only, no Supabase, no clock, no I/O — the same seam as
 * pricing.ts and parks.ts, so it can be tested exhaustively.
 *
 * NEVER THROWS. Hostile input (null body, empty string, pure punctuation, an
 * unrecognised population) returns `hold`. An exception inside a fence must
 * never read as "safe" — today's code gets that right by luck, because a throw
 * is swallowed into no-reply. Here it is deliberate.
 *
 * THE WORD LIST IS THE WEAKEST LAYER IN THIS SYSTEM. The fence is the data
 * quarantine (ai-fields.ts), the import boundary (ai-boundary.test.ts), the
 * one-door seal (ai-screen.ts) and AUTOSEND_ALLOWED. See docs/ai-safety-fence.md §5.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Population =
  | "lake_customer"
  | "park_tenant"
  | "park_owner"
  | "rv_guest"
  | "crew"
  | "unknown";

/** Every population a rule may be scoped to. `unknown` is deliberately absent:
 *  unknown senders run EVERY rule, by construction, and defineRule refuses to
 *  let an author scope to it so nobody can believe they opted out. */
export const SCOPABLE_POPULATIONS = [
  "lake_customer",
  "park_tenant",
  "park_owner",
  "rv_guest",
  "crew",
] as const;
export type ScopablePopulation = (typeof SCOPABLE_POPULATIONS)[number];

export const ALL = SCOPABLE_POPULATIONS;
export const PARK_RESIDENTIAL = ["park_tenant", "park_owner"] as const;
export const PARK_ANY = ["park_tenant", "park_owner", "rv_guest"] as const;
export const OWNER_ONLY = ["park_owner"] as const;

export type Disposition = "allow" | "hold" | "never_ai" | "emergency";
/** A rule may not declare "allow" — a rule that fires always tightens. */
export type RuleDisposition = Exclude<Disposition, "allow">;

export type Category =
  | "life_safety"
  | "habitability"
  | "accommodation"
  | "fair_housing"
  | "tenancy"
  | "housing_decision"
  | "money"
  | "access"
  | "complaint";

export interface FenceInput {
  body: string;
  /** Stamped on the thread AT CREATION, from the row that created it.
   *  NEVER inferred from the body. */
  population: Population;
  /** The strictest disposition anything earlier on this thread reached, if it
   *  has not yet expired. Makes stickiness a pure input, not a DB lookup. */
  threadFloor?: Disposition;
  /** First names on this thread. Suppresses a commercial token that is also a
   *  person's name. Never applied to a housing or safety term. */
  knownNames?: readonly string[];
  /** True when this lake is inside its freeze window (rule 7 dates). Promotes
   *  heat/water holds to emergency. Passed in; the fence owns no clock. */
  freezeWindow?: boolean;
}

export interface FenceReason {
  ruleId: string;
  category: Category;
  disposition: RuleDisposition;
  /** The EXACT token or phrase that fired. This is what ops wants to see. */
  matched: string;
  /** Plain English, rendered verbatim on the ops board. */
  opsText: string;
}

export interface FenceResult {
  disposition: Disposition;
  /** May the body be sent to the model for intent + confidence? */
  mayClassify: boolean;
  /** May a reply send itself, with no human reading it? */
  mayAutoSend: boolean;
  /** May the model write a draft that a human ships? */
  mayDraftForOps: boolean;
  /** Out of band, NOW — not the nightly digest. */
  page: boolean;
  /** Code-shaped content is in this thread; redact in and out of the prompt. */
  redactBeforeModel: boolean;
  /** Write back to the thread; pass in next time. */
  threadFloor: Disposition;
  /** Every rule that fired, strictest first. */
  reasons: readonly FenceReason[];
  /** The one line the ops board renders. */
  opsHeadline: string;
  population: Population;
  fenceVersion: string;
}

export interface DispositionEffects {
  mayClassify: boolean;
  mayDraftForOps: boolean;
  page: boolean;
  sticky: boolean;
}

export const EFFECTS: Record<Disposition, DispositionEffects> = Object.freeze({
  allow:     { mayClassify: true,  mayDraftForOps: true,  page: false, sticky: false },
  hold:      { mayClassify: false, mayDraftForOps: true,  page: false, sticky: false },
  never_ai:  { mayClassify: false, mayDraftForOps: false, page: false, sticky: true  },
  emergency: { mayClassify: false, mayDraftForOps: false, page: true,  sticky: true  },
});

/**
 * Autonomy is per-population POLICY, expressed as data, in one place.
 *
 * Only the lake channel may auto-send at launch. rv_guest is `false` even
 * though "what's our site number" is genuinely safe, because rv_guest is
 * separated from park_tenant by a BILLING DIAL (the park's term threshold),
 * not by legal status — and a long-stay RV resident who renews monthly stays
 * stamped rv_guest indefinitely. Flip it deliberately, later, after a season of
 * shadow data. Never as a side effect of adding a word to the table.
 */
export const AUTOSEND_ALLOWED: Record<Population, boolean> = Object.freeze({
  lake_customer: true,
  rv_guest: false,
  park_tenant: false,
  park_owner: false,
  crew: false,
  unknown: false,
});

/** A message this long is never a "what day is trash" question, and a long
 *  message is exactly where an accommodation request gets buried inside a
 *  friendly scheduling note — which is also where the intent classifier is
 *  most confident and most wrong. */
export const MAX_AUTOSEND_TOKENS = 25;

export const FENCE_VERSION = "2026-08-08.1";

// ---------------------------------------------------------------------------
// Normalisation — ONE function, applied to the message and to every rule's
// own words at definition time. If the two sides ever diverge, a rule stops
// matching silently, which is the quietest way a fence can fail.
// ---------------------------------------------------------------------------

export function normalizeTokens(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/'/g, "")            // doctor's note === doctors note
    .replace(/[^a-z0-9]+/g, " ")  // bed-bugs, "smells like gas!!"
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

function stream(tokens: readonly string[]): string {
  return ` ${tokens.join(" ")} `;
}

function phraseHit(padded: string, phrase: string): boolean {
  return padded.includes(` ${phrase} `);
}

// ---------------------------------------------------------------------------
// Rule definition. Every rule goes through defineRule, which THROWS at module
// load on bad static data — so a bad edit fails in dev and in CI (every test
// file imports this module) long before it can reach a tenant.
// ---------------------------------------------------------------------------

export interface RuleSpec {
  id: string;
  category: Category;
  disposition: RuleDisposition;
  populations: readonly ScopablePopulation[];
  /** Single words, matched exactly. */
  tokens?: readonly string[];
  /** The ONLY place an ambiguous word may appear. */
  phrases?: readonly string[];
  /** The sentence ops reads. */
  opsText: string;
  /** What a machine would get wrong. Required; it is the review artefact. */
  why: string;
  /** `hold` rules only — defineRule refuses otherwise. */
  suppressibleByName?: boolean;
  /** True on habitability_soft only: this rule needs an anchor to escalate. */
  requiresAnchor?: boolean;
  /** Sets redactBeforeModel when it fires. */
  redacts?: boolean;
  /** The forcing function. `stops` must fire; `passes` must not. Every rule is
   *  ALSO checked against every OTHER rule's `passes` — which is how a
   *  carelessly added bare `rent` fails on a line its author never touched. */
  examples: { stops: readonly string[]; passes: readonly string[] };
}

export interface Rule extends RuleSpec {
  tokenSet: ReadonlySet<string>;
  phraseList: readonly string[];
}

/** Words too common to carry a never_ai or emergency phrase on their own.
 *  A phrase made entirely of these can join across a comma and fire on
 *  anything. Not exhaustive; it does not need to be — it only has to make the
 *  careless case fail loudly. */
const HIGH_FREQUENCY = new Set([
  "a","about","all","an","and","any","are","as","at","be","been","but","by",
  "can","come","could","do","does","for","from","get","give","go","had","has",
  "have","he","her","here","him","his","how","i","if","im","in","is","it","its",
  "just","keep","know","let","like","make","me","move","my","no","not","of",
  "off","on","one","or","other","our","out","over","put","say","see","she",
  "should","so","some","take","tell","that","the","their","them","then","there",
  "they","this","to","too","up","us","want","was","we","what","when","where",
  "who","why","will","with","would","you","your",
]);

const claimedTokens = new Map<string, string>();

export function defineRule(spec: RuleSpec): Rule {
  const where = `rule "${spec.id}"`;
  const strict = spec.disposition === "never_ai" || spec.disposition === "emergency";

  if (spec.populations.length === 0) {
    throw new Error(`${where}: scope it to at least one population.`);
  }
  for (const p of spec.populations) {
    if (!(SCOPABLE_POPULATIONS as readonly string[]).includes(p)) {
      throw new Error(
        `${where}: "${p}" is not a scopable population. Unknown senders run every rule by construction.`,
      );
    }
  }
  if (spec.suppressibleByName && spec.disposition !== "hold") {
    throw new Error(`${where}: suppressibleByName is only legal on a 'hold' rule.`);
  }
  if (!spec.examples.stops.length) {
    throw new Error(`${where}: needs at least one sentence this rule must catch.`);
  }
  if (!spec.examples.passes.length) {
    throw new Error(`${where}: needs at least one sentence this rule must NOT catch.`);
  }
  if (strict && spec.examples.stops.length < 3) {
    throw new Error(
      `${where}: a never_ai/emergency rule needs at least THREE 'stops' examples. ` +
        `One example written by the person who wrote the words proves nothing.`,
    );
  }

  const tokens = (spec.tokens ?? []).map((t) => {
    const norm = normalizeTokens(t);
    if (norm.length !== 1) {
      throw new Error(`${where}: token "${t}" normalises to ${norm.length} tokens — put it in phrases.`);
    }
    if (norm[0].length < 3) {
      throw new Error(`${where}: token "${t}" is too short to match safely.`);
    }
    const owner = claimedTokens.get(norm[0]);
    if (owner && owner !== spec.id) {
      throw new Error(`${where}: token "${norm[0]}" already belongs to rule "${owner}" — pick one home for it.`);
    }
    claimedTokens.set(norm[0], spec.id);
    return norm[0];
  });

  const phrases = (spec.phrases ?? []).map((p) => {
    const norm = normalizeTokens(p);
    if (norm.length < 2) {
      throw new Error(`${where}: phrase "${p}" is one token — a phrase needs two. Move it to tokens or make it longer.`);
    }
    if (strict && norm.every((t) => HIGH_FREQUENCY.has(t))) {
      throw new Error(
        `${where}: phrase "${p}" is made entirely of high-frequency English. ` +
          `At this severity it will join across a comma and fire on ordinary traffic. ` +
          `Add a distinguishing word or drop the rung to 'hold'.`,
      );
    }
    return norm.join(" ");
  });

  return { ...spec, tokenSet: new Set(tokens), phraseList: phrases };
}

// ---------------------------------------------------------------------------
// The three named detectors. These live OUTSIDE the rule table on purpose:
// the moment a rule can carry a detect() callback, the table stops being
// reviewable data.
// ---------------------------------------------------------------------------

const ACCESS_WORDS = new Set([
  "gate","gates","door","keypad","lockbox","garage","entry","alarm",
  "combo","combination","passcode","password","code","codes",
]);
const NOT_A_CODE_BEFORE = new Set(["part","serial","model","invoice","order","lot","site","unit"]);
const NOT_A_CODE_AFTER = new Set([
  "n","s","e","w","north","south","east","west",
  "rd","road","st","street","dr","drive","ln","lane","ave","avenue","blvd","hwy","way","ct","court",
]);

function isClockTime(t: string): boolean {
  if (t.length !== 3 && t.length !== 4) return false;
  const h = Number(t.slice(0, t.length - 2));
  const m = Number(t.slice(-2));
  return h >= 1 && h <= 12 && m >= 0 && m <= 59;
}

export function looksLikeCredential(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!/^\d{3,8}$/.test(t)) continue;
    if (/^(19|20)\d{2}$/.test(t)) continue;
    if (isClockTime(t)) continue;
    if (i > 0 && NOT_A_CODE_BEFORE.has(tokens[i - 1])) continue;
    let addressy = false;
    for (let k = i + 1; k <= i + 3 && k < tokens.length; k++) {
      if (NOT_A_CODE_AFTER.has(tokens[k])) addressy = true;
    }
    if (addressy) continue;
    for (let k = Math.max(0, i - 3); k <= Math.min(tokens.length - 1, i + 3); k++) {
      if (k !== i && ACCESS_WORDS.has(tokens[k])) return true;
    }
  }
  return false;
}

const SENSE_WORDS = new Set(["smell", "smells", "smelling", "smelled", "smelt"]);
const HAZARD_WORDS = new Set([
  "tank","tanks","propane","gas","furnace","heater","burner","stove",
  "pilot","vent","breaker","wiring","wires",
]);

/** Catches "it smells funny by the tank out back" — the understatement case no
 *  phrase list reaches. Window of five tokens, either direction. */
export function looksLikeHazardOdor(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (!SENSE_WORDS.has(tokens[i])) continue;
    for (let k = Math.max(0, i - 5); k <= Math.min(tokens.length - 1, i + 5); k++) {
      if (k !== i && HAZARD_WORDS.has(tokens[k])) return true;
    }
  }
  return false;
}

const COLD_UNITS = new Set(["out", "outside", "degrees", "inside"]);

/** "its 5 out", "its 4 degrees" — a freezing dwelling stated without a word. */
export function looksLikeColdTemp(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!/^-?\d{1,2}$/.test(tokens[i])) continue;
    if (Number(tokens[i]) > 32) continue;
    if (COLD_UNITS.has(tokens[i + 1])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

const ORDER: Record<Disposition, number> = { allow: 0, hold: 1, never_ai: 2, emergency: 3 };

function maxDisposition(a: Disposition, b: Disposition): Disposition {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** Paging is an EVENT; ineligibility is a STATE. Last week's gas leak must not
 *  page the on-call tonight, so the floor caps at never_ai. A fresh emergency
 *  on a sticky thread still pages. */
function capFloor(d: Disposition): Disposition {
  return d === "emergency" ? "never_ai" : d;
}

function appliesTo(rule: Rule, population: Population): boolean {
  // ANYTHING the table does not recognise runs EVERY rule. This is three lines
  // and it is the most important safety property in the module: `population`
  // arrives from a database column via `as Population`, TypeScript's union is
  // erased at runtime, and a new population value added in a migration would
  // otherwise fall through every includes() and land on `allow`.
  if (!(SCOPABLE_POPULATIONS as readonly string[]).includes(population)) return true;
  return (rule.populations as readonly string[]).includes(population as ScopablePopulation);
}

// ---------------------------------------------------------------------------
// The pure function
// ---------------------------------------------------------------------------

export function screenMessage(input: FenceInput): FenceResult {
  const population = (input?.population ?? "unknown") as Population;
  const fallback = (d: Disposition): FenceResult => buildResult(d, [], population, false, 0);

  try {
    const tokens = normalizeTokens(input?.body);
    if (tokens.length === 0) return fallback("hold");

    const padded = stream(tokens);
    const names = new Set(
      (input?.knownNames ?? [])
        .filter((n) => typeof n === "string" && n.length <= 40)
        .flatMap((n) => normalizeTokens(n))
        .filter((n) => n.length >= 3)
        .slice(0, 24),
    );

    const anchored =
      ANCHORS.some((a) => phraseHit(padded, a)) || looksLikeColdTemp(tokens);
    const seasonal = input?.freezeWindow === true;
    const seasonalWord = SEASONAL_WORDS.some((w) => tokens.includes(w));

    const reasons: FenceReason[] = [];
    let redact = false;

    for (const rule of RULES) {
      if (!appliesTo(rule, population)) continue;

      let matched: string | null = null;
      for (const t of tokens) {
        if (rule.tokenSet.has(t)) {
          if (rule.suppressibleByName && names.has(t)) continue;
          matched = t;
          break;
        }
      }
      if (!matched) {
        for (const p of rule.phraseList) {
          if (phraseHit(padded, p)) { matched = p; break; }
        }
      }
      if (!matched) continue;

      let disposition: RuleDisposition = rule.disposition;
      if (rule.requiresAnchor && !anchored) disposition = "hold";
      if (seasonal && seasonalWord && disposition === "hold" && rule.category === "habitability") {
        disposition = "emergency";
      }

      if (rule.redacts) redact = true;
      reasons.push({
        ruleId: rule.id,
        category: rule.category,
        disposition,
        matched,
        opsText: rule.opsText,
      });
    }

    // The detectors, outside the table.
    if (looksLikeCredential(tokens)) {
      redact = true;
      reasons.push({
        ruleId: "access_credential_shape",
        category: "access",
        disposition: "hold",
        matched: "an access word next to a code-shaped number",
        opsText: "Held — access codes are in this thread. Do not let a machine repeat them.",
      });
    }
    if (looksLikeHazardOdor(tokens)) {
      reasons.push({
        ruleId: "hazard_odor",
        category: "habitability",
        disposition: "emergency",
        matched: "a smell reported next to gas, propane or a heater",
        opsText: "URGENT — possible gas, fire, electrical, sewage or freeze emergency at the home.",
      });
    }

    let disposition: Disposition = "allow";
    for (const r of reasons) disposition = maxDisposition(disposition, r.disposition);

    const inherited = input?.threadFloor ?? "allow";
    const effective = maxDisposition(disposition, capFloor(inherited));

    reasons.sort((a, b) => ORDER[b.disposition] - ORDER[a.disposition]);
    return buildResult(effective, reasons, population, redact, tokens.length, disposition);
  } catch {
    // An exception inside the screen means BLOCK. Never "safe".
    return fallback("hold");
  }
}

function buildResult(
  disposition: Disposition,
  reasons: readonly FenceReason[],
  population: Population,
  redact: boolean,
  tokenCount: number,
  freshDisposition: Disposition = disposition,
): FenceResult {
  const fx = EFFECTS[disposition];
  const known = (SCOPABLE_POPULATIONS as readonly string[]).includes(population);
  const autosendPopulation = known ? AUTOSEND_ALLOWED[population] === true : false;

  return {
    disposition,
    mayClassify: fx.mayClassify,
    mayDraftForOps: fx.mayDraftForOps,
    mayAutoSend:
      disposition === "allow" && autosendPopulation && tokenCount <= MAX_AUTOSEND_TOKENS,
    // Page on a FRESH emergency only, never on an inherited floor.
    page: freshDisposition === "emergency",
    redactBeforeModel: redact,
    threadFloor: capFloor(disposition),
    reasons,
    opsHeadline: headline(disposition, reasons),
    population,
    fenceVersion: FENCE_VERSION,
  };
}

function headline(d: Disposition, reasons: readonly FenceReason[]): string {
  if (!reasons.length) return d === "allow" ? "" : "Held for a human.";
  const unique = [...new Set(reasons.map((r) => r.opsText))];
  return unique.join(" · ");
}
```

`ANCHORS`, `SEASONAL_WORDS` and `RULES` are the literal content of §2.3; they
are `defineRule({...})` calls over the token and phrase lists printed there, in
the order the rules appear.

---

## 5. Structural enforcement — the part that is not a word list

### 5.1 Where the choke point lives

There is exactly one function in the codebase that talks to a model:
`aiComplete` in `src/lib/ai.ts`. Two modules call it. That is the whole AI
surface, and it is why this is tractable.

**Change its signature so a string cannot be passed.** `aiComplete` takes a
`SealedPrompt`, a value that can only be minted by `seal()` in
`src/lib/ai-screen.ts`. The brand is a module-private `Symbol` and the payload
lives in a `WeakMap` keyed by the handle, so:

- passing `{ system, user }` is a **compile error** — no other file can name the
  brand key;
- passing a cast-forged object is a **runtime throw** — the WeakMap has nothing
  for it;
- `seal()` captures the exact bytes, so a caller cannot seal a benign prompt and
  mutate it afterwards.

`seal()` runs `screenMessage(body, "unknown")` and refuses on `never_ai` or
`emergency`. **One vocabulary, one module.** The two competing drafts each had
their own word list and the two disagreed on nine messages — the better list was
the one not wired to the ops board, so an eviction message was silently refused
at the API door while the dispatcher saw nothing and the thread floor stayed
clean. That failure mode is designed out by having exactly one list.

### 5.2 Four layers, weakest last

| # | Layer | Mechanism | What it beats |
|---|---|---|---|
| 1 | **No housing data reachable** | `ai-fields.ts`: an allowlist of `(assembler, table, columns)` that **throws** on anything else. Every `.select()` in `comms-context.ts` is wrapped in `aiSelect(...)`. `park*`, `lot_*`, `renter_*`, `lease`, `deposit`, `application`, `screening`, `eviction`, `tenan*` tables are refused **by name**, unconditionally. | A model that cannot see a lease cannot draft about one. This is where the owner's absolute constraint actually lives. |
| 2 | **No housing code reachable** | `ai-boundary.test.ts`: reads every `.ts`/`.tsx` under `src/`, builds an import map, and asserts a **pinned** list of which files may import an AI module — plus a quarantine: no file under `src/app/park*`, `src/lib/parks.ts`, `src/components/*Park*` may import one, and that failure **cannot be silenced by updating the pin**. | The "✨ Draft reply" button someone wires onto a park screen next year. The two existing draft buttons are ordinary components calling an ordinary server action; copying one is fifteen minutes' work and nothing today would object. |
| 3 | **No unscreened call possible** | The seal, §5.1. Plus `AI_PURPOSES`, a closed union with a frozen registry: adding a purpose without declaring its audience, its context assembler, and whether it may send unattended is a compile error. Exactly one purpose may auto-send, and that is asserted in a test. | A new AI feature written by someone who has not read this document. |
| 4 | **Content bar** | `screenMessage`, §2–4. | Text a customer typed that reached a prompt some other way. |

Layer 4 is a word list. It is documented as the weakest one in the file header.

### 5.3 The tests that make it stick

1. **Per-rule examples.** Every rule carries `stops` and `passes`. `never_ai`
   and `emergency` rules need at least three `stops`.
2. **Cross-rule examples — the one that actually works.** Every rule is checked
   against **every other rule's `passes`**. Append `rent` as a bare token to a
   lake-scoped rule and you do not fail your own test; you fail `rent_ledger`'s
   counter-example and the RV corpus, on a line you never touched.
3. **The held-out corpus** (§6). Written by people who did not write the rules.
   This is separate from the per-rule examples on purpose — the first draft's
   own examples all passed while 29 accommodation-shaped messages walked
   through, because an author naturally writes examples in phrasings they
   already listed.
4. **`defineRule` guards**, all seven, each with its own error message and its
   own test: multi-token in `tokens`, single-token in `phrases`, a token claimed
   by two rules, missing `passes`, `suppressibleByName` on a strict rung,
   scoping to `unknown`, and an all-high-frequency strict phrase.
5. **The boundary test**, §5.2 layer 2, whose failing case is titled
   `READ THIS IF YOU ARE HERE BECAUSE THE TEST FAILED` and ends with: *"Can it
   be reached by a park renter? If you are not certain the answer is no, the
   answer is no."*

### 5.4 The absolute prohibition, stated as code and not as a comment

The AI must never touch a housing application, a decision, a decline, a decline
reason, an adverse-action notice, a legal notice, an eviction-adjacent message,
or a deposit-deduction justification. Four independent things enforce that:

- **No free-text field exists in any decision path.** `decideApplication` takes
  a two-value enum from a form and writes `status`, `decided_by`, `decided_at`.
  There is no reason column, no deposit table, no notice generator in the repo.
  **Keep it that way** — the moment a `decline_reason text` column exists,
  something will want to help write it.
- **No park table may be queried for a model** (§5.2 layer 1). Enforced by a
  function that throws, with an error message that says *"if you believe this is
  wrong, it is a conversation with the owner and counsel, not a code change."*
- **No park surface may import an AI module** (§5.2 layer 2).
- **Rules N6, N7, N8, N9 refuse the message anyway** if it arrives through the
  message channel.

### 5.5 The kill switch, and the fact that it currently fails open

Three findings that are not vocabulary and must land in the same commit:

1. **`ai_autoreply_enabled` is seeded `1` in production, has no ops UI, and
   fails OPEN** — `getPlatformSettings` catches any error and returns defaults,
   where the value is `1`. A Supabase read failure *enables* autonomy. Add
   `ai_master_kill` as its own read with its own catch and the opposite default:
   the **only** value that means "live" is an explicit `0`; a missing row, an
   unparseable value, a timeout and an exception all mean off. Seed it **on**
   (i.e. killed), so autonomy ships dark.
2. **Two switches, both reachable from `/ops` without a deploy.** `ai_master_kill`
   stops every model call including ops drafting; `ai_autoreply_enabled` stops
   only unattended sending. During an incident the owner hits the first; for the
   parks launch the second stays off indefinitely.
3. **A database trigger on `messages`** that refuses an insert with `ai = true`
   while the master kill is set. A TypeScript check protects the code we have; a
   trigger protects the code someone writes next year.

Also: `.env.local` in the working tree carries a live `ANTHROPIC_API_KEY`.
"Autonomy is off because there's no key" is a statement about a past
environment. **Check whether the Vercel production environment carries that key
before parks go live** — today it is the only thing standing between a renter's
message and an unattended reply.

### 5.6 Where the fence runs, and the ordering bug it exposes

```ts
// src/app/messages/actions.ts — in sendOwnerMessage, immediately after the
// message insert, and OUTSIDE the try/catch that wraps maybeAutoReply.
const fence = screenMessage({
  body,
  population: thread.population,     // stamped at creation
  threadFloor: thread.fence_floor,   // sticky, with expiry
  knownNames: thread.knownNames,
  freezeWindow: lake.inFreezeWindow,
});
await recordFenceVerdict(admin, messageId, fence);   // ops board + thread floor
if (fence.page) await pageOnCall(admin, propertyId, fence);
if (!fence.mayClassify) return;
// ...only now the dial, the rate rails, the classifier, the draft.
```

Three things about that placement, all of them corrections to today's code:

- **The fence runs before the rate rails.** Today the "≤2 AI messages per
  property per hour" and "never two machine turns in a row" checks return
  *before* classification. An emergency arriving as the third message in an hour
  would never be screened at all.
- **The fence, the verdict write and the page are outside the swallowing
  catch.** `maybeAutoReply` is called inside `catch {}` with a comment saying a
  failure is harmless because "a human will see the message on the ops board
  regardless." That was written when the only thing that could fail was a
  classifier. Autonomy may fail silently; escalation and stickiness may not.
- **Ops outbound is screened too**, purely to raise the floor. If a dispatcher
  types *"we're starting the eviction on lot 14"* into a thread, that text is
  currently never screened, does not raise the floor, and lands verbatim in the
  next draft prompt. Backfill the floor once over existing `messages` rows
  before parks go live — it is a pure function over a text column.

### 5.7 The page channel — build it in the same commit or do not ship

**This is the single most important operational finding in the whole review.**
`pageOnCall` does not exist. Inbound customer messages notify nobody. The nightly
digest's only message section selects `ai = true` — machine-authored messages
only — so a message the fence *holds* appears in **no digest section at all**.
The ops message board has no unread state, no urgency sort and no filter.

So shipping the fence without a delivery lane is a **net safety regression**: a
gas-smell message that today at least surfaces tomorrow morning as a quoted AI
reply would, under the fence, be held, answered by nobody, and reported nowhere.

Build it on the shape that already works — `gapSlaAlerts` already SMSes ops
phones and dedupes through `nudge_log`:

- **`page`** → immediate SMS to every ops phone, deduped by
  `property + category + day`, no quiet hours. `sendSms` has no rate limit
  today, so the dedupe key is load-bearing.
- **`hold` and `never_ai`** → an ops queue with unread state and an SLA, not
  just a chip. This is where the 40-odd flagged messages a week live.
- **Nothing is ever surfaced to the person who wrote the message.** No "we can't
  answer that here" auto-reply — that is itself a machine-generated artefact in a
  housing matter, and it tells someone their message was machine-triaged. The
  message simply reaches a human, which is what it would have done anyway.

### 5.8 Stickiness, with an expiry and an override

`never_ai` is sticky, and in the first draft it was sticky **forever**, with no
expiry and no ops override. Modelled against realistic traffic that gives the
lake channel a nine-week half-life: after one season, 84% of lake threads would
be permanently machine-ineligible, and nobody would be able to say when it
happened. The feature would not be switched off, it would decay.

- The floor **decays after 60 days** with no further hit on that thread.
- Ops can **clear the floor** with a named, logged click. The dispatcher who
  answers a ramp question by hand is the one human guaranteed to know the thread
  is now a housing thread — so give them the button in *both* directions: they
  can also **raise** a thread to `never_ai` manually. That single control
  converts every vocabulary miss in §7 from permanent to one-message.
- The **category stays on the record forever**; only the ineligibility expires.

### 5.9 The refusal log, and why it is deliberately bad at its job

A log of "messages we thought were accommodation requests" **is a disability
record**. A log of "threads that mentioned an eviction notice" is a list of
tenants in legal trouble. Building the obvious version creates, on purpose, the
most sensitive dataset in the company — in order to protect people from a
machine.

So the log answers *"is the fence firing more than it used to?"* and refuses to
answer *"who asked for a ramp?"*

- **Recorded:** timestamp, purpose, a **coarse** code, an HMAC'd thread
  reference, body length. That is the whole row.
- **Not recorded:** the body (not truncated, not hashed), the matched term,
  which category inside "housing", any user id, name, phone or property id.
  Accommodation and eviction log as the same code — the table *cannot* separate a
  disability matter from a legal one.
- **Read:** ops only, via RLS, with client writes revoked.
- **Retention:** 90 days, pruned nightly. That number is a placeholder a human
  picked; see counsel item 8.
- A migration post-condition fails if the table ever grows a column outside the
  fixed set.

---

## 6. The test corpus

Written by the red teams, not by the rule authors. This is the held-out set from
§5.3 item 3 and it becomes `src/lib/comms-fence.corpus.test.ts` verbatim.

`expect` is the minimum acceptable disposition — a message marked `never_ai` may
also come back `emergency`, but never `hold`. `page: true` asserts the on-call
is woken.

```ts
export interface CorpusCase {
  id: string;
  body: string;
  population: Population;
  expect: Disposition;
  page?: boolean;
  /** true = a machine may answer this with no human in the loop */
  autosend?: boolean;
  note?: string;
}

export const CORPUS: readonly CorpusCase[] = [
  // ---- LAKE HOMEOWNER: the traffic the old screen wrongly ate -------------
  { id: "L01", body: "can you winterize the pontoon before the freeze", population: "lake_customer", expect: "allow", autosend: true, note: "old screen: BLOCKED, free ⊂ freeze" },
  { id: "L02", body: "there is an issue with the water spigot at lot 12", population: "lake_customer", expect: "allow", autosend: true, note: "old screen: BLOCKED as a legal threat, sue ⊂ issue" },
  { id: "L03", body: "the guy showed up late", population: "lake_customer", expect: "allow", note: "old: BLOCKED, owed ⊂ showed" },
  { id: "L04", body: "leave the bait in the freezer", population: "lake_customer", expect: "allow", autosend: true },
  { id: "L05", body: "the billboard on 120 has our sign on it", population: "lake_customer", expect: "allow" },
  { id: "L06", body: "the brokerage sent the roll over", population: "lake_customer", expect: "allow" },
  { id: "L07", body: "we reached a compromise on the pier sections", population: "lake_customer", expect: "allow" },
  { id: "L08", body: "is there a surcharge for the boat lift", population: "lake_customer", expect: "allow" },
  { id: "L09", body: "are you free thursday or friday to do the mow", population: "lake_customer", expect: "allow", autosend: true },
  { id: "L10", body: "we need to cancel saturday and do it the week after", population: "lake_customer", expect: "allow", autosend: true, note: "a reschedule, the highest-value automatable intent" },
  { id: "L11", body: "can you charge the boat battery while youre out there", population: "lake_customer", expect: "allow", autosend: true },
  { id: "L12", body: "put it on the credit card you have on file", population: "lake_customer", expect: "allow" },
  { id: "L13", body: "whats the billing address you have for us", population: "lake_customer", expect: "allow" },
  { id: "L14", body: "one of the pier brackets is broken", population: "lake_customer", expect: "allow" },
  { id: "L15", body: "meet me at the boat ramp", population: "lake_customer", expect: "allow", autosend: true },
  { id: "L16", body: "the kids are coming up this weekend can you get the pier in by friday", population: "lake_customer", expect: "allow" },
  { id: "L17", body: "no kids this trip just the two of us", population: "lake_customer", expect: "allow", note: "owner-side fair housing must not run here" },
  { id: "L18", body: "its really pouring out can we push the mow to thursday", population: "lake_customer", expect: "hold", page: false, note: "midwest for heavy rain" },
  { id: "L19", body: "there was water everywhere in the bilge after the storm", population: "lake_customer", expect: "hold", page: false },
  { id: "L20", body: "theres no heat on out there yet we shut it down in october", population: "lake_customer", expect: "hold", page: false },
  { id: "L21", body: "our address is 911 lakeshore drive not 9 11", population: "lake_customer", expect: "allow" },
  { id: "L22", body: "call me at 260 911 4412", population: "lake_customer", expect: "allow" },
  { id: "L23", body: "im scared the pier wont be in before the fourth", population: "lake_customer", expect: "allow" },
  { id: "L24", body: "the gate has been sticking since 2019 can someone look", population: "lake_customer", expect: "allow" },
  { id: "L25", body: "whats the code for the gate again my sister is coming up", population: "lake_customer", expect: "hold", note: "redactBeforeModel must be true" },
  { id: "L26", body: "my card was declined can you try the other one", population: "lake_customer", expect: "allow" },
  { id: "L27", body: "should i take the cover off before you get here", population: "lake_customer", expect: "allow", autosend: true },
  { id: "L28", body: "my daughter needs a service dog is that ok", population: "lake_customer", expect: "never_ai", note: "accommodation_core runs everywhere" },
  { id: "L29", body: "my mom cant do the stairs at the cottage anymore", population: "lake_customer", expect: "allow", note: "contextual is park-only; core misses this and we accept it" },
  { id: "L30", body: "the cottage furnace wont kick on and its 5 out", population: "lake_customer", expect: "emergency", page: true, note: "looksLikeColdTemp" },

  // ---- PARK TENANT: emergencies ------------------------------------------
  { id: "P01", body: "no heat since last night and its 4 degrees in here", population: "park_tenant", expect: "emergency", page: true },
  { id: "P02", body: "i smell gas outside by my tank", population: "park_tenant", expect: "emergency", page: true },
  { id: "P03", body: "sewage is coming up in my tub", population: "park_tenant", expect: "emergency", page: true },
  { id: "P04", body: "my pipes froze under the trailer and theres water everywhere", population: "park_tenant", expect: "emergency", page: true },
  { id: "P05", body: "the breaker box was sparking i shut everything off", population: "park_tenant", expect: "emergency", page: true },
  { id: "P06", body: "theres a gas smell in the trailer", population: "park_tenant", expect: "emergency", page: true },
  { id: "P07", body: "i smell rotten eggs in the back bedroom", population: "park_tenant", expect: "emergency", page: true },
  { id: "P08", body: "it smells funny by the tank out back", population: "park_tenant", expect: "emergency", page: true, note: "looksLikeHazardOdor" },
  { id: "P09", body: "i smell smoke", population: "park_tenant", expect: "emergency", page: true },
  { id: "P10", body: "sparks came out of the outlet", population: "park_tenant", expect: "emergency", page: true },
  { id: "P11", body: "furnace went out last night", population: "park_tenant", expect: "emergency", page: true },
  { id: "P12", body: "its freezing in here the baby is here", population: "park_tenant", expect: "emergency", page: true, note: "the old screen caught this by accident; the fix must not lose it" },
  { id: "P13", body: "no water at all since it got cold", population: "park_tenant", expect: "emergency", page: true, note: "a frozen line hours before it splits" },
  { id: "P14", body: "septic is full and its in the yard", population: "park_tenant", expect: "emergency", page: true },
  { id: "P15", body: "toilet is overflowing onto the floor", population: "park_tenant", expect: "emergency", page: true },
  { id: "P16", body: "the ceiling is sagging over the bed", population: "park_tenant", expect: "emergency", page: true },
  { id: "P17", body: "my mom fell and i cant get her up", population: "park_tenant", expect: "emergency", page: true },
  { id: "P18", body: "i fell on my steps again last week can someone look at them", population: "park_tenant", expect: "emergency", page: true, note: "first person; the first draft paged only for she/he" },
  { id: "P19", body: "nobody has seen mrs parker in three days", population: "park_tenant", expect: "emergency", page: true },
  { id: "P20", body: "he lives alone and his lights have been off all week", population: "park_tenant", expect: "emergency", page: true },
  { id: "P21", body: "the detector going off again its just the battery", population: "park_tenant", expect: "hold", page: false },
  { id: "P22", body: "the smoke detector alarm going off every time i cook", population: "park_tenant", expect: "hold", page: false },
  { id: "P23", body: "furnace is acting up again can someone look when youre around", population: "park_tenant", expect: "hold", page: false, note: "understatement; the seasonal dial promotes this in january" },
  { id: "P24", body: "water heater quit 3 days ago still no hot water", population: "park_tenant", expect: "hold" },

  // ---- PARK TENANT: accommodation ----------------------------------------
  { id: "P25", body: "can i get a ramp built i use a wheelchair now", population: "park_tenant", expect: "never_ai" },
  { id: "P26", body: "hey quick question can i put a ramp in myself out front my son would build it", population: "park_tenant", expect: "never_ai", note: "tenant-paid modification; put a ramp vs put in a ramp" },
  { id: "P27", body: "can somebody put a rail on my steps so i have something to hold onto", population: "park_tenant", expect: "never_ai" },
  { id: "P28", body: "is there any way to get a bar put in the shower to hold onto", population: "park_tenant", expect: "never_ai" },
  { id: "P29", body: "i cant do steps anymore is there a lot that sits level with the road", population: "park_tenant", expect: "never_ai" },
  { id: "P30", body: "my doctor says i need a support animal does that break the pet rule", population: "park_tenant", expect: "never_ai" },
  { id: "P31", body: "can i have the lot closer to the office my knees are shot", population: "park_tenant", expect: "never_ai" },
  { id: "P32", body: "can my home health aide park overnight she helps me shower", population: "park_tenant", expect: "never_ai" },
  { id: "P33", body: "can you put a grab bar in my bathroom", population: "park_tenant", expect: "never_ai" },
  { id: "P34", body: "im hard of hearing and i never hear anybody knock can they call instead", population: "park_tenant", expect: "never_ai" },
  { id: "P35", body: "im legally blind so i cant read the notices you put on the post", population: "park_tenant", expect: "never_ai" },
  { id: "P36", body: "my moms walker wont fit through the front door can anything be done", population: "park_tenant", expect: "never_ai" },
  { id: "P37", body: "my husbands concentrator needs its own outlet who do i ask", population: "park_tenant", expect: "never_ai" },
  { id: "P38", body: "i use a wheelchiar now so the door is to narrow", population: "park_tenant", expect: "never_ai", note: "misspelling of the strongest token in the list" },
  { id: "P39", body: "my dog alerts me before a seizure so hes with me all the time", population: "park_tenant", expect: "never_ai" },
  { id: "P40", body: "hes a companion animal not a regular pet", population: "park_tenant", expect: "never_ai" },
  { id: "P41", body: "my doctor appointment is tuesday can you come wednesday instead", population: "park_tenant", expect: "hold", note: "a reschedule, NOT a disability disclosure" },
  { id: "P42", body: "hey are you guys coming thursday or friday also my son wants to put a little wooden platform by my front steps so i can get in easier do i need to tell the office first", population: "park_tenant", expect: "never_ai", note: "the request buried in a scheduling message; 39 tokens" },

  // ---- PARK TENANT: tenancy, money, fair housing --------------------------
  { id: "P43", body: "i got a paper taped to my door what does it mean", population: "park_tenant", expect: "never_ai" },
  { id: "P44", body: "i found a letter under my door yesterday what does it mean", population: "park_tenant", expect: "never_ai" },
  { id: "P45", body: "how long do i have", population: "park_tenant", expect: "never_ai", note: "contains no housing word and never will" },
  { id: "P46", body: "does the 30 days start when they gave me the paper or when i opened it", population: "park_tenant", expect: "never_ai" },
  { id: "P47", body: "am i getting evicted", population: "park_tenant", expect: "never_ai" },
  { id: "P48", body: "im getting evictions paperwork what do i do", population: "park_tenant", expect: "never_ai", note: "a plural the first draft missed" },
  { id: "P49", body: "somebody came to the door with papers this morning", population: "park_tenant", expect: "never_ai" },
  { id: "P50", body: "what happens if i just stay", population: "park_tenant", expect: "never_ai" },
  { id: "P51", body: "they want me gone by the 1st", population: "park_tenant", expect: "never_ai" },
  { id: "P52", body: "manager told me im not welcome here anymore", population: "park_tenant", expect: "never_ai" },
  { id: "P53", body: "am i getting my deposit back when i move out", population: "park_tenant", expect: "never_ai" },
  { id: "P54", body: "will i get my money back when i leave", population: "park_tenant", expect: "never_ai", note: "a deposit question that never says deposit" },
  { id: "P55", body: "they took 400 out for cleaning the carpet", population: "park_tenant", expect: "never_ai" },
  { id: "P56", body: "if i fix the step myself can i take it off what i pay", population: "park_tenant", expect: "never_ai", note: "repair and deduct in plain words" },
  { id: "P57", body: "can i hold my payment until they fix the furnace", population: "park_tenant", expect: "never_ai" },
  { id: "P58", body: "who do i give rent to now that the park sold", population: "park_tenant", expect: "never_ai" },
  { id: "P59", body: "is my agreement month to month or a year", population: "park_tenant", expect: "never_ai" },
  { id: "P60", body: "my daughter and her two kids need to stay with us until she gets on her feet", population: "park_tenant", expect: "never_ai", note: "my son / my daughter were missing entirely from the first draft" },
  { id: "P61", body: "is it true theres a rule that only two people can live in a single wide", population: "park_tenant", expect: "never_ai" },
  { id: "P62", body: "the manager only ever knocks on the doors on the back row", population: "park_tenant", expect: "never_ai" },
  { id: "P63", body: "the manager tows cars off our row but never off the front row", population: "park_tenant", expect: "never_ai" },
  { id: "P64", body: "i think theyre trying to push us out because of where were from", population: "park_tenant", expect: "never_ai" },
  { id: "P65", body: "i got a notice from the county about my mailbox", population: "park_tenant", expect: "hold", note: "got a notice must not be a phrase" },
  { id: "P66", body: "other tenants said the water was going off tuesday is that right", population: "park_tenant", expect: "allow", note: "never_ai is sticky; neighbourly gossip must not kill a thread" },
  { id: "P67", body: "can i keep my fishing boat on the lot over winter", population: "park_tenant", expect: "allow", note: "landlord_advice is owner-only now" },
  { id: "P68", body: "how much notice do you need to schedule a mow", population: "park_tenant", expect: "allow" },
  { id: "P69", body: "my kids left their bikes by the road sorry", population: "park_tenant", expect: "allow" },
  { id: "P70", body: "bill next door keeps parking half on my lot", population: "park_tenant", expect: "allow", note: "a neighbour named Bill" },
  { id: "P71", body: "sue in 12 said you were coming friday is that right", population: "park_tenant", expect: "allow" },
  { id: "P72", body: "i left a money order in the office slot", population: "park_tenant", expect: "allow", note: "the park's actual rent instrument" },
  { id: "P73", body: "what day is trash", population: "park_tenant", expect: "allow", autosend: false, note: "safe, but park_tenant never auto-sends" },
  { id: "P74", body: "is the office open saturday", population: "park_tenant", expect: "allow", autosend: false },

  // ---- RV GUEST -----------------------------------------------------------
  { id: "R01", body: "whats our site number", population: "rv_guest", expect: "allow", autosend: false },
  { id: "R02", body: "what time do we have to be out on sunday", population: "rv_guest", expect: "allow", note: "checkout, not a tenancy termination" },
  { id: "R03", body: "can we get a site closer to the office", population: "rv_guest", expect: "allow", note: "site preference, not an accommodation" },
  { id: "R04", body: "how much is the deposit to hold site 14", population: "rv_guest", expect: "allow", note: "a booking FAQ" },
  { id: "R05", body: "is the pool adults only after 8pm", population: "rv_guest", expect: "allow" },
  { id: "R06", body: "can we bring our dog", population: "rv_guest", expect: "allow" },
  { id: "R07", body: "do you take dogs over 40 lbs", population: "rv_guest", expect: "allow" },
  { id: "R08", body: "is that not a pet friendly loop", population: "rv_guest", expect: "allow" },
  { id: "R09", body: "site 14 for a month my dog is a medical alert dog is the 40 lb limit a problem", population: "rv_guest", expect: "never_ai" },
  { id: "R10", body: "we have four kids whats the max people on a site", population: "rv_guest", expect: "never_ai", note: "occupancy_limit runs everywhere" },
  { id: "R11", body: "my wife uses oxygen at night does site 9 have reliable power", population: "rv_guest", expect: "never_ai" },
  { id: "R12", body: "something smells weird at site 14 kind of like propane", population: "rv_guest", expect: "emergency", page: true },
  { id: "R13", body: "whats the wifi password", population: "rv_guest", expect: "hold" },
  { id: "R14", body: "we need to cancel", population: "rv_guest", expect: "allow" },

  // ---- PARK OWNER ---------------------------------------------------------
  { id: "O01", body: "how many lots are open right now", population: "park_owner", expect: "allow", autosend: false },
  { id: "O02", body: "whats my occupancy vs last year", population: "park_owner", expect: "allow" },
  { id: "O03", body: "can you run a report on last season occupancy", population: "park_owner", expect: "allow", note: "the owner's core use of the product" },
  { id: "O04", body: "send everyone a freeze warning the cold snaps coming", population: "park_owner", expect: "never_ai", note: "owner_drafting_request; old screen blocked this on 'free' inside freeze" },
  { id: "O05", body: "write me a letter telling lot 14 they need to pay or leave", population: "park_owner", expect: "never_ai", note: "cleared BOTH first-draft screens" },
  { id: "O06", body: "draft something for lot 22 about being late again", population: "park_owner", expect: "never_ai" },
  { id: "O07", body: "how do i word this so it doesnt sound like a threat", population: "park_owner", expect: "never_ai" },
  { id: "O08", body: "whats the nicest way to tell someone their agreement isnt being renewed", population: "park_owner", expect: "never_ai" },
  { id: "O09", body: "what should i say to someone who is behind", population: "park_owner", expect: "never_ai" },
  { id: "O10", body: "is 10 days enough warning", population: "park_owner", expect: "never_ai" },
  { id: "O11", body: "should i take this guy or not", population: "park_owner", expect: "never_ai" },
  { id: "O12", body: "why did the report say decline", population: "park_owner", expect: "never_ai" },
  { id: "O13", body: "i want to run a background check on 3 people", population: "park_owner", expect: "never_ai" },
  { id: "O14", body: "the tenant in 7 is 45 days behind what do i do", population: "park_owner", expect: "never_ai" },
  { id: "O15", body: "can i charge a late fee", population: "park_owner", expect: "never_ai" },
  { id: "O16", body: "i dont rent to that crowd tell them 12 is taken", population: "park_owner", expect: "never_ai", note: "first-person-plural lock in the first draft let this through" },
  { id: "O17", body: "the guy who called about 7 barely speaks english is his paperwork going to be a problem", population: "park_owner", expect: "never_ai" },
  { id: "O18", body: "put a note on 40 id rather keep the back row for the older folks the families get loud", population: "park_owner", expect: "never_ai" },
  { id: "O19", body: "we like to keep this a quiet park mostly retirees is there a way to say that on the listing", population: "park_owner", expect: "never_ai" },
  { id: "O20", body: "the neighborhood is changing and i want to be careful who we put in here", population: "park_owner", expect: "never_ai" },
  { id: "O21", body: "can i refuse the couple with the service dog were no pets", population: "park_owner", expect: "never_ai" },
  { id: "O22", body: "send everyone a reminder that children are not allowed in the pool area without an adult", population: "park_owner", expect: "never_ai" },
  { id: "O23", body: "the tenant in 7 wants a rail on her steps do i have to", population: "park_owner", expect: "never_ai" },
  { id: "O24", body: "i want to raise rent 75 on everyone starting january", population: "park_owner", expect: "never_ai" },
  { id: "O25", body: "add lot 43 im putting a home on it", population: "park_owner", expect: "allow" },
  { id: "O26", body: "send me the rent roll for the bank", population: "park_owner", expect: "allow" },
  { id: "O27", body: "he fell behind on his lot rent again", population: "park_owner", expect: "never_ai", page: false, note: "must NOT page" },
  { id: "O28", body: "the sewage bill went up again", population: "park_owner", expect: "hold", page: false },
  { id: "O29", body: "did his deposit come through yet", population: "park_owner", expect: "allow" },

  // ---- CREW ---------------------------------------------------------------
  { id: "C01", body: "how many photos do i need", population: "crew", expect: "allow" },
  { id: "C02", body: "im at the gate at 730 nobody is here", population: "crew", expect: "allow", note: "a clock, not a code" },
  { id: "C03", body: "the gate arm hit my truck out on 200 west", population: "crew", expect: "allow", note: "Indiana rural addressing is numeric" },
  { id: "C04", body: "left the gate open at 145 shoreline drive sorry", population: "crew", expect: "allow" },
  { id: "C05", body: "the hitch pin sheared off part number 4471", population: "crew", expect: "allow" },
  { id: "C06", body: "gate code isnt working", population: "crew", expect: "hold", note: "redactBeforeModel true; the code is in the thread history" },
  { id: "C07", body: "when you drain the lines make sure the water is gushing before you close it", population: "crew", expect: "hold", page: false },
  { id: "C08", body: "the car alarm going off next door all morning", population: "crew", expect: "hold", page: false },
  { id: "C09", body: "took the trailer to discount tire on 20", population: "crew", expect: "allow" },
  { id: "C10", body: "im free after 2 if you need me on turkey", population: "crew", expect: "allow" },
  { id: "C11", body: "the string trimmer broke i need a new one", population: "crew", expect: "allow" },
  { id: "C12", body: "no damage on the lift everything looks good", population: "crew", expect: "allow" },
  { id: "C13", body: "theres water pouring out under the trailer at 22", population: "crew", expect: "emergency", page: true },
  { id: "C14", body: "smell gas at lot 9", population: "crew", expect: "emergency", page: true },
  { id: "C15", body: "the furnace at lot 9 is putting out a burning smell i shut it off", population: "crew", expect: "emergency", page: true },
  { id: "C16", body: "lady at lot 9 asked me about building a ramp to her door she said her doctor wrote a note who do i tell", population: "crew", expect: "never_ai", note: "doctor wrote is in accommodation_core, which runs on crew" },
  { id: "C17", body: "renter in 14 says shes being evicted and wants to know if she still has to let me in", population: "crew", expect: "never_ai", note: "evicted is a token in tenancy_termination — see §7 limit 5" },
  { id: "C18", body: "i was backing up and clipped the post", population: "crew", expect: "allow" },
  { id: "C19", body: "lift is bent looks like storm damage", population: "crew", expect: "hold" },
  { id: "C20", body: "wheres my money for last week", population: "crew", expect: "hold" },

  // ---- UNKNOWN / hostile input --------------------------------------------
  { id: "U01", body: "am i getting evicted", population: "unknown", expect: "never_ai" },
  { id: "U02", body: "am i getting evicted", population: "park_resident" as Population, expect: "never_ai", note: "an unrecognised population string must run EVERY rule" },
  { id: "U03", body: "", population: "lake_customer", expect: "hold" },
  { id: "U04", body: "...!!!", population: "lake_customer", expect: "hold" },
  { id: "U05", body: null as unknown as string, population: "lake_customer", expect: "hold" },
  { id: "U06", body: "can i get a ramp built i use a wheelchair now", population: "unknown", expect: "never_ai" },
] as const;
```

**Additional assertions in the same file:**

- Every case with `page: false` must return `page === false`.
- Every case with `autosend: true` must return `mayAutoSend === true`; every
  other case must return `mayAutoSend === false`.
- `L25` and `C06` must return `redactBeforeModel === true`.
- After `P25` (`never_ai`), a follow-up *"thank you so much that helps a lot"*
  on the same thread with `threadFloor: "never_ai"` must still be `never_ai` and
  must **not** page.
- After `P02` (`emergency`), the returned `threadFloor` must be `never_ai`, not
  `emergency` — a past emergency must not page the on-call again tonight.
- `screenMessage` must never throw, for any case.

---

## 7. What we deliberately do not do

1. **We do not auto-send to tenants, park owners, RV guests or crews.** Not even
   *"what day is trash."* The vocabulary has known gaps; this is the belt that
   makes them survivable. Only the lake channel keeps autonomy at launch.

2. **We do not do negation handling.** *"No damage, looks great"* gets held. A
   cheap negation check is gameable — *"I'm not saying I'll sue, but…"* — and it
   turns a deterministic screen into something nobody can reason about. Accept
   one human read of a message that says everything is fine.

3. **We do not claim crisis detection.** `life_safety_hard` is a floor. No
   vocabulary catches a message that says only *"I'm done."* This must never be
   described to anyone as handling that, and no product copy may imply it.

4. **We do not screen in any language but English.** A Spanish-language
   accommodation request passes this fence exactly as it passes the current one.
   That needs a native reviewer, not a translated array. Two mitigations do
   carry over: layers 1–3 of §5.2 are language-independent, and no park-side
   population can auto-send. This is a real gap and it is stated as one.

5. **We do not scope the housing vocabulary to crews beyond the core.** A crew
   relaying *"the lady at lot 9 wants a ramp"* is caught only if the message
   contains a core term. There is no crew AI surface wired today, and
   `AUTOSEND_ALLOWED.crew` is `false`, so the exposure is an ops draft button. If
   a crew AI surface is ever built, stamp `crew_park` from the job's park lot and
   add it to `PARK_RESIDENTIAL` first.

6. **We do not spell-correct or fuzzy-match.** Four common misspellings are
   listed by hand (`wheelchiar`, `handycap`, `handycapped`, `disabilty`).
   Enumerating misspellings does not scale and everyone should know that. The
   class-level answer is a second-pass model asked only *"is this a housing or
   disability matter, yes or no"* whose only possible output is a refusal — that
   is a future design, not a word.

7. **We do not surface a refusal to the person who wrote the message.** No
   "we can't answer that here" reply. That is itself a machine-generated artefact
   in a housing matter.

8. **We do not name a statute, a deadline, or an agency anywhere in the code or
   this document.** Every `why` that touches a legal concept is a flag for
   counsel, not settled advice. The terms the vocabulary review marked uncertain
   — source-of-income protection, 55+ age-restricted housing, criminal-record
   screening, RUBS, township trustee, the Indiana agency initialisms, home-versus-lot
   termination — are **deliberately absent from the arrays**. They go to counsel
   before they go in the table.

9. **We do not build a per-category refusal log.** §5.9. Coarse is the
   privacy-preserving choice.

10. **We do not treat the corpus score as a safety metric.** It is a regression
    test. The first draft scored 33/33 on patency against a corpus that contained
    no reschedule request, no card decline and no RV checkout question — the test
    could not fail. Before flipping any `AUTOSEND_ALLOWED` value, run the fence in
    **shadow mode against a month of real messages**, log dispositions, send
    nothing.

---

## 8. Expected volume — is this sustainable?

**Model.** A 79-lot park (55 long-term tenants, 24 RV sites at ~65% occupancy),
2 owner-side users, 5 crews, and a lake base of 120 in peak season. Roughly
**323 messages a week**. The weights are an estimate, not measured traffic — but
the direction of every number below is robust, because the effects are
concentrated in the highest-volume message types.

| | messages/wk | today's 20-word screen | this design |
|---|---|---|---|
| Auto-answered by a machine, nobody reads it | 168 lake + 68 RV eligible | ~50 | **~45** (lake only, ≤25 tokens) |
| Reaches a human as normal inbox traffic | all the rest | ~273 | **~278** |
| Flagged `hold` — human reads, ops may still draft | — | 51 | **~34** |
| Flagged `never_ai` — human writes it, no draft button | — | 0 | **~12** |
| **Pages the on-call out of band** | — | **0 (no channel exists)** | **~2** |

**Read that table carefully, because the honest number is not the scary one.**
Every message already reaches a human today — 100% of them. The fence does not
add reading work; it *categorises* work that was already there and it *removes*
about 17 messages a week of pointless blocking (the reschedules and freeze
questions the old substring bug ate). The genuinely new demand on a person is:

- **~46 flagged items a week** (34 hold + 12 never_ai) — roughly **7 a day**,
  arriving with a one-line reason. That is one dispatcher's coffee.
- **~2 pages a week** out of band. This is the number that matters. The first
  draft of this fence produced **7.1 pages a week, of which ~5.8 were rain** —
  `pouring out` alone was five. An on-call who learns in ten days that the page
  means weather will not open the one that means gas. Two a week is a number
  someone will still read.

At beta scale (~176 messages/week, and note the park is the *majority* of the
inbox at beta), the same design yields roughly 26 flagged items and 1 page a
week.

**Sustainable: yes, with two conditions.** First, the flagged queue needs unread
state and an SLA — a chip on a board nobody sorts is not delivery (§5.7).
Second, the page channel must be built in the same commit. Without it the fence
makes emergencies *quieter* than they are today, because a held message appears
in no digest section at all.

---

## 9. For counsel

Flags, not conclusions. No statute, deadline or agency name is asserted anywhere
in this document or in the code it specifies.

1. **Does an automated reply to a request for a reasonable accommodation or
   modification start, satisfy, or prejudice any duty?** And what is the park
   owner's exposure when LakeLife's software sends it under the owner's
   operational identity? This is the question the entire design is built around
   and we have answered it structurally (no machine reply) rather than legally.

2. **Must a recipient be told that a reply was machine-written?** Today the
   homeowner read path does not select the `ai` column and the bubble is
   hardcoded to "LakeLife dispatch," so a machine reply is indistinguishable
   from a human one. Fixing that is a missing column, not a policy — but whether
   disclosure is *required*, and whether it changes anything above, is for
   counsel.

3. **Indiana-specific vocabulary we deliberately left out of the rule table**,
   pending an answer: source-of-income / voucher protection; 55+ and other
   age-restricted housing categories; criminal-record screening guidance; the
   correct name of the state manufactured-housing regulator and the child-welfare
   agency initialism; "RUBS" as a term of art; township-trustee emergency
   assistance. Each of these should probably *stop the machine*; none should be
   rendered to a park owner as "you did something unlawful."

4. **Home-versus-lot termination.** A park tenant typically owns the home and
   rents only the pad. Which of the notice, abandonment, lien and towing
   questions does the software have to *enforce* rather than merely record?

5. **The long-stay RV guest.** Our population stamp is set once, at reservation,
   from the park's billing term threshold, and nothing re-evaluates it. A person
   who books two months and renews four times stays `rv_guest` for eight months.
   Where does the line between transient guest and tenant actually sit, and does
   elapsed occupancy move it regardless of the paper?

6. **Habitability response time.** Does a delayed or automated response to a
   habitability report bear on the landlord's duties, and does it matter that
   LakeLife is the software rather than the landlord? This determines how hard
   the SLA on the `hold` queue needs to be.

7. **The park owner's broadcast composer.** It does not exist yet. When built,
   it is the single message that reaches all 79 households at once, and nothing
   currently screens it. Rate limits, record-keeping and review requirements are
   worth specifying before it is written rather than after.

8. **Retention on the refusal log.** We chose 90 days as a placeholder. The
   right number is the shortest window that still allows someone to tune the
   screen. Also: is a coarse, pseudonymised log of "the fence fired" itself a
   record that carries obligations?

9. **Emergency acknowledgement.** We considered — and did not build — a fixed,
   non-generated acknowledgment that says call 911 and that a human has been
   paged. That is a static template with no model in the path. Whether sending
   one helps or hurts is a question for counsel and the owner, not for us.

10. **The screening handoff.** Confirming the existing posture: LakeLife is never
    a Consumer Reporting Agency, screening is a handoff to a licensed provider,
    we record only the human's decision, and there is no free-text field anywhere
    in a decision path. §5.4 lists the four mechanisms that hold that line. Please
    confirm those four are the right four.
