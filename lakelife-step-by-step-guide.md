# LakeLife — The Super Simple, Step-by-Step Guide
**Read this like a recipe. Do one step, check it off, do the next one. No skipping ahead.**

---

## First: how this whole thing works (30 seconds)

You are the **boss**. Claude Code is your **builder**.

The builder is really good at building, but it only builds what you tell it to. Lucky for you, we already wrote down everything it needs in the three files you have. So your job is basically:

1. Set up the workshop (this guide, ~1–2 hours, one time)
2. Hand the builder the blueprints
3. Say "build phase 1" ... then "build phase 2" ... and so on
4. Click around after each phase to make sure you like it

That's it. You never write code. You just click, copy, paste, and say yes or no.

---

## Little dictionary (words you'll bump into)

| Word | What it actually means |
|---|---|
| **Folder / project** | A regular folder on your computer where all the LakeLife stuff lives |
| **Repo** (GitHub) | An automatic save system. Every change gets saved forever. It's your undo button |
| **API key** | A secret password that lets your app talk to another company's service (like Twilio for texting). Treat keys like the keys to your truck |
| **.env.local** | A special text file where all your secret keys go. It stays on your computer only |
| **Deploy** | Push a button and your app goes live on the internet |
| **Localhost** | Your app running privately on just your computer, so you can test before anyone sees it |

---

# PART A — Set up your workshop (do this today)

## Step 1: Have your three LakeLife files handy

