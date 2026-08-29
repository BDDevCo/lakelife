"use client";

import { slotLabel, type ShotProgress } from "@/lib/shot-list";

/**
 * THE NAMED WALK-AROUND, ON THE CREW'S SCREEN (0146).
 *
 * A count is not an instruction. Before this, a crew opening a boat storage
 * job read "0 / 7 photos required" and had to guess which seven — and seven
 * photos of the same fender satisfied the gate, which is exactly the record
 * that loses an argument about a gouge six months later.
 *
 * Each chip opens the camera for ONE named shot and labels the photo with it,
 * so the file can answer "show me the engine" instead of offering seven
 * pictures and a shrug.
 *
 * IT PROMPTS; IT DOES NOT GATE. The server's rule is still the count (0146
 * left it there on purpose — there is no offline support in the vendor app,
 * so a device with no signal cannot know which named slots are still empty).
 * A chip that refused to let a crew finish would be enforcing a rule no
 * trigger has, which is the failure this codebase keeps paying for.
 *
 * ONE COMPONENT, TWO DOORS: the route card and the full job page. They showed
 * the photo count two different ways already; the walk-around does not get to
 * drift the same way.
 */
export function WalkAround({
  progress,
  uploading,
  onPick,
}: {
  progress: ShotProgress;
  uploading: boolean;
  /** Called with the slug; the caller opens its own file input. */
  onPick: (slot: string) => void;
}) {
  if (progress.required.length === 0) return null;
  const allDone = progress.missing.length === 0;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {progress.required.map((slug) => {
          const done = progress.done.includes(slug);
          const label = slotLabel(slug);
          return (
            <button
              key={slug}
              className="ll-pill"
              onClick={() => onPick(slug)}
              disabled={uploading}
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                // `.ll-pill` is the STATUS-badge class — uppercase and tracked
                // out, which is right for "NEW" and wrong for a list of seven
                // things to photograph: it shouts, and "STARBOARD SIDE" eats a
                // third of a 375px row. Same shape, ordinary words.
                textTransform: "none",
                letterSpacing: "normal",
                cursor: uploading ? "default" : "pointer",
                border: `1px solid ${done ? "var(--ok)" : "var(--line)"}`,
                background: done ? "rgba(14,122,106,.10)" : "transparent",
                color: done ? "var(--ok)" : "inherit",
                // 375px, gloved thumb, boat on the trailer behind them.
                minHeight: 32,
                padding: "4px 10px",
              }}
              title={done ? `${label} — shot. Tap to add another.` : `Take the ${label} shot`}
            >
              {done ? "✓ " : "+ "}
              {label}
            </button>
          );
        })}
      </div>
      <div
        className="mut"
        style={{ fontSize: 12, marginTop: 6, color: allDone ? "var(--ok)" : undefined }}
      >
        {progress.message}
      </div>
    </div>
  );
}
