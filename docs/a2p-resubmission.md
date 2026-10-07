# A2P campaign resubmission — exact field text

Campaign `CMb9ca180daa1e8859869c18d53725e21c`, rejected 4 Oct 2026.
Brand `BNc2b2d71ac53facf53cf7248d2448ffd1` is still **approved** — only the
campaign was rejected, so this is an edit-and-resubmit, not a fresh start.

Every claim below was checked against the code on 7 Oct 2026. A carrier
submission that overstates what the software does is worse than the rejection
it is trying to clear.

---

## The three rejections, and what answers each

| Rejection | What it was | Answer |
|---|---|---|
| "consent cannot be a required condition for service or transaction completion" | Real. Sign-up pushed to `/verify`, whose only controls were *Text me a code* / *Resend* / *Wrong number?* — no way past. | **Fixed in code** (`b453ac5`): `/verify` now has **Skip for now**. |
| "a compliant privacy policy can not be verified" | Real. The policy said "we do not sell" and "no cross-context behavioural advertising" — CCPA language, not the mobile opt-in carve-out carriers look for. | **Fixed in code** (`b453ac5`): new *Your mobile number and text messages* section. |
| "Terms and Conditions issues" / opt-in link lacks Privacy + T&C | **Not a code defect.** The campaign gave `https://www.lakelife.ai/` as the opt-in URL, so the reviewer landed on the marketing homepage. | **Point the opt-in URL at `https://www.lakelife.ai/sms`**, which already carries all of it. |

---

## Message flow / "How do end users consent to receive messages?"

> End users opt in on LakeLife's own screens. LakeLife never buys, rents,
> imports or appends phone numbers, and a number is only ever added by the
> person it belongs to.
>
> A mobile-home-park resident opts in from their own rent screen at
> https://www.lakelife.ai/parks/my using a standalone checkbox that is
> unchecked by default and reads: "Yes — text this number about my lot and my
> rent at [park name]. Message and data rates may apply. I can stop them any
> time by replying STOP or turning this off here." The number is then confirmed
> with a one-time code before any other message is sent. A lake-home owner opts
> in the same way from their notification settings.
>
> SMS consent is entirely OPTIONAL. It is not bundled into our Terms of Service,
> and it is never a condition of creating an account, renting a lot, paying
> rent, or completing any transaction. The consent checkbox is separate from
> accepting the Terms and is never pre-ticked. Account creation offers an
> explicit "Skip for now", so an account can be created and used with no mobile
> number at all. Consent to operational messages and any marketing consent are
> recorded separately and neither implies the other.
>
> Full program details — message types, frequency, "Message and data rates may
> apply", HELP and STOP instructions, and the carrier disclaimer — are on a
> public page that needs no login: https://www.lakelife.ai/sms
>
> Privacy policy: https://www.lakelife.ai/privacy — states that mobile opt-in
> data is never shared with third parties or affiliates for marketing or
> promotional purposes, and is never sold.
>
> Terms of service: https://www.lakelife.ai/terms

## There is no separate "opt-in URL" field — it goes in Message flow

I said to change one. There isn't one to change, which is why you couldn't get
to it. Twilio error 30917's own checklist puts the links inside `message_flow`:

> `message_flow` includes a link to your privacy policy and a link to your
> terms and conditions.

So the whole resubmission is that one text box, plus the samples. Paste the
block above into **Message flow** / "How do end users consent to receive
messages?" and the URLs travel with it.

If the Brand's business-profile website is still the bare homepage, that is
fine — the brand is already approved and 30927 only requires the opt-in
evidence to be on the same domain, which `lakelife.ai/sms` is.

## Campaign description — unchanged, it was never the problem

The existing description is accurate; leave it.

## Sample messages — verified against the live send paths today

Each of these is the real body, not an invented sample:

1. `LakeLife: Weekly mow is done at 4521 Lakeview Dr — 4 photos are on your job page: [link] All good? Reply STOP to stop texts.`
   — `src/app/vendor/actions.ts:371`
2. `LakeLife: your crew couldn't make Pier removal at 4521 Lakeview Dr — no charge. Pick any open day to rebook: [link] Reply STOP to stop texts.`
   — `src/lib/automation.ts:1473`
3. `The Haven: you can see lot 9 - your rent and receipts - here: [link]` + newline + `Nothing about how you pay changes. We'll never text asking for a code or card details. Reply STOP to stop.`
   — `src/lib/invite-channels.ts:125` (`inviteSmsBody`), deliberately GSM-7 so it
   bills as one segment

**I nearly put an invented sample here.** My first draft wrote a rent-reminder
SMS — "your lot 9 rent of $542.53 is due 1 January" — and no such body exists.
`reminderBody` produces one email/paper letter and SMS has never been a channel
for it, so that sample would have described a message the software cannot send.
That is the exact failure `/sms` warns about in its own header, and a carrier
reviewer who asks to see a message matching a sample is entitled to get one.

If you change a message body in the code, change it here in the same commit —
`/sms` says the same thing about itself, and a sample nobody re-reads is a
marketing invention with a citation.

## Opt-out / help

- **Opt-out keywords:** `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT`
- **Opt-out message:** `LakeLife: you're unsubscribed and won't get more texts from us. Reply HELP for help.`
- **Help keywords:** `HELP, INFO`
- **Help message:** `LakeLife: help at hello@lakelife.ai or https://www.lakelife.ai/sms. Msg&data rates may apply. Reply STOP to stop.`

## The tick-boxes Twilio asks about this campaign

- Subscriber opt-in — **yes**
- Subscriber opt-out — **yes**
- Subscriber help — **yes**
- Embedded link — **yes** (job pages, rebooking, the rent screen)
- Embedded phone number — no
- Age-gated content — no
- Direct lending — no
- Affiliate marketing — **no**

---

## Before you resubmit

Deploy must be live, because the reviewer visits the real site. Check in a
logged-out browser:

1. https://www.lakelife.ai/sms loads without a login.
2. https://www.lakelife.ai/privacy shows *Your mobile number and text messages*,
   including message frequency and "message and data rates may apply".
3. https://www.lakelife.ai/sms shows the consent card itself — an unticked
   checkbox with the real sentence and Terms/Privacy links under it. This is the
   public opt-in evidence; error 30917 rejects a flow it can only read about.
4. Sign up with a new email and confirm **Skip for now** appears on `/verify`.

If any of those is missing, the deploy has not landed yet and resubmitting will
spend another review cycle.
