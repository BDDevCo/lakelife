"use client";

import type { OpsTab, OpsTask } from "@/app/ops/ops-today-helpers";
import { useOpsTab } from "./OpsTabs";

/**
 * WHAT NEEDS YOU, AT THE TOP, BEFORE ANYTHING ELSE.
 *
 * The console used to open with four tiles reading 0, 0, $0 and $0, then nine
 * tabs defaulting to an empty Jobs board. The fact that mattered most — no
 * crew on the platform can take any job — was two taps away, on the Crews tab,
 * under the roster.
 *
 * Every row here carries its own verb and opens the tab that holds the work,
 * the same rule the park's morning screen now follows: the card did the
 * computing, so the card should not hand back a URL and make him find it
 * again. Nothing on this card WRITES anything — it moves him to the screen
 * where the decision lives, because every one of these decisions spends money
 * or speaks to somebody.
 */
export function OpsToday({
  tasks, quiet, openingTab,
}: {
  tasks: readonly OpsTask[];
  /** What was checked, for when the list is empty. */
  quiet: string;
  /** Only for the no-provider fallback — the live tab lives in OpsTabs. */
  openingTab: OpsTab;
}) {
  // `open` sets the tab AND scrolls the strip into view. A control labelled
  // "Open dispatch" that silently highlights something a thousand pixels down
  // is the defect this card was built to fix, one level smaller.
  const { open } = useOpsTab(openingTab);
  if (tasks.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill ok">Nothing needs you</span>
        <p className="mut" style={{ fontSize: 13.5, margin: "10px 0 0", lineHeight: 1.55 }}>
          {quiet}
        </p>
      </div>
    );
  }

  const now = tasks.filter((t) => t.urgency === "now");
  const rest = tasks.filter((t) => t.urgency !== "now");

  return (
    <div
      className="ll-card ll-card-pad"
      style={{
        marginTop: 18,
        borderLeft: `4px solid ${now.length > 0 ? "var(--gold)" : "var(--teal-dark)"}`,
      }}
    >
      <span className={`ll-pill ${now.length > 0 ? "gold" : "teal"}`}>
        {now.length > 0 ? "Needs you today" : "Worth a look"}
      </span>
      <h2 style={{ fontSize: 16, margin: "10px 0 4px" }}>
        {now.length > 0
          ? now.length === 1
            ? "1 thing needs you today"
            : `${now.length} things need you today`
          : rest.length === 1
            ? "1 thing worth a look"
            : `${rest.length} things worth a look`}
        {now.length > 0 && rest.length > 0 && (
          <span className="mut" style={{ fontWeight: 400, fontSize: 14 }}>
            {" "}· {rest.length} more below {rest.length === 1 ? "it" : "them"}
          </span>
        )}
      </h2>

      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {tasks.map((t) => (
          <div
            key={t.key}
            style={{
              display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: 10,
              background: t.urgency === "now" ? "var(--sand-light)" : "transparent",
              border: t.urgency === "now" ? "none" : "1px solid var(--line)",
            }}
          >
            <div style={{ flex: "1 1 260px", minWidth: 0, fontSize: 13.5, lineHeight: 1.5 }}>
              {t.said}
            </div>
            {t.tab ? (
              <button
                className="ll-btn sm"
                style={{ flex: "0 0 auto" }}
                onClick={() => open(t.tab as OpsTab)}
              >
                {t.verb}
              </button>
            ) : (
              /* No button, because the thing is already on this page and a
                 button that scrolled would be a second way to reach one
                 control. The row still says where it is. */
              <span className="mut" style={{ flex: "0 0 auto", fontSize: 12.5 }}>
                {t.verb}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
