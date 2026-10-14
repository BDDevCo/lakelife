import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MANAGER_CAN, MANAGER_CANNOT, cleanInviteEmail, handoffEmailLines,
  handoffQuietSentence, inviteBlockMessage, inviteStanding, joinHandoffWords,
} from "./handoff-helpers";

/**
 * "I NEED TO HAND THIS OFF TO AN ADMIN TO MANAGE."
 *
 * Verified against production on 13 Oct 2026:
 *
 *   park_members : 1 row, role='owner'.  managers: 0.
 *   users.role   : an ENUM of exactly (owner, vendor, ops).
 *
 * `park_members.role` has allowed 'manager' since migration 0052, and the word
 * is READ in four places that gate real behaviour. It was WRITTEN by exactly
 * one statement in the whole product — `createPark`, hard-coding "owner".
 *
 * A working, enforced, tested permission tier with no door to it: the
 * no-caller shape, at the scale of an entire role. There was no screen
 * anywhere that could put a second person on a park.
 */

const SRC = (f: string) =>
  readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const actions = strip(SRC("./handoff-actions.ts"));
const component = strip(SRC("../../components/ParkPeople.tsx"));
const portal = strip(SRC("../portal/page.tsx"));
const welcome = strip(SRC("../welcome/page.tsx"));

/**
 * The LAST migration to define each thing, never a hard-coded filename: a
 * guard resolved from `0173_....sql` once passed against a definition three
 * migrations had since replaced.
 */
const lastMigrationMatching = (re: RegExp) => {
  const dir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let found = "";
  for (const f of files) {
    const body = readFileSync(dir + f, "utf8");
    if (re.test(body)) found = body;
  }
  return found;
};

const migration = lastMigrationMatching(/create table if not exists public\.park_member_invites/);
const memberGuard = lastMigrationMatching(/function public\.guard_manager_was_invited\(\)/);