You've already got these saved in OneDrive under **LakeLife → LakeLife App Docs** — perfect, that's your file cabinet:
- `lakelife.html` (the clickable prototype)
- `lakelife-beta-launch-plan.md` (the master plan)
- `lakelife-claude-code-kickoff.md` (the builder's instructions)

✅ **Done when:** you can open that OneDrive folder in Finder and see all three files.

## Step 2: Install Claude Code

1. On your Mac (not your phone — you'll want the big screen for this), go to **claude.ai/download** and grab the **Mac** version of the Claude Desktop app.
2. Open the downloaded file and drag the Claude icon into your **Applications** folder, like any Mac app. Open it from Applications and sign in with your normal Claude account.
3. Look at the top of the app — you'll see tabs. Click the one called **Code**.

✅ **Done when:** you're looking at the Code tab in the Claude Desktop app.

## Step 3: Make the project folder (NOT inside OneDrive — this matters)

Your planning docs stay in OneDrive — that's your file cabinet. But the folder where Claude Code *builds* needs to be a plain folder on your Mac, **outside** OneDrive. Why: the build creates thousands of tiny files that would choke OneDrive sync, OneDrive can "sync" a file while the builder is mid-edit and corrupt it, and your secret-keys file should never copy to the cloud. Docs → OneDrive. Code → local. (The code gets its own backup later — GitHub, in Step 17.)

1. Open **Finder**.
2. In the menu bar at the top, click **Go → Home** (or press **Cmd + Shift + H**). This is your Mac's home folder — OneDrive doesn't touch it.
3. Your build folder lives at: **Home → Claude → LakeLife**. ✓ (Already made!)
4. **Copy** your three files from OneDrive's **LakeLife App Docs** into that LakeLife folder. To copy instead of move, hold the **Option (⌥)** key while you drag them over.

✅ **Done when:** **Home → Claude → LakeLife** has 3 files in it — and your OneDrive copies are still sitting right where they were.

## Step 4: Make the CLAUDE.md file (the builder's rulebook)

This is the one file you create yourself. It's just copy-paste.

1. Open the file `lakelife-claude-code-kickoff.md` (double-click it — it opens like a document).
2. Find **Part 2**. You'll see a big gray box of text that starts with `# LakeLife — Project Brief for Claude Code`.
3. Select ALL the text inside that gray box and copy it.
4. Open **TextEdit** (press **Cmd + Space**, type "TextEdit", hit enter).
5. Important first move: in the menu bar click **Format → Make Plain Text**. (This turns off the fancy formatting that would break the file. If you don't see that option, it's already in plain text — carry on.)
6. Paste the text in.
7. Press **Cmd + S** to save. Name it exactly `CLAUDE.md` and save it inside **Home → Claude → LakeLife** (the build folder, not the OneDrive one).
   - TextEdit will ask about using the ".md" ending — click **"Use .md"**. If it ever sneaks a `.txt` on the end, just rename the file in Finder and delete the `.txt` part.

✅ **Done when:** your `lakelife` folder has **4** files: the 3 you downloaded + `CLAUDE.md`.

> **Why this matters:** Claude Code automatically reads `CLAUDE.md` every single time it works. It's like the rules taped to the job-site trailer wall. It contains the big ones — vendors never see prices, no photos = no payout, gate codes stay locked up.

---

# PART B — Sign up for your services (do this today or tomorrow)

Your app needs helpers: one company stores your data, one sends texts, one shows maps, and so on. You sign up for each (most are **free to start**), and each gives you a secret key. You'll collect the keys as you go.

**Get a keys notebook first:** open the **Notes** app on your Mac (or TextEdit) and start a note called `LakeLife keys` — keep it OUT of the lakelife build folder. Every time a website gives you a key, paste it there with a label. You'll hand these to the builder later, and it will put them in the right place.

Do these one at a time. Each takes 5–10 minutes.

## Step 5: GitHub (the forever-save system)
1. Go to **github.com** → Sign up (use your business email).
2. That's it for now. Just have the account. Claude Code will use it later.

## Step 6: Supabase (the filing cabinet — database, logins, photo storage)
1. Go to **supabase.com** → Start your project → sign in **with your GitHub account** (easiest).
2. Click **New Project**. Name: `lakelife`. It will ask you to create a **database password** — make one up, and paste it into your keys notebook labeled `SUPABASE DB PASSWORD`.
3. Pick the region closest to Indiana (US East). Click Create. Wait ~2 minutes while it sets up.
4. In your new project, find **Settings → API**. You'll see:
   - **Project URL** → copy into notebook as `SUPABASE URL`
   - **anon public key** → notebook as `SUPABASE ANON KEY`
   - **service_role key** → notebook as `SUPABASE SERVICE KEY` ⚠️ *this one is extra-secret — never goes anywhere except the .env.local file*

## Step 7: Vercel (the "put it on the internet" button)
1. Go to **vercel.com** → Sign up → again, sign in **with GitHub**.
2. Done for now. When the builder is ready to go live, it connects here.

## Step 8: Twilio (the texting company)
1. Go to **twilio.com** → Sign up. It will text YOUR phone a code to verify you — that's the same trick your app will do to customers.
2. From the main dashboard (they call it the Console), copy:
   - **Account SID** → notebook as `TWILIO SID`
   - **Auth Token** (click to reveal) → notebook as `TWILIO TOKEN`
3. Click **Get a phone number** → buy a number (about $1/month). Notebook: `TWILIO PHONE NUMBER`.
4. In the left menu find **Verify** → create a new Verify Service, name it `LakeLife`. Copy its **Service SID** → notebook as `TWILIO VERIFY SID`.

## Step 9: Resend (the email sender — receipts & welcome emails)
1. Go to **resend.com** → Sign up.
2. Create an **API key** → notebook as `RESEND KEY`.

## Step 10: Google Maps (real maps + drive times)
1. Go to **console.cloud.google.com** → sign in with a Google account → create a project called `lakelife`.
2. It will ask for a credit card. That's normal — Google gives a free monthly credit that covers you at beta size. You'll likely pay $0.
3. In the search bar up top, search **"Maps JavaScript API"** → Enable it. Then search **"Directions API"** → Enable it too.
4. Go to **APIs & Services → Credentials → Create Credentials → API key**. Copy it → notebook as `GOOGLE MAPS KEY`.

## Step 11: Buy your domain (your app's address)
1. Go to a registrar (Namecheap, GoDaddy, Cloudflare — any is fine).
2. Search for the name you want — try `golakelife.com`, `lakelifeapp.com`, `mylakelife.com` — buy one (~$10–15/year).
3. Notebook: `DOMAIN = whatever you bought`. Don't do anything else with it yet.

## Step 12: (Parallel — no computer needed) The business stuff only you can do
While you work through the build, get these moving because they take weeks:
- Form the **LakeLife entity** + open its **bank account**
- Call your buddy: start **payment processor underwriting** under that entity, and get the **split-payments question answered in writing** (it's explained in the launch plan, section 3)
- Send your attorney the launch plan section 2 — the **three documents** (customer terms, privacy policy, vendor agreement)

✅ **Done with Part B when:** your keys notebook has about 9 labeled lines in it, and the business stuff is in motion.

---

# PART C — Start the build (the fun part)

## Step 13: Open your project in Claude Code

1. Open **Claude Desktop → Code tab**.
2. It will ask which folder to work in. Choose **Home → Claude → LakeLife** — NOT the OneDrive one.
3. You'll see a chat box, just like talking to me — except this Claude can create and edit files in that folder.

## Step 14: Paste the Phase 1 prompt

Copy this whole thing and paste it into Claude Code, then hit enter:

> Read CLAUDE.md, lakelife.html, and lakelife-beta-launch-plan.md fully. Then scaffold the Next.js + Supabase project: repo structure, env template, Supabase schema from §5 of the plan (all tables, with row-level security enforcing the three roles), and the design system pulled from the prototype (colors, fonts, wave motif, cards, pills, buttons). Build sign-in: Apple, Google, and email signup; required email; Twilio Verify SMS code on the mobile number, matching the prototype's flow. Seed the three lakes with their ice-out/freeze dates. Tell me how to run it locally and what to click. I am not a developer — when you need something from me (a key, a click in a dashboard, a yes/no), stop and ask me in plain English.

That last sentence is important — it tells the builder to treat you like the boss, not like another programmer.

## Step 15: What happens next (so nothing surprises you)

- Claude Code will **think out loud**, create a bunch of files, and sometimes ask **"May I run this?"** — it's asking permission to do setup work in your folder. Saying yes is normal. If you don't understand what it's asking, type: **"Explain that like I'm not a developer, then ask me again."**
- At some point it will create a file called **`.env.local`** and say "add your keys." That's your keys notebook moment: it will either ask you to paste the keys into the chat one by one, or tell you to open `.env.local` in TextEdit and fill in the blanks. Either way, copy from your Notes, paste, done.
- When Phase 1 finishes, it will say something like **"run `npm run dev` and open localhost:3000."** Just ask it: **"Start it for me and tell me exactly what to click to test sign-up."** It will.

## Step 16: Test like a customer

Open the local app in your browser and pretend you're a lake homeowner:
- Sign up with your real email
- Get the real text code on your real phone (Twilio is live — this actually works!)
- Poke every button

When something looks wrong, tell the builder like you'd tell a contractor. Good bug reports sound like: *"On my screen the code boxes are squished together"* or *"I never got the text."* It will fix it, then you test again.

## Step 17: Save your progress

After Phase 1 works, type into Claude Code:

> Commit everything with a clear message and push it to a new private GitHub repo called lakelife.

That's the forever-save. Do this after **every** phase. If anything ever goes sideways, nothing is lost.

## Step 18: The rest of the build — one phase at a time

Open `lakelife-claude-code-kickoff.md`, Part 3. There are 7 phase prompts. You just did #1. The pattern for every phase is the same:

**Paste the next phase prompt → let it build → test in your browser → report anything weird → when happy, commit & push → next phase.**

In plain words, here's what each remaining phase gives you:
- **Phase 2:** the signup wizard (pier sections, boats by the foot, toys) + the friendly recap + prices that calculate themselves
- **Phase 3:** customers can actually book services on the calendar
- **Phase 4:** the vendor app — routes, navigation, photo-required completion, flag items
- **Phase 5:** your ops dashboard + the robot that builds routes every night at 8pm
- **Phase 6:** real money — wait to start this until your buddy's underwriting is done and he's handed you the payment keys
- **Phase 7:** polish it, make it installable on phones, and put it live on your domain

Pace: a few evenings a week gets you through Phases 1–5 in about a month. Right on schedule for onboarding vendors in late September and going live for the fall pull season.

---

# When you're stuck (copy-paste these exact sentences)

| Situation | Type this into Claude Code |
|---|---|
| You don't understand what it just said | "Explain that in plain English, like I'm not a developer." |
| Something broke | "Something's wrong. Here's what I see: [describe it]. Please figure out why and fix it." |
| It's asking for a key you don't recognize | "Which service is this key from, and walk me through exactly where to click to get it." |
| You want to see it | "Start the app for me and tell me what to click to test what you just built." |
| You're worried it changed too much | "Show me a simple summary of everything you changed and why." |
| Total disaster, panic | "Roll back to the last commit that worked." (This is why Step 17 matters!) |

And when you hit a **business** decision mid-build — pricing, vendor terms, the processor call — come back to this chat. Builder builds; we think through the business stuff here.

---

# The whole thing on one page ✂️

☐ 1. Files in OneDrive → LakeLife App Docs ✓ (already done!)
☐ 2. Install Claude Desktop (Mac) → Code tab
☐ 3. Home → Claude → LakeLife folder (outside OneDrive) ✓ → Option-drag the 3 files in
☐ 4. Create `CLAUDE.md` from the kickoff kit's Part 2
☐ 5–11. Sign up: GitHub, Supabase, Vercel, Twilio, Resend, Google Maps, domain → keys into notebook
☐ 12. Business track: entity, bank, processor underwriting, attorney docs
☐ 13. Open folder in Claude Code
☐ 14. Paste Phase 1 prompt
☐ 15–16. Answer its questions, paste keys, test as a customer
☐ 17. Commit & push (every phase!)
☐ 18. Phases 2 → 7, one at a time
☐ 🌊 October: 10–15 real homeowners, real piers coming out of real water

You've built buildings from dirt. This is the same thing with fewer permits. One step at a time.
