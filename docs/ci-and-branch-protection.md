# CI, and the two things it is not

Set up 15 Aug 2026. Written for the product owner, not for a developer.

## What it does

Every time code changes, GitHub runs three things by itself and puts a ✓ or ✗
next to the commit:

| | what it catches |
| --- | --- |
| **Typecheck** | code that refers to something that isn't there any more |
| **Tests** | 1,900 checks on pricing, the photo gate, role access, rent maths |
| **Lint** | dead imports, unused variables, some React mistakes |

That's it. It's a **smoke alarm**: it tells you something is wrong within about
a minute, so you don't find out from the app misbehaving.

Before this existed, five pull requests were merged with no signal at all
beyond "Vercel deployed it" — which a change can pass while breaking five
hundred tests. All five happened to be fine. None was checked.

## What it is NOT: a lock

**No check can currently stop anything.** A ✗ appears and the code can still be
merged, because `main` has no protection rules. Everything is advisory.

That is a reasonable place to be while one person merges everything. It is
worth knowing rather than assuming, because "the tests block it" is the kind of
belief that is comfortable and wrong.

## What it is NOT: a build check

The workflow deliberately does not run `next build`. It can't — the build reads
the database while it renders, so it needs Supabase credentials, and putting
production secrets into GitHub to duplicate a build **Vercel already runs on
every pull request with the real ones** would be worse than useless. Vercel is
the build check.

## The one advisory step

`Lint` ends with `continue-on-error: true`, which means lint problems are
reported but never turn the tick red. That was deliberate: when CI was added
there were 11 lint errors, and a check that is always red is one everybody
learns to scroll past — worse than no check, because it looks like coverage.

**Lint is now at zero**, so that line could be deleted. Deleting it means a
future lint error joins the alarm. Nobody needs to hurry: it changes nothing
until something new breaks lint, and it still would not BLOCK anything.

Editing this file needs the `workflow` permission, which Claude's token does
not have on purpose — a tool that can silently add something that runs on every
change is a tool worth restricting. Do it in GitHub's web editor:
`https://github.com/BDDevCo/lakelife/edit/main/.github/workflows/ci.yml`

## Branch protection — the actual lock, when it is time

Turning checks from advisory into required is a **repository setting**, not a
change to this file:

> Settings → Branches → Add branch protection rule → Branch name `main` →
> tick **Require status checks to pass before merging** → select **CI**

After that a red ✗ genuinely prevents a merge.

**Do not turn this on yet.** While one person merges everything, it mostly
means telling yourself you are not allowed to do things — and the first time it
gets in the way at 11pm the temptation is to switch it off permanently, which
costs more than it ever saved.

**Turn it on when any of these becomes true:**

- somebody other than Brendon can push to this repository;
- work is merged that a person did not read first — parallel Claude sessions
  opening their own PRs is exactly this, and it has already happened once;
- there are paying customers, so a broken merge costs money rather than an
  afternoon.

Until then the alarm is the part that earns its keep, and it is already
running.

## If a run ever fails

Open the ✗, click the failed step, read the last twenty lines. Tests name the
file and the assertion. Typecheck names the file and line. Neither needs a
developer to interpret — paste it to Claude and it will pick it up from there.
