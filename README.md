# LakeLife — the app

This is the real LakeLife app (Phase 1). It's the "engine behind the cockpit"
your prototype designed. You don't edit code — you run it, click around, and
tell Claude Code what to change.

---

## What Phase 1 gives you

- The LakeLife look and feel, pulled straight from your prototype (logo, waves,
  colors, fonts).
- **Sign-up** three ways: Continue with Apple, Continue with Google, or email.
- **Text verification**: after signing up, we text a 6-digit code to the
  mobile number and confirm it (Twilio) — the same flow as the prototype.
- A **database** with every table from your launch plan, plus the security
  rules that keep the three roles apart (vendors can never see customer prices).
- Your **three lakes** loaded with their real ice-out and freeze dates.

---

## How to run it on your Mac

Open the **Terminal** app, then type these two lines (press Enter after each):

```
cd "/Users/brendonhome/Claude/LakeLife/LakeLife App Docs"
npm run dev
```

When it says **"Ready"**, open your web browser to:

> http://localhost:3000

That's your app running privately on your own computer. To stop it, click back
in Terminal and press **Ctrl + C**.

> Tip: just ask Claude Code *"Start the app for me"* and it'll do the two lines
> above for you.

---

## Where your keys go

Your keys live in a file called **`.env.local`** (already created for you, blank).
Open it in TextEdit and paste each key from your notebook after the `=` sign.
The file itself explains each one. The keys you need for Phase 1:

| In the file | From your notebook |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | SUPABASE URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | SUPABASE ANON KEY |
| `SUPABASE_SERVICE_ROLE_KEY` | SUPABASE SERVICE KEY |
| `TWILIO_ACCOUNT_SID` | TWILIO SID |
| `TWILIO_AUTH_TOKEN` | TWILIO TOKEN |
| `TWILIO_VERIFY_SERVICE_SID` | TWILIO VERIFY SID |
| `TWILIO_PHONE_NUMBER` | TWILIO PHONE NUMBER |

**After pasting keys, stop the app (Ctrl + C) and run `npm run dev` again** so it
picks them up. Until you do, the app still runs — it just shows a friendly
"add your keys" banner instead of letting you sign up.

---

## Two one-time setup steps inside Supabase

These happen in the Supabase website, not in code. Claude Code will walk you
through them — here's the summary:

1. **Create the database tables.** In Supabase → **SQL Editor** → New query,
   paste and run each file **in order**:
   - `supabase/migrations/0001_schema.sql`
   - `supabase/migrations/0002_rls.sql`
   - `supabase/seed/seed_lakes.sql`
   (Just ask Claude Code: *"Walk me through running the SQL files in Supabase."*)

2. **Turn on Google & Apple sign-in.** In Supabase → **Authentication →
   Providers**, enable Google and Apple. Each needs a couple of values from
   Google/Apple. This one has a few steps — **ask Claude Code to guide you**, or
   skip it for now and test with **email sign-up**, which needs no extra setup.

---

## What to click to test (pretend you're a lake homeowner)

1. Go to http://localhost:3000 — you should see the LakeLife home page.
2. Click **"New here? Create a profile →"**.
3. Use the **email** option: type your name, email, a password, and your real
   mobile number. Click **Create account**.
   - *(For the smoothest test, in Supabase → Authentication → Sign In / Up, you
     can temporarily turn OFF "Confirm email" so it logs you straight in. Turn it
     back on before real customers use it. Or just click the confirmation link
     from your inbox.)*
4. On the **Verify your mobile** screen, click **Text me a code**. Your real
   phone gets a real text (Twilio is live!).
5. Type the 6 digits → **Verify & continue**.
6. You land on a **Welcome** page with a checklist showing email + mobile
   verified. 🎉

If something looks off, tell Claude Code like you'd tell a contractor — e.g.
*"the code boxes are squished"* or *"I never got the text"* — and it'll fix it.

---

## Running the tests

```
npm test
```

This checks the phone-number handling and the pull-deadline rule
(freeze − 8 days). More tests get added as we build pricing and the photo gate.

---

## For the curious — where things live

```
src/app/            the pages (home, verify, welcome) and the API routes
src/components/      the reusable UI (logo, waves, sign-in modal, code entry)
src/lib/             Supabase + Twilio helpers, phone/date math + its tests
supabase/            the database: schema, security rules, and the lakes seed
.env.local           your secret keys (never shared, never committed)
```