describe("the door exists at all", () => {
  it("there is now a writer for a manager membership", () => {
    expect(actions.length, "the scan is measuring nothing").toBeGreaterThan(2000);
    expect(actions).toMatch(/from\("park_members"\)[\s\S]{0,200}\.insert\(/);
    // From the invitation's own role column — see the next block for why.
    expect(actions).toMatch(/role: inv\.role/);
  });

  it("and a screen that reaches it", () => {
    expect(component).toMatch(/inviteParkManager\(/);
    const page = SRC("./people/page.tsx");
    expect(page).toMatch(/<ParkPeople view=\{view\} \/>/);
    // A screen nothing links to is the same defect one level up.
    const nav = SRC("../../components/ParkNav.tsx");
    expect(nav).toContain('{ href: "/park/people"');
    expect(nav).toMatch(/matches: \[[^\]]*"\/park\/people"/);
  });
});

/**
 * THE ONE THING THIS DOOR MAY NEVER DO.
 *
 * An owner can publish the park to the public internet and commit it to
 * buying services. "The invite link that creates a second one of those" is not
 * a thing to build by accident on the way to a handoff, so it is refused in
 * three independent places.
 */
describe("this door can never mint an owner", () => {
  it("the table refuses any role but manager", () => {
    expect(migration.length, "0193 was not found").toBeGreaterThan(1000);
    expect(migration).toMatch(/role\s+text not null default 'manager' check \(role = 'manager'\)/);
  });

  it("the invite action never names a role, so it cannot name the wrong one", () => {
    const insert = actions.match(/from\("park_member_invites"\)\s*\.insert\(\{[^}]*\}\)/);
    expect(insert, "the invitation insert moved — repoint this").not.toBeNull();
    expect(insert![0]).not.toMatch(/role/);
  });

  it("nothing in the module writes an owner membership except createPark", () => {
    // The one legitimate writer. If a second appears, it is this test's job to
    // make somebody say so out loud.
    // Scoped to a WRITE: `role: "owner" | "manager"` is a type annotation in
    // this same file, and a regex that cannot tell those apart is a test that
    // fails for the wrong reason.
    expect(actions).not.toMatch(/\.insert\(\{[^}]*role: "owner"/);
    const created = strip(SRC("../ops/parks-actions.ts"));
    expect((created.match(/role: "owner"/g) ?? []).length).toBe(1);
  });

  it("and removing the park owner is refused, by the action AND the database", () => {
    expect(actions).toMatch(/who\.role === "owner"/);
    expect(migration).toMatch(/guard_park_keeps_an_owner/);
    expect(migration).toMatch(/before delete on public\.park_members/);
    // The reason, which is why it is structural: getMyPark resolves a park
    // ONLY through park_members, so a park with no owner row is invisible to
    // every screen in the module.
    expect(migration).toMatch(/only owner/i);
  });
});

describe("only the owner changes who runs the park", () => {
  it("every write asserts the OWNER role, not merely membership", () => {
    // A manager who could invite another manager could hand out access to the
    // owner's rent roll.
    for (const fn of [
      "inviteParkManager", "resendParkManagerInvite",
      "revokeParkManagerInvite", "removeParkManager",
    ]) {
      const at = actions.indexOf(`export async function ${fn}`);
      expect(at, `${fn} is gone — repoint this test`).toBeGreaterThan(-1);
      const body = actions.slice(at, at + 400);
      expect(body, `${fn} does not assert the owner role`)
        .toMatch(/assertOwner\(parkId\)/);
    }
  });

  it("assertOwner checks membership first and then the role", () => {
    const at = actions.indexOf("async function assertOwner");
    const body = actions.slice(at, at + 600);
    expect(body).toMatch(/assertMyPark\(parkId\)/);
    expect(body).toMatch(/membership\.role !== "owner"/);
    // Two different sentences: "not your park" and "not your call" are
    // different facts about somebody's account.
    expect(body).toMatch(/DENIED/);
    expect(body).toMatch(/OWNER_ONLY/);
  });

  it("an id from the browser is never trusted to name its own park", () => {
    // Every row-scoped act filters on park_id as well as the id.
    for (const m of actions.matchAll(/\.eq\("id", inviteId\)/g)) {
      const after = actions.slice(m.index ?? 0, (m.index ?? 0) + 120);
      expect(after, "an invitation is acted on without checking it is this park's")
        .toMatch(/\.eq\("park_id", parkId\)/);
    }
    expect((actions.match(/\.eq\("id", inviteId\)/g) ?? []).length).toBeGreaterThan(1);
  });

  it("a manager sees the list and cannot change it", () => {
    expect(component).toMatch(/view\.viewerIsOwner && /);
    expect(component).toMatch(/!view\.viewerIsOwner/);
  });
});

/**
 * THE PROMISE ON SCREEN CANNOT DRIFT FROM WHAT IS ENFORCED.
 *
 * The invitation tells somebody what they are being given. If a third
 * owner-only act is added and this list is not, the email over-promises — and
 * the person who accepted finds a button that refuses them.
 */
describe("what a manager cannot do matches the gates that exist", () => {
  it("ONE LINE OF COPY PER OWNER-ONLY ACT, and no more", () => {
    // THE DRIFT THIS CATCHES, and it caught it on the first run: adding this
    // module's own `assertOwner` made a THIRD owner-only act, and the
    // invitation still listed two — so it told somebody they could do
    // everything except publish and buy, including inviting other people.
    //
    // Scanned by MODULE rather than by occurrence: a module may refuse the
    // same way in four actions, and that is one act, not four.
    const dir = fileURLToPath(new URL("./", import.meta.url));
    const refusing: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.includes(".test."))) {
      const body = strip(readFileSync(dir + f, "utf8"));
      // A REFUSAL, not a read. `viewerIsOwner: membership.role === "owner"` is
      // a fact handed to a screen so it can draw the right buttons; it does
      // not stop anybody doing anything, so it is not an act to describe.
      const refuses =
        /role !== "owner"/.test(body) ||
        /return role === "owner";/.test(body);
      if (refuses) refusing.push(f);
    }
    expect(
      refusing.sort(),
      `modules that refuse a manager: ${refusing.sort().join(", ")} — ` +
      "if this set changed, MANAGER_CANNOT has to change with it",
    ).toEqual(["actions.ts", "handoff-actions.ts", "service-helpers.ts"]);
    expect(MANAGER_CANNOT).toHaveLength(refusing.length);
  });

  it("and names all three: publishing, buying, and handing it on", () => {
    const words = MANAGER_CANNOT.join(" ");
    expect(words).toMatch(/public/i);
    expect(words).toMatch(/buying a service|buy/i);
    expect(words).toMatch(/who helps run it/i);
    // Each gate's own module still says the same thing in its own words.
    expect(strip(SRC("./actions.ts"))).toMatch(/Only the park owner can publish the park/);
    expect(strip(SRC("./service-helpers.ts"))).toMatch(/return role === "owner";/);
    expect(actions).toMatch(/Only the park owner can change who helps run it/);
  });

  it("the email and the screen draw from the same two lists", () => {
    // Copy in two files is two sets of promises to keep true.
    expect(component).toMatch(/MANAGER_CAN\.map/);
    expect(component).toMatch(/MANAGER_CANNOT\.map/);
    const lines = handoffEmailLines({
      parkName: "The Haven", invitedByName: "Brendon", note: null,
      joinUrl: "https://www.lakelife.ai", email: "mike@example.test",
    }).join(" ");
    for (const c of MANAGER_CAN) expect(lines).toContain(c);
    for (const c of MANAGER_CANNOT) expect(lines).toContain(c);
  });

  it("the email says what is being handed over before it says how to accept", () => {
    const lines = handoffEmailLines({
      parkName: "The Haven", invitedByName: "Brendon", note: null,
      joinUrl: "https://www.lakelife.ai", email: "mike@example.test",
    });
    const body = lines.join("\n");
    // A park membership is read access to every household's name, lot and
    // payment history. Somebody should know that is what the link does.
    expect(body).toMatch(/payment history/);
    const warned = lines.findIndex((l) => /payment history/.test(l));
    const accept = lines.findIndex((l) => /create your account/i.test(l));
    expect(warned).toBeGreaterThan(-1);
    expect(accept).toBeGreaterThan(warned);
    // And nothing happens until they do.
    expect(body).toMatch(/nothing happens until you sign in/i);
  });

  it("THE LINK IS THE BARE SITE, because /portal bounces a new visitor", () => {
    // The defect this replaced: /portal redirects a visitor with no session
    // straight to the marketing homepage, so the first draft's link bounced
    // the one reader it was written for and changed the URL under them on the
    // way. The crew invitation links the bare site for the same reason.
    expect(actions).not.toMatch(/joinUrl: `\$\{site\}\/portal`/);
    expect((actions.match(/joinUrl: site/g) ?? []).length,
      "both the invite and the resend have to use the bare site").toBe(2);
  });

  it("and it says CREATE an account, not just sign in", () => {
    // Somebody being handed a park usually has no LakeLife account at all.
    // "Sign in" is copy that instructs an action the screen does not offer
    // them yet.
    const body = handoffEmailLines({
      parkName: "The Haven", invitedByName: "Brendon", note: null,
      joinUrl: "https://www.lakelife.ai", email: "mike@example.test",
    }).join(" ");
    expect(body).toMatch(/create your account/i);
    expect(body).toMatch(/or sign in, if you already have one/i);
    // THE ADDRESS IS THE WHOLE MECHANISM: 0193 refuses an acceptance by any
    // other account, so signing up with a different one is the single mistake
    // that makes this email do nothing. It is named, and the consequence said.
    expect(body).toContain("mike@example.test");
    expect(body).toMatch(/THIS email address/);
    expect(body).toMatch(/different address/i);
  });

  it("the note is theirs, in their words, and only when there is one", () => {
    const withNote = handoffEmailLines({
      parkName: "The Haven", invitedByName: "Brendon",
      note: "Covering while I'm away in February.", joinUrl: "x", email: "mike@example.test",
    }).join(" ");
    expect(withNote).toContain("Covering while I'm away in February.");
    const without = handoffEmailLines({
      parkName: "The Haven", invitedByName: "Brendon", note: "   ", joinUrl: "x", email: "mike@example.test",
    }).join(" ");
    expect(without).not.toMatch(/Their note/);
  });

  it("an unnamed inviter still reads as a sentence", () => {
    const l = handoffEmailLines({
      parkName: "The Haven", invitedByName: null, note: null, joinUrl: "x", email: "mike@example.test",
    }).join(" ");
    expect(l).toMatch(/^The owner has asked you/);
    expect(l).not.toMatch(/undefined|null/);
  });
});

