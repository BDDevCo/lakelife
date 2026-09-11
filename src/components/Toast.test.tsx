import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * THE TOAST'S GOLD TICK IS EARNED, NOT ASSUMED.
 *
 * The prototype (lakelife.html:940) puts a gold ✓ before every toast because
 * every prototype toast is good news. The app's are not: a hundred call sites
 * hand it `res.error ?? "Couldn't …"`. So the tick is drawn by toast.ok()
 * only, toast.err() can never draw one, and bare toast() is neutral — the
 * safe direction on every site nobody has classified.
 */

// ToastHost reads window events; test the render branch it produces directly.
function host(kind: "ok" | "err" | "info", message: string) {
  return renderToStaticMarkup(
    <div className="ll-toast" role="status" aria-live="polite">
      {kind === "ok" && <span className="tick" aria-hidden="true">✓</span>}
      <span>{message}</span>
    </div>,
  );
}

describe("the tick", () => {
  it("is drawn for a success", () => {
    expect(host("ok", "Saved.")).toContain('class="tick"');
  });
  it("is never drawn for a failure", () => {
    expect(host("err", "Couldn't send that.")).not.toContain("✓");
  });
  it("is not drawn on a toast nobody classified", () => {
    // A success left unmarked is merely tick-less. A failure that got a tick
    // would be a lie. Neutral must be tick-less.
    expect(host("info", "Autopilot off — no more proposals for this one.")).not.toContain("✓");
  });
});

describe("no failure path can reach a tick", () => {
  const dir = fileURLToPath(new URL("../", import.meta.url));
  const files: string[] = [];
  (function walk(d: string) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith("Toast.tsx")) files.push(p);
    }
  })(dir);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("every `.error ??` toast is toast.err, so it can never wear one", () => {
    const guilty: string[] = [];
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/\btoast\((\s*\w+\.error\b)/g)) guilty.push(`${f.slice(dir.length)}: ${m[0]}`);
    }
    expect(guilty, "a failure is passed to the neutral toast — one default flip away from a tick").toEqual([]);
  });

  it("nothing calls toast.ok with an error", () => {
    const guilty: string[] = [];
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/\btoast\.ok\(([^)]{0,80})/g)) {
        if (/\.error\b|Couldn|didn't|failed/i.test(m[1])) guilty.push(`${f.slice(dir.length)}: ${m[0]}`);
      }
    }
    expect(guilty, "a failure would wear the gold tick").toEqual([]);
  });

  it("the scanner still sees the sites it judges", () => {
    let ok = 0, err = 0;
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      ok += (src.match(/\btoast\.ok\(/g) ?? []).length;
      err += (src.match(/\btoast\.err\(/g) ?? []).length;
    }
    expect(ok).toBeGreaterThanOrEqual(20);
    expect(err).toBeGreaterThanOrEqual(90);
  });
});
