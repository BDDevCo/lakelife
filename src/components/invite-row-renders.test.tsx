import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteRow } from "./ParkPeople";
import type { ParkInvite } from "@/app/park/handoff-actions";

/**
 * WHAT A SOURCE SCAN CANNOT TELL YOU.
 *
 * The test that was supposed to prove the owner's own note gets shown back to
 * him asserted that the string `.note` appeared in ParkPeople.tsx. Mutating
 * the render to `{false && i.note && (` left that string exactly where it was,
 * so the scan passed over a dead branch — the note was a column with no reader
 * again and nothing said so.
 *
 * A scan proves a token is PRESENT. It never proves it is REACHABLE. So the
 * row is a hook-free component now, exported for exactly this, and these read
 * the markup it actually produces.
 */

const invite = (over: Partial<ParkInvite> = {}): ParkInvite => ({
  id: "i1",
  email: "mike@example.test",
  note: null,
  invitedAtSaid: "October 13, 2026",
  acceptedAt: null,
  revokedAt: null,
  ...over,
});

const render = (over: Partial<ParkInvite> = {}, opts: {
  viewerIsOwner?: boolean; busyRow?: string | null;
} = {}) =>
  renderToStaticMarkup(
    <InviteRow
      invite={invite(over)}
      viewerIsOwner={opts.viewerIsOwner ?? true}
      busyRow={opts.busyRow ?? null}
      onResend={() => {}}
      onRevoke={() => {}}
    />,
  );

describe("an invitation's row", () => {
  it("SHOWS HIM THE NOTE HE WROTE", () => {
    const html = render({ note: "Covering while I'm away in February." });
    expect(html).toContain("You said:");
    expect(html).toContain("Covering while I&#x27;m away in February.");
  });

  it("and says nothing about a note when there isn't one", () => {
    expect(render({ note: null })).not.toContain("You said:");
    expect(render({ note: "" })).not.toContain("You said:");
  });

  it("escapes the note, because it is typed text going into markup", () => {
    const html = render({ note: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("names the address and the day in words", () => {
    const html = render();
    expect(html).toContain("mike@example.test");
    expect(html).toContain("October 13, 2026");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("an open invitation offers both acts", () => {
    const html = render();
    expect(html).toContain("Waiting on them");
    expect(html).toContain("Send it again");
    expect(html).toContain("Withdraw it");
  });

  it("a taken-up invitation offers neither", () => {
    // There is nothing to resend and nothing to withdraw — what you withdraw
    // then is the membership, which is a different act on a different list.
    const html = render({ acceptedAt: "2026-10-14T00:00:00Z" });
    expect(html).toContain("Taken up");
    expect(html).not.toContain("Send it again");
    expect(html).not.toContain("Withdraw it");
  });

  it("a withdrawn one offers neither either", () => {
    const html = render({ revokedAt: "2026-10-14T00:00:00Z" });
    expect(html).toContain("Withdrawn");
    expect(html).not.toContain("Send it again");
    expect(html).not.toContain("Withdraw it");
  });

  it("a manager sees the row and gets no buttons on it", () => {
    const html = render({}, { viewerIsOwner: false });
    expect(html).toContain("mike@example.test");
    expect(html).not.toContain("Send it again");
    expect(html).not.toContain("Withdraw it");
  });

  it("the row mid-act says which act, and disables only that button", () => {
    const html = render({}, { busyRow: "resend:i1" });
    expect(html).toContain("Sending");
    // The other one stays live: one button spinning must not freeze the sheet.
    expect(html).toContain("Withdraw it");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1);
  });

  it("and the withdraw act says its own word", () => {
    const html = render({}, { busyRow: "revoke:i1" });
    expect(html).toContain("Withdrawing");
    expect(html).toContain("Send it again");
    // ASSERTED IN BOTH DIRECTIONS. With only the resend case checked, widening
    // one button's guard to `busyRow !== null` was invisible: that button was
    // the busy one anyway, so the count stayed at one. It is the OTHER act
    // that exposes a guard which stopped caring which row is busy.
    expect((html.match(/disabled=""/g) ?? []).length,
      "a spinner on one act disabled the other").toBe(1);
  });

  it("nothing is disabled when nothing is running", () => {
    expect(render({}, { busyRow: null })).not.toContain('disabled=""');
  });

  it("a busy row elsewhere on the sheet leaves this row alone", () => {
    // Each row is keyed by its own id, so another invitation's act must not
    // grey this one out.
    const html = render({}, { busyRow: "resend:SOMEONE-ELSE" });
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Send it again");
    expect(html).toContain("Withdraw it");
  });
});