describe("the addresses it refuses, and what it says", () => {
  it("takes an ordinary address, lower-cased", () => {
    expect(cleanInviteEmail("  Mike@Example.COM ")).toBe("mike@example.com");
  });

  it("refuses what is not an address", () => {
    for (const bad of ["", "   ", "mike", "mike@", "@example.com", "mike@example", "a@b"]) {
      expect(cleanInviteEmail(bad), `accepted ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("AN EXISTING ACCOUNT IS FINE — that is the normal case", () => {
    // Unlike the crew doors. The person he hands a park to may well already be
    // a LakeLife homeowner, and telling him to find them a second email would
    // be the software inventing a problem.
    expect(actions).not.toMatch(/checkInviteEmail/);
    expect(actions).toMatch(/kind: "ok"/);
  });

  it("but a crew account is refused, and says why", () => {
    // /portal rewrites users.role to 'vendor' when it claims a crew
    // invitation, so one account cannot be both — and which identity wins is a
    // product decision, not something an invite door settles in passing.
    const m = inviteBlockMessage({ kind: "is_a_crew" });
    expect(m).toMatch(/crew account/i);
    expect(m).toMatch(/different email/i);
    expect(actions).toMatch(/existing\.role === "vendor"/);
  });

  it("his own email, an ops account, and somebody already on the park", () => {
    expect(inviteBlockMessage({ kind: "is_you" })).toMatch(/your own email/i);
    expect(inviteBlockMessage({ kind: "is_ops" })).toMatch(/operations account/i);
    expect(inviteBlockMessage({ kind: "already_on_this_park", role: "owner" }, "Mike"))
      .toMatch(/Mike already owns this park/);
    expect(inviteBlockMessage({ kind: "already_on_this_park", role: "manager" }, "Mike"))
      .toMatch(/already helps run this park/);
  });

  it("an open invitation names the move on the screen he is on", () => {
    const m = inviteBlockMessage({ kind: "already_invited" });
    expect(m).toMatch(/Withdraw it below/);
    // And the screen has that control.
    expect(component).toMatch(/Withdraw it/);
  });

  it("A FAILED READ IS NOT A FREE ADDRESS, and nothing was written", () => {
    const m = inviteBlockMessage({ kind: "read_failed" });
    expect(m).toMatch(/couldn't check/i);
    expect(m).toMatch(/nothing has been sent/i);
    // Three reads in the block check, and each one's failure is its own case.
    expect((actions.match(/kind: "read_failed"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(actions).not.toMatch(/\.error\) return \{ kind: "ok" \}/);
  });

  it("a unique-violation on the insert is read as the real case, not as retry", () => {
    // A bare INSERT's 23505 reads as `data: null`, and "try again" for a path
    // that cannot succeed is a loop this codebase has already paid for.
    expect(actions).toMatch(/error\?\.code === "23505"/);
    expect(actions).toMatch(/kind: "already_invited"/);
  });
});

describe("the invitation is a row first and an email second", () => {
  it("the insert comes before the send", () => {
    const insert = actions.indexOf('from("park_member_invites")');
    const send = actions.indexOf("await sendEmail(");
    expect(insert).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(insert);
  });

  it("a failed send leaves the invitation standing, and says so", () => {
    // The reverse order is how somebody ends up holding a link that matches no
    // record. And a send failure that reported `ok: false` would read as "no
    // invitation exists", which is false and un-actionable.
    expect(actions).toMatch(/if \(!sent\.ok\) \{[\s\S]{0,400}ok: true,/);
    expect(actions).toMatch(/is invited, but the email didn't go out/);
    expect(actions).toMatch(/press Send again/);
  });
});

describe("taking up the invitation", () => {
  it("is claimed at both doors, BEFORE anything can rewrite users.role", () => {
    // claimCrewInvite flips any non-vendor/non-ops user to 'vendor' on an
    // email match, which would empty the services menu of somebody who had
    // just been given a park to run.
    const claim = portal.indexOf("claimParkInvite(user.id");
    const crew = portal.indexOf("claimCrewInvite(user.id");
    expect(claim, "/portal never claims a park invitation").toBeGreaterThan(-1);
    expect(crew).toBeGreaterThan(-1);
    expect(claim, "a park invitation is claimed after the crew role rewrite")
      .toBeLessThan(crew);
  });

  it("and /welcome routes them to the door that owns the claim", () => {
    const invite = welcome.indexOf("hasParkInvite()");
    const property = welcome.indexOf("listProperties()");
    const crew = welcome.indexOf("hasCrewInvite()");
    expect(invite).toBeGreaterThan(-1);
    // Before the lake-house wizard, which is the screen this bug landed them
    // on, and before anything reads them as a crew.
    expect(invite).toBeLessThan(property);
    expect(invite).toBeLessThan(crew);
  });

  it("an existing member is never asked to accept again", () => {
    const member = portal.indexOf("isParkMember(user.id)");
    const claim = portal.indexOf("claimParkInvite(user.id");
    expect(member).toBeLessThan(claim);
  });

  it("THE MEMBERSHIP IS WRITTEN BEFORE THE INVITATION IS STAMPED", () => {
    const at = actions.indexOf("export async function claimParkInvite");
    const body = actions.slice(at);
    const member = body.indexOf('from("park_members")');
    const stamp = body.indexOf("accepted_at: new Date");
    expect(member).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    // The other order stamps an invitation as taken up by somebody who was
    // never given the park. This order's worst case is an open invitation
    // against a membership that exists — visible, and fixable.
    expect(stamp, "the invitation is closed out before the membership exists")
      .toBeGreaterThan(member);
  });

  it("already-a-member is not treated as a failure to claim", () => {
    const at = actions.indexOf("export async function claimParkInvite");
    const body = actions.slice(at);
    expect(body).toMatch(/memberErr\.code !== "23505"/);
  });

  it("a failed read is not 'no invitation' — it is logged and the link survives", () => {
    const at = actions.indexOf("export async function claimParkInvite");
    const body = actions.slice(at, at + 1600);
    expect(body).toMatch(/console\.error\("\[handoff\] whether they were invited to a park/);
  });

  it("the database refuses an acceptance by the wrong account", () => {
    // The structural half. An invitation to one address must never become
    // authority over somebody else's rent money because a lookup matched the
    // wrong row.
    expect(migration).toMatch(/lower\(u\.email\) = new\.email/);
    expect(migration).toMatch(/only be taken up by the address it was sent to/);
  });

  it("THE MEMBERSHIP ITSELF HAS TO HAVE BEEN INVITED", () => {
    // 0194, and it exists because mutating this very file found the hole:
    // drop one `.is("revoked_at", null)` from the claim's SELECT and a
    // WITHDRAWN invitation still worked. The membership insert succeeded, the
    // person was on the park, and only the stamp afterwards hit 0193's
    // trigger. The record was protected; the authority was not.
    //
    // So the order the application writes them in no longer matters: a
    // manager row may exist only because an invitation to that account's own
    // email was open on that park.
    expect(memberGuard.length, "0194 was not found").toBeGreaterThan(500);
    expect(memberGuard).toMatch(/before insert on public\.park_members/);
    expect(memberGuard).toMatch(/i\.revoked_at is null/);
    // Their OWN address. An invitation to anybody else never satisfies it.
    expect(memberGuard).toMatch(/lower\(u\.email\) into addr/);
    expect(memberGuard).toMatch(/i\.email = addr/);
    // An acceptance by somebody else is not their invitation either.
    expect(memberGuard).toMatch(/i\.accepted_user_id = new\.user_id/);
    // And an owner is out of scope, or createPark could not create a park.
    expect(memberGuard).toMatch(/if new\.role <> 'manager' then/);
    expect(memberGuard).toMatch(/revoke all on function public\.guard_manager_was_invited\(\) from public, anon, authenticated/);
  });

  it("and the app still filters the withdrawn ones, belt and braces", () => {
    const at = actions.indexOf("export async function claimParkInvite");
    const body = actions.slice(at, at + 900);
    expect(body).toMatch(/\.is\("accepted_at", null\)/);
    expect(body).toMatch(/\.is\("revoked_at", null\)/);
  });

  it("and a withdrawn invitation cannot be accepted afterwards", () => {
    // The stale link in somebody's inbox: the one-ending CHECK is satisfied by
    // clearing revoked_at, and without this nothing else looks.
    expect(migration).toMatch(/old\.revoked_at is not null and new\.accepted_at is not null/);
  });
});

describe("the table is a record, not a scratchpad", () => {
  it("one open invitation per person per park, and the index is partial", () => {
    expect(migration).toMatch(/create unique index[\s\S]{0,200}park_member_invites_one_open_idx/);
    // Partial, so "invited, withdrawn, invited again" is possible — the
    // ordinary course of a handoff that falls through.
    expect(migration).toMatch(/where accepted_at is null and revoked_at is null/);
  });

  it("it warns whoever adds the next kind of row to it", () => {
    // 0192's lesson: a partial unique index is a guarantee somebody relied on,
    // and sharing the table silently spends it.
    expect(migration).toMatch(/0192/);
  });

  it("an ending is one-way and there is only one of them", () => {
    expect(migration).toMatch(/park_member_invites_one_ending/);
    expect(migration).toMatch(/park_member_invites_acceptance_is_whole/);
    expect(migration).toMatch(/park_member_invites_revocation_is_whole/);
    expect(migration).toMatch(/already been taken up/);
    expect(migration).toMatch(/already withdrawn/);
  });

  it("the facts of the invitation itself cannot be rewritten", () => {
    // Changing the park or the email on an open invite is indistinguishable,
    // afterwards, from having invited that person to that park all along.
    expect(migration).toMatch(/new\.park_id is distinct from old\.park_id/);
    expect(migration).toMatch(/new\.email is distinct from old\.email/);
    expect(migration).toMatch(/new\.role is distinct from old\.role/);
  });

  it("the email is lower-cased by the TABLE, not left to the caller", () => {
    // The crew doors learned what a case-sensitive pre-check against a
    // case-insensitive index costs: a constraint-name error on screen and a
    // retry that can never work.
    expect(migration).toMatch(/check \(email = lower\(email\)/);
  });

  it("RLS is on and client writes are revoked", () => {
    // Postgres' default grants would let a signed-in client write this table
    // directly — which on THIS table means granting themselves a park.
    expect(migration).toMatch(/alter table public\.park_member_invites enable row level security/);
    expect(migration).toMatch(/revoke insert, update, delete on public\.park_member_invites from anon, authenticated/);
    expect(migration).toMatch(/ll_manages_park\(park_id\)/);
  });

  it("the guard functions are not callable by a client either", () => {
    expect(migration).toMatch(/revoke all on function public\.guard_park_member_invite\(\) from public, anon, authenticated/);
    expect(migration).toMatch(/revoke all on function public\.guard_park_keeps_an_owner\(\) from public, anon, authenticated/);
  });
});

describe("the screen says the thing he came to find out", () => {
  it("one person who can open a park is said out loud", () => {
    const s = handoffQuietSentence("The Haven");
    expect(s).toContain("The Haven");
    // The consequence, not the state. He may be about to plan a week away.
    expect(s).toMatch(/nobody can raise a bill, record a payment or answer a household/);
    for (const c of MANAGER_CANNOT) expect(s).toContain(c);
  });

  it("a failed read never renders as that sentence", () => {
    // "Nobody else can open this park" is a sentence with a consequence
    // attached, so it has to be earned by a read that worked.
    expect(actions).toMatch(/mustRead\("who can open this park"/);
    expect(actions).toMatch(/mustRead\("who has been invited to help run this park"/);
  });

  it("removing somebody says what it did NOT do", () => {
    expect(actions).toMatch(/Their account still exists/);
    expect(component).toMatch(/doesn&apos;t delete their account/);
  });

  it("a date is a date a person reads", () => {
    expect(actions).toMatch(/dayInWords\(/);
    expect(actions).not.toMatch(/invitedAtSaid: String\(i\.invited_at\)\.slice/);
  });

  it("an invitation's standing is derived from the two timestamps", () => {
    expect(inviteStanding({ acceptedAt: null, revokedAt: null })).toBe("open");
    expect(inviteStanding({ acceptedAt: "2026-10-13T00:00:00Z", revokedAt: null })).toBe("accepted");
    expect(inviteStanding({ acceptedAt: null, revokedAt: "2026-10-13T00:00:00Z" })).toBe("withdrawn");
    // Accepted wins if both were somehow set — the DB refuses that pair, and
    // the reading that matters is "they got in".
    expect(inviteStanding({ acceptedAt: "a", revokedAt: "b" })).toBe("accepted");
  });

  it("lists read as lists", () => {
    expect(joinHandoffWords([])).toBe("");
    expect(joinHandoffWords(["a"])).toBe("a");
    expect(joinHandoffWords(["a", "b"])).toBe("a and b");
    expect(joinHandoffWords(["a", "b", "c"])).toBe("a, b and c");
  });
});
