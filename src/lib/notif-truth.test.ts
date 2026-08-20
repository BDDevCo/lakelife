import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NOTIF_DEFS } from "./notifications";
import { channelsFor, staticGate } from "./notif-prefs";

/**
 * THE SWITCH ON THE SCREEN MUST GOVERN THE MESSAGE THAT ACTUALLY GOES.
 *
 * "Approval needed from a crew flag" was declared a TEXT-ONLY type. The
 * settings screen draws its chips from that declaration, so the customer got
 * one switch, for SMS — the channel that has delivered nothing since 19 July.
 * The email on that same path was sent with no gate on it whatsoever. So the
 * message that actually arrived was the one they could not stop, and the one
 * they could stop never arrived. A switch that governs nothing is worse than
 * no switch: it is a promise broken every time it is tested.
 *
 * Two directions, and both matter:
 *
 *   A DECLARED CHANNEL THAT NOTHING CONSULTS is a chip that does nothing —
 *   the customer turns it off and the message keeps coming.
 *
 *   A CONSULTED CHANNEL THE DEF DENIES is a send path written against a
 *   switch that can never say yes. That is sometimes deliberate (see `day`),
 *   which is why it is listed rather than banned — a human has to say so.
 *
 * Source-scanning, because the failure is an OMISSION. There is no behavioural
 * test for a gate nobody wrote.
 */

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

/** Comments describe what the code SHOULD do; only the code counts. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ALL = sources(join(process.cwd(), "src"))
  .map((f) => stripComments(readFileSync(f, "utf8")))
  .join("\n");

/** Every (type, channel) pair any send path actually asks about. */
const consulted = new Set<string>();
for (const m of ALL.matchAll(/allowsNotification\(\s*[^,]+,\s*"([a-z]+)"\s*,\s*"(sms|email)"/g)) {
  consulted.add(`${m[1]}:${m[2]}`);
}

/**
 * Consulted, but the def says no — the call can never return true.
 * Deliberate ones live here with the reason.
 */
const KNOWINGLY_DEAD: Record<string, string> = {
  "day:email":
    "the service-day reminder is text-only by design; the send path already " +
    "asks, so the day we offer it on email it works with no code change",
};

describe("the scanner still finds things", () => {
  it("sees the gate calls at all", () => {
    expect(consulted.size).toBeGreaterThanOrEqual(6);
    expect(consulted.has("book:sms")).toBe(true);
  });
});

describe("every chip on the settings screen governs a real send", () => {
  for (const def of NOTIF_DEFS) {
    if (def.locked) continue; // receipts are a record of money, not a preference
    for (const ch of channelsFor(def)) {
      it(`"${def.label}" — the ${ch} switch is consulted before sending`, () => {
        expect(
          consulted.has(`${def.type}:${ch}`),
          `NOTIF_DEFS offers a ${ch} chip for "${def.type}" but no send path calls ` +
            `allowsNotification(user, "${def.type}", "${ch}"). Either gate the send ` +
            `or stop drawing the chip.`,
        ).toBe(true);
      });
    }
  }
});

describe("no send path asks a question the definition can only answer no to", () => {
  for (const key of [...consulted].sort()) {
    const [type, ch] = key.split(":") as [string, "sms" | "email"];
    if (!NOTIF_DEFS.some((d) => d.type === type)) continue; // unknown type: allowed
    it(`${key}`, () => {
      const denied = staticGate(type, ch) === "deny";
      expect(
        !denied || key in KNOWINGLY_DEAD,
        `A send path asks about ${key}, but NOTIF_DEFS denies that channel, so it ` +
          `can never fire. Add the channel to the def, or list it in KNOWINGLY_DEAD ` +
          `with the reason.`,
      ).toBe(true);
    });
  }
});

/**
 * ASKED IS NOT THE SAME AS OBEYED.
 *
 * The first version of this file only proved the question was put. Removing
 * `&& apprByEmail` from the send — restoring the exact bug — left the
 * `allowsNotification(…, "appr", "email")` call sitting there, and every test
 * still passed. A gate computed and then ignored is the bug, not a near miss.
 *
 * So: every name a gate result is bound to has to be READ somewhere after it.
 */
describe("a gate that is computed must be used", () => {
  const files = sources(join(process.cwd(), "src")).filter((f) => !/\.test\./.test(f));
  const bound: Array<{ file: string; name: string; uses: number }> = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    if (!src.includes("allowsNotification")) continue;
    // const [a, b] = await Promise.all([ allowsNotification(...), ... ])
    for (const m of src.matchAll(
      /const\s*\[([^\]]+)\]\s*=\s*await Promise\.all\(\[([\s\S]{0,400}?)\]\)/g,
    )) {
      if (!m[2].includes("allowsNotification")) continue;
      for (const raw of m[1].split(",")) {
        const name = raw.trim();
        if (!name) continue;
        const uses = [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
        bound.push({ file: f.replace(process.cwd() + "/", ""), name, uses });
      }
    }
  }

  it("finds the bindings at all", () => {
    expect(bound.length).toBeGreaterThanOrEqual(4);
  });

  for (const b of bound) {
    it(`${b.name} (${b.file}) is read after it is computed`, () => {
      expect(
        b.uses,
        `${b.name} is bound to an allowsNotification result and then never read. ` +
          `The send it guards is going out ungated.`,
      ).toBeGreaterThan(1);
    });
  }
});

describe("the crew flag, specifically", () => {
  it("offers both channels — the email is the one that arrives", () => {
    const appr = NOTIF_DEFS.find((d) => d.type === "appr")!;
    expect(channelsFor(appr)).toEqual(["sms", "email"]);
  });
  it("gates both of them", () => {
    expect(consulted.has("appr:sms")).toBe(true);
    expect(consulted.has("appr:email")).toBe(true);
  });
  it("defaults on, so today's mail keeps arriving", () => {
    expect(NOTIF_DEFS.find((d) => d.type === "appr")!.defaultOn).toBe(true);
  });
});
